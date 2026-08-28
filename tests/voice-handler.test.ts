/**
 * Voice render handler tests — validation and error-path contract for
 * POST /api/voice/render and GET /api/voice/characters.
 *
 * Deps are INJECTED per call (toolCheck + render) so no module-scope
 * mock.module is needed (avoids the process-global mock leak the team hit
 * before).
 *
 * Contract:
 *   - invalid JSON / missing fields -> 400 API_ERROR,
 *   - factSource "user" without text -> 400 MISSING_TEXT,
 *   - missing toolchain -> 500 MISSING_TOOLS,
 *   - unknown character -> 404 UNKNOWN_CHARACTER,
 *   - fact/validation render errors -> 400, download/render -> 500,
 *   - success -> 200 with path/text/character/duration/factSource.
 */
import { describe, expect, test } from "bun:test";
import {
  handleVoiceCharacters,
  handleVoiceRender,
  type VoiceHandlerDeps,
} from "../src/lib/voice-handler";

function okDeps(overrides: Partial<VoiceHandlerDeps> = {}): VoiceHandlerDeps {
  return {
    toolCheck: async () => ({ ok: true, message: "tools OK" }),
    render: async (input) => ({
      ok: true,
      path: "/tmp/clipflow-voice-1/short.mp4",
      text: input.text ?? "Did you know that this works.",
      characterId: input.characterId,
      characterName: "Blaubeer-Papa",
      durationSec: 24,
      factSource: (input.factSource as "ai" | "user") ?? "ai",
    }),
    ...overrides,
  };
}

async function post(
  body: unknown,
  deps: VoiceHandlerDeps = okDeps()
): Promise<Response> {
  return handleVoiceRender(
    new Request("https://x/api/voice/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    deps
  );
}

describe("handleVoiceRender validation", () => {
  test("invalid JSON -> 400 API_ERROR", async () => {
    const r = await post("not-json", { toolCheck: async () => ({ ok: true, message: "" }) });
    expect(r.status).toBe(400);
    const j = (await r.json()) as { code: string };
    expect(j.code).toBe("API_ERROR");
  });

  test("missing videoUrl -> 400", async () => {
    const r = await post({ characterId: "blaubeer-papa" });
    expect(r.status).toBe(400);
  });

  test("missing characterId -> 400", async () => {
    const r = await post({ videoUrl: "https://youtu.be/dQw4w9WgXcQ" });
    expect(r.status).toBe(400);
  });

  test("factSource user without text -> 400 MISSING_TEXT", async () => {
    const r = await post({
      videoUrl: "https://youtu.be/dQw4w9WgXcQ",
      characterId: "blaubeer-papa",
      factSource: "user",
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { code: string }).code).toBe("MISSING_TEXT");
  });

  test("missing toolchain -> 500 MISSING_TOOLS", async () => {
    const r = await post(
      {
        videoUrl: "https://youtu.be/dQw4w9WgXcQ",
        characterId: "blaubeer-papa",
        text: "hi",
        factSource: "user",
      },
      { toolCheck: async () => ({ ok: false, message: "missing ffmpeg" }) }
    );
    expect(r.status).toBe(500);
    expect(((await r.json()) as { code: string }).code).toBe("MISSING_TOOLS");
  });
});

describe("handleVoiceRender error mapping", () => {
  test("unknown character -> 404 UNKNOWN_CHARACTER", async () => {
    const r = await post(
      {
        videoUrl: "https://youtu.be/dQw4w9WgXcQ",
        characterId: "x",
        text: "hi",
        factSource: "user",
      },
      okDeps({ render: async () => ({ ok: false, code: "UNKNOWN_CHARACTER", error: "no" }) })
    );
    expect(r.status).toBe(404);
    expect(((await r.json()) as { code: string }).code).toBe("UNKNOWN_CHARACTER");
  });

  test("factgen failure -> 400 FACT_GEN_FAILED", async () => {
    const r = await post(
      { videoUrl: "https://youtu.be/dQw4w9WgXcQ", characterId: "blaubeer-papa" },
      okDeps({ render: async () => ({ ok: false, code: "FACT_GEN_FAILED", error: "no transcript" }) })
    );
    expect(r.status).toBe(400);
    expect(((await r.json()) as { code: string }).code).toBe("FACT_GEN_FAILED");
  });

  test("download failure -> 500 DOWNLOAD_FAILED", async () => {
    const r = await post(
      { videoUrl: "https://youtu.be/dQw4w9WgXcQ", characterId: "blaubeer-papa", text: "hi", factSource: "user" },
      okDeps({ render: async () => ({ ok: false, code: "DOWNLOAD_FAILED", error: "blocked" }) })
    );
    expect(r.status).toBe(500);
    expect(((await r.json()) as { code: string }).code).toBe("DOWNLOAD_FAILED");
  });

  test("render failure -> 500 RENDER_FAILED", async () => {
    const r = await post(
      { videoUrl: "https://youtu.be/dQw4w9WgXcQ", characterId: "blaubeer-papa", text: "hi", factSource: "user" },
      okDeps({ render: async () => ({ ok: false, code: "RENDER_FAILED", error: "ffmpeg" }) })
    );
    expect(r.status).toBe(500);
  });
});

describe("handleVoiceRender success", () => {
  test("returns 200 with render metadata", async () => {
    const r = await post({
      videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      characterId: "blaubeer-papa",
      text: "Mein eigener Text.",
      factSource: "user",
      maxDuration: 30,
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j.success).toBe(true);
    expect(j.path).toBe("/tmp/clipflow-voice-1/short.mp4");
    expect(j.text).toBe("Mein eigener Text.");
    expect(j.factSource).toBe("user");
  });

  test("ai mode without text still succeeds", async () => {
    const r = await post({
      videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      characterId: "extrovertierter-coach",
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { factSource: string };
    expect(j.factSource).toBe("ai");
  });
});

describe("handleVoiceCharacters", () => {
  test("returns the parody library without provider internals", async () => {
    const r = await handleVoiceCharacters();
    expect(r.status).toBe(200);
    const j = (await r.json()) as { characters: Array<Record<string, unknown>> };
    expect(j.characters.length).toBeGreaterThanOrEqual(6);
    for (const c of j.characters) {
      expect(c.id).toBeDefined();
      expect(c.name).toBeDefined();
      expect(c.bio).toBeDefined();
      expect(c.emoji).toBeDefined();
      expect(c.style).toBeDefined();
      expect(c.language).toBeDefined();
      expect(c).not.toHaveProperty("voiceId");
      expect(c).not.toHaveProperty("pitch");
    }
  });
});
