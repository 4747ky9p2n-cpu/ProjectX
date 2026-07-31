/**
 * YouTube Shorts Upload Pipeline
 *
 * Downloads a segment of a YouTube video using yt-dlp, re-encodes it to
 * vertical 9:16 Shorts format using ffmpeg, and uploads it to the user's
 * connected YouTube channel via the YouTube Data API v3.
 *
 * Prerequisites (system):
 *   yt-dlp  — pip3 install yt-dlp
 *   ffmpeg  — apt install ffmpeg (or equivalent)
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
  if (!tools.ytdlp) missing.push("yt-dlp (pip3 install yt-dlp)");
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

  // ── 2. Check tools ──
  const tools = await checkTools();
  if (!tools.ytdlp || !tools.ffmpeg) {
    const missing: string[] = [];
    if (!tools.ytdlp) missing.push("yt-dlp (run: pip3 install yt-dlp)");
    if (!tools.ffmpeg) missing.push("ffmpeg (run: apt install ffmpeg)");
    return {
      success: false,
      code: "MISSING_TOOLS",
      error: `Video processing tools are not installed. Missing: ${missing.join(", ")}`,
    };
  }

  // ── 3. Prepare temp directory ──
  const workDir = `/tmp/clipflow-${Date.now()}`;
  const rawClipPath = `${workDir}/raw.mp4`;
  const shortPath = `${workDir}/short.mp4`;

  try {
    await Bun.$`mkdir -p ${workDir}`.quiet();

    // ── 4. Download clip segment with yt-dlp ──
    const startEnd = `*${input.startTime}-${input.endTime}`;
    console.log(`[ClipFlow] Downloading clip: ${input.videoUrl} [${startEnd}]`);

    const dlResult = await Bun.$`yt-dlp \
      --download-sections ${startEnd} \
      -f "best[height<=1080]" \
      -o ${rawClipPath} \
      --no-playlist \
      --no-warnings \
      ${input.videoUrl}`
      .quiet()
      .nothrow();

    if (dlResult.exitCode !== 0) {
      // Clean up
      await Bun.$`rm -rf ${workDir}`.quiet().nothrow();
      return {
        success: false,
        code: "DOWNLOAD_FAILED",
        error: "Failed to download video segment. The source video may be unavailable or restricted.",
      };
    }

    // Wait for the file to exist
    const rawFile = Bun.file(rawClipPath);
    if (!(await rawFile.exists())) {
      await Bun.$`rm -rf ${workDir}`.quiet().nothrow();
      return {
        success: false,
        code: "DOWNLOAD_FAILED",
        error: "Download completed but the output file was not found.",
      };
    }

    // ── 5. Re-encode to vertical 9:16 Shorts format ──
    console.log(`[ClipFlow] Encoding to vertical 9:16 Shorts format`);

    const encodeResult = await Bun.$`ffmpeg \
      -i ${rawClipPath} \
      -vf "crop=ih*9/16:ih,scale=1080:1920" \
      -c:a copy \
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

  // Truncate title to 100 chars (YouTube limit)
  const safeTitle = title.slice(0, 100);

  // Extract tags from hashtags in description
  const tags = extractTags(description);

  // YouTube's resumable upload URL
  const uploadUrl =
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";

  // Step 1: Initiate resumable upload (get upload URL)
  const metadata = {
    snippet: {
      title: safeTitle,
      description: description.slice(0, 5000), // YouTube limit
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
        error: `YouTube rejected the upload: ${initResp.status} ${initResp.statusText}`,
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
        error: `Failed to upload video: ${uploadResp.status}`,
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
   Helpers
   ───────────────────────────────────────────── */

/** Extract YouTube-compatible tags from description hashtags. */
function extractTags(description: string): string[] {
  const tagRegex = /#(\w+)/g;
  const tags: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(description)) !== null) {
    const tag = match[1];
    // YouTube: max 30 chars per tag, lowercase, no spaces
    if (tag.length <= 30 && !tags.includes(tag)) {
      tags.push(tag);
    }
  }
  return tags.slice(0, 30); // YouTube allows max ~30 tags
}
