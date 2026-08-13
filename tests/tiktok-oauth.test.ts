/**
 * TikTok OAuth + handlers tests — cookie parsing, token refresh (single-use
 * refresh tokens), OAuth flow shape, missing-secrets degradation.
 * Run with: bun test tests/tiktok-oauth.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  parseTikTokTokens,
  getValidTikTokToken,
  createTikTokAuthCookie,
  clearTikTokAuthCookie,
  tiktokSetupPending,
} from "../src/lib/tiktok-auth";
import {
  handleTikTokAuthInitiate,
  handleTikTokAuthCallback,
  handleTikTokDisconnect,
  handleTikTokChannelInfo,
} from "../src/lib/tiktok-handlers";

const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const USER_URL = "https://open.tiktokapis.com/v2/user/info/";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setTikTokSecrets(set: boolean) {
  if (set) {
    process.env.TIKTOK_CLIENT_KEY = "test_client_key";
    process.env.TIKTOK_CLIENT_SECRET = "test_client_secret";
  } else {
    delete process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_SECRET;
  }
}

describe("tiktok-auth", () => {
  afterEach(() => {
    setTikTokSecrets(false);
    globalThis.fetch = fetch; // restore
  });

  test("parseTikTokTokens reads the URL-encoded tiktok_auth cookie", () => {
    const tokens = {
      access_token: "at1",
      refresh_token: "rt1",
      expiry: Date.now() + 3600_000,
    };
    const cookie = `youtube_auth=garbage; tiktok_auth=${encodeURIComponent(
      JSON.stringify(tokens)
    )}; other=1`;
    const parsed = parseTikTokTokens(cookie);
    expect(parsed).not.toBeNull();
    expect(parsed!.access_token).toBe("at1");
  });

  test("parseTikTokTokens rejects corrupted/partial cookies", () => {
    expect(parseTikTokTokens(null)).toBeNull();
    expect(parseTikTokTokens("tiktok_auth=not-json")).toBeNull();
    expect(
      parseTikTokTokens(`tiktok_auth=${encodeURIComponent(JSON.stringify({ access_token: "x" }))}`)
    ).toBeNull();
  });

  test("tiktokSetupPending reflects env secrets", () => {
    setTikTokSecrets(false);
    expect(tiktokSetupPending()).toBe(true);
    setTikTokSecrets(true);
    expect(tiktokSetupPending()).toBe(false);
  });

  test("getValidTikTokToken returns unexpired tokens without refreshing", async () => {
    const tokens = {
      access_token: "at_ok",
      refresh_token: "rt_ok",
      expiry: Date.now() + 3600_000,
    };
    const cookie = `tiktok_auth=${encodeURIComponent(JSON.stringify(tokens))}`;
    const result = await getValidTikTokToken(cookie);
    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe("at_ok");
    expect(result!.freshCookie).toBeUndefined();
  });

  test("getValidTikTokToken refreshes expired tokens and returns a freshCookie with the NEW refresh token", async () => {
    setTikTokSecrets(true);
    let refreshBody: URLSearchParams | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(TOKEN_URL);
      refreshBody = init?.body as URLSearchParams;
      return jsonResponse({
        access_token: "at_new",
        refresh_token: "rt_new_single_use",
        expires_in: 86400,
        open_id: "open_1",
      });
    }) as typeof fetch;

    const tokens = {
      access_token: "at_old",
      refresh_token: "rt_old",
      expiry: Date.now() - 1000, // expired
    };
    const cookie = `tiktok_auth=${encodeURIComponent(JSON.stringify(tokens))}`;
    const result = await getValidTikTokToken(cookie);

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe("at_new");
    expect(result!.tokens.refresh_token).toBe("rt_new_single_use");
    expect(refreshBody!.get("grant_type")).toBe("refresh_token");
    expect(refreshBody!.get("refresh_token")).toBe("rt_old");
    expect(refreshBody!.get("client_key")).toBe("test_client_key");
    // freshCookie persists the ROTATED token
    expect(result!.freshCookie).toContain("tiktok_auth=");
    const persisted = parseTikTokTokens(
      `tiktok_auth=${decodeURIComponent(
        result!.freshCookie!.split("tiktok_auth=")[1].split(";")[0]
      )}`
    );
    expect(persisted!.refresh_token).toBe("rt_new_single_use");
  });

  test("getValidTikTokToken returns null when secrets are missing", async () => {
    setTikTokSecrets(false);
    const tokens = {
      access_token: "at_old",
      refresh_token: "rt_old",
      expiry: Date.now() - 1000,
    };
    const cookie = `tiktok_auth=${encodeURIComponent(JSON.stringify(tokens))}`;
    const result = await getValidTikTokToken(cookie);
    expect(result).toBeNull();
  });

  test("cookie helpers produce the expected header shape", () => {
    const c = createTikTokAuthCookie({
      access_token: "a",
      refresh_token: "r",
      expiry: 1,
    });
    expect(c).toContain("tiktok_auth=");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Max-Age=31536000");
    expect(clearTikTokAuthCookie()).toContain("Max-Age=0");
  });
});

describe("tiktok-handlers", () => {
  afterEach(() => {
    setTikTokSecrets(false);
    globalThis.fetch = fetch; // restore
  });

  test("initiate without secrets returns setup-pending JSON (no crash)", async () => {
    setTikTokSecrets(false);
    const resp = await handleTikTokAuthInitiate();
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { setupPending: boolean; error: string };
    expect(body.setupPending).toBe(true);
    expect(body.error).toContain("TIKTOK_CLIENT_KEY");
  });

  test("initiate with secrets redirects with the right OAuth params", async () => {
    setTikTokSecrets(true);
    const resp = await handleTikTokAuthInitiate();
    expect(resp.status).toBe(302);
    const location = resp.headers.get("Location")!;
    expect(location).toContain("https://www.tiktok.com/v2/auth/authorize/?");
    const url = new URL(location);
    expect(url.searchParams.get("client_key")).toBe("test_client_key");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("user.info.basic,video.publish");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://570ab42d07b3065f1977678d88b714aa.ctonew.app/api/auth/tiktok/callback"
    );
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
    const setCookie = resp.headers.get("Set-Cookie")!;
    expect(setCookie).toContain("tiktok_oauth_state=");
    expect(setCookie).toContain("Max-Age=600");
  });

  test("callback rejects a CSRF state mismatch", async () => {
    setTikTokSecrets(true);
    const req = new Request(
      "https://x/api/auth/tiktok/callback?code=abc&state=WRONG",
      { headers: { cookie: "tiktok_oauth_state=right" } }
    );
    const resp = await handleTikTokAuthCallback(req);
    const text = await resp.text();
    expect(text).toContain("Invalid State");
  });

  test("callback exchanges the code and 302s to /app?tiktok=connected", async () => {
    setTikTokSecrets(true);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(TOKEN_URL);
      const body = init?.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("auth_code_1");
      expect(body.get("client_key")).toBe("test_client_key");
      return jsonResponse({
        access_token: "at_cb",
        refresh_token: "rt_cb",
        expires_in: 86400,
        open_id: "open_cb",
      });
    }) as typeof fetch;

    const req = new Request(
      "https://x/api/auth/tiktok/callback?code=auth_code_1&state=state123",
      { headers: { cookie: "tiktok_oauth_state=state123" } }
    );
    const resp = await handleTikTokAuthCallback(req);
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("/app?tiktok=connected");
    const setCookies = resp.headers
      .get("Set-Cookie")!
      .split(/,(?=\s*tiktok_auth=)/) as string[];
    const authCookie = setCookies.find((c) => c.startsWith("tiktok_auth="));
    expect(authCookie).toBeDefined();
    expect(authCookie!).toContain("HttpOnly");
  });

  test("disconnect clears the cookie and redirects", async () => {
    const resp = await handleTikTokDisconnect();
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("/app?tiktok=disconnected");
    expect(resp.headers.get("Set-Cookie")).toContain("tiktok_auth=;");
  });

  test("channel info reports setupPending when secrets are missing", async () => {
    setTikTokSecrets(false);
    const resp = await handleTikTokChannelInfo(new Request("https://x/api/auth/tiktok/channel"));
    const body = (await resp.json()) as { connected: boolean; setupPending: boolean };
    expect(body.connected).toBe(false);
    expect(body.setupPending).toBe(true);
  });

  test("channel info returns connected:false without a cookie", async () => {
    setTikTokSecrets(true);
    const resp = await handleTikTokChannelInfo(new Request("https://x/api/auth/tiktok/channel"));
    const body = (await resp.json()) as { connected: boolean };
    expect(body.connected).toBe(false);
  });

  test("channel info fetches the user and returns {connected, user}", async () => {
    setTikTokSecrets(true);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input).startsWith(USER_URL)).toBe(true);
      expect(init?.headers).toBeDefined();
      const headers = new Headers(init!.headers as HeadersInit);
      expect(headers.get("authorization")).toBe("Bearer at_valid");
      return jsonResponse({
        data: {
          user: {
            open_id: "open_1",
            display_name: "Test Creator",
            avatar_url: "https://example.com/av.png",
          },
        },
      });
    }) as typeof fetch;

    const tokens = {
      access_token: "at_valid",
      refresh_token: "rt_valid",
      expiry: Date.now() + 3600_000,
    };
    const req = new Request("https://x/api/auth/tiktok/channel", {
      headers: {
        cookie: `tiktok_auth=${encodeURIComponent(JSON.stringify(tokens))}`,
      },
    });
    const resp = await handleTikTokChannelInfo(req);
    const body = (await resp.json()) as {
      connected: boolean;
      user?: { openId: string; displayName: string; avatarUrl: string };
    };
    expect(body.connected).toBe(true);
    expect(body.user!.displayName).toBe("Test Creator");
    expect(body.user!.avatarUrl).toBe("https://example.com/av.png");
  });
});
