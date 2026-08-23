/**
 * Upload Clip Handler
 *
 * Handles POST /api/upload/clip — accepts a JSON body with clip metadata,
 * reads the auth cookie, runs the upload pipeline, and returns JSON.
 * Called directly from serve.ts.
 *
 * Contract:
 *   - Invalid bodies stay synchronous: 400 for missing/invalid fields,
 *     500 API_ERROR for an invalid destination.
 *   - Missing auth is detected SYNCHRONOUSLY (mirroring uploadClip's early
 *     exits): 401 NO_AUTH when the destination's channel is not connected,
 *     or 500 TIKTOK_FAILED when the TikTok app secrets are absent. The user
 *     must see these immediately, never after a background run.
 *   - A valid body + valid auth returns HTTP 202 `{ success: true,
 *     background: true, accepted: true, destination }` and the pipeline runs
 *     fire-and-forget. The response never waits for the pipeline, so there is
 *     no long-running request that can time out mid-flight. The client must
 *     only treat a server response (202 or a legacy success body) as success.
 */

import {
  uploadClip,
  type UploadClipInput,
  type UploadClipOutcome,
  type UploadClipResult,
  type UploadDestination,
} from "./youtube-upload";
import { getValidAccessToken } from "./youtube-auth";
import {
  getValidTikTokToken,
  tiktokSetupPending,
} from "./tiktok-auth";
import { enqueueUpload } from "./upload-queue";

const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Rebuild a Cookie header from the incoming one, replacing the `tiktok_auth`
 * value with a freshly rotated one (taken from a Set-Cookie value produced by
 * `createTikTokAuthCookie`). TikTok refresh tokens are SINGLE-USE, so the
 * background pipeline must see the rotated token, not the consumed one, or
 * its refresh would fail and the TikTok leg would be skipped.
 */
function withRotatedTikTokCookie(
  cookieHeader: string | null,
  freshSetCookie: string
): string {
  const match = freshSetCookie.match(/^tiktok_auth=([^;]+)/);
  if (!match) return cookieHeader ?? "";
  const fresh = match[1]!;
  const others = (cookieHeader ?? "")
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith("tiktok_auth="));
  return [...others, `tiktok_auth=${fresh}`].join("; ");
}

