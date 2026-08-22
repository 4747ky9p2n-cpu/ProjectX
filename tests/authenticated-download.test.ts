/**
 * Authenticated yt-dlp download fallback tests.
 *
 * Covers fallback ordering + error mapping for the authenticated download
 * path (Piped -> authenticated yt-dlp with the owner's OAuth -> Supadata):
 *   - When a valid YouTube OAuth token exists and Piped fails, the source
 *     video is retried via yt-dlp with an Authorization: Bearer header, BEFORE
 *     any Supadata call is made.
 *   - When no token exists, the authenticated path is skipped (tried:false)
 *     and download falls through to Supadata.
 *   - Authenticated failures map to distinct, honest messages (age-restricted
 *     / members-only vs generic auth failure); anonymous yt-dlp failure keeps
 *     its bot-block message.
 *
 * All network/process work is mocked (never hits the network): global fetch,
 * Bun.$, Bun.file, and getValidAccessToken.
 *
 * Run with: bun test tests/authenticated-download.test.ts
 */
import { describe, test, expect, mock, afterEach } from "bun:test";
import {
  downloadSourceVideo,
  downloadViaYtDlpFallback,
  tryYtDlpAuthenticated,
  composeFinalDownloadError,
} from "../src/lib/youtube-upload";

const origDollar = Bun.$;
const origFile = Bun.file;
const origFetch = globalThis.fetch;

const URL = "https://www.youtube.com/watch?v=gVE2t-LRK-s";
const COOKIE =
  "youtube_auth=" +
    encodeURIComponent(
      JSON.stringify({
        access_token: "at",
        refresh_token: "rt",
        expiry: Date.now() + 3_600_000,
      })
    );

/** Mocked getValidAccessToken; implementation toggled per test. */
const getValidAccessTokenMock = mock(
  async (_cookie: string | null): Promise<{ accessToken: string } | null> => null
);
mock.module("../src/lib/youtube-auth", () => ({
  getValidAccessToken: getValidAccessTokenMock,
}));

/** Record yt-dlp invocations and return a controllable result. */
let ytdlpCalls: { header: string | null; separate: boolean }[] = [];
let ytdlpResult: { exitCode: number; stderr: string };

// The template args arrive as the 2nd..nth params of the tag function. We
// re-wrap Bun.$ to capture the interpolated args (to read the bearer token
// and assert --add-header lands as its OWN argv element) and return a
// `.nothrow()` chain like the real Bun.$ shell object.
function captureImpl(_strings: any, ...values: any[]) {
  // Bun.$ passes a nested array (headerArgs) as a single interpolated value,
  // then flattens it into real argv elements. Flatten to mirror real argv.
  const argv: string[] = values.flat(1).map(String);
  const idx = argv.indexOf("--add-header");
  let header: string | null = null;
  let separate = false;
  if (idx >= 0) {
    separate = true; // --add-header arrived as its own argv element
    const value = argv[idx + 1] ?? "";
    header = value.replace(/^Authorization: Bearer /, "") || null;
  }
  ytdlpCalls.push({ header, separate });
  const result = { exitCode: ytdlpResult.exitCode, stderr: ytdlpResult.stderr };
  // The downloader chains `.quiet().nothrow()`; `.quiet()` must pass through
  // while still capturing stderr on the result for error mapping.
  return {
    quiet: () => ({ nothrow: () => result }),
    nothrow: () => result,
  };
}
function makeYtDlpCapture() {
  ytdlpCalls = [];
  // @ts-ignore
  Bun.$ = captureImpl as any;
}

function makeBunFileMock(exists = true, size = 1_000_000) {
  // @ts-ignore
  Bun.file = () => ({ exists: () => Promise.resolve(exists), size }) as any;
}

/** fetch mock: registry/healthcheck probes fail; Supadata returns a 429 limit. */
function installFetchMock() {
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : String((input as Request).url);
    if (url.includes("api.supadata.ai")) {
      return new Response(JSON.stringify({ error: "limit-exceeded" }), {
        status: 429,
      });
    }
    throw new Error("network down (mock)");
  }) as any;
}

afterEach(() => {
  Bun.$ = origDollar;
  Bun.file = origFile;
  globalThis.fetch = origFetch;
  getValidAccessTokenMock.mockImplementation(async () => null);
});

describe("downloadViaYtDlpFallback error mapping", () => {
  test("authenticated: 'Sign in to confirm' -> age-restricted message", async () => {
    ytdlpResult = { exitCode: 1, stderr: "Sign in to confirm you're not a bot" };
    makeYtDlpCapture();
    makeBunFileMock();
    const r = await downloadViaYtDlpFallback(URL, "/tmp/x.mp4", "REAL_TOKEN");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/age-restricted/i);
    expect(ytdlpCalls[0]!.header).toBe("REAL_TOKEN");
    // --add-header must be passed as its own argv element, NOT inlined into a
    // single quoted string (that made yt-dlp say "no such option").
    expect(ytdlpCalls[0]!.separate).toBe(true);
  });

  test("authenticated: 'members-only' -> members/private message", async () => {
    ytdlpResult = { exitCode: 1, stderr: "This video is members-only" };
    makeYtDlpCapture();
    makeBunFileMock();
    const r = await downloadViaYtDlpFallback(URL, "/tmp/x.mp4", "REAL_TOKEN");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/members-only/i);
  });

  test("authenticated: other failure -> generic auth-failure message", async () => {
    ytdlpResult = { exitCode: 1, stderr: "some other error" };
    makeYtDlpCapture();
    makeBunFileMock();
    const r = await downloadViaYtDlpFallback(URL, "/tmp/x.mp4", "REAL_TOKEN");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Authenticated download failed/i);
  });

  test("anonymous (no token): keeps the bot-block message", async () => {
    ytdlpResult = { exitCode: 1, stderr: "Sign in to confirm you're not a bot" };
    makeYtDlpCapture();
    makeBunFileMock();
    const r = await downloadViaYtDlpFallback(URL, "/tmp/x.mp4", null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/bot detection/i);
    expect(ytdlpCalls[0]!.header).toBeNull();
  });

  test("success: exit 0 + valid file -> ok", async () => {
    ytdlpResult = { exitCode: 0, stderr: "" };
    makeYtDlpCapture();
    makeBunFileMock(true, 2_000_000);
    const r = await downloadViaYtDlpFallback(URL, "/tmp/x.mp4", "REAL_TOKEN");
    expect(r.ok).toBe(true);
    expect(ytdlpCalls[0]!.header).toBe("REAL_TOKEN");
  });
});

