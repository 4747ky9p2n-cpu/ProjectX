/**
 * Voice render pipeline tests.
 *
 * Pure helpers (wrapText, computeRenderDuration, buildVoiceFilterGraph) are
 * tested directly. The main `renderVoiceVideo` is exercised with injected
 * download/synth/fact-gen dependencies so the network, Piper and real
 * downloads are never touched. Error paths are covered without ffmpeg.
 *
 * One end-to-end test builds a REAL background + voiceover with ffmpeg and
 * runs the actual render command (guarded by ffmpeg availability) — proving
 * the generated filter graph is a valid ffmpeg invocation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import * as os from "node:os";
import {
  buildVoiceFilterGraph,
  computeRenderDuration,
  FONT_PATH,
  renderVoiceVideo,
  wrapText,
} from "../src/lib/voice-render";
import { CHARACTERS } from "../src/lib/characters";

const tmpRoots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicerender-"));
  tmpRoots.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
  tmpRoots.length = 0;
});

describe("wrapText", () => {
  test("wraps long text into multi-line blocks", () => {
    const wrapped = wrapText(
      "Did you know that researchers found this hack saves people insane amounts of money",
      16
    );
    const lines = wrapped.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(20);
  });

  test("keeps short text on a single line", () => {
    expect(wrapText("Kurz").split("\n").length).toBe(1);
  });
});

describe("computeRenderDuration", () => {
  test("adds a short tail above the speech", () => {
    expect(computeRenderDuration(20)).toBe(24);
  });
  test("floors at the minimum duration", () => {
    expect(computeRenderDuration(2)).toBe(12);
  });
  test("caps at the Short ceiling", () => {
    expect(computeRenderDuration(90)).toBe(45);
    expect(computeRenderDuration(40, 30)).toBe(30);
  });
});

describe("buildVoiceFilterGraph", () => {
  test("produces a valid graph: crop, scale, drawtext, apad", () => {
    const g = buildVoiceFilterGraph("/tmp/caption.txt", 24);
    expect(g).toContain("[0:v]crop=ih*9/16:ih,scale=1080:1920");
    expect(g).toContain("drawtext=");
    expect(g).toContain("textfile='/tmp/caption.txt'");
    expect(g).toContain(`enable='between(t,0,24)'`);
    expect(g).toContain("[1:a]apad[a]");
    expect(g.split(";").length).toBeGreaterThanOrEqual(2);
  });
  test("uses the DejaVu font path", () => {
    const g = buildVoiceFilterGraph("/tmp/caption.txt", 10);
    expect(g).toContain(FONT_PATH);
  });
});

describe("renderVoiceVideo error paths", () => {
  test("unknown character -> UNKNOWN_CHARACTER (no deps touched)", async () => {
    const out = await renderVoiceVideo({
      videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      characterId: "nope",
      text: "hello",
      factSource: "user",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("UNKNOWN_CHARACTER");
  });

  test("user factSource without text -> MISSING_TEXT", async () => {
    const out = await renderVoiceVideo({
      videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      characterId: CHARACTERS[0]!.id,
      factSource: "user",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("MISSING_TEXT");
  });

  test("failed download -> DOWNLOAD_FAILED", async () => {
    const out = await renderVoiceVideo(
      {
        videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        characterId: CHARACTERS[0]!.id,
        text: "Hello world this is a test.",
        factSource: "user",
      },
      { download: async () => ({ ok: false, error: "download blocked" }) }
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("DOWNLOAD_FAILED");
      expect(out.error).toContain("download blocked");
    }
  });

  test("failed TTS -> passes the TTS code through", async () => {
    const out = await renderVoiceVideo(
      {
        videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        characterId: CHARACTERS[0]!.id,
        text: "Hello world.",
        factSource: "user",
      },
      {
        download: async () => ({ ok: true }),
        synth: async () => ({ ok: false, code: "TTS_FAILED", error: "piper boom" }),
      }
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("TTS_FAILED");
      expect(out.error).toContain("piper boom");
    }
  });

  test("fact generation throws -> FACT_GEN_FAILED", async () => {
    const out = await renderVoiceVideo(
      {
        videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        characterId: CHARACTERS[0]!.id,
        factSource: "ai",
      },
      {
        genFact: async () => {
          throw new Error("no transcript");
        },
      }
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("FACT_GEN_FAILED");
  });
});

describe("renderVoiceVideo end-to-end (local ffmpeg)", () => {
  test(
    "renders a real 9:16 Short with a caption and a voiceover",
    async () => {
      // Skip when ffmpeg isn't installed.
      const ff = await Bun.$`which ffmpeg`.quiet().nothrow();
      if (!String(ff.stdout ?? "").trim()) {
        console.log("skipping: ffmpeg not installed");
        return;
      }
      const workDir = tempDir();
      // Injected download writes a real 5s background clip.
      const bg = path.join(workDir, "bg.mp4");
      await Bun
        .$`ffmpeg -y -f lavfi -i testsrc=duration=5:size=1280x720:rate=30 -pix_fmt yuv420p ${bg}`
        .quiet()
        .nothrow();
      // Injected synth writes a real 3s voiceover wav.
      const voice = path.join(workDir, "voiceover.wav");
      await Bun
        .$`ffmpeg -y -f lavfi -i sine=frequency=440:duration=3 -ar 22050 -ac 1 ${voice}`
        .quiet()
        .nothrow();

      const out = await renderVoiceVideo(
        {
          videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          characterId: CHARACTERS[0]!.id,
          text: "Did you know that this is the perfect voice test clip.",
          factSource: "user",
          maxDuration: 30,
        },
        {
          workDirRoot: workDir,
          download: async () => ({ ok: true }),
          synth: async () => ({ ok: true, durationSec: 12, path: voice }),
        }
      );
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.path.endsWith("short.mp4")).toBe(true);
        expect(existsSync(out.path)).toBe(true);
        expect(out.durationSec).toBeGreaterThanOrEqual(12);
        expect(out.characterName).toBe(CHARACTERS[0]!.name);
      }
    },
    60_000
  );
});
