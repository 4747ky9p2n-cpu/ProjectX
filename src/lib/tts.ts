/* ─────────────────────────────────────────────
   KI-Sprach-Kategorie — Text-to-Speech engine (Piper)
   ─────────────────────────────────────────────
   Provider choice: PIPER (self-hosted, open-source, MIT-licensed neural TTS).
   See the rationale in characters.ts — the key constraints:

     - Genuinely free: Piper is open-source with ~dozens of pre-trained open
       voices. Unlimited use, NO API key, NO per-character/cost caps. This
       satisfies the owner's "free, pre-built parody voices" requirement.
     - Fits a ~4GB box: Piper is a small onnxruntime neural model, fast and
       low-RAM, runs entirely locally (no external dependency after the
       one-time model download).
     - Works on this host: edge-tts (Microsoft) is higher-quality but requires
       a WebSocket to speech.platform.bing.com, which is blocked on this host
       (even a public echo server fails with close 1006). ElevenLabs has
       limited free characters and needs an API key. Piper avoids both.

   The engine:
     1. `ensureVoice`  — lazily downloads a missing voice model into a stable
        dir (IDEMPOTENT; first use of a new voice triggers one download).
     2. `piperSynthesize` — runs the `piper` CLI on the model to produce a
        raw WAV, then applies the character's pitch/rate styling via ffmpeg so
        each character sounds distinct from the base neural voice.
     3. `piperAvailable` — tool presence check so the handler can surface a
        clear MISSING_TOOLS error.

   The pipeline that CALLS synthesis (voice-render.ts) accepts an injected
   `synth` function so unit tests can stub the provider entirely (no network,
   no subprocess, no onnx runtime).
   ───────────────────────────────────────────── */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { VoiceCharacter } from "./characters";

export interface SynthesizeInput {
  /** The exact text to speak. */
  text: string;
  /** The character whose voice/voiceId/pitch/rate to use. */
  character: VoiceCharacter;
  /** Output file path for the styled voiceover (wav). Written by the engine. */
  outPath: string;
  /** Override the voice model directory (tests use a temp dir). */
  voicesDir?: string;
}

export type SynthesizeOutcome =
  | {
      ok: true;
      /** Duration of the produced voiceover in seconds. */
      durationSec: number;
      /** Absolute path to the rendered voiceover. */
      path: string;
    }
  | { ok: false; code: string; error: string };

export interface TtsSynth {
  (input: SynthesizeInput): Promise<SynthesizeOutcome>;
}

/**
 * Default model directory. Kept on the large system overlay (NOT /home, which
 * is a small 300M mount) so voice models (~45-130MB each) don't fill the repo
 * disk. Override via PIPER_VOICES_DIR.
 */
export function defaultVoicesDir(): string {
  return process.env.PIPER_VOICES_DIR ?? "/var/lib/clipflow/piper-voices";
}

/** Absolute path the piper engine expects for a voice's onnx model. */
export function voiceOnnxPath(
  voiceId: string,
  voicesDir: string = defaultVoicesDir()
): string {
  return path.join(voicesDir, `${voiceId}.onnx`);
}

/** True when the piper CLI is installed (cached in module scope). */
let _piperChecked: boolean | null = null;
export async function piperAvailable(): Promise<boolean> {
  if (_piperChecked !== null) return _piperChecked;
  try {
    const r = await Bun.$`which piper`.quiet().nothrow();
    _piperChecked = String(r.stdout ?? "").trim().length > 0;
  } catch {
    _piperChecked = false;
  }
  return _piperChecked;
}

/** For tests: forget the cached piper availability result. */
export function resetPiperCache(): void {
  _piperChecked = null;
}

/**
 * Ensure a voice's model files exist in `voicesDir`. Piper 1.7 does NOT
 * auto-download, so we pre-download via `piper.download_voices --download-dir`.
 * Idempotent: does nothing when the .onnx is already present.
 */