export async function handleUploadClip(req: Request): Promise<Response> {
  try {
    // Parse the JSON body
    const body = (await req.json()) as UploadClipInput;

    // Validate required fields (synchronous 400s)
    if (!body.videoUrl || !body.title || !body.description) {
      return jsonResponse(
        {
          success: false,
          code: "API_ERROR",
          error: "Missing required fields: videoUrl, title, description.",
        },
        400
      );
    }

    if (typeof body.startTime !== "number" || typeof body.endTime !== "number") {
      return jsonResponse(
        {
          success: false,
          code: "API_ERROR",
          error: "startTime and endTime must be numbers (seconds).",
        },
        400
      );
    }

    if (body.startTime >= body.endTime) {
      return jsonResponse(
        {
          success: false,
          code: "API_ERROR",
          error: "startTime must be less than endTime.",
        },
        400
      );
    }

    // `destination` is optional and defaults to "youtube"; validate it here
    // (the pipeline validates it too, but that now runs in the background and
    // can no longer surface the error synchronously).
    const destination: UploadDestination = body.destination ?? "youtube";
    if (
      destination !== "youtube" &&
      destination !== "tiktok" &&
      destination !== "both"
    ) {
      return jsonResponse(
        {
          success: false,
          code: "API_ERROR",
          error: "Invalid destination. Use youtube, tiktok, or both.",
        },
        500
      );
    }

    const cookieHeader = req.headers.get("cookie");

    // ── Synchronous auth check (mirrors uploadClip's early exits) ──
    // Only the cheap checks run here so the response is instant. Token
    // refreshes may still happen (YouTube refresh tokens are reusable, so the
    // background pipeline re-reading the same cookie is harmless; TikTok
    // refresh tokens are single-use, so a rotation here is handed to the
    // background via the rebuilt cookie below AND persisted to the browser via
    // Set-Cookie on the 202 response).
    const needYouTube = destination === "youtube" || destination === "both";
    const needTikTok = destination === "tiktok" || destination === "both";

    const [youtubeAuth, tiktokAuth] = await Promise.all([
      needYouTube ? getValidAccessToken(cookieHeader) : Promise.resolve(null),
      needTikTok ? getValidTikTokToken(cookieHeader) : Promise.resolve(null),
    ]);
    const tiktokConfigured = !tiktokSetupPending();

    if (destination === "youtube" && !youtubeAuth) {
      return jsonResponse(
        {
          success: false,
          code: "NO_AUTH",
          error: "Not connected to YouTube. Connect or reconnect your channel first.",
        },
        401
      );
    }
    if (destination === "tiktok" && !tiktokConfigured) {
      return jsonResponse(
        {
          success: false,
          code: "TIKTOK_FAILED",
          error:
            "TikTok is not set up yet — the owner must add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET (TikTok Developer app approved for Content Posting).",
        },
        500
      );
    }
    if (destination === "tiktok" && !tiktokAuth) {
      return jsonResponse(
        {
          success: false,
          code: "NO_AUTH",
          error: "Not connected to TikTok. Connect your TikTok account first.",
        },
        401
      );
    }
    if (destination === "both" && !youtubeAuth && !tiktokAuth) {
      return jsonResponse(
        {
          success: false,
          code: "NO_AUTH",
          error:
            "Connect at least one channel (YouTube or TikTok) to upload this clip.",
        },
        401
      );
    }

    // ── Accept: return 202 immediately, run the pipeline in the background ──
    // The pipeline is intentionally NOT awaited. Final outcome/errors are
    // logged server-side so a run that fails after acceptance is diagnosable
    // from .run/server.log.
    //
    // Pipelines are serialized through a process-wide queue so only ONE clip
    // pipeline runs at a time (parallel runs overwhelmed the single alive Piped
    // download instance into HTTP 500s). Enqueueing is synchronous and
    // non-blocking — the 202 response is still returned immediately no matter
    // how busy the queue is. The task closure captures `body` and
    // `backgroundCookie` right here (AT ENQUEUE TIME), so a later job's TikTok
    // refresh-token rotation can never leak into this job.
    const rotatedTikTokCookie = tiktokAuth?.freshCookie;
    const backgroundCookie = rotatedTikTokCookie
      ? withRotatedTikTokCookie(cookieHeader, rotatedTikTokCookie)
      : cookieHeader;

    enqueueUpload(async () => {
      await uploadClip(body, backgroundCookie)
        .then((outcome: UploadClipOutcome) => {
          if (outcome.success) {
            console.log(
              "[ClipFlow] Background upload finished:",
              JSON.stringify(outcome).slice(0, 500)
            );
            const freshCookie = (outcome as UploadClipResult).tiktokFreshCookie;
            if (freshCookie) {
              // The 202 response was already sent, so a rotation that happened
              // DURING the pipeline cannot be persisted. Rare (the access token
              // would have to expire mid-pipeline); the next upload's sync check
              // rotates the (stale) cookie token again.
              console.error(
                "[ClipFlow] Background upload rotated the TikTok refresh token after the 202 response was sent — rotated token NOT persisted; the next upload will refresh again."
              );
            }
          } else {
            console.error(
              "[ClipFlow] Background upload failed:",
              outcome.code,
              "-",
              outcome.error
            );
          }
        })
        .catch((err: unknown) => {
          console.error("[ClipFlow] Background upload crashed:", err);
        });
    });

    const response = new Response(
      JSON.stringify({
        success: true,
        background: true,
        accepted: true,
        destination,
      }),
      { status: 202, headers: JSON_HEADERS }
    );
    // Persist a TikTok refresh token rotated during the synchronous check.
    if (rotatedTikTokCookie) {
      response.headers.append("Set-Cookie", rotatedTikTokCookie);
    }
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request body.";
    return jsonResponse(
      {
        success: false,
        code: "API_ERROR",
        error: message,
      },
      400
    );
  }
}
