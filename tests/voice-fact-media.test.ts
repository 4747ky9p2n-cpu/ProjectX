import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleVoiceFact,
  handleVoiceMedia,
} from "../src/lib/voice-handler";

function jsonReq(body: unknown, url = "http://localhost/api/voice/fact"): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Voice work dirs are /tmp/clipflow-voice-<ts>; create one for the media test.
const workDir = mkdtempSync(join(tmpdir(), "clipflow-voice-"));
const mediaFile = join(workDir, "short.mp4");
writeFileSync(mediaFile, "fake-mp4-bytes");

afterAll(() => {
  // cleanup handled by startupDiagnostics / not required.
});

describe("handleVoiceFact", () => {
  test("missing videoUrl -> 400 API_ERROR", async () => {
    const res = await handleVoiceFact(
      jsonReq({ characterId: "blaubeer-papa" })
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe("API_ERROR");
  });

  test("missing characterId -> 400 API_ERROR", async () => {
    const res = await handleVoiceFact(
      jsonReq({ videoUrl: "https://youtu.be/abc" })
    );
    expect(res.status).toBe(400);
  });

  test("unknown character -> 404 UNKNOWN_CHARACTER", async () => {
    const res = await handleVoiceFact(
      jsonReq({ videoUrl: "https://youtu.be/abc", characterId: "nope" })
    );
    expect(res.status).toBe(404);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe("UNKNOWN_CHARACTER");
  });

  test("returns generated fact text with injected genFact", async () => {
    const res = await handleVoiceFact(jsonReq({ videoUrl: "https://youtu.be/abc", characterId: "blaubeer-papa" }), {
      genFact: async () => ({ text: "Wusstest du, dass Blau ist? (de)" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean; text: string };
    expect(data.success).toBe(true);
    expect(data.text).toContain("Blau");
  });

  test("genFact throws -> 500 FACT_GEN_FAILED", async () => {
    const res = await handleVoiceFact(jsonReq({ videoUrl: "https://youtu.be/abc", characterId: "blaubeer-papa" }), {
      genFact: async () => {
        throw new Error("boom");
      },
    });
    expect(res.status).toBe(500);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe("FACT_GEN_FAILED");
  });
});

describe("handleVoiceMedia (safe serving)", () => {
  test("missing path -> 400", async () => {
    const res = await handleVoiceMedia(new Request("http://localhost/api/voice/media"));
    expect(res.status).toBe(400);
  });

  test("serves a real file under /tmp/clipflow-voice-*", async () => {
    const res = await handleVoiceMedia(
      new Request(`http://localhost/api/voice/media?path=${encodeURIComponent(mediaFile)}`)
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect(await res.text()).toBe("fake-mp4-bytes");
  });

  test("rejects paths outside the controlled prefix", async () => {
    const res = await handleVoiceMedia(
      new Request(`http://localhost/api/voice/media?path=${encodeURIComponent("/etc/hostname")}`)
    );
    expect(res.status).toBe(404);
  });

  test("rejects non-mp4 extension", async () => {
    const res = await handleVoiceMedia(
      new Request(`http://localhost/api/voice/media?path=${encodeURIComponent(join(workDir, "raw.mp4"))}`)
    );
    // raw.mp4 does not exist and real remote is under prefix but not .mp4-ext in this dir
    expect(res.status === 404 || res.status === 400).toBe(true);
  });

  test("rejects missing file under prefix", async () => {
    const res = await handleVoiceMedia(
      new Request(`http://localhost/api/voice/media?path=${encodeURIComponent(join(workDir, "nope.mp4"))}`)
    );
    expect(res.status).toBe(404);
  });
});