export async function ensureVoice(
  voiceId: string,
  voicesDir: string = defaultVoicesDir()
): Promise<{ ok: true; onnxPath: string } | { ok: false; error: string }> {
  const onnxPath = voiceOnnxPath(voiceId, voicesDir);
  if (existsSync(onnxPath)) return { ok: true, onnxPath };
  try {
    await Bun.$`mkdir -p ${voicesDir}`.quiet().nothrow();
    const r = await Bun
      .$`python3 -m piper.download_voices --download-dir ${voicesDir} ${voiceId}`
      .quiet()
      .nothrow();
    if (r.exitCode !== 0 || !existsSync(onnxPath)) {
      return {
        ok: false,
        error:
          `Voice model '${voiceId}' could not be downloaded. ` +
          `Check network access to huggingface.co or pre-download the model.`,
      };
    }
    return { ok: true, onnxPath };
  } catch (err) {
    return {
      ok: false,
      error: `Voice model download failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Resolve the sample rate a Piper model outputs (needed for correct pitch
 * math). Reads it from the voice's `.onnx.json` config when present, else
 * assumes Piper's default 22050 Hz.
 */
export function piperSampleRate(
  voiceId: string,
  voicesDir: string = defaultVoicesDir()
): number {
  try {
    const cfgPath = path.join(voicesDir, `${voiceId}.onnx.json`);
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
        audio?: { sample_rate?: number };
      };
      if (cfg?.audio?.sample_rate) return cfg.audio.sample_rate;
    }
  } catch {
    // fall through to default
  }
  return 22_050;
}

/**
 * Build the ffmpeg audio filter string that applies a character's pitch (in
 * semitones) and rate (playback multiplier) to a synthesized audio file.
 *
 * Approach (keeps overall pacing while shifting pitch):
 *   pitch up/down by `pitch` semitones using `asetrate` (multiplies sample
 *   rate by 2^(semitones/12)), resample back to the original rate, then
 *   `atempo` to restore normal speed. The requested `rate` multiplier is
 *   folded in so a single atempo does both jobs. Exported for unit tests.
 */
export function pitchRateFilter(
  pitchSemitones: number,
  rate: number,
  sampleRate: number = 22_050
): string {
  const semitoneFactor = Math.pow(2, pitchSemitones / 12);
  const restatedRate = Math.round(sampleRate * semitoneFactor);
  const atempo = rate / semitoneFactor;
  // atempo accepts 0.5..100; clamp defensively.
  const clamped = Math.min(100, Math.max(0.5, atempo));
  const parts: string[] = [];
  if (Math.abs(pitchSemitones) > 0.01) {
    parts.push(`asetrate=${restatedRate}`);
    parts.push(`aresample=${sampleRate}`);
  }
  if (Math.abs(clamped - 1) > 0.01) {
    parts.push(`atempo=${clamped.toFixed(4)}`);
  }
  return parts.join(",");
}

/**
 * Write `text` to the file piper reads from, escaping characters that could
 * confuse the CLI/stdin path. We write to a file to avoid shell quoting
 * issues with quotes, colons and newlines in the spoken text.
 */
export function writePiperTextFile(text: string, textPath: string): void {
  const clean = text
    .replace(/\r/g, " ")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  writeFileSync(textPath, clean, "utf-8");
}

/**
 * Default Piper-backed synthesizer. Layers:
 *   1. ensure the voice model is present,
 *   2. piper CLI -> neutral WAV,
 *   3. ffmpeg -> pitch/rate styled WAV at `outPath`.
 * Returns a machine-readable code on any failure.
 */
export async function piperSynthesize(
  input: SynthesizeInput
): Promise<SynthesizeOutcome> {
  const voicesDir = input.voicesDir ?? defaultVoicesDir();

  if (!(await piperAvailable())) {
    return {
      ok: false,
      code: "MISSING_TOOLS",
      error: "Piper TTS is not installed. Install with: pip3 install piper-tts.",
    };
  }

  const ensured = await ensureVoice(input.character.voiceId, voicesDir);
  if (!ensured.ok) {
    return { ok: false, code: "TTS_MODEL_UNAVAILABLE", error: ensured.error };
  }

  const workDir = path.dirname(input.outPath);
  await Bun.$`mkdir -p ${workDir}`.quiet().nothrow();
  const neutralWav = path.join(workDir, "voice-neutral.wav");
  const textFile = path.join(workDir, "voice.txt");
  writePiperTextFile(input.text, textFile);

  // 1) Raw neutral synthesis (piper CLI reads text, writes WAV).
  const synth = await Bun
    .$`piper --model ${ensured.onnxPath} --input_file ${textFile} --output_file ${neutralWav} --debug`
    .quiet()
    .nothrow();
  if (synth.exitCode !== 0 || !existsSync(neutralWav)) {
    return {
      ok: false,
      code: "TTS_FAILED",
      error: "Piper failed to synthesize the text.",
    };
  }

  // 2) Measure the neutral duration (for the final render math).
  const probe = await Bun
    .$`ffprobe -v error -show_entries format=duration -of csv=p=0 ${neutralWav}`
    .quiet()
    .nothrow();
  const neutralDur = parseFloat(String(probe.stdout ?? "").trim()) || 3;

  // 3) Style it (pitch/rate) into the final outPath.
  const sampleRate = piperSampleRate(input.character.voiceId, voicesDir);
  const af = pitchRateFilter(input.character.pitch, input.character.rate, sampleRate);
  const styledDur = neutralDur / input.character.rate;

  if (!af) {
    // No pitch and no rate change — the neutral wav IS the final voiceover.
    await Bun.$`cp ${neutralWav} ${input.outPath}`.quiet().nothrow();
    return { ok: true, durationSec: styledDur, path: input.outPath };
  }

  const styled = await Bun
    .$`ffmpeg -y -i ${neutralWav} -af ${af} -ac 1 -ar 22050 ${input.outPath}`
    .quiet()
    .nothrow();
  if (styled.exitCode !== 0 || !existsSync(input.outPath)) {
    return {
      ok: false,
      code: "TTS_FAILED",
      error: "Could not apply the character's voice styling.",
    };
  }
  return { ok: true, durationSec: styledDur, path: input.outPath };
}

/**
 * Check whether the whole voice toolchain is present so the handler can
 * surface one clear error.
 */
export async function voiceToolStatus(): Promise<{
  ok: boolean;
  message: string;
}> {
  const [ffmpeg, piper, font] = await Promise.all([
    Bun.$`which ffmpeg`.quiet().nothrow(),
    piperAvailable(),
    Bun.$`test -f /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf`.quiet().nothrow(),
  ]);
  const hasFfmpeg = String(ffmpeg.stdout ?? "").trim().length > 0;
  if (!hasFfmpeg || !piper) {
    return {
      ok: false,
      message:
        "Missing tools for voice render. Install ffmpeg (apt install ffmpeg) " +
        "and piper-tts (pip3 install piper-tts).",
    };
  }
  if (font.exitCode !== 0) {
    return {
      ok: false,
      message:
        "Missing font for text overlay. Install fonts-dejavu-core (apt).",
    };
  }
  return { ok: true, message: "ffmpeg, piper & font OK" };
}
