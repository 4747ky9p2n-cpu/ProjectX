/**
 * Upload handler tests — 202 background contract:
 *   - invalid bodies stay synchronous (400s, 500 for an invalid destination),
 *   - missing auth returns synchronous 401 NO_AUTH (or TIKTOK_FAILED when the
 *     TikTok app secrets are absent),
 *   - a valid body + valid auth returns HTTP 202 `{ success: true,
 *     background: true, accepted: true, destination }` and STARTS the
 *     pipeline without awaiting it.
 * Run with: bun test tests/upload-handler.test.ts
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { handleUploadClip } from "../src/lib/upload-handler";

const BASE = {
  videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  startTime: 10,
  endTime: 40,
  title: "Viral moment",
  description: "Best part #shorts #viral",
};

type MockOutcome = { success: boolean; videoId: string; videoUrl: string };

/** The pipeline is stubbed so tests never touch the network/ffmpeg. */
const uploadClipMock = mock(async (): Promise<MockOutcome> => ({
  success: true,
  videoId: "mocked123",
  videoUrl: "https://youtube.com/shorts/mocked123",
}));

mock.module("../src/lib/youtube-upload", () => ({
  uploadClip: uploadClipMock,
}));

/** A valid (non-expired) youtube_auth cookie header. */
function youtubeCookie(overrides: Record<string, unknown> = {}): string {
  const tokens = {
    access_token: "at",
    refresh_token: "rt",
    expiry: Date.now() + 3_600_000,
    ...overrides,
  };
  return `youtube_auth=${encodeURIComponent(JSON.stringify(tokens))}`;
}

/** A valid (non-expired) tiktok_auth cookie header. */
function tiktokCookie(overrides: Record<string, unknown> = {}): string {
  const tokens = {
    access_token: "tat",
    refresh_token: "trt",
    expiry: Date.now() + 3_600_000,
    ...overrides,
  };
  return `tiktok_auth=${encodeURIComponent(JSON.stringify(tokens))}`;
}

