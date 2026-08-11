/**
 * YouTube Shorts Upload Pipeline
 *
 * Downloads the source video via the Supadata download API (works from
 * datacenter IPs where yt-dlp is bot-blocked by YouTube), cuts the clip
 * segment with ffmpeg, re-encodes it to vertical 9:16 Shorts format, and
 * uploads it to the user's connected YouTube channel via the YouTube Data
 * API v3.
 *
 * yt-dlp is kept only as a last-resort fallback when the Supadata download
 * URL itself fails to produce a file (it is bot-blocked on this host).
 *
 * Prerequisites (system):
 *   ffmpeg  — apt install ffmpeg (or equivalent)
 *   yt-dlp  — optional, fallback only
 */

import { getValidAccessToken } from "./youtube-auth";

/* ─────────────────────────────────────────────
   Types
   ───────────────────────────────────────────── */

export interface UploadClipInput {
  /** Start timestamp in seconds */
  startTime: number;
  /** End timestamp in seconds */
  endTime: number;
  /** Clip title (max 100 chars, will be truncated) */
  title: string;
  /** Clip description (may include hashtags) */
  description: string;
  /** Full YouTube URL of the source video */
  videoUrl: string;
}

export interface UploadClipResult {
  success: true;
  videoId: string;
  videoUrl: string;
}

export interface UploadClipError {
  success: false;
  error: string;
  /** Machine-readable error code for the UI */
  code: "NO_AUTH" | "MISSING_TOOLS" | "DOWNLOAD_FAILED" | "ENCODE_FAILED" | "UPLOAD_FAILED" | "API_ERROR";
}

export type UploadClipOutcome = UploadClipResult | UploadClipError;

/* ─────────────────────────────────────────────
   Tool Detection
   ───────────────────────────────────────────── */

let toolCheckCache: { ytdlp: boolean; ffmpeg: boolean } | null = null;

async function checkTools(): Promise<{ ytdlp: boolean; ffmpeg: boolean }> {
  if (toolCheckCache) return toolCheckCache;

  const [ytdlpOk, ffmpegOk] = await Promise.all([
    Bun.$`which yt-dlp`.quiet().nothrow()
      .then((r) => r.exitCode === 0)
      .catch(() => false),
    Bun.$`which ffmpeg`.quiet().nothrow()
      .then((r) => r.exitCode === 0)
      .catch(() => false),
  ]);

  toolCheckCache = { ytdlp: ytdlpOk, ffmpeg: ffmpegOk };
  return toolCheckCache;
}

/** Returns a human-readable message about which tools are missing. */
export async function getToolStatus(): Promise<{
  ytdlp: boolean;
  ffmpeg: boolean;
  message: string;
}> {
  const tools = await checkTools();
  const missing: string[] = [];
  if (!tools.ffmpeg) missing.push("ffmpeg (apt install ffmpeg)");

  return {
    ...tools,
    message:
      missing.length === 0
        ? "All tools available"
        : `Missing: ${missing.join(", ")}`,
  };
}

/* ─────────────────────────────────────────────
   Main Upload Pipeline
   ───────────────────────────────────────────── */

/**
 * Full upload pipeline for a YouTube Shorts clip.
 * Accepts the clip metadata and the request's Cookie header for auth.
 */
