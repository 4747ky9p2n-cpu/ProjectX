/**
 * YouTube OAuth Handlers
 *
 * Standalone request handlers for the OAuth flow.
 * Called directly from serve.ts, bypassing the TanStack Start router
 * since this version doesn't support API routes.
 */

import { randomBytes } from "node:crypto";
import { createAuthCookie, clearAuthCookie } from "./youtube-auth";

const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID || "PLACEHOLDER_CLIENT_ID";
const GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET || "PLACEHOLDER_CLIENT_SECRET";
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ||
  "http://localhost:3000/api/auth/youtube/callback";

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
].join(" ");

const TOKEN_URL = "https://oauth2.googleapis.com/token";

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

/**
 * GET /api/auth/youtube — initiate OAuth flow
 */
export function handleAuthInitiate(): Response {
  const state = randomBytes(32).toString("hex");

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });

  const googleAuthUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" + params.toString();

  const stateCookie = `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: googleAuthUrl,
      "Set-Cookie": stateCookie,
    },
  });
}

/**
 * GET /api/auth/youtube/callback — handle OAuth callback
 */
export async function handleAuthCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const cookies = parseCookies(req.headers.get("cookie") || "");
  const savedState = cookies["oauth_state"];

  if (!savedState || savedState !== state) {
    return htmlPage("Invalid State", "CSRF check failed. Please try again.", true);
  }

  if (error) {
    return htmlPage("Access Denied", "You declined the authorization.", true);
  }

  if (!code) {
    return htmlPage("Missing Code", "No authorization code received.", true);
  }

  // Exchange code for tokens
  let tokenData: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  try {
    const tokenResp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      console.error("Token exchange failed:", errText);
      return htmlPage(
        "Connection Failed",
        "Could not complete authentication. Please try again.",
        true
      );
    }

    tokenData = (await tokenResp.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
  } catch (err) {
    console.error("Token exchange error:", err);
    return htmlPage(
      "Connection Failed",
      "Network error during authentication. Please try again.",
      true
    );
  }

  const tokens = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expiry: Date.now() + tokenData.expires_in * 1000,
  };

  const authCookie = createAuthCookie(tokens);
  const clearStateCookie =
    "oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";

  const response = new Response(null, {
    status: 302,
    headers: { Location: "/app?connected=true" },
  });
  response.headers.append("Set-Cookie", authCookie);
  response.headers.append("Set-Cookie", clearStateCookie);

  return response;
}

/**
 * GET /api/auth/youtube/disconnect — clear auth cookie
 */
export function handleDisconnect(): Response {
  const response = new Response(null, {
    status: 302,
    headers: { Location: "/app?disconnected=true" },
  });
  response.headers.append("Set-Cookie", clearAuthCookie());
  return response;
}

/**
 * GET /api/auth/youtube/channel — get connected channel info (JSON)
 */
export async function handleChannelInfo(req: Request): Promise<Response> {
  const { getValidAccessToken, fetchYouTubeChannel } = await import(
    "./youtube-auth"
  );
  const cookieHeader = req.headers.get("cookie");
  const result = await getValidAccessToken(cookieHeader);

  if (!result) {
    return new Response(JSON.stringify({ connected: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const channel = await fetchYouTubeChannel(result.accessToken);

  if (!channel) {
    return new Response(JSON.stringify({ connected: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({ connected: true, channel }),
    { headers: { "Content-Type": "application/json" } }
  );
}
