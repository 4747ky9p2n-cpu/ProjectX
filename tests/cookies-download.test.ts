/**
 * yt-dlp browser-cookies download fallback tests (YOUTUBE_COOKIES).
 *
 * Covers fallback ordering + error mapping for the cookies path
 * (Piped -> yt-dlp --cookies -> yt-dlp OAuth bearer -> Supadata):
 *   - When the YOUTUBE_COOKIES secret is set, the cookies-based yt-dlp attempt
 *     is tried BEFORE the OAuth-bearer attempt.
 *   - The cookies value is written to a transient, permission-protected file
 *     under /tmp/clipflow-cookies-*, referenced by path with --cookies, and
 *     removed in a finally block after the attempt.
 *   - The secret content never appears in argv or in any returned error.
 *   - Cookies failures map to distinct, machine-readable causes (bot-blocked /
 *     members-only) and, when bot-blocked, surface a refresh-the-secret message.
 *   - When the secret is unset the cookies path is skipped entirely.
 *
 * All network/process work is mocked (never hits the network): global fetch,
 * Bun.$, Bun.write, and Bun.file.
 *
 * NOTE on the Bun.$ mock: Bun.$ tag functions receive the literal template
 * segments as `strings` and only the INTERPOLATED values as `values`. So a
 * command like `Bun.$`chmod 600 ${path}`` yields raw="chmod 600" and argv=[path].
 * We capture both to distinguish chmod/rm no-ops from the yt-dlp download.
 *
 * Run with: bun test tests/cookies-download.test.ts
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  downloadSourceVideo,
  downloadViaYtDlpWithCookies,
  tryYtDlpCookies,
  youtubeCookiesSecret,
  composeFinalDownloadError,
} from "../src/lib/youtube-upload";

const origDollar = Bun.$;
const origFile = Bun.file;
const origWrite = Bun.write;
const origFetch = globalThis.fetch;
const origCookiesEnv = process.env.YOUTUBE_COOKIES;

const URL = "https://www.youtube.com/watch?v=gVE2t-LRK-s";
const COOKIE_CONTENT =
  "# Netscape HTTP Cookie File\n.google.com\tTRUE\t/\tTRUE\t1700000000\tSID\tTOPSECRETCOOKIEVAL\n.youtube.com\tTRUE\t/\tTRUE\t1700000000\tSID\tSSIDVAL\n";
const COOKIE =
  "youtube_auth=" +
    encodeURIComponent(
      JSON.stringify({
        access_token: "TEST_ACCESS",
        refresh_token: "rt",
        expiry: Date.now() + 3_600_000,
      })
    );

interface Call {
  argv: string[];
  raw: string;
}

/** Record every Bun.$ invocation and return controllable results per command. */
let calls: Call[] = [];
let written: { path: string; content: string }[] = [];
let cookiesResult: { exitCode: number; stderr: string } = {
  exitCode: 0,
  stderr: "",
};
let authResult: { exitCode: number; stderr: string } = { exitCode: 0, stderr: "" };

/** Build the result for a captured call based on which command it was. */
function resultFor(c: Call) {
  // chmod/rm/which are no-ops (the literal command lives in `raw`, not argv).
  if (c.raw.includes("chmod") || c.raw.includes("rm") || c.raw.includes("which")) {
    return { exitCode: 0, stderr: "" };
  }
  if (c.argv.includes("--cookies")) {
    return { exitCode: cookiesResult.exitCode, stderr: cookiesResult.stderr };
  }
  // authenticated yt-dlp (Authorization header) / anonymous fallback
  return { exitCode: authResult.exitCode, stderr: authResult.stderr };
}

// Bun.$ passes interpolated arrays as a single nested value; flatten to mirror
// the real argv Bun builds.
function captureImpl(strings: any, ...values: any[]) {
  const argv: string[] = values.flat(1).map(String);
  const rec: Call = { argv, raw: strings.join(" ") };
  calls.push(rec);
  const r = resultFor(rec);
  return {
    quiet: () => ({ nothrow: () => r }),
    nothrow: () => r,
  };
}
function makeCapture() {
  calls = [];
  written = [];
  // @ts-ignore
  Bun.$ = captureImpl as any;
  // @ts-ignore
  Bun.write = (async (path: string, content: any) => {
    written.push({ path, content: String(content) });
    return String(content).length;
  }) as any;
}

function makeBunFileMock(exists = true, size = 1_000_000) {
  // @ts-ignore
  Bun.file = () => ({ exists: () => Promise.resolve(exists), size }) as any;
}

/** fetch mock: Piped probes/streams fail; Supadata returns a 429 limit. */
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

function cookiesDownloadCalls(): Call[] {
  return calls.filter((c) => c.argv.includes("--cookies"));
}

function cookiesPathsUsed(): string[] {
  return cookiesDownloadCalls().map((c) => {
    const i = c.argv.indexOf("--cookies");
    return c.argv[i + 1] ?? "";
  });
}