export async function uploadClipToYouTube(
  input: UploadClipInput,
  cookieHeader: string | null
): Promise<UploadClipOutcome> {
  // ── 1. Authenticate ──
  const auth = await getValidAccessToken(cookieHeader);
  if (!auth) {
    return {
      success: false,
      code: "NO_AUTH",
      error: "Not connected to YouTube. Connect your channel first.",
    };
  }

  // ── 2. Check tools (only ffmpeg is required; yt-dlp is an optional fallback) ──
  const tools = await checkTools();
  if (!tools.ffmpeg) {
    return {
      success: false,
      code: "MISSING_TOOLS",
      error: "Video processing tool ffmpeg is not installed. Run: apt install ffmpeg",
    };
  }

  // ── 3. Prepare temp directory ──
  const workDir = `/tmp/clipflow-${Date.now()}`;
  const rawClipPath = `${workDir}/raw.mp4`;
  const shortPath = `${workDir}/short.mp4`;

  try {
    await Bun.$`mkdir -p ${workDir}`.quiet();

    // ── 4. Download source video (Supadata API primary, yt-dlp fallback) ──
    console.log(`[ClipFlow] Downloading source video: ${input.videoUrl}`);
    const download = await downloadSourceVideo(input.videoUrl, rawClipPath);
    if (!download.ok) {
      // Clean up
      await Bun.$`rm -rf ${workDir}`.quiet().nothrow();
      return {
        success: false,
        code: "DOWNLOAD_FAILED",
        error: download.error,
      };
    }

    // ── 5. Cut the clip segment and re-encode to vertical 9:16 Shorts ──
    // Both download paths produce the FULL source video in raw.mp4, so we
    // cut the clip with ffmpeg input-seek -ss <start> -t <duration>.
    const clipStart = input.startTime;
    const clipDuration = Math.max(0.1, input.endTime - input.startTime);
    console.log(
      `[ClipFlow] Encoding to vertical 9:16 Shorts format (start=${clipStart}s, dur=${clipDuration}s)`
    );

    const encodeResult = await Bun.$`ffmpeg \
      -ss ${clipStart} \
      -i ${rawClipPath} \
      -t ${clipDuration} \
      -vf "crop=ih*9/16:ih,scale=1080:1920" \
      -c:v libx264 -preset veryfast -crf 23 \
      -c:a aac -b:a 128k \
      -y \
      ${shortPath}`
      .quiet()
      .nothrow();

    if (encodeResult.exitCode !== 0) {
      await Bun.$`rm -rf ${workDir}`.quiet().nothrow();
      return {
        success: false,
        code: "ENCODE_FAILED",
        error: "Failed to encode video to vertical Shorts format.",
      };
    }

    const shortFile = Bun.file(shortPath);
    if (!(await shortFile.exists())) {
      await Bun.$`rm -rf ${workDir}`.quiet().nothrow();
      return {
        success: false,
        code: "ENCODE_FAILED",
        error: "Encoding completed but the output file was not found.",
      };
    }

    // ── 6. Upload to YouTube ──
    console.log(`[ClipFlow] Uploading to YouTube...`);

    const uploadResult = await uploadToYouTubeAPI(
      auth.accessToken,
      shortPath,
      input.title,
      input.description
    );

    // ── 7. Cleanup ──
    await Bun.$`rm -rf ${workDir}`.quiet().nothrow();

    return uploadResult;
  } catch (err) {
    // Clean up temp dir on any unexpected error
    await Bun.$`rm -rf ${workDir}`.quiet().nothrow();

    return {
      success: false,
      code: "API_ERROR",
      error: err instanceof Error ? err.message : "Unexpected error during upload.",
    };
  }
}

/* ─────────────────────────────────────────────
   Video Download (Supadata primary, yt-dlp fallback)
   ───────────────────────────────────────────── */

/**
 * Reads the Supadata API key from the environment, falling back to the
 * project key so the site works without env vars configured.
 */
function supadataApiKey(): string {
  return process.env.SUPADATA_API_KEY || "sd_f8518e4e6943014d9d87d2012fa004a6";
}

interface DownloadSuccess {
  ok: true;
}

interface DownloadFailure {
  ok: false;
  error: string;
}

type DownloadOutcome = DownloadSuccess | DownloadFailure;

/**
 * Download the source video to `rawClipPath`.
 *
 * Strategy:
 *   1. Ask Supadata's download API for a direct video URL (or the bytes).
 *   2. Stream the bytes to disk.
 *   3. If Supadata's API call failed with a plan/limit error (limit-exceeded
 *      or another 4xx), return a clear error — no fallback, because yt-dlp is
 *      bot-blocked from this host anyway.
 *   4. Only if Supadata gave us a URL but the download from it failed do we
 *      fall back to yt-dlp.
 */
