/**
 * TikTok Content Posting API — Direct Post upload
 *
 * Uploads an already-encoded Shorts clip to the user's connected TikTok
 * account via the TikTok Content Posting API:
 *
 *   1. POST /v2/post/publish/video/init/   — create the publish, get
 *      `publish_id`, `upload_url`, `chunk_size`.
 *   2. PUT each chunk to `upload_url` with a `Content-Range: bytes a-b/size`
 *      header (chunked upload, no auth on the PUT itself).
 *   3. POST /v2/post/publish/video/status/fetch/ with `{ publish_id }` and
 *      poll until `PUBLISH_COMPLETE` (or a publish failure).
 *
 * Privacy: SELF_ONLY (safest default — never posts publicly without the
 * owner deciding otherwise; YouTube stays `public`).
 *
 * TikTok has a single `title` field (max 2200 chars) — the description is
 * appended to the title, truncated to ~1500 chars.
 */

import {
  sanitizeDescription,
  sanitizeTitle,
  truncateToCodePoints,
} from "./sanitize";

export interface TikTokUploadSuccess {
  ok: true;
  publishId: string;
  /** Not returned by the Content Posting API — always undefined for now. */
  videoUrl?: string;
}

export interface TikTokUploadFailure {
  ok: false;
  error: string;
}

export type TikTokUploadOutcome = TikTokUploadSuccess | TikTokUploadFailure;

/** Requested chunk size: 5 MiB (TikTok allows ~5–64 MB chunks). */
export const TIKTOK_CHUNK_SIZE = 5 * 1024 * 1024;
const TIKTOK_INIT_URL =
  "https://open.tiktokapis.com/v2/post/publish/video/init/";
const TIKTOK_STATUS_URL =
  "https://open.tiktokapis.com/v2/post/publish/video/status/fetch/";
const TIKTOK_MAX_TITLE_CHARS = 2200;
const TIKTOK_MAX_DESC_CHARS = 1500;
const TIKTOK_MIN_TITLE_CHARS = 12;

/* ─────────────────────────────────────────────
   Chunk Plan (pure math — unit-testable)
   ───────────────────────────────────────────── */

export interface ChunkRange {
  start: number;
  end: number;
}

export interface ChunkPlan {
  chunkSize: number;
  totalChunkCount: number;
  ranges: ChunkRange[];
}

/**
 * Split a file of `fileSize` bytes into chunks of `chunkSize` bytes.
 * The last chunk may be smaller. Ranges are inclusive: chunk k covers
 * bytes [k*chunkSize, min(fileSize, (k+1)*chunkSize) - 1].
 */
export function computeChunkPlan(
  fileSize: number,
  chunkSize: number
): ChunkPlan {
  const size = Math.max(0, Math.floor(fileSize));
  const cs = Math.max(1, Math.floor(chunkSize));
  const totalChunkCount = Math.max(1, Math.ceil(size / cs));
  const ranges: ChunkRange[] = [];
  for (let i = 0; i < totalChunkCount; i++) {
    const start = i * cs;
    const end = Math.min(size, start + cs) - 1;
    ranges.push({ start, end });
  }
  return { chunkSize: cs, totalChunkCount, ranges };
}

/** Build the HTTP Content-Range header value for a chunk PUT. */
export function buildContentRange(
  start: number,
  end: number,
  totalSize: number
): string {
  return `bytes ${start}-${end}/${totalSize}`;
}

/* ─────────────────────────────────────────────
   Upload
   ───────────────────────────────────────────── */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TikTokApiErrorBody {
  error?: { code?: number | string; message?: string; log_id?: string };
}

/** Parse a TikTok API error body into a readable message. */
export function parseTikTokError(bodyText: string): string {
  try {
    const data = JSON.parse(bodyText) as TikTokApiErrorBody;
    const err = data.error;
    if (err && (err.code !== undefined || err.message)) {
      const bits = [String(err.code ?? ""), err.message ?? ""]
        .map((b) => b.trim())
        .filter(Boolean);
      if (bits.length > 0) return bits.join(": ");
    }
  } catch {
    // not JSON — fall through to raw text
  }
  const trimmed = bodyText.trim();
  return trimmed ? trimmed.slice(0, 300) : "unknown error";
}

export interface TikTokUploadOptions {
  /** Status-poll interval in ms (default 2000). Tests pass 0 for speed. */
  pollIntervalMs?: number;
  /** Max status polls before timing out (default 60 ≈ 2 min). */
  maxPolls?: number;
}

/**
 * Upload an encoded clip to TikTok.
 * Returns `{ ok: true, publishId }` on success, or `{ ok: false, error }`
 * with a human-readable message (real API rejections are surfaced, network
 * failures too — the caller decides how to present them).
 */
