/* ─────────────────────────────────────────────
   KI-Sprach-Kategorie — Voice video render pipeline
   ─────────────────────────────────────────────
   Turns a background video + a character + spoken text into a Short-ready
   9:16 MP4:
     1. Resolve the character (parody voice).
     2. Decide the spoken text (user text, or an AI "viral fact" derived from
        the video transcript).
     3. Download the background video (REUSES the existing
        `downloadSourceVideo` helper — no re-implemented download logic).
     4. Synthesize the voiceover for the text in the character's voice (via
        the injected/default Piper TTS synth).
     5. ffmpeg renders a 9:16 Short mixing: the (looped) background video +
        the voiceover + a burned-in caption of the spoken text.

   Uploads stay OUT of scope (the existing 202 pipeline is reused by the UI in
   a later phase) — this returns the RENDERED MP4 path for preview.

   All heavy deps (download, synth, fact-gen) are injectable so unit tests can
   stub them entirely (see tests/voice-render.test.ts).
   ───────────────────────────────────────────── */

import * as path from "node:path";
import { findCharacter } from "./characters";
import { piperSynthesize, type TtsSynth } from "./tts";
import { generateViralFact } from "./factgen";
import { downloadSourceVideo } from "./youtube-upload";

export const DEFAULT_MAX_DURATION = 45; // Short ceiling (safety, < 60)
export const MIN_DURATION = 12; // keep a usable clip even for short voiceovers
export const TAIL_PADDING = 4; // seconds of background after speech ends
export const FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

export interface RenderVoiceInput {
  videoUrl: string;
  characterId: string;
  /** User-provided text (optional when factSource is "ai"). */
  text?: string;
  /** "ai" generates a viral fact from the video; "user" uses `text`. */
  factSource?: "ai" | "user";
  cookieHeader?: string | null;
  /** Hard ceiling for the rendered clip (seconds). */
  maxDuration?: number;
}

export type RenderVoiceOutcome =
  | {
      ok: true;
      /** Absolute path to the rendered 9:16 MP4 (for preview/upload later). */
      path: string;
      /** The exact spoken text (user or generated). */
      text: string;
      characterId: string;
      characterName: string;
      /** Rendered clip duration in seconds. */
      durationSec: number;
      factSource: "ai" | "user";
    }
  | { ok: false; code: string; error: string };

export interface RenderDeps {
  /** TTS synthesizer (default: Piper). Tests stub this. */
  synth?: TtsSynth;
  /** Background video downloader (default: existing downloadSourceVideo). */
  download?: typeof downloadSourceVideo;
  /** AI fact generator (default: transcript-based). Tests stub this. */
  genFact?: typeof generateViralFact;
  /** Override the temp work dir root (tests use a temp dir). */
  workDirRoot?: string;
}

/**
 * Wrap `text` into lines of at most `width` characters at word boundaries so
 * the ffmpeg drawtext caption stays readable on a 1080px-wide Short.
 * Exported for unit tests.
 */
export function wrapText(text: string, width: number = 22): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > width && line) {
      lines.push(line.trim());
      line = word;
    } else {
      line = (line + " " + word).trim();
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join("\n");
}

/**
 * Compute the final rendered clip duration (seconds): speech + a short tail,
 * floored at MIN_DURATION and capped at maxDuration. Exported for tests.
 */
export function computeRenderDuration(
  speechDurationSec: number,
  maxDuration: number = DEFAULT_MAX_DURATION
): number {
  return Math.min(
    maxDuration,
    Math.max(MIN_DURATION, Math.ceil(speechDurationSec + TAIL_PADDING))
  );
}

/**
 * Escape a value for use inside an ffmpeg drawtext option. drawtext splits on
 * `:` and treats `'` as quote, so we strip/quote defensively to avoid breaking
 * the filter graph. Values here are file paths (no special chars in practice).
 */
function dtQuote(v: string): string {
  return `'${v.replace(/'/g, "")}'`;
}

/**
 * Build the ffmpeg filter_complex graph for a voice Short. Produces:
 *   [0:v] crop+scale to 1080x1920, burn multi-line caption, -> [v]
 *   [1:a] pad with silence, -> [a]
 * Exported (pure) so unit tests can assert the graph shape without running
 * ffmpeg.
 */
