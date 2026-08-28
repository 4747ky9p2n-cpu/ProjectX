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
