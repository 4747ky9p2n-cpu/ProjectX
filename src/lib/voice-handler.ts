/**
 * Voice Render Handler
 *
 * Handles POST /api/voice/render — accepts a JSON body, runs the voice render
 * pipeline (background video + character voiceover + burned-in caption), and
 * returns the rendered MP4 path for preview. Uploads stay OUT of scope (the
 * existing 202 upload pipeline is reused by the UI in a later phase).
 *
 * Contract:
 *   - Invalid bodies stay synchronous 400s (missing videoUrl/characterId,
 *     bad json).
 *   - Unknown character id -> 404 UNKNOWN_CHARACTER.
 *   - factSource "user" without text -> 400 MISSING_TEXT.
 *   - Missing toolchain -> 500 MISSING_TOOLS (fast, before any download).
 *   - Render/download/TTS failures -> 500 with machine-readable `code`.
 *   - Success -> 200 `{ success: true, path, text, characterId,
 *     characterName, durationSec, factSource }`.
 *
 * Called directly from serve.ts.
 */

import {
  renderVoiceVideo,
  type RenderVoiceInput,
  type RenderVoiceOutcome,
} from "./voice-render";
import { voiceToolStatus } from "./tts";
import { generateViralFact } from "./factgen";
import { CHARACTERS } from "./characters";

const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Injectable deps so tests don't need module-scope mocks (avoids the
 * process-global mock.module leak the team hit before). */
export interface VoiceHandlerDeps {
  render?: (
    input: RenderVoiceInput
  ) => Promise<RenderVoiceOutcome>;
  toolCheck?: () => Promise<{ ok: boolean; message: string }>;
  genFact?: (opts: {
    videoUrl: string;
    language: string;
  }) => Promise<{ text: string }>;
}

/**
 * GET /api/voice/characters — returns the parody character library for the
 * (later) UI picker. Internal provider fields (voiceId, pitch, rate) are kept
 * out of the payload.
 */
export async function handleVoiceCharacters(): Promise<Response> {
  const characters = CHARACTERS.map(
    ({ id, name, bio, emoji, style, language }) => ({
      id,
      name,
      bio,
      emoji,
      style,
      language,
    })
  );
  return jsonResponse({ success: true, characters }, 200);
}

export interface VoiceRenderBody {
  videoUrl?: unknown;
  characterId?: unknown;
  text?: unknown;
  factSource?: unknown;
  maxDuration?: unknown;
}

export async function handleVoiceRender(
  req: Request,
  deps: VoiceHandlerDeps = {}
): Promise<Response> {
  let body: VoiceRenderBody;
  try {
    body = (await req.json()) as VoiceRenderBody;
  } catch {
    return jsonResponse(
      { success: false, code: "API_ERROR", error: "Invalid JSON body." },
      400
    );
  }

  // ── Validation (synchronous 400s) ──
  if (typeof body.videoUrl !== "string" || body.videoUrl.trim().length === 0) {
    return jsonResponse(
      { success: false, code: "API_ERROR", error: "videoUrl is required." },
      400
    );
  }
  if (typeof body.characterId !== "string" || body.characterId.trim().length === 0) {
    return jsonResponse(
      { success: false, code: "API_ERROR", error: "characterId is required." },
      400
    );
  }

  const factSource = body.factSource === "user" ? "user" : "ai";
  const text =
    typeof body.text === "string" && body.text.trim().length > 0
      ? body.text.trim()
      : undefined;
  if (factSource === "user" && !text) {
    return jsonResponse(
      {
        success: false,
        code: "MISSING_TEXT",
        error: "No text provided. Pass `text` when factSource is 'user'.",
      },
      400
    );
  }

  // ── Fast toolchain check (before any expensive download) ──
  const tools = await (deps.toolCheck ?? voiceToolStatus)();
  if (!tools.ok) {
    return jsonResponse(
      { success: false, code: "MISSING_TOOLS", error: tools.message },
      500
    );
  }

  const cookieHeader = req.headers.get("cookie");

  const input: RenderVoiceInput = {
    videoUrl: body.videoUrl,
    characterId: body.characterId,
    text,
    factSource,
    cookieHeader,
    maxDuration:
      typeof body.maxDuration === "number" && body.maxDuration > 0
        ? body.maxDuration
        : undefined,
  };

  const outcome = await (deps.render ?? renderVoiceVideo)(input);
  if (!outcome.ok) {
    const status =
      outcome.code === "UNKNOWN_CHARACTER"
        ? 404
        : outcome.code === "MISSING_TEXT" ||
            outcome.code === "FACT_GEN_FAILED"
          ? 400
          : 500;
    return jsonResponse(
      { success: false, code: outcome.code, error: outcome.error },
      status
    );
  }

  return jsonResponse(
    {
      success: true,
      path: outcome.path,
      text: outcome.text,
      characterId: outcome.characterId,
      characterName: outcome.characterName,
      durationSec: outcome.durationSec,
      factSource: outcome.factSource,
    },
    200
  );
}
/**
 * GET /api/voice/media?path=<abs> — serves a rendered voice Short for browser
 * preview in a <video> tag.
 *
 * SAFETY: this deliberately serves files ONLY from the controlled voice render
 * work directory (/tmp/clipflow-voice-<ts>/short.mp4). The path is validated
 * with realpath(); any path that does not resolve (after symlink resolution)
 * under the /tmp/clipflow-voice- prefix — or is not an .mp4 file — is rejected
 * with 404/400. This never exposes arbitrary files on disk.
 */
