/**
 * Upload handler tests — destination passthrough and graceful degradation
 * when TikTok secrets are missing.
 * Run with: bun test tests/upload-handler.test.ts
 */
import { describe, test, expect, afterEach } from "bun:test";
import { handleUploadClip } from "../src/lib/upload-handler";

const BASE = {
  videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  startTime: 10,
  endTime: 40,
  title: "Viral moment",
  description: "Best part #shorts #viral",
};

async function post(body: Record<string, unknown>): Promise<Response> {
  return handleUploadClip(
    new Request("https://x/api/upload/clip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("handleUploadClip destination handling", () => {
  afterEach(() => {
    delete process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_SECRET;
  });

  test("destination tiktok with no secrets -> clear TIKTOK_FAILED error (no crash, 500)", async () => {
    delete process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_SECRET;
    const resp = await post({ ...BASE, destination: "tiktok" });
    expect(resp.status).toBe(500);
    const body = (await resp.json()) as { success: boolean; code: string; error: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe("TIKTOK_FAILED");
    expect(body.error).toContain("TIKTOK_CLIENT_KEY");
    expect(body.error).toContain("TIKTOK_CLIENT_SECRET");
  });

  test("destination both with no secrets and no youtube auth -> NO_AUTH (401)", async () => {
    delete process.env.TIKTOK_CLIENT_KEY;
    const resp = await post({ ...BASE, destination: "both" });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe("NO_AUTH");
  });

  test("destination youtube with no auth -> NO_AUTH (401) — no regression", async () => {
    const resp = await post({ ...BASE, destination: "youtube" });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { success: boolean; code: string; error: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe("NO_AUTH");
    expect(body.error).toContain("YouTube");
  });

  test("no destination defaults to youtube -> NO_AUTH (backward compatible)", async () => {
    const resp = await post({ ...BASE });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { code: string };
    expect(body.code).toBe("NO_AUTH");
  });

  test("invalid destination -> API_ERROR (no crash, no download attempted)", async () => {
    const resp = await post({ ...BASE, destination: "twitch" as unknown as string });
    expect(resp.status).toBe(500);
    const body = (await resp.json()) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe("API_ERROR");
    expect(body.error).toContain("Invalid destination");
  });

  test("missing required fields still 400s", async () => {
    const resp = await post({ startTime: 1, endTime: 2 });
    expect(resp.status).toBe(400);
  });

  test("startTime >= endTime still 400s", async () => {
    const resp = await post({ ...BASE, startTime: 50, endTime: 10 });
    expect(resp.status).toBe(400);
  });
});
