/**
 * Upload Clip Handler
 *
 * Handles POST /api/upload/clip — accepts a JSON body with clip metadata,
 * reads the auth cookie, runs the upload pipeline, and returns JSON.
 * Called directly from serve.ts.
 */

import { uploadClipToYouTube, type UploadClipInput, type UploadClipOutcome } from "./youtube-upload";

export async function handleUploadClip(req: Request): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    // Parse the JSON body
    const body = (await req.json()) as UploadClipInput;

    // Validate required fields
    if (!body.videoUrl || !body.title || !body.description) {
      return new Response(
        JSON.stringify({
          success: false,
          code: "API_ERROR",
          error: "Missing required fields: videoUrl, title, description.",
        }),
        { status: 400, headers }
      );
    }

    if (typeof body.startTime !== "number" || typeof body.endTime !== "number") {
      return new Response(
        JSON.stringify({
          success: false,
          code: "API_ERROR",
          error: "startTime and endTime must be numbers (seconds).",
        }),
        { status: 400, headers }
      );
    }

    if (body.startTime >= body.endTime) {
      return new Response(
        JSON.stringify({
          success: false,
          code: "API_ERROR",
          error: "startTime must be less than endTime.",
        }),
        { status: 400, headers }
      );
    }

    const cookieHeader = req.headers.get("cookie");

    // Run the upload pipeline
    const outcome: UploadClipOutcome = await uploadClipToYouTube(body, cookieHeader);

    if (outcome.success) {
      return new Response(
        JSON.stringify(outcome),
        { status: 200, headers }
      );
    } else {
      // Map error codes to HTTP statuses
      let status = 500;
      switch (outcome.code) {
        case "NO_AUTH":
          status = 401;
          break;
        case "MISSING_TOOLS":
          status = 503;
          break;
        case "DOWNLOAD_FAILED":
        case "ENCODE_FAILED":
          status = 502;
          break;
        case "UPLOAD_FAILED":
          status = 500;
          break;
        default:
          status = 500;
      }

      return new Response(
        JSON.stringify(outcome),
        { status, headers }
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request body.";
    return new Response(
      JSON.stringify({
        success: false,
        code: "API_ERROR",
        error: message,
      }),
      { status: 400, headers }
    );
  }
}
