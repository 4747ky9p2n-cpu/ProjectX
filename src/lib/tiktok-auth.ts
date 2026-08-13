/**
 * TikTok OAuth Token Management
 *
 * Mirrors `youtube-auth.ts`: tokens live in a single httpOnly cookie
 * (`tiktok_auth`). Provides helpers to read, refresh, and clear tokens.
 *
 * Env vars (NO hardcoded fallbacks — the owner's TikTok Developer app is not
 * approved for Content Posting yet, so the code must degrade gracefully):
 *   TIKTOK_CLIENT_KEY      — TikTok app Client Key
 *   TIKTOK_CLIENT_SECRET   — TikTok app Client Secret
 *
 * NOTE: TikTok refresh tokens are SINGLE-USE — every refresh returns a NEW
 * refresh token which must be persisted. `getValidTikTokToken` returns a
 * `freshCookie` Set-Cookie value when a refresh occurred so the caller can
 * persist the rotated token.
 */

export interface TikTokTokens {
  access_token: string;
  refresh_token: string;
  /** epoch ms when the access token expires */
  expiry: number;
  open_id?: string;
}

export interface TikTokUser {
  openId: string;
  displayName: string;
  avatarUrl: string;
}

const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";

/** Credentials from the environment, or null when not configured yet. */
export function tiktokCredentials(): {
  clientKey: string;
  clientSecret: string;
} | null {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  if (!clientKey || !clientSecret) return null;
  return { clientKey, clientSecret };
}

/** True when the TikTok app is not configured (owner must add secrets). */
export function tiktokSetupPending(): boolean {
  return tiktokCredentials() === null;
}

/**
 * Parse the `tiktok_auth` cookie value into a token object.
 */
export function parseTikTokTokens(
  cookieHeader: string | null
): TikTokTokens | null {
  if (!cookieHeader) return null;
  const cookies = parseCookieString(cookieHeader);
  const raw = cookies["tiktok_auth"];
  if (!raw) return null;
  try {
    const tokens = JSON.parse(decodeURIComponent(raw)) as TikTokTokens;
    if (tokens.access_token && tokens.refresh_token && tokens.expiry) {
      return tokens;
    }
  } catch {
    // corrupted cookie
  }
  return null;
}

/**
 * Get a valid TikTok access token, refreshing when near expiry.
 * Returns null if no tokens are stored, the app is unconfigured, or the
 * refresh fails.
 */
export async function getValidTikTokToken(
  cookieHeader: string | null
): Promise<{
  accessToken: string;
  tokens: TikTokTokens;
  /** Set-Cookie value to persist rotated tokens (present when refreshed). */
  freshCookie?: string;
} | null> {
  let tokens = parseTikTokTokens(cookieHeader);
  if (!tokens) return null;

  // If not expired (with 60s buffer), return as-is
  if (Date.now() < tokens.expiry - 60_000) {
    return { accessToken: tokens.access_token, tokens };
  }

  const refreshed = await refreshTikTokToken(tokens.refresh_token);
  if (!refreshed) return null;

  return {
    accessToken: refreshed.access_token,
    tokens: refreshed,
    // TikTok refresh tokens rotate — persist the NEW refresh token.
    freshCookie: createTikTokAuthCookie(refreshed),
  };
}

/**
 * Exchange a TikTok refresh token for a new access token.
 * TikTok refresh tokens are single-use: the response contains a NEW
 * refresh_token which callers MUST store (and replace the old one).
 */
async function refreshTikTokToken(
  refreshToken: string
): Promise<TikTokTokens | null> {
  const creds = tiktokCredentials();
  if (!creds) return null;

  try {
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: creds.clientKey,
        client_secret: creds.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!resp.ok) {
      console.error(`[ClipFlow] TikTok token refresh failed (HTTP ${resp.status})`);
      return null;
    }

    const data = (await resp.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      open_id?: string;
      error?: string;
      error_description?: string;
    };

    if (!data.access_token) {
      console.error(
        `[ClipFlow] TikTok token refresh response had no access_token: ${
          data.error_description || data.error || "unknown error"
        }`
      );
      return null;
    }

    return {
      access_token: data.access_token,
      // The NEW single-use refresh token; fall back to the old one only if
      // the API (unexpectedly) did not rotate it.
      refresh_token: data.refresh_token || refreshToken,
      expiry: Date.now() + (data.expires_in ?? 86_400) * 1000,
      open_id: data.open_id,
    };
  } catch (err) {
    console.error(
      `[ClipFlow] TikTok token refresh network error: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}

/**
 * Fetch the authenticated TikTok user's profile (for the connection chip).
 */
export async function fetchTikTokUser(
  accessToken: string
): Promise<TikTokUser | null> {
  try {
    const resp = await fetch(
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      }
    );

    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      data?: {
        user?: {
          open_id?: string;
          display_name?: string;
          avatar_url?: string;
        };
      };
    };

    const user = data.data?.user;
    if (!user) return null;

    return {
      openId: user.open_id ?? "",
      displayName: user.display_name || "TikTok User",
      avatarUrl: user.avatar_url || "",
    };
  } catch {
    return null;
  }
}

/**
 * Create Set-Cookie header value for the auth cookie.
 */
export function createTikTokAuthCookie(tokens: TikTokTokens): string {
  const value = encodeURIComponent(JSON.stringify(tokens));
  return `tiktok_auth=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`;
}

/**
 * Create Set-Cookie header value to clear the auth cookie.
 */
export function clearTikTokAuthCookie(): string {
  return `tiktok_auth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * Parse a Cookie header string into a key-value record.
 */
function parseCookieString(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
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