describe("tryYtDlpAuthenticated", () => {
  test("with a token in the cookie -> threads it into yt-dlp, tried:true", async () => {
    getValidAccessTokenMock.mockImplementation(async () => ({
      accessToken: "TEST_ACCESS",
    }));
    ytdlpResult = { exitCode: 0, stderr: "" };
    makeYtDlpCapture();
    makeBunFileMock(true, 1_000_000);
    const r = await tryYtDlpAuthenticated(URL, "/tmp/x.mp4", COOKIE);
    expect(r.tried).toBe(true);
    expect(r.ok).toBe(true);
    expect(ytdlpCalls[0]!.header).toBe("TEST_ACCESS");
  });

  test("no token in the cookie -> skipped (tried:false), yt-dlp never invoked", async () => {
    getValidAccessTokenMock.mockImplementation(async () => null);
    makeYtDlpCapture();
    makeBunFileMock();
    const r = await tryYtDlpAuthenticated(URL, "/tmp/x.mp4", null);
    expect(r.tried).toBe(false);
    expect(ytdlpCalls.length).toBe(0);
  });
});

describe("downloadSourceVideo fallback ordering", () => {
  test("Piped fails + token present -> authenticated yt-dlp succeeds BEFORE Supadata", async () => {
    // If ordering were wrong (Supadata before authenticated), the 429 limit
    // error would short-circuit and we'd get a failure. Getting ok:true proves
    // the authenticated path ran first and won.
    getValidAccessTokenMock.mockImplementation(async () => ({
      accessToken: "TEST_ACCESS",
    }));
    ytdlpResult = { exitCode: 0, stderr: "" };
    makeYtDlpCapture();
    makeBunFileMock(true, 1_000_000);
    installFetchMock();
    const r = await downloadSourceVideo(URL, "/tmp/x.mp4", COOKIE);
    expect(r.ok).toBe(true);
    expect(ytdlpCalls.length).toBeGreaterThan(0);
    expect(ytdlpCalls[0]!.header).toBe("TEST_ACCESS");
  });

  test("Piped fails + no token -> authenticated skipped, falls through to Supadata (limit error)", async () => {
    getValidAccessTokenMock.mockImplementation(async () => null);
    makeYtDlpCapture();
    makeBunFileMock();
    installFetchMock();
    const r = await downloadSourceVideo(URL, "/tmp/x.mp4", null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/limit/i);
    expect(ytdlpCalls.length).toBe(0);
  });
});

describe("secret hygiene (authenticated download)", () => {
  test("the owner's OAuth token never leaks into any returned error", async () => {
    // Even on total failure, no error string returned to the caller may contain
    // the bearer token (it must not surface in logs or client-visible output).
    ytdlpResult = { exitCode: 1, stderr: "Sign in to confirm you're not a bot" };
    makeYtDlpCapture();
    makeBunFileMock();
    const r = await downloadViaYtDlpFallback(URL, "/tmp/x.mp4", "REAL_TOKEN_123");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain("REAL_TOKEN_123");
      expect(r.error).not.toContain("Bearer");
    }
  });
});

describe("composeFinalDownloadError (bot-blocked-with-auth surface)", () => {
  test("bot-blocked-with-auth -> crystal-clear fix (browser cookies)", () => {
    const msg = composeFinalDownloadError(
      "Video download failed (Supadata API 404): Not Found",
      true
    );
    expect(msg).toMatch(/browser cookies/i);
    expect(msg).toMatch(/--cookies/i);
    expect(msg).toMatch(/connected YouTube account/i);
  });

  test("not bot-blocked -> underlying message passed through unchanged", () => {
    const msg = composeFinalDownloadError("Video download failed (Supadata API 404): Not Found", false);
    expect(msg).toBe("Video download failed (Supadata API 404): Not Found");
  });
});

describe("downloadSourceVideo aggregated error surface", () => {
  test("Piped fails + authenticated yt-dlp bot-blocked + Supadata limit -> cookies fix surfaced (not a raw Supadata 404)", async () => {
    getValidAccessTokenMock.mockImplementation(async () => ({
      accessToken: "TEST_ACCESS",
    }));
    ytdlpResult = {
      exitCode: 1,
      stderr: "Sign in to confirm you're not a bot",
    };
    makeYtDlpCapture();
    makeBunFileMock();
    installFetchMock(); // Supadata returns 429 limit-exceeded
    const r = await downloadSourceVideo(URL, "/tmp/x.mp4", COOKIE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // The owner must see the actionable fix, not a bare "Supadata API 404".
      expect(r.error).toMatch(/browser cookies/i);
      expect(r.error).toMatch(/--cookies/i);
    }
  });
});