export async function downloadSourceVideo(
  videoUrl: string,
  rawClipPath: string
): Promise<DownloadOutcome> {
  // ── Primary: Supadata download API ──
  const res = await fetchSupadataDownload(videoUrl);
  if (res.ok) {
    try {
      const contentType = res.response.headers.get("content-type") || "";
      if (
        contentType.includes("video") ||
        contentType.includes("octet-stream") ||
        contentType.includes("binary")
      ) {
        // Response body IS the video — stream it straight to disk.
        await Bun.write(rawClipPath, res.response);
      } else {
        const data = await res.response.json().catch(() => null);
        const downloadUrl = extractDownloadUrl(data);
        if (!downloadUrl) {
          console.error(
            "[ClipFlow] Supadata download response had no URL field:",
            JSON.stringify(data).slice(0, 500)
          );
          return await downloadViaYtDlpFallback(videoUrl, rawClipPath);
        }
        await downloadVideoBytes(downloadUrl, rawClipPath);
      }

      const file = Bun.file(rawClipPath);
      if (await file.exists()) {
        const size = file.size;
        console.log(`[ClipFlow] Source video downloaded (${size} bytes)`);
        if (size > 0) return { ok: true };
        return {
          ok: false,
          error:
            "Downloaded video file is empty. The source video may be unavailable or restricted.",
        };
      }
      return await downloadViaYtDlpFallback(videoUrl, rawClipPath);
    } catch (err) {
      // The download URL fetch failed (network error, timeout, dead link).
      // Keep yt-dlp as a fallback ONLY in this case.
      console.error("[ClipFlow] Supadata video download failed:", err);
      return await downloadViaYtDlpFallback(videoUrl, rawClipPath);
    }
  }

  // Supadata API call itself failed. For limit/plan errors and other 4xx we
  // surface a clear error to the user instead of trying yt-dlp (bot-blocked).
  console.error(`[ClipFlow] Supadata download API error: ${res.error}`);
  if (res.kind === "limit" || res.kind === "4xx") {
    return { ok: false, error: res.error };
  }
  // 5xx / network failure: try the yt-dlp fallback as a last resort.
  return await downloadViaYtDlpFallback(videoUrl, rawClipPath);
}