afterEach(() => {
  Bun.$ = origDollar;
  Bun.file = origFile;
  // @ts-ignore
  Bun.write = origWrite;
  globalThis.fetch = origFetch;
  if (origCookiesEnv === undefined) delete process.env.YOUTUBE_COOKIES;
  else process.env.YOUTUBE_COOKIES = origCookiesEnv;
});

describe("youtubeCookiesSecret", () => {
  test("returns null when the secret is unset", () => {
    delete process.env.YOUTUBE_COOKIES;
    expect(youtubeCookiesSecret()).toBeNull();
  });

  test("returns the value when set", () => {
    process.env.YOUTUBE_COOKIES = COOKIE_CONTENT;
    expect(youtubeCookiesSecret()).toBe(COOKIE_CONTENT);
  });

  test("returns null when set to whitespace", () => {
    process.env.YOUTUBE_COOKIES = "   \n  ";
    expect(youtubeCookiesSecret()).toBeNull();
  });
});

describe("tryYtDlpCookies", () => {
  test("secret unset -> skipped (tried:false), yt-dlp never invoked", async () => {
    delete process.env.YOUTUBE_COOKIES;
    makeCapture();
    makeBunFileMock();
    const r = await tryYtDlpCookies(URL, "/tmp/x.mp4");
    expect(r.tried).toBe(false);
    expect(cookiesDownloadCalls().length).toBe(0);
    expect(written.length).toBe(0);
  });

  test("secret set + success -> tried:true, ok, transient file written then removed, path used via --cookies", async () => {
    process.env.YOUTUBE_COOKIES = COOKIE_CONTENT;
    cookiesResult = { exitCode: 0, stderr: "" };
    makeCapture();
    makeBunFileMock(true, 2_000_000);
    const r = await tryYtDlpCookies(URL, "/tmp/x.mp4");
    expect(r.tried).toBe(true);
    expect(r.ok).toBe(true);

    // The transient cookies file was written with the secret content, under the
    // /tmp/clipflow-cookies-* prefix.
    expect(written.length).toBe(1);
    expect(written[0]!.path).toMatch(/^\/tmp\/clipflow-cookies-/);
    expect(written[0]!.content).toBe(COOKIE_CONTENT);

    const paths = cookiesPathsUsed();
    expect(paths.length).toBe(1);
    const ckPath = paths[0]!;
    expect(ckPath).toBe(written[0]!.path);

    // Permission-protected (chmod 600)…
    expect(calls.some((c) => c.raw.includes("chmod") && c.raw.includes("600"))).toBe(true);
    // …and cleaned up in a finally block via rm -f <path>.
    expect(
      calls.some((c) => c.raw.includes("rm") && c.argv.includes(ckPath))
    ).toBe(true);

    // The cookie SECRET never appears in any argv (only the path does).
    for (const c of calls) {
      for (const arg of c.argv) {
        expect(arg).not.toContain("TOPSECRETCOOKIEVAL");
      }
    }
  });

  test("secret set + bot-blocked -> cause bot-blocked + refresh-secret message, file still cleaned up", async () => {
    process.env.YOUTUBE_COOKIES = COOKIE_CONTENT;
    cookiesResult = { exitCode: 1, stderr: "Sign in to confirm you're not a bot" };
    makeCapture();
    makeBunFileMock();
    const r = await tryYtDlpCookies(URL, "/tmp/x.mp4");
    expect(r.tried).toBe(true);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.cause).toBe("bot-blocked");
      expect(r.error).toMatch(/refresh/i);
      expect(r.error).not.toContain("TOPSECRETCOOKIEVAL");
    }
    expect(cookiesPathsUsed().length).toBe(1);
    const ckPath = cookiesPathsUsed()[0]!;
    expect(
      calls.some((c) => c.raw.includes("rm") && c.argv.includes(ckPath))
    ).toBe(true);
  });

  test("secret set + members-only -> cause members-only", async () => {
    process.env.YOUTUBE_COOKIES = COOKIE_CONTENT;
    cookiesResult = { exitCode: 1, stderr: "This video is members-only" };
    makeCapture();
    makeBunFileMock();
    const r = await tryYtDlpCookies(URL, "/tmp/x.mp4");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.cause).toBe("members-only");
      expect(r.error).toMatch(/members-only/i);
    }
  });
});

