/**
 * TikTok upload tests — chunk math + full flow with a stubbed fetch.
 * Run with: bun test tests/tiktok-upload.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  computeChunkPlan,
  buildContentRange,
  uploadToTikTokAPI,
  TIKTOK_CHUNK_SIZE,
} from "../src/lib/tiktok-upload";

const MIB = 1024 * 1024;

/* ── pure chunk-math ── */
describe("computeChunkPlan", () => {
  test("splits a file into ceil(size/chunk) chunks with inclusive ranges", () => {
    // 12 MiB file, 5 MiB chunks -> 3 chunks
    const plan = computeChunkPlan(12 * MIB, 5 * MIB);
    expect(plan.totalChunkCount).toBe(3);
    expect(plan.ranges).toEqual([
      { start: 0, end: 5 * MIB - 1 },
      { start: 5 * MIB, end: 10 * MIB - 1 },
      { start: 10 * MIB, end: 12 * MIB - 1 },
    ]);
  });

  test("exact multiple -> no remainder chunk", () => {
    const plan = computeChunkPlan(10, 5);
    expect(plan.totalChunkCount).toBe(2);
    expect(plan.ranges[1]).toEqual({ start: 5, end: 9 });
  });

  test("file smaller than chunk -> single chunk", () => {
    const plan = computeChunkPlan(20, 10_000);
    expect(plan.totalChunkCount).toBe(1);
    expect(plan.ranges[0]).toEqual({ start: 0, end: 19 });
  });

  test("empty file -> still one chunk (server requires >= 1)", () => {
    const plan = computeChunkPlan(0, 5);
    expect(plan.totalChunkCount).toBe(1);
  });

  test("default chunk size is 5 MiB and a multiple of 1024", () => {
    expect(TIKTOK_CHUNK_SIZE).toBe(5 * MIB);
    expect(TIKTOK_CHUNK_SIZE % 1024).toBe(0);
  });
});

describe("buildContentRange", () => {
  test("produces bytes a-b/total", () => {
    expect(buildContentRange(0, 5242879, 12582912)).toBe(
      "bytes 0-5242879/12582912"
    );
    expect(buildContentRange(10485760, 12582911, 12582912)).toBe(
      "bytes 10485760-12582911/12582912"
    );
  });
});