/** yt-dlp fallback: download the full video (best <=1080p) to rawClipPath. */
async function downloadViaYtDlpFallback(
  videoUrl: string,
  rawClipPath: string
): Promise<DownloadOutcome> {
  try {
    const dlResult = await Bun.$`yt-dlp \
      -f "best[height<=1080]" \
      -o ${rawClipPath} \
      --no-playlist \
      --no-warnings \
      ${videoUrl}`
      .quiet()
      .nothrow();

    if (dlResult.exitCode !== 0) {
      return {
        ok: false,
        error:
          "Failed to download the video. Supadata download failed and the yt-dlp fallback is blocked on this host (YouTube bot detection).",
      };
    }
    const file = Bun.file(rawClipPath);
    if (!(await file.exists()) || file.size === 0) {
      return {
        ok: false,
        error: "Download completed but the output file was not found.",
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "Failed to download the video (yt-dlp fallback error).",
    };
  }
}

/**
 * Call the Supadata video download API.
 * GET https://api.supadata.ai/v1/youtube/video/download?url=<encoded>
 *
 * The endpoint is not in the public OpenAPI docs, so we handle both JSON
 * responses with a URL field and raw binary/video responses defensively.
 */
async function fetchSupadataDownload(videoUrl: string): Promise<
  | { ok: true; response: Response }
  | { ok: false; error: string; kind: "limit" | "4xx" | "5xx" | "network" }
> {
  const apiUrl = `https://api.supadata.ai/v1/youtube/video/download?url=${encodeURIComponent(videoUrl)}`;
  const TIMEOUT_MS = 60_000;

  try {
    const resp = await fetch(apiUrl, {
      headers: { "x-api-key": supadataApiKey() },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (resp.ok) return { ok: true, response: resp };

    const bodyText = await resp.text().catch(() => "");
    console.error(`[ClipFlow] Supadata download API ${resp.status}: ${bodyText.slice(0, 500)}`);

    // Parse the documented error JSON shape:
    // { "error": "...", "message": "...", "details": "...", "documentationUrl": "..." }
    let parsed: { error?: string; message?: string; details?: string } | null = null;
    try {
      parsed = JSON.parse(bodyText) as typeof parsed;
    } catch {
      parsed = null;
    }

    const isLimit =
      resp.status === 429 ||
      parsed?.error === "limit-exceeded" ||
      (parsed?.error ?? "").toLowerCase().includes("limit");

    if (isLimit) {
      return {
        ok: false,
        kind: "limit",
        error:
          "The video download service limit was reached. Please upgrade the Supadata plan (supadata.ai).",
      };
    }

    if (resp.status >= 400 && resp.status < 500) {
      const reason = parsed
        ? [parsed.message, parsed.details].filter(Boolean).join(" — ")
        : bodyText.trim() || resp.statusText;
      return {
        ok: false,
        kind: "4xx",
        error: `Video download failed (Supadata API ${resp.status}): ${reason || "request rejected"}`,
      };
    }

    return { ok: false, kind: "5xx", error: `Supadata download API returned ${resp.status}` };
  } catch (err) {
    return {
      ok: false,
      kind: "network",
      error: `Supadata download API request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Defensively extract a direct video URL from a Supadata download response.
 * Handles {downloadUrl}, {url}, {videoUrl} and nested {data:*}/{video:*}/{result:*} shapes.
 */
function extractDownloadUrl(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;

  for (const key of ["downloadUrl", "url", "videoUrl", "download_url", "video_url"]) {
    const v = obj[key];
    if (typeof v === "string" && v.startsWith("http")) return v;
  }

  for (const nested of ["data", "video", "result"]) {
    const child = obj[nested];
    if (typeof child === "object" && child !== null) {
      const found = extractDownloadUrl(child);
      if (found) return found;
    }
  }

  // Some shapes wrap URLs in an array, e.g. {formats: [{url, ...}]} —
  // take the first usable entry.
  for (const key of ["formats", "urls", "downloads"]) {
    const list = obj[key];
    if (Array.isArray(list)) {
      for (const entry of list) {
        const found = extractDownloadUrl(entry);
        if (found) return found;
      }
    }
  }

  return null;
}

/** Stream a direct video URL to disk (large files — no full in-memory buffer). */
async function downloadVideoBytes(url: string, destPath: string): Promise<void> {
  // 10-minute cap: a full-length video at a decent bitrate fits well inside it.
  const resp = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!resp.ok) {
    throw new Error(`Video download failed (HTTP ${resp.status})`);
  }
  await Bun.write(destPath, resp);
}

/* ─────────────────────────────────────────────
   YouTube Data API v3 Upload
   ───────────────────────────────────────────── */

async function uploadToYouTubeAPI(
  accessToken: string,
  videoPath: string,
  title: string,
  description: string
): Promise<UploadClipOutcome> {
  const file = Bun.file(videoPath);
  const fileBytes = await file.arrayBuffer();
  const fileBuffer = Buffer.from(fileBytes);

  // Sanitize metadata BEFORE truncation so we never split a surrogate pair
  // (a lone surrogate makes JSON.stringify emit \uD83D-style escapes, which
  // Google rejects with "The string did not match the expected pattern").
  const safeTitle = truncateToCodePoints(sanitizeTitle(title), 100);
  const safeDescription = truncateToCodePoints(
    stripLoneSurrogates(description),
    5000
  );

  // Extract + sanitize tags from hashtags in description
  const tags = extractTags(description);

  // YouTube's resumable upload URL
  const uploadUrl =
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";

  // Step 1: Initiate resumable upload (get upload URL)
  const metadata = {
    snippet: {
      title: safeTitle,
      description: safeDescription,
      tags,
      categoryId: "22", // People & Blogs
    },
    status: {
      privacyStatus: "unlisted",
      selfDeclaredMadeForKids: false,
    },
  };

  try {
    const initResp = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "video/mp4",
        "X-Upload-Content-Length": String(fileBuffer.length),
      },
      body: JSON.stringify(metadata),
    });

    if (!initResp.ok) {
      const errText = await initResp.text();
      console.error("[ClipFlow] Upload initiation failed:", errText);
      return {
        success: false,
        code: "UPLOAD_FAILED",
        error: `YouTube rejected the upload (${initResp.status}): ${parseGoogleError(errText)}`,
      };
    }

    // Get the resumable upload URL from the Location header
    const resumeUrl = initResp.headers.get("Location");
    if (!resumeUrl) {
      return {
        success: false,
        code: "UPLOAD_FAILED",
        error: "YouTube did not return an upload URL.",
      };
    }

    // Step 2: Upload the video bytes
    const uploadResp = await fetch(resumeUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(fileBuffer.length),
      },
      body: fileBuffer,
    });

    if (!uploadResp.ok) {
      const errText = await uploadResp.text();
      console.error("[ClipFlow] Upload failed:", errText);
      return {
        success: false,
        code: "UPLOAD_FAILED",
        error: `Failed to upload video (${uploadResp.status}): ${parseGoogleError(errText)}`,
      };
    }

    const responseData = (await uploadResp.json()) as {
      id: string;
      snippet?: { title?: string };
    };

    const videoId = responseData.id;
    console.log(`[ClipFlow] Upload successful: https://youtube.com/shorts/${videoId}`);

    return {
      success: true,
      videoId,
      videoUrl: `https://youtube.com/shorts/${videoId}`,
    };
  } catch (err) {
    console.error("[ClipFlow] Upload error:", err);
    return {
      success: false,
      code: "API_ERROR",
      error: err instanceof Error ? err.message : "Network error during upload.",
    };
  }
}

/* ─────────────────────────────────────────────
   Metadata Sanitization
   ───────────────────────────────────────────── */

/**
 * Strip anything the YouTube Data API rejects in a snippet.title:
 * emojis, variation selectors, control/format chars, replacement
 * characters and unpaired surrogates. Keeps letters, digits and
 * punctuation (incl. non-ASCII letters like ä/é/ß).
 */
function sanitizeTitle(title: string): string {
  return stripLoneSurrogates(title)
    .replace(/\p{Extended_Pictographic}/gu, "") // emoji pictographs (🤯🔥💡…)
    .replace(/[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu, "") // variation selectors (emoji style)
    .replace(/\p{Cc}/gu, "") // control characters
    .replace(/\p{Cf}/gu, "") // format characters (ZWJ, bidi, soft hyphen…)
    .replace(/[\uFFFD\uFFFE\uFFFF]/gu, "") // replacement char + noncharacters
    .replace(/\s+/g, " ")
    .trim();
}

/** Remove unpaired surrogate halves that break JSON/API string validation. */
function stripLoneSurrogates(s: string): string {
  // eslint-disable-next-line no-misleading-character-class
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/gu, "").replace(
    /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu,
    ""
  );
}

/** Truncate by Unicode code points so we never split a surrogate pair. */
function truncateToCodePoints(s: string, max: number): string {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join("");
}

/** Keep only [a-zA-Z0-9_-], lowercase, max 30 chars (YouTube tag rules). */
function sanitizeTag(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase().slice(0, 30);
}

/** Extract YouTube-compatible tags from description hashtags. */
function extractTags(description: string): string[] {
  const tagRegex = /#([^\s#]+)/g;
  const seen = new Set<string>();
  const tags: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(description)) !== null) {
    const tag = sanitizeTag(match[1]);
    // Drop empty results and dedupe
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
    // YouTube allows max ~30 tags
    if (tags.length >= 30) break;
  }
  return tags;
}

/* ─────────────────────────────────────────────
   Google API Error Parsing
   ───────────────────────────────────────────── */

interface GoogleApiErrorBody {
  error?: {
    code?: number;
    message?: string;
    errors?: Array<{
      message?: string;
      domain?: string;
      reason?: string;
      location?: string;
      locationType?: string;
    }>;
  };
}

/**
 * Parse a Google API error response body and return a human-readable
 * string with the real reason, e.g.:
 *   "The string did not match the expected pattern. — location: snippet.tags[0], reason: invalidValue"
 * Falls back to the raw body text if it isn't the expected JSON shape.
 */
function parseGoogleError(bodyText: string): string {
  try {
    const data = JSON.parse(bodyText) as GoogleApiErrorBody;
    const err = data.error;
    if (err) {
      const parts: string[] = [];
      if (err.message) parts.push(err.message);

      const details: string[] = [];
      for (const e of err.errors ?? []) {
        const bits: string[] = [];
        if (e.location) bits.push(`location: ${e.location}`);
        if (e.reason) bits.push(`reason: ${e.reason}`);
        if (e.message && e.message !== err.message) bits.push(`detail: ${e.message}`);
        if (bits.length > 0) details.push(bits.join(", "));
      }
      if (details.length > 0) parts.push(details.join("; "));

      if (parts.length > 0) return parts.join(" — ");
    }
  } catch {
    // Not JSON — fall through to raw text
  }
  return bodyText.slice(0, 500);
}