export async function handleVoiceMedia(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path");
  if (!rawPath) {
    return jsonResponse(
      { success: false, code: "API_ERROR", error: "Missing `path` query param." },
      400
    );
  }
  // Resolve symlinks/.. so a crafted path cannot escape the controlled prefix.
  let resolved: string;
  try {
    resolved = String(
      (await Bun.$`realpath -m ${rawPath}`.quiet().nothrow()).stdout ?? ""
    ).trim();
  } catch {
    return jsonResponse(
      { success: false, code: "API_ERROR", error: "Bad path." },
      400
    );
  }
  if (!resolved.startsWith("/tmp/clipflow-voice-") || !resolved.endsWith(".mp4")) {
    return jsonResponse(
      { success: false, code: "NOT_FOUND", error: "No such rendered short." },
      404
    );
  }
  const file = Bun.file(resolved);
  if (!(await file.exists())) {
    return jsonResponse(
      { success: false, code: "NOT_FOUND", error: "Rendered short not found." },
      404
    );
  }
  return new Response(file, {
    headers: {
      "Content-Type": "video/mp4",
      "Cache-Control": "private, max-age=300",
    },
  });
}

/**
 * POST /api/voice/fact — body `{ videoUrl, characterId }`. Cheaply generates a
 * viral-fact text (from the video transcript, phrased in the character's
 * language) WITHOUT running the expensive render pipeline. The UI shows this
 * text for review before committing to /api/voice/render.
 *
 * Returns 200 `{ success: true, text }` or 400/404/500 with `code`.
 */
export async function handleVoiceFact(
  req: Request,
  deps: VoiceHandlerDeps = {}
): Promise<Response> {
  let body: { videoUrl?: unknown; characterId?: unknown };
  try {
    body = (await req.json()) as { videoUrl?: unknown; characterId?: unknown };
  } catch {
    return jsonResponse(
      { success: false, code: "API_ERROR", error: "Invalid JSON body." },
      400
    );
  }
  const videoUrl = typeof body.videoUrl === "string" ? body.videoUrl.trim() : "";
  const characterId =
    typeof body.characterId === "string" ? body.characterId.trim() : "";
  if (!videoUrl) {
    return jsonResponse(
      { success: false, code: "API_ERROR", error: "videoUrl is required." },
      400
    );
  }
  if (!characterId) {
    return jsonResponse(
      { success: false, code: "API_ERROR", error: "characterId is required." },
      400
    );
  }
  const character = CHARACTERS.find((c) => c.id === characterId);
  if (!character) {
    return jsonResponse(
      { success: false, code: "UNKNOWN_CHARACTER", error: "Unknown character id." },
      404
    );
  }
  const genFact = deps.genFact ?? generateViralFact;
  try {
    const fact = await genFact({
      videoUrl,
      language: character.language,
    });
    return jsonResponse({ success: true, text: fact.text }, 200);
  } catch (err) {
    return jsonResponse(
      {
        success: false,
        code: "FACT_GEN_FAILED",
        error: `Could not generate the viral fact: ${(err as Error).message}`,
      },
      500
    );
  }
}
