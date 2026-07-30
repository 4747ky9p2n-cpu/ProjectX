/**
 * YouTube OAuth Token Management
 *
 * Manages tokens stored in a single httpOnly cookie (`youtube_auth`).
 * Provides helpers to read, refresh, and clear tokens.
 */

export interface YouTubeTokens {
  access_token: string;
  refresh_token: string;
  expiry: number; // epoch ms
}

export interface YouTubeChannel {
  id: string;
  title: string;
  thumbnail: string;
  subscriberCount: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Parse the `youtube_auth` cookie value into a token object.
 */
export function parseTokens(cookieHeader: string | null): YouTubeTokens | null {
  if (!cookieHeader) return null;
  const cookies = parseCookieString(cookieHeader);
  const raw = cookies["youtube_auth"];
  if (!raw) return null;
  try {
    const tokens = JSON.parse(decodeURIComponent(raw)) as YouTubeTokens;
    if (tokens.access_token && tokens.refresh_token && tokens.expiry) {
      return tokens;
    }
  } catch {
    // corrupted cookie
  }
  return null;
}

/**
 * Get a valid access token, refreshing if expired.
 * Returns null if no tokens are stored or refresh fails.
 */
export async function getValidAccessToken(
  cookieHeader: string | null
): Promise<{ accessToken: string; tokens: YouTubeTokens } | null> {
  let tokens = parseTokens(cookieHeader);
  if (!tokens) return null;

  // If not expired (with 60s buffer), return as-is
  if (Date.now() < tokens.expiry - 60_000) {
    return { accessToken: tokens.access_token, tokens };
  }

  // Refresh the token
  const refreshed = await refreshAccessToken(tokens.refresh_token);
  if (!refreshed) return null;

  return { accessToken: refreshed.access_token, tokens: refreshed };
}

/**
 * Exchange a refresh token for a new access token.
 */
async function refreshAccessToken(
  refreshToken: string
): Promise<YouTubeTokens | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID || "PLACEHOLDER_CLIENT_ID";
  const clientSecret =
    process.env.GOOGLE_CLIENT_SECRET || "PLACEHOLDER_CLIENT_SECRET";

  try {
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      access_token: string;
      expires_in: number;
    };

    return {
      access_token: data.access_token,
      refresh_token: refreshToken, // keep existing refresh token
      expiry: Date.now() + data.expires_in * 1000,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch the authenticated user's YouTube channel info.
 */
export async function fetchYouTubeChannel(
  accessToken: string
): Promise<YouTubeChannel | null> {
  try {
    const resp = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      }
    );

    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      items?: Array<{
        id: string;
        snippet: { title: string; thumbnails: { default: { url: string } } };
        statistics: { subscriberCount: string };
      }>;
    };

    const channel = data.items?.[0];
    if (!channel) return null;

    return {
      id: channel.id,
      title: channel.snippet.title,
      thumbnail: channel.snippet.thumbnails.default.url,
      subscriberCount: channel.statistics.subscriberCount || "0",
    };
  } catch {
    return null;
  }
}

/**
 * Create Set-Cookie header value for the auth cookie.
 */
export function createAuthCookie(tokens: YouTubeTokens): string {
  const value = encodeURIComponent(JSON.stringify(tokens));
  return `youtube_auth=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`;
}

/**
 * Create Set-Cookie header value to clear the auth cookie.
 */
export function clearAuthCookie(): string {
  return `youtube_auth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
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