describe("downloadViaYtDlpWithCookies", () => {
  test("success -> --cookies path and --quiet passed, ok", async () => {
    cookiesResult = { exitCode: 0, stderr: "" };
    makeCapture();
    makeBunFileMock(true, 2_000_000);
    const r = await downloadViaYtDlpWithCookies(
      URL,
      "/tmp/x.mp4",
      "/tmp/clipflow-cookies-abc"
    );
    expect(r.ok).toBe(true);
    const dl = cookiesDownloadCalls()[0]!;
    expect(dl.argv).toContain("--cookies");
    expect(dl.argv).toContain("/tmp/clipflow-cookies-abc");
    expect(dl.argv).toContain("--quiet");
    expect(dl.raw).toMatch(/yt-dlp/);
  });

  test("secret content never leaks into argv or the returned error", async () => {
    cookiesResult = { exitCode: 1, stderr: "Sign in to confirm you're not a bot" };
    makeCapture();
    makeBunFileMock();
    const r = await downloadViaYtDlpWithCookies(
      URL,
      "/tmp/x.mp4",
      "/tmp/clipflow-cookies-abc"
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain("TOPSECRETCOOKIEVAL");
    for (const c of calls) {
      for (const arg of c.argv) {
        expect(arg).not.toContain("TOPSECRETCOOKIEVAL");
      }
    }
  });

  test("generic non-zero exit -> honest non-cookie-blocked message (no 'refresh' claim)", async () => {
    cookiesResult = { exitCode: 1, stderr: "unrelated error" };
    makeCapture();
    makeBunFileMock();
    const r = await downloadViaYtDlpWithCookies(URL, "/tmp/x.mp4", "/tmp/c-abc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/browser cookies/);
  });
});

describe("downloadSourceVideo fallback ordering (cookies first)", () => {
  test("secret set + cookies succeed -> returns ok WITHOUT contacting Supadata or OAuth", async () => {
    process.env.YOUTUBE_COOKIES = COOKIE_CONTENT;
    cookiesResult = { exitCode: 0, stderr: "" };
    authResult = { exitCode: 0, stderr: "" };
    makeCapture();
    makeBunFileMock(true, 2_000_000);
    installFetchMock();
    const r = await downloadSourceVideo(URL, "/tmp/x.mp4", COOKIE);
    expect(r.ok).toBe(true);
    // Cookies path was attempted; the OAuth path (--add-header) must NOT run.
    expect(cookiesDownloadCalls().length).toBeGreaterThan(0);
    expect(calls.some((c) => c.argv.includes("--add-header"))).toBe(false);
  });

  test("cookies attempted BEFORE OAuth when both are available and cookies fails", async () => {
    process.env.YOUTUBE_COOKIES = COOKIE_CONTENT;
    cookiesResult = { exitCode: 1, stderr: "Sign in to confirm you're not a bot" };
    authResult = { exitCode: 0, stderr: "" }; // OAuth would succeed
    makeCapture();
    makeBunFileMock(true, 2_000_000);
    installFetchMock();
    const r = await downloadSourceVideo(URL, "/tmp/x.mp4", COOKIE);
    // Cookies failed, OAuth succeeded -> overall ok.
    expect(r.ok).toBe(true);
    const dlCalls = calls.filter((c) => c.raw.includes("yt-dlp"));
    const cookiesIdx = dlCalls.findIndex((c) => c.argv.includes("--cookies"));
    const oauthIdx = dlCalls.findIndex((c) => c.argv.includes("--add-header"));
    expect(cookiesIdx).toBeGreaterThanOrEqual(0);
    expect(oauthIdx).toBeGreaterThan(cookiesIdx);
  });

  test("secret unset -> cookies path skipped, OAuth path still used", async () => {
    delete process.env.YOUTUBE_COOKIES;
    authResult = { exitCode: 0, stderr: "" };
    makeCapture();
    makeBunFileMock(true, 2_000_000);
    installFetchMock();
    const r = await downloadSourceVideo(URL, "/tmp/x.mp4", COOKIE);
    expect(r.ok).toBe(true);
    expect(cookiesDownloadCalls().length).toBe(0);
    expect(calls.some((c) => c.argv.includes("--add-header"))).toBe(true);
  });
});

describe("aggregated error surface (cookies bot-blocked)", () => {
  test("cookies bot-blocked + OAuth bot-blocked + Supadata limit -> refresh-secret message", async () => {
    process.env.YOUTUBE_COOKIES = COOKIE_CONTENT;
    cookiesResult = { exitCode: 1, stderr: "Sign in to confirm you're not a bot" };
    authResult = { exitCode: 1, stderr: "Sign in to confirm you're not a bot" };
    makeCapture();
    makeBunFileMock();
    installFetchMock(); // Supadata returns 429 limit-exceeded
    const r = await downloadSourceVideo(URL, "/tmp/x.mp4", COOKIE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // The owner must see the actionable refresh-the-cookies fix.
      expect(r.error).toMatch(/YOUTUBE_COOKIES/i);
      expect(r.error).toMatch(/refresh/i);
      expect(r.error).toMatch(/SID/i);
    }
  });

  test("composeFinalDownloadError: botBlockedWithCookies -> refresh-cookies fix", () => {
    const msg = composeFinalDownloadError(
      "Video download failed (Supadata API 429)",
      true,
      true
    );
    expect(msg).toMatch(/YOUTUBE_COOKIES/i);
    expect(msg).toMatch(/refresh/i);
    expect(msg).toMatch(/SID, SSID and HSID/i);
  });

  test("composeFinalDownloadError: not blocked -> passed through unchanged", () => {
    const msg = composeFinalDownloadError(
      "Video download failed (Supadata API 404): Not Found",
      false,
      false
    );
    expect(msg).toBe("Video download failed (Supadata API 404): Not Found");
  });
});