async function post(
  body: Record<string, unknown>,
  cookie?: string
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return handleUploadClip(
    new Request("https://x/api/upload/clip", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
  );
}

describe("handleUploadClip 202 background contract", () => {
  afterEach(() => {
    delete process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_SECRET;
    uploadClipMock.mockClear();
    uploadClipMock.mockImplementation(async (): Promise<MockOutcome> => ({
      success: true,
      videoId: "mocked123",
      videoUrl: "https://youtube.com/shorts/mocked123",
    }));
  });

  /* ── synchronous validation (unchanged contract) ── */

  test("missing required fields still 400s", async () => {
    const resp = await post({ startTime: 1, endTime: 2 });
    expect(resp.status).toBe(400);
    expect(uploadClipMock).not.toHaveBeenCalled();
  });

  test("startTime >= endTime still 400s", async () => {
    const resp = await post({ ...BASE, startTime: 50, endTime: 10 });
    expect(resp.status).toBe(400);
    expect(uploadClipMock).not.toHaveBeenCalled();
  });

  test("invalid destination -> API_ERROR (no crash, pipeline never started)", async () => {
    const resp = await post(
      { ...BASE, destination: "twitch" as unknown as string },
      youtubeCookie()
    );
    expect(resp.status).toBe(500);
    const body = (await resp.json()) as { success: boolean; code: string; error: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe("API_ERROR");
    expect(body.error).toContain("Invalid destination");
    expect(uploadClipMock).not.toHaveBeenCalled();
  });

  /* ── synchronous auth failures (mirror uploadClip's early exits) ── */

  test("no destination defaults to youtube -> NO_AUTH (backward compatible)", async () => {
    const resp = await post({ ...BASE });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { code: string };
    expect(body.code).toBe("NO_AUTH");
    expect(uploadClipMock).not.toHaveBeenCalled();
  });

  test("destination youtube with no auth -> NO_AUTH (401), pipeline never started", async () => {
    const resp = await post({ ...BASE, destination: "youtube" });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as {
      success: boolean;
      code: string;
      error: string;
    };
    expect(body.success).toBe(false);
    expect(body.code).toBe("NO_AUTH");
    expect(body.error).toContain("YouTube");
    expect(uploadClipMock).not.toHaveBeenCalled();
  });

  test("corrupted youtube_auth cookie -> NO_AUTH (401)", async () => {
    const resp = await post({ ...BASE }, "youtube_auth=not-json");
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { code: string };
    expect(body.code).toBe("NO_AUTH");
    expect(uploadClipMock).not.toHaveBeenCalled();
  });

  test("destination tiktok with no secrets -> TIKTOK_FAILED (500), pipeline never started", async () => {
    delete process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_SECRET;
    const resp = await post({ ...BASE, destination: "tiktok" });
    expect(resp.status).toBe(500);
    const body = (await resp.json()) as {
      success: boolean;
      code: string;
      error: string;
    };
    expect(body.success).toBe(false);
    expect(body.code).toBe("TIKTOK_FAILED");
    expect(body.error).toContain("TIKTOK_CLIENT_KEY");
    expect(body.error).toContain("TIKTOK_CLIENT_SECRET");
    expect(uploadClipMock).not.toHaveBeenCalled();
  });

  test("destination tiktok with secrets but no token -> NO_AUTH (401)", async () => {
    process.env.TIKTOK_CLIENT_KEY = "tk";
    process.env.TIKTOK_CLIENT_SECRET = "ts";
    const resp = await post({ ...BASE, destination: "tiktok" });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { code: string; error: string };
    expect(body.code).toBe("NO_AUTH");
    expect(body.error).toContain("TikTok");
    expect(uploadClipMock).not.toHaveBeenCalled();
  });

  test("destination both with no secrets and no youtube auth -> NO_AUTH (401)", async () => {
    delete process.env.TIKTOK_CLIENT_KEY;
    const resp = await post({ ...BASE, destination: "both" });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe("NO_AUTH");
    expect(uploadClipMock).not.toHaveBeenCalled();
  });

  /* ── 202 background acceptance ── */

  test("valid body + valid youtube auth -> 202 background, pipeline started not awaited", async () => {
    uploadClipMock.mockClear();
    let resolvePipeline!: (value: MockOutcome) => void;
    // A promise that stays pending until we resolve it: if the handler
    // AWAITED the pipeline, the request would never return and this test
    // would time out. Returning 202 while it is still pending proves the
    // pipeline runs fire-and-forget.
    uploadClipMock.mockImplementation(
      async (): Promise<MockOutcome> =>
        new Promise<MockOutcome>((res) => {
          resolvePipeline = res;
        })
    );

    const resp = await post(
      { ...BASE, destination: "youtube" },
      youtubeCookie()
    );
    expect(resp.status).toBe(202);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      success: true,
      background: true,
      accepted: true,
      destination: "youtube",
    });
    expect(uploadClipMock).toHaveBeenCalledTimes(1);
    // Resolve the background job so nothing dangles.
    resolvePipeline({ success: true, videoId: "x", videoUrl: "y" });
  });

  test("destination both with valid youtube auth + missing tiktok secrets -> 202 background (tiktok skipped in background)", async () => {
    delete process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_SECRET;
    const resp = await post(
      { ...BASE, destination: "both" },
      youtubeCookie()
    );
    expect(resp.status).toBe(202);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      success: true,
      background: true,
      accepted: true,
      destination: "both",
    });
    expect(uploadClipMock).toHaveBeenCalledTimes(1);
  });

  test("destination tiktok with secrets + valid tiktok token -> 202 background", async () => {
    process.env.TIKTOK_CLIENT_KEY = "tk";
    process.env.TIKTOK_CLIENT_SECRET = "ts";
    const resp = await post(
      { ...BASE, destination: "tiktok" },
      tiktokCookie()
    );
    expect(resp.status).toBe(202);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      success: true,
      background: true,
      accepted: true,
      destination: "tiktok",
    });
    expect(uploadClipMock).toHaveBeenCalledTimes(1);
  });
});