/* ── full flow with stubbed fetch ── */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("uploadToTikTokAPI (stubbed fetch)", () => {
  let realFetch: typeof fetch;
  let calls: { url: string; method: string; headers: Headers; body: unknown }[];
  let tmpFile: string;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    calls = [];
    tmpFile = `/tmp/tiktok-test-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    try {
      require("node:fs").rmSync(tmpFile, { force: true });
    } catch {
      /* ignore */
    }
  });

  /** Stub fetch with per-URL responder. */
  function stubFetch(respond: (url: string, init: RequestInit) => Response) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      let body: unknown = null;
      if (init?.body && typeof init.body === "string") body = JSON.parse(init.body);
      calls.push({ url, method, headers, body });
      return respond(url, init ?? {});
    }) as typeof fetch;
  }

  test("single-chunk upload: init body, Content-Range, status poll -> success", async () => {
    // 20-byte file; the server accepts our 5 MiB chunk size -> 1 chunk.
    await Bun.write(tmpFile, "x".repeat(20));

    let statusPolls = 0;
    stubFetch((url) => {
      if (url.includes("/post/publish/video/init/")) {
        return jsonResponse({
          data: {
            publish_id: "pub_123",
            upload_url: "https://upload.example.tiktok/vid",
            chunk_size: TIKTOK_CHUNK_SIZE,
          },
        });
      }
      if (url === "https://upload.example.tiktok/vid") {
        return new Response(null, { status: 206 });
      }
      if (url.includes("/post/publish/video/status/fetch/")) {
        statusPolls++;
        return statusPolls === 1
          ? jsonResponse({ data: { status: "PROCESSING_UPLOAD" } })
          : jsonResponse({ data: { status: "PUBLISH_COMPLETE" } });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const result = await uploadToTikTokAPI("tok_access", tmpFile, "My Title", "Desc #shorts", {
      pollIntervalMs: 0,
      maxPolls: 5,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.publishId).toBe("pub_123");

    // init call
    const initCall = calls.find((c) => c.url.includes("/init/"));
    expect(initCall).toBeDefined();
    expect(initCall!.method).toBe("POST");
    expect(initCall!.headers.get("authorization")).toBe("Bearer tok_access");
    expect(initCall!.headers.get("content-type")).toContain("application/json");
    const initBody = initCall!.body as {
      post_info: { title: string; privacy_level: string };
      source_info: {
        source: string;
        video_size: number;
        chunk_size: number;
        total_chunk_count: number;
      };
    };
    expect(initBody.post_info.title).toContain("My Title");
    expect(initBody.post_info.title).toContain("Desc #shorts");
    expect(initBody.post_info.privacy_level).toBe("SELF_ONLY");
    expect(initBody.source_info.source).toBe("FILE_UPLOAD");
    expect(initBody.source_info.video_size).toBe(20);
    expect(initBody.source_info.chunk_size).toBe(TIKTOK_CHUNK_SIZE);
    expect(initBody.source_info.total_chunk_count).toBe(1);

    // PUT chunk
    const putCall = calls.find((c) => c.method === "PUT");
    expect(putCall).toBeDefined();
    expect(putCall!.headers.get("Content-Range")).toBe("bytes 0-19/20");
    expect(putCall!.headers.get("Content-Length")).toBe("20");

    // status polls
    const pollCalls = calls.filter((c) => c.url.includes("/status/fetch/"));
    expect(pollCalls.length).toBe(2);
    expect((pollCalls[0].body as { publish_id: string }).publish_id).toBe("pub_123");
  });

  test("server-overridden chunk_size -> multi-chunk Content-Range offsets", async () => {
    // 20-byte file; server answers init with chunk_size 10 -> 2 chunks.
    await Bun.write(tmpFile, "x".repeat(20));

    stubFetch((url) => {
      if (url.includes("/init/")) {
        return jsonResponse({
          data: {
            publish_id: "pub_multi",
            upload_url: "https://upload.example.tiktok/vid",
            chunk_size: 10,
          },
        });
      }
      if (url === "https://upload.example.tiktok/vid") {
        return new Response(null, { status: 206 });
      }
      if (url.includes("/status/fetch/")) {
        return jsonResponse({ data: { status: "PUBLISH_COMPLETE" } });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const result = await uploadToTikTokAPI("tok_access", tmpFile, "T", "D", {
      pollIntervalMs: 0,
      maxPolls: 5,
    });
    expect(result.ok).toBe(true);

    const putCalls = calls.filter((c) => c.method === "PUT");
    expect(putCalls.length).toBe(2);
    expect(putCalls[0].headers.get("Content-Range")).toBe("bytes 0-9/20");
    expect(putCalls[1].headers.get("Content-Range")).toBe("bytes 10-19/20");
  });

  test("status FAILED surfaces the publish_error message", async () => {
    await Bun.write(tmpFile, "x".repeat(20));

    stubFetch((url) => {
      if (url.includes("/init/")) {
        return jsonResponse({
          data: {
            publish_id: "pub_fail",
            upload_url: "https://upload.example.tiktok/vid",
            chunk_size: TIKTOK_CHUNK_SIZE,
          },
        });
      }
      if (url === "https://upload.example.tiktok/vid") {
        return new Response(null, { status: 206 });
      }
      if (url.includes("/status/fetch/")) {
        return jsonResponse({
          data: {
            status: "FAILED",
            publish_error: { code: 20013, message: "Video is too long" },
          },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const result = await uploadToTikTokAPI("tok_access", tmpFile, "T", "D", {
      pollIntervalMs: 0,
      maxPolls: 5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Video is too long");
  });

  test("init rejection maps the TikTok error JSON", async () => {
    await Bun.write(tmpFile, "x".repeat(20));

    stubFetch(() => {
      return jsonResponse(
        { error: { code: 10001, message: "Access token invalid", log_id: "abc" } },
        401
      );
    });

    const result = await uploadToTikTokAPI("bad_token", tmpFile, "T", "D", {
      pollIntervalMs: 0,
      maxPolls: 5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("401");
      expect(result.error).toContain("Access token invalid");
    }
  });

  test("missing file -> clear error before any fetch", async () => {
    stubFetch(() => {
      throw new Error("fetch should not be called");
    });
    const result = await uploadToTikTokAPI("tok", "/tmp/does-not-exist-xyz.mp4", "T", "D");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not found");
    expect(calls.length).toBe(0);
  });

  test("sanitization: title strips emojis/control chars; description truncated to 1500", async () => {
    await Bun.write(tmpFile, "x".repeat(20));

    const longDesc = "word ".repeat(500); // 2500 chars
    stubFetch((url) => {
      if (url.includes("/init/")) {
        return jsonResponse({
          data: {
            publish_id: "pub_san",
            upload_url: "https://upload.example.tiktok/vid",
            chunk_size: TIKTOK_CHUNK_SIZE,
          },
        });
      }
      if (url === "https://upload.example.tiktok/vid") return new Response(null, { status: 206 });
      if (url.includes("/status/fetch/")) {
        return jsonResponse({ data: { status: "PUBLISH_COMPLETE" } });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    await uploadToTikTokAPI("tok", tmpFile, "🔥 Cool\nTitle\u0000", longDesc, {
      pollIntervalMs: 0,
      maxPolls: 5,
    });

    const initCall = calls.find((c) => c.url.includes("/init/"));
    const title = (initCall!.body as { post_info: { title: string } }).post_info.title;
    expect(title).not.toContain("🔥");
    expect(title).not.toContain("\u0000");
    // sanitizeTitle strips emojis + control chars (incl. \n) and collapses
    // whitespace, so "🔥 Cool\nTitle\u0000" -> "CoolTitle"
    expect(title).toContain("CoolTitle");
    // 100 (sanitized title) + 1 (newline) + 1500 (truncated description)
    expect(Array.from(title).length).toBeLessThanOrEqual(2200);
  });
});