export async function uploadToTikTokAPI(
  accessToken: string,
  videoPath: string,
  title: string,
  description: string,
  opts?: TikTokUploadOptions
): Promise<TikTokUploadOutcome> {
  const file = Bun.file(videoPath);
  if (!(await file.exists())) {
    return { ok: false, error: "Encoded clip file not found before TikTok upload." };
  }
  const fileBuffer = Buffer.from(await file.arrayBuffer());
  const videoSize = fileBuffer.length;

  // Compose the TikTok title: sanitized title + "\n" + truncated description.
  // TikTok has no separate description field; max title length is 2200 chars.
  const safeTitle = truncateToCodePoints(sanitizeTitle(title), 100);
  const safeDescription = truncateToCodePoints(
    sanitizeDescription(description),
    TIKTOK_MAX_DESC_CHARS
  );
  let postTitle = safeTitle + (safeDescription ? `\n${safeDescription}` : "");
  // TikTok requires >= 12 chars in the title; pad only in the (rare) case
  // the composed title would be too short.
  if (postTitle.length < TIKTOK_MIN_TITLE_CHARS) {
    postTitle = `${postTitle} #shorts`;
  }
  postTitle = truncateToCodePoints(postTitle, TIKTOK_MAX_TITLE_CHARS);

  const requestedPlan = computeChunkPlan(videoSize, TIKTOK_CHUNK_SIZE);

  try {
    // ── 1. Init ──
    const initResp = await fetch(TIKTOK_INIT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        post_info: {
          title: postTitle,
          privacy_level: "SELF_ONLY",
        },
        source_info: {
          source: "FILE_UPLOAD",
          video_size: videoSize,
          chunk_size: requestedPlan.chunkSize,
          total_chunk_count: requestedPlan.totalChunkCount,
        },
      }),
    });

    const initText = await initResp.text().catch(() => "");
    if (!initResp.ok) {
      const tiktokError = parseTikTokError(initText);
      console.error(
        `[ClipFlow] TikTok init failed (HTTP ${initResp.status}): ${initText}`
      );
      return {
        ok: false,
        error: `TikTok rejected the upload (${initResp.status}): ${tiktokError}`,
      };
    }

    let initData: {
      data?: { publish_id?: string; upload_url?: string; chunk_size?: number };
    };
    try {
      initData = JSON.parse(initText) as typeof initData;
    } catch {
      initData = {};
    }

    const publishId = initData.data?.publish_id;
    const uploadUrl = initData.data?.upload_url;
    if (!publishId || !uploadUrl) {
      console.error(`[ClipFlow] TikTok init response missing publish_id/upload_url: ${initText}`);
      return {
        ok: false,
        error: "TikTok did not return a publish_id / upload_url.",
      };
    }

    // Honor the server's chunk_size when it overrides ours (recompute the
    // ranges so Content-Range offsets always match reality).
    const serverChunkSize =
      initData.data?.chunk_size && initData.data.chunk_size > 0
        ? Math.floor(initData.data.chunk_size)
        : requestedPlan.chunkSize;
    const uploadPlan =
      serverChunkSize === requestedPlan.chunkSize
        ? requestedPlan
        : computeChunkPlan(videoSize, serverChunkSize);
    if (uploadPlan.totalChunkCount !== requestedPlan.totalChunkCount) {
      console.warn(
        `[ClipFlow] TikTok adjusted chunk_size: requested ${requestedPlan.chunkSize} (${requestedPlan.totalChunkCount} chunks), using ${uploadPlan.chunkSize} (${uploadPlan.totalChunkCount} chunks)`
      );
    }

    // ── 2. Upload chunks ──
    for (const range of uploadPlan.ranges) {
      const chunk = fileBuffer.subarray(range.start, range.end + 1);
      const putResp = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Range": buildContentRange(range.start, range.end, videoSize),
          "Content-Length": String(chunk.length),
        },
        body: chunk,
      });
      if (!putResp.ok) {
        const errText = await putResp.text().catch(() => "");
        console.error(
          `[ClipFlow] TikTok chunk ${range.start}-${range.end} failed (HTTP ${putResp.status}): ${errText}`
        );
        return {
          ok: false,
          error: `TikTok chunk upload failed (${putResp.status}).`,
        };
      }
    }

    // ── 3. Poll publish status ──
    const pollIntervalMs = opts?.pollIntervalMs ?? 2_000;
    const maxPolls = opts?.maxPolls ?? 60;
    for (let i = 0; i < maxPolls; i++) {
      await sleep(pollIntervalMs);

      const statusResp = await fetch(TIKTOK_STATUS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({ publish_id: publishId }),
      });
      const statusText = await statusResp.text().catch(() => "");
      if (!statusResp.ok) {
        const tiktokError = parseTikTokError(statusText);
        console.error(
          `[ClipFlow] TikTok status fetch failed (HTTP ${statusResp.status}): ${statusText}`
        );
        return {
          ok: false,
          error: `TikTok status check failed (${statusResp.status}): ${tiktokError}`,
        };
      }

      let statusData: {
        data?: {
          status?: string;
          publish_error?: { code?: number | string; message?: string };
        };
      };
      try {
        statusData = JSON.parse(statusText) as typeof statusData;
      } catch {
        statusData = {};
      }

      const status = statusData.data?.status;
      if (status === "PUBLISH_COMPLETE") {
        console.log(`[ClipFlow] TikTok upload complete (publish_id=${publishId})`);
        return { ok: true, publishId };
      }

      const pubErr = statusData.data?.publish_error;
      if (status === "FAILED" || pubErr) {
        const detail = pubErr?.message
          ? `${String(pubErr.code ?? "")} ${pubErr.message}`.trim()
          : "";
        console.error(`[ClipFlow] TikTok publish failed: ${statusText}`);
        return {
          ok: false,
          error: `TikTok publish failed${detail ? `: ${detail}` : "."}`,
        };
      }

      // status is undefined or PROCESSING_UPLOAD — keep polling.
    }

    return {
      ok: false,
      error:
        "TikTok publish timed out while processing. Check your TikTok account.",
    };
  } catch (err) {
    console.error("[ClipFlow] TikTok upload error:", err);
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "Network error during TikTok upload.",
    };
  }
}