export function buildVoiceFilterGraph(
  textFileAbs: string,
  durationSec: number,
  fontPath: string = FONT_PATH
): string {
  const caption =
    `drawtext=fontfile=${dtQuote(fontPath)}:` +
    `textfile=${dtQuote(textFileAbs)}:` +
    `fontcolor=white:fontsize=54:` +
    `borderw=4:bordercolor=black@0.85:` +
    `box=1:boxcolor=black@0.45:boxborderw=28:` +
    `line_spacing=14:` +
    `x=(w-text_w)/2:y=h-th-320:` +
    `enable=${dtQuote(`between(t,0,${durationSec})`)}`;
  return `[0:v]crop=ih*9/16:ih,scale=1080:1920,${caption}[v];[1:a]apad[a]`;
}

/**
 * Main entry point — render the voice-overlayed 9:16 Short and return its
 * path. Never throws: failures are returned as machine-readable codes.
 */
export async function renderVoiceVideo(
  input: RenderVoiceInput,
  deps: RenderDeps = {}
): Promise<RenderVoiceOutcome> {
  const character = findCharacter(input.characterId);
  if (!character) {
    return {
      ok: false,
      code: "UNKNOWN_CHARACTER",
      error: `Unknown character id '${input.characterId}'.`,
    };
  }

  const factSource: "ai" | "user" =
    input.factSource === "user" ? "user" : "ai";

  // ── Resolve the spoken text ──
  let text: string;
  if (input.text && input.text.trim().length > 0) {
    text = input.text.trim();
  } else if (factSource === "user") {
    return {
      ok: false,
      code: "MISSING_TEXT",
      error:
        "No text provided. Pass `text` when factSource is 'user' (or use 'ai').",
    };
  } else {
    const genFact = deps.genFact ?? generateViralFact;
    try {
      const fact = await genFact({
        videoUrl: input.videoUrl,
        language: character.language,
      });
      text = fact.text;
    } catch (err) {
      return {
        ok: false,
        code: "FACT_GEN_FAILED",
        error: `Could not generate the viral fact: ${(err as Error).message}`,
      };
    }
  }

  // `workDirRoot` (test override) is used directly as the work directory;
  // otherwise default to a unique temp dir so parallel renders never collide.
  const workDir =
    deps.workDirRoot ?? `/tmp/clipflow-voice-${Date.now()}`;
  const rawPath = path.join(workDir, "bg.mp4");
  const voicePath = path.join(workDir, "voiceover.wav");
  const textFile = path.join(workDir, "caption.txt");
  const outPath = path.join(workDir, "short.mp4");

  try {
    await Bun.$`mkdir -p ${workDir}`.quiet();

    // ── Download the background video (reuse existing helper) ──
    const download = deps.download ?? downloadSourceVideo;
    const dl = await download(input.videoUrl, rawPath, input.cookieHeader ?? null);
    if (!dl.ok) {
      return { ok: false, code: "DOWNLOAD_FAILED", error: dl.error };
    }

    // ── Synthesize the voiceover ──
    const synth = deps.synth ?? piperSynthesize;
    const tts = await synth({
      text,
      character,
      outPath: voicePath,
    });
    if (!tts.ok) {
      return { ok: false, code: tts.code, error: tts.error };
    }

    // ── Render the 9:16 Short ──
    const duration = computeRenderDuration(
      tts.durationSec,
      input.maxDuration ?? DEFAULT_MAX_DURATION
    );
    const wrapped = wrapText(text);
    // Write caption text via Node for full control over content.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(textFile, wrapped, "utf-8");

    const filter = buildVoiceFilterGraph(textFile, duration);
    const enc = await Bun
      .$`ffmpeg -y -stream_loop -1 -i ${rawPath} -i ${voicePath} -filter_complex ${filter} -map [v] -map [a] -t ${duration} -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -ar 44100 -movflags +faststart ${outPath}`
      .quiet()
      .nothrow();

    if (enc.exitCode !== 0) {
      return {
        ok: false,
        code: "RENDER_FAILED",
        error: "ffmpeg could not render the voice Short.",
      };
    }
    const outFile = Bun.file(outPath);
    if (!(await outFile.exists())) {
      return {
        ok: false,
        code: "RENDER_FAILED",
        error: "Render finished but the output file was not found.",
      };
    }

    return {
      ok: true,
      path: outPath,
      text,
      characterId: character.id,
      characterName: character.name,
      durationSec: duration,
      factSource,
    };
  } catch (err) {
    return {
      ok: false,
      code: "RENDER_CRASHED",
      error: `Voice render crashed: ${(err as Error).message}`,
    };
  }
}
