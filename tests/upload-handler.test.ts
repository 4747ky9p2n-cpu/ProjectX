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
import {
  enqueueUpload,
  isQueueIdle,
  resetUploadQueue,
} from "../src/lib/upload-queue";

/** A controllable deferred promise with explicit resolve/reject. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Poll until the process-wide upload queue is idle (or fail on timeout). */
async function waitForQueueIdle(timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!isQueueIdle()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("upload queue did not become idle in time");
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}

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
    resetUploadQueue();
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
    await waitForQueueIdle();
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

describe("upload queue serialisation (process-wide, concurrency 1)", () => {
  afterEach(() => {
    delete process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_SECRET;
    uploadClipMock.mockClear();
    uploadClipMock.mockImplementation(async (): Promise<MockOutcome> => ({
      success: true,
      videoId: "mocked123",
      videoUrl: "https://youtube.com/shorts/mocked123",
    }));
    resetUploadQueue();
  });

  test("two concurrent valid-auth uploads both return 202 immediately (queue never blocks the response)", async () => {
    const first = deferred<MockOutcome>();
    uploadClipMock.mockClear();
    uploadClipMock.mockImplementation(() => first.promise);

    const resp1 = await post(
      { ...BASE, destination: "youtube" },
      youtubeCookie()
    );
    const resp2 = await post(
      { ...BASE, destination: "youtube" },
      youtubeCookie()
    );

    // Both respond 202 even though the first pipeline is still running and the
    // second is waiting in the queue.
    expect(resp1.status).toBe(202);
    expect(resp2.status).toBe(202);
    const body1 = (await resp1.json()) as Record<string, unknown>;
    const body2 = (await resp2.json()) as Record<string, unknown>;
    expect(body1.accepted).toBe(true);
    expect(body2.accepted).toBe(true);

    first.resolve({ success: true, videoId: "x", videoUrl: "y" });
    await waitForQueueIdle();
  });

  test("pipeline runs serially — the second uploadClip call does not start until the first resolves", async () => {
    const first = deferred<MockOutcome>();
    const second = deferred<MockOutcome>();
    uploadClipMock.mockClear();
    let call = 0;
    uploadClipMock.mockImplementation(() => {
      call += 1;
      return call === 1 ? first.promise : second.promise;
    });

    await post({ ...BASE, destination: "youtube" }, youtubeCookie());
    await post({ ...BASE, destination: "youtube" }, youtubeCookie());

    // Only the first pipeline has started; the second is still queued.
    await waitForQueueIdleTimeout(50).catch(() => {});
    expect(uploadClipMock).toHaveBeenCalledTimes(1);

    // Resolve the first — only then does the second start.
    first.resolve({ success: true, videoId: "1", videoUrl: "y1" });
    await waitFor(() => uploadClipMock.mock.calls.length >= 2, "second start");

    second.resolve({ success: true, videoId: "2", videoUrl: "y2" });
    await waitForQueueIdle();
  });

  test("a rejected first job is logged and does not prevent the queued second job from running", async () => {
    uploadClipMock.mockClear();
    let call = 0;
    uploadClipMock.mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new Error("boom");
      return { success: true, videoId: "ok", videoUrl: "y" };
    });

    const resp1 = await post(
      { ...BASE, destination: "youtube" },
      youtubeCookie()
    );
    const resp2 = await post(
      { ...BASE, destination: "youtube" },
      youtubeCookie()
    );
    expect(resp1.status).toBe(202);
    expect(resp2.status).toBe(202);

    // Both jobs eventually run despite the first rejecting.
    await waitForQueueIdle();
    expect(call).toBe(2);
    expect(uploadClipMock).toHaveBeenCalledTimes(2);
  });

  test("a single job still behaves as before (fires once and completes)", async () => {
    const d = deferred<MockOutcome>();
    uploadClipMock.mockClear();
    uploadClipMock.mockImplementation(() => d.promise);

    const resp = await post(
      { ...BASE, destination: "youtube" },
      youtubeCookie()
    );
    expect(resp.status).toBe(202);
    expect(uploadClipMock).toHaveBeenCalledTimes(1);

    d.resolve({ success: true, videoId: "solo", videoUrl: "y" });
    await waitForQueueIdle();
    expect(uploadClipMock).toHaveBeenCalledTimes(1);
  });

  test("queue is resilient: a task that throws is skipped and the next queued task still runs", async () => {
    resetUploadQueue();
    const order: string[] = [];
    enqueueUpload(async () => {
      order.push("first-started");
      throw new Error("first task exploded");
    });
    enqueueUpload(async () => {
      order.push("second-started");
    });

    await waitForQueueIdle();
    expect(order).toEqual(["first-started", "second-started"]);
    expect(isQueueIdle()).toBe(true);
  });
});

/** Await `pred` becoming truthy (poll) or fail after a timeout. */
async function waitFor(
  pred: () => boolean,
  label: string,
  timeoutMs = 2000
): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Like waitForQueueIdle but bounded by plain elapsed time (used with catch). */
async function waitForQueueIdleTimeout(timeoutMs = 50): Promise<void> {
  const start = Date.now();
  while (!isQueueIdle()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}
