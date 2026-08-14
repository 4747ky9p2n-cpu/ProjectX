/**
 * TikTok OAuth Handlers
 *
 * Mirrors `oauth-handlers.ts` (YouTube). Standalone request handlers for the
 * TikTok OAuth flow, called directly from serve.ts.
 *
 * Scopes: `user.info.basic,video.publish` — read the user profile (for the
 * connection chip) and publish videos (Content Posting API).
 *
 * Graceful degradation: when TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET are not
 * configured yet (owner's TikTok Developer app still awaiting Content Posting
 * approval), every endpoint returns a clear "setup pending" response instead
 * of crashing.
 */

import { randomBytes } from "node:crypto";
import {
  createTikTokAuthCookie,
  clearTikTokAuthCookie,
  fetchTikTokUser,
  getValidTikTokToken,
  tiktokCredentials,
} from "./tiktok-auth";

const TIKTOK_REDIRECT_URI =
  process.env.TIKTOK_REDIRECT_URI ||
  "https://570ab42d07b3065f1977678d88b714aa.ctonew.app/api/auth/tiktok/callback";

const SCOPES = "user.info.basic,video.publish";

const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const STATE_COOKIE = "tiktok_oauth_state";

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(";").forEach((pair) => {
    const eqIdx = pair.indexOf("=");
    if (eqIdx > 0) {
      const key = pair.slice(0, eqIdx).trim();
      const value = pair.slice(eqIdx + 1).trim();
      if (key) cookies[key] = value;
    }
  });
  return cookies;
}

function jsonResponse(
  body: Record<string, unknown>,
  status = 200
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function htmlPage(title: string, message: string, isError = false): Response {
  const color = isError ? "#ef4444" : "#22c55e";
  return new Response(
    `<!DOCTYPE html>
<html>
<body style="background:#0a0a0a;color:#fff;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center;max-width:400px">
<h1 style="color:${color};font-size:1.5rem;margin-bottom:0.5rem">${title}</h1>
<p style="color:#9ca3af;line-height:1.5">${message}</p>
<a href="/app" style="display:inline-block;margin-top:1.5rem;padding:0.75rem 2rem;background:${isError ? "#ef4444" : "#22c55e"};color:#fff;border-radius:0.75rem;text-decoration:none;font-weight:600">Back to ClipFlow</a>
</div>
</body>
</html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

/** Message shown wherever TikTok is not configured yet. */
function setupPendingMessage(): string {
  return "TikTok is not set up yet — the owner must add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET (TikTok Developer app approved for Content Posting).";
}

/**
 * GET /api/auth/tiktok — initiate the TikTok OAuth flow
 */
export function handleTikTokAuthInitiate(): Response {
  const creds = tiktokCredentials();

  if (!creds) {
    return jsonResponse({
      setupPending: true,
      error: setupPendingMessage(),
    });
  }

  const state = randomBytes(32).toString("hex");

  const params = new URLSearchParams({
    client_key: creds.clientKey,
    response_type: "code",
    scope: SCOPES,
    redirect_uri: TIKTOK_REDIRECT_URI,
    state,
  });

  const authUrl = AUTHORIZE_URL + "?" + params.toString();

  const stateCookie = `${STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl,
      "Set-Cookie": stateCookie,
    },
  });
}

/**
 * GET /api/auth/tiktok/callback — handle the OAuth callback
 */
export async function handleTikTokAuthCallback(
  req: Request
): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const cookies = parseCookies(req.headers.get("cookie") || "");
  const savedState = cookies[STATE_COOKIE];

  if (!savedState || savedState !== state) {
    return htmlPage(
      "Invalid State",
      "CSRF check failed. Please try again.",
      true
    );
  }

  if (error) {
    return htmlPage("Access Denied", "You declined the authorization.", true);
  }

  if (!code) {
    return htmlPage("Missing Code", "No authorization code received.", true);
  }

  const creds = tiktokCredentials();
  if (!creds) {
    return htmlPage("Setup Pending", setupPendingMessage(), true);
  }

  // Exchange code for tokens
  let tokenData: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    open_id?: string;
    error_description?: string;
  };

  try {
    const tokenResp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_key: creds.clientKey,
        client_secret: creds.clientSecret,
        redirect_uri: TIKTOK_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    tokenData = (await tokenResp.json().catch(() => ({}))) as typeof tokenData;

    if (!tokenResp.ok || !tokenData.access_token) {
      console.error(
        `[ClipFlow] TikTok token exchange failed (HTTP ${tokenResp.status}): ${
          tokenData.error_description || tokenResp.statusText
        }`
      );
      return htmlPage(
        "Connection Failed",
        "Could not complete authentication. Please try again.",
        true
      );
    }
  } catch (err) {
    console.error("TikTok token exchange error:", err);
    return htmlPage(
      "Connection Failed",
      "Network error during authentication. Please try again.",
      true
    );
  }

  const tokens = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token || "",
    expiry: Date.now() + (tokenData.expires_in ?? 86_400) * 1000,
    open_id: tokenData.open_id,
  };

  const authCookie = createTikTokAuthCookie(tokens);
  const clearStateCookie = `${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

  const response = new Response(null, {
    status: 302,
    headers: { Location: "/app?tiktok=connected" },
  });
  response.headers.append("Set-Cookie", authCookie);
  response.headers.append("Set-Cookie", clearStateCookie);

  return response;
}

/**
 * GET /api/auth/tiktok/disconnect — clear the auth cookie
 */
export function handleTikTokDisconnect(): Response {
  const response = new Response(null, {
    status: 302,
    headers: { Location: "/app?tiktok=disconnected" },
  });
  response.headers.append("Set-Cookie", clearTikTokAuthCookie());
  return response;
}

/**
 * GET /api/auth/tiktok/channel — get the connected TikTok user (JSON)
 * Returns `{ connected: false, setupPending: true }` when the app is not
 * configured yet, so the UI can show a "setup pending" hint.
 */
export async function handleTikTokChannelInfo(
  req: Request
): Promise<Response> {
  const cookieHeader = req.headers.get("cookie");
  const result = await getValidTikTokToken(cookieHeader);

  if (!result) {
    return jsonResponse({
      connected: false,
      setupPending: tiktokCredentials() === null,
    });
  }

  const user = await fetchTikTokUser(result.accessToken);

  if (!user) {
    return jsonResponse({ connected: false, setupPending: false });
  }

  const response = jsonResponse({ connected: true, user });
  // Persist a rotated refresh token if a refresh happened during this check.
  if (result.freshCookie) {
    response.headers.append("Set-Cookie", result.freshCookie);
  }
  return response;
}
