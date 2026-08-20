/**
 * YouTube Shorts Upload Pipeline
 *
 * Downloads the source video, cuts the clip segment with ffmpeg, re-encodes
 * it to vertical 9:16 Shorts format, and uploads it to the user's connected
 * YouTube channel via the YouTube Data API v3.
 *
 * Download strategy (all work from datacenter IPs where direct yt-dlp is
 * bot-blocked by YouTube):
 *   1. Piped public API (free, no key) — primary. The instance proxy serves
 *      a muxed mp4 that downloads reliably from this host.
 *   2. Supadata download API (free tier) — first fallback.
 *   3. yt-dlp — last resort, only when the Supadata API gave us a URL but the
 *      download from it failed (bot-blocked on this host, so rarely useful).
 *
 * Prerequisites (system):
 *   ffmpeg  — apt install ffmpeg (or equivalent)
 *   yt-dlp  — optional, fallback only
 */

import { getValidAccessToken } from "./youtube-auth";
import { getValidTikTokToken, tiktokSetupPending } from "./tiktok-auth";
import { uploadToTikTokAPI } from "./tiktok-upload";
import {
  sanitizeDescription,
  sanitizeTitle,
  truncateToCodePoints,
} from "./sanitize";

/* ─────────────────────────────────────────────
   Types
   ───────────────────────────────────────────── */

/** A caption segment as carried on the clip input (source-video-relative). */
export interface CaptionSegment {
  text: string;
  start: number;
  duration: number;
}

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
  /**
   * Caption segments overlapping [startTime, endTime], with start/duration
   * UNCHANGED (relative to the source video, not the clip). Optional: when
   * absent/empty the clip is encoded without burned-in captions.
   */
  segments?: CaptionSegment[];
  /**
   * Where to publish the clip. Defaults to "youtube" (backward compatible).
   * "both" uploads the SAME encoded clip to YouTube and TikTok.
   */
  destination?: UploadDestination;
}

export type UploadDestination = "youtube" | "tiktok" | "both";

/** Per-destination outcome used while composing a "both" upload. */
export type DestinationUploadResult =
  | { ok: true; kind: "youtube"; videoId: string; videoUrl: string }
  | { ok: true; kind: "tiktok"; publishId: string; videoUrl?: string };

export interface DestinationUploadError {
  ok: false;
  code: UploadClipError["code"] | "TIKTOK_FAILED";
  error: string;
}

export type DestinationUploadOutcome =
  | DestinationUploadResult
  | DestinationUploadError;

export interface UploadClipResult {
  success: true;
  /**
   * Top-level values stay backward compatible: YouTube values when "youtube"
   * (or "both") is selected; the TikTok publish_id when "tiktok"-only.
   */
  videoId: string;
  videoUrl: string;
  destination?: UploadDestination;
  /** Per-destination results, present when destination === "both". */
  youtube?: { videoId: string; videoUrl: string };
  tiktok?: { publishId?: string; videoUrl?: string };
  /**
   * Present when a "both" upload partially succeeded (one destination failed
   * while the other succeeded) — e.g. "TikTok failed: <msg>".
   */
  partialError?: string;
  /**
   * Set-Cookie value that persists a ROTATED TikTok refresh token (TikTok
   * refresh tokens are single-use). The HTTP handler must append it.
   */
  tiktokFreshCookie?: string;
}

export interface UploadClipError {
  success: false;
  error: string;
  /** Machine-readable error code for the UI */
  code:
    | "NO_AUTH"
    | "MISSING_TOOLS"
    | "DOWNLOAD_FAILED"
    | "ENCODE_FAILED"
    | "UPLOAD_FAILED"
    | "API_ERROR"
    | "TIKTOK_FAILED";
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
  if (!tools.ytdlp) missing.push("yt-dlp (pip install yt-dlp)");

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
 * Full upload pipeline for a Shorts clip.
 * Downloads the source, cuts/encodes the vertical 9:16 clip ONCE, then
 * uploads the SAME encoded file to every selected destination (YouTube,
 * TikTok, or both). Accepts the clip metadata and the request's Cookie
 * header for auth.
 */
export async function uploadClip(
  input: UploadClipInput,
  cookieHeader: string | null
): Promise<UploadClipOutcome> {
  const destination: UploadDestination = input.destination ?? "youtube";
  // Guard against malformed clients: only youtube/tiktok/both are valid.
  if (
    destination !== "youtube" &&
    destination !== "tiktok" &&
    destination !== "both"
  ) {
    return {
      success: false,
      code: "API_ERROR",
      error: "Invalid destination. Use youtube, tiktok, or both.",
    };
  }
  const needYouTube = destination === "youtube" || destination === "both";
  const needTikTok = destination === "tiktok" || destination === "both";

  // ── 1. Authenticate (per destination) ──
  const [youtubeAuth, tiktokAuth] = await Promise.all([
    needYouTube ? getValidAccessToken(cookieHeader) : Promise.resolve(null),
    needTikTok ? getValidTikTokToken(cookieHeader) : Promise.resolve(null),
  ]);
  const tiktokConfigured = !tiktokSetupPending();

  // Early exits — skip the whole download/encode phase when nothing can be
  // uploaded (single-destination) or no destination has any auth ("both").
  if (destination === "youtube" && !youtubeAuth) {
    return {
      success: false,
      code: "NO_AUTH",
      error: "Not connected to YouTube. Connect your channel first.",
    };
  }
  if (destination === "tiktok" && !tiktokConfigured) {
    return {
      success: false,
      code: "TIKTOK_FAILED",
      error:
        "TikTok is not set up yet — the owner must add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET (TikTok Developer app approved for Content Posting).",
    };
  }
  if (destination === "tiktok" && !tiktokAuth) {
    return {
      success: false,
      code: "NO_AUTH",
      error: "Not connected to TikTok. Connect your TikTok account first.",
    };
  }
  if (destination === "both" && !youtubeAuth && !tiktokAuth) {
    return {
      success: false,
      code: "NO_AUTH",
      error:
        "Connect at least one channel (YouTube or TikTok) to upload this clip.",
    };
  }

  // ── 2. Check tools (ffmpeg required for encoding; yt-dlp required for the
  //        authenticated fallback that bypasses YouTube's anonymous bot-check,
  //        which the free Piped network can no longer do for the owner's videos) ──
  const tools = await checkTools();
  const missingTools: string[] = [];
  if (!tools.ffmpeg) missingTools.push("ffmpeg (Run: apt install ffmpeg)");
  if (!tools.ytdlp) missingTools.push("yt-dlp (Run: pip install yt-dlp)");
  if (missingTools.length > 0) {
    return {
      success: false,
      code: "MISSING_TOOLS",
      error: `Missing required tool(s): ${missingTools.join(", ")}`,
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
    const download = await downloadSourceVideo(
      input.videoUrl,
      rawClipPath,
      cookieHeader
    );
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

    // Build the video filter chain. crop+scale first (1080×1920 canvas), then
    // burn in ASS captions AFTER the scale so text is drawn in the final
    // 1080×1920 coordinate space (large, readable, correctly positioned).
    let vfChain = "crop=ih*9/16:ih,scale=1080:1920";

    // Optional burned-in captions: use the transcript segments the client
    // sent for this clip's time window. Missing/invalid/empty segments are
    // handled gracefully — the clip encodes WITHOUT subtitles.
    const captionSegments = normalizeCaptionSegments(input.segments);
    if (captionSegments.length > 0) {
      if (await assFilterAvailable()) {
        const assPath = `${workDir}/clip.ass`;
        const eventCount = await buildAssFile(
          captionSegments,
          clipStart,
          clipDuration,
          assPath
        );
        if (eventCount > 0) {
          vfChain += `,ass=${assPath}`;
          console.log(
            `[ClipFlow] Burning ${eventCount} caption events into Short (ass=${assPath})`
          );
        } else {
          console.log(
            "[ClipFlow] No caption segments overlap the clip window — encoding without subtitles"
          );
        }
      } else {
        console.log(
          "[ClipFlow] libass subtitles unavailable (no ass filter in ffmpeg) — encoding without subtitles"
        );
      }
    } else {
      console.log(
        "[ClipFlow] No transcript segments for this clip — encoding without subtitles"
      );
    }

    const encodeResult = await Bun.$`ffmpeg \
      -ss ${clipStart} \
      -i ${rawClipPath} \
      -t ${clipDuration} \
      -vf ${vfChain} \
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

    // ── 6. Upload to the selected destination(s) ──
    // The SAME encoded shortPath is uploaded to each destination. Per-
    // destination failures are collected; "both" uploads keep going even if
    // one destination fails, and the outcome reports partial success.
    let youtubeRes: DestinationUploadOutcome | undefined;
    let tiktokRes: DestinationUploadOutcome | undefined;
    let tiktokFreshCookie: string | undefined;

    if (needYouTube) {
      console.log(`[ClipFlow] Uploading to YouTube...`);
      youtubeRes = youtubeAuth
        ? toDestOutcome(
            await uploadToYouTubeAPI(
              youtubeAuth.accessToken,
              shortPath,
              input.title,
              input.description
            )
          )
        : {
            ok: false,
            code: "NO_AUTH",
            error: "YouTube skipped: not connected.",
          };
    }

    if (needTikTok) {
      console.log(`[ClipFlow] Uploading to TikTok...`);
      if (!tiktokConfigured) {
        tiktokRes = {
          ok: false,
          code: "TIKTOK_FAILED",
          error:
            "TikTok is not set up yet — the owner must add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET (TikTok Developer app approved for Content Posting).",
        };
      } else if (!tiktokAuth) {
        tiktokRes = {
          ok: false,
          code: "NO_AUTH",
          error: "TikTok skipped: not connected.",
        };
      } else {
        const res = await uploadToTikTokAPI(
          tiktokAuth.accessToken,
          shortPath,
          input.title,
          input.description
        );
        tiktokRes = res.ok
          ? { ok: true, kind: "tiktok", publishId: res.publishId, videoUrl: res.videoUrl }
          : { ok: false, code: "TIKTOK_FAILED", error: res.error };
        // TikTok refresh tokens rotate on every refresh — persist the new one.
        if (tiktokAuth.freshCookie) tiktokFreshCookie = tiktokAuth.freshCookie;
      }
    }

    // ── 7. Cleanup ──
    await Bun.$`rm -rf ${workDir}`.quiet().nothrow();

    return composeUploadOutcome(
      destination,
      youtubeRes,
      tiktokRes,
      tiktokFreshCookie
    );
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
   Outcome Composition
   ───────────────────────────────────────────── */

/** Convert the YouTube upload result into the shared per-destination shape. */
function toDestOutcome(r: UploadClipOutcome): DestinationUploadOutcome {
  if (r.success) {
    return { ok: true, kind: "youtube", videoId: r.videoId, videoUrl: r.videoUrl };
  }
  return { ok: false, code: r.code, error: r.error };
}

function isYtSuccess(
  r: DestinationUploadOutcome | undefined
): r is Extract<DestinationUploadResult, { kind: "youtube" }> {
  return r?.ok === true && r.kind === "youtube";
}

function isTtSuccess(
  r: DestinationUploadOutcome | undefined
): r is Extract<DestinationUploadResult, { kind: "tiktok" }> {
  return r?.ok === true && r.kind === "tiktok";
}

/**
 * Compose the final UploadClipOutcome from the per-destination results.
 * Top-level videoId/videoUrl stay backward compatible (YouTube values for
 * youtube/both, TikTok publish_id for tiktok-only). "both" uploads that
 * partially succeed return success:true with a `partialError` describing the
 * failed destination; if BOTH destinations fail the overall result is an
 * error listing both messages.
 */
function destErrorMsg(
  r: DestinationUploadOutcome | undefined,
  fallback: string
): string {
  return r && !r.ok ? r.error : fallback;
}

function composeUploadOutcome(
  destination: UploadDestination,
  youtube: DestinationUploadOutcome | undefined,
  tiktok: DestinationUploadOutcome | undefined,
  tiktokFreshCookie?: string
): UploadClipOutcome {
  if (destination === "youtube") {
    if (isYtSuccess(youtube)) {
      return {
        success: true,
        videoId: youtube.videoId,
        videoUrl: youtube.videoUrl,
        destination,
        tiktokFreshCookie,
      };
    }
    if (!youtube) {
      return { success: false, code: "API_ERROR", error: "No YouTube upload was attempted." };
    }
    if (youtube.ok === false) {
      return { success: false, code: youtube.code, error: youtube.error };
    }
    return {
      success: false,
      code: "API_ERROR",
      error: "YouTube upload returned an unexpected result.",
    };
  }

  if (destination === "tiktok") {
    if (isTtSuccess(tiktok)) {
      return {
        success: true,
        videoId: tiktok.publishId,
        videoUrl: tiktok.videoUrl ?? "",
        destination,
        tiktok: { publishId: tiktok.publishId, videoUrl: tiktok.videoUrl },
        tiktokFreshCookie,
      };
    }
    if (!tiktok) {
      return { success: false, code: "API_ERROR", error: "No TikTok upload was attempted." };
    }
    if (tiktok.ok === false) {
      return { success: false, code: tiktok.code, error: tiktok.error };
    }
    return {
      success: false,
      code: "API_ERROR",
      error: "TikTok upload returned an unexpected result.",
    };
  }

  // destination === "both"
  if (isYtSuccess(youtube) && isTtSuccess(tiktok)) {
    return {
      success: true,
      videoId: youtube.videoId,
      videoUrl: youtube.videoUrl,
      destination: "both",
      youtube: { videoId: youtube.videoId, videoUrl: youtube.videoUrl },
      tiktok: { publishId: tiktok.publishId, videoUrl: tiktok.videoUrl },
      tiktokFreshCookie,
    };
  }
  if (isYtSuccess(youtube)) {
    return {
      success: true,
      videoId: youtube.videoId,
      videoUrl: youtube.videoUrl,
      destination: "both",
      youtube: { videoId: youtube.videoId, videoUrl: youtube.videoUrl },
      partialError: `TikTok failed: ${destErrorMsg(tiktok, "unknown error")}`,
      tiktokFreshCookie,
    };
  }
  if (isTtSuccess(tiktok)) {
    return {
      success: true,
      videoId: tiktok.publishId,
      videoUrl: tiktok.videoUrl ?? "",
      destination: "both",
      tiktok: { publishId: tiktok.publishId, videoUrl: tiktok.videoUrl },
      partialError: `YouTube failed: ${destErrorMsg(youtube, "unknown error")}`,
      tiktokFreshCookie,
    };
  }

  // Both destinations failed — surface both messages.
  const parts = [
    youtube ? `YouTube: ${destErrorMsg(youtube, "unknown error")}` : null,
    tiktok ? `TikTok: ${destErrorMsg(tiktok, "unknown error")}` : null,
  ].filter(Boolean);
  return {
    success: false,
    code: "UPLOAD_FAILED",
    error: parts.join(" — ") || "Both uploads failed.",
  };
}

/* ─────────────────────────────────────────────
   Video Download (Piped primary, Supadata fallback, yt-dlp last resort)
   ───────────────────────────────────────────── */

/**
 * Piped API instances to try, in order. The first one is confirmed working
 * from this host (2026-08): the instance's own proxy serves a muxed mp4.
 *
 * The public Piped instance ecosystem collapsed to a single registered
 * instance in 2026-08 — verified live on 2026-08-12 via
 * `GET <instance>/streams/<videoId>` against the owner's failing video:
 *
 *   ✅ api.piped.private.coffee  → HTTP 200, muxed mp4 via proxy.piped.private.coffee
 *   ❌ pipedapi.kavin.rocks      → HTTP 526 (Cloudflare SSL origin error)
 *   ❌ pipedapi.adminforge.de    → HTTP 404 HTML error page
 *   ❌ pipedapi.drgns.space      → connection refused
 *   ❌ pipedapi.ducks.party, piped-api.lunar.icu, pipedapi.tokhmi.xyz, … → refused
 *   ❌ pipedapi.leptons.xyz      → HTTP 403 Cloudflare challenge
 *   ❌ pipedapi.moomoo.me        → HTTP 502
 *   ❌ pipedapi.r4fo.com, pipedapi.orangenet.cc, pipedapi.whatever.social → HTTP 200 HTML shell, no API
 *   ❌ pipedapi.vern.cc          → HTTP 404
 *
 * The dead entries are kept at the end of the list rather than removed:
 * they are historically stable and may come back, and the health probe +
 * failure cooldown below make them cost ~nothing to skip (never a full 20s
 * timeout). The runtime registry lookup at the top of `downloadViaPiped`
 * additionally picks up any instance that (re-)registers, so the list
 * self-heals without a code change.
 */
const PIPED_INSTANCES = [
  "https://api.piped.private.coffee",
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.drgns.space",
  "https://pipedapi.ducks.party",
  "https://pipedapi.leptons.xyz",
  "https://pipedapi.moomoo.me",
  "https://pipedapi.r4fo.com",
  "https://pipedapi.orangenet.cc",
  "https://pipedapi.vern.cc",
  "https://piped-api.lunar.icu",
  "https://pipedapi.whatever.social",
];

/**
 * Official Piped instance registry (maintained by the Piped project):
 * `https://piped-instances.kavin.rocks/` returns the CURRENT registered
 * instances as JSON, e.g. [{ "api_url": "https://api.piped.private.coffee", … }].
 * Consulted at runtime (cached 10 min) so new/returning instances are picked
 * up automatically; the static `PIPED_INSTANCES` list is the fallback when
 * the registry is unreachable.
 */
const PIPED_INSTANCE_REGISTRY_URL = "https://piped-instances.kavin.rocks/";
const PIPED_REGISTRY_TTL_MS = 10 * 60_000;
const PIPED_REGISTRY_TIMEOUT_MS = 4_000;
let pipedRegistryCache: { instances: string[]; fetchedAt: number } | null = null;

/** Instances that failed recently are skipped for 60s (bounded Map). */
const PIPED_INSTANCE_COOLDOWN_MS = 60_000;
const pipedRecentlyFailed = new Map<string, number>();

/** Fast health-probe results per instance, cached 5 min. */
const PIPED_HEALTH_TTL_MS = 5 * 60_000;
const pipedHealthCache = new Map<string, { healthy: boolean; checkedAt: number }>();

function isPipedInstanceInCooldown(instance: string): boolean {
  const expiry = pipedRecentlyFailed.get(instance);
  return expiry !== undefined && Date.now() < expiry;
}

function markPipedInstanceFailed(instance: string): void {
  pipedRecentlyFailed.set(instance, Date.now() + PIPED_INSTANCE_COOLDOWN_MS);
  // Bound the map: prune expired entries once it grows past 64 instances.
  if (pipedRecentlyFailed.size > 64) {
    const now = Date.now();
    for (const [key, expiry] of pipedRecentlyFailed) {
      if (expiry <= now) pipedRecentlyFailed.delete(key);
    }
  }
}

/**
 * Lightweight liveness probe (<2.5s) so dead hosts are skipped instead of
 * burning a 20s streams timeout. Any HTTP response counts as reachable (even
 * a 404/5xx — the streams call surfaces the real error); only network-level
 * failures (DNS, connection refused, timeout) mark the instance unhealthy.
 */
async function pipedInstanceIsReachable(instance: string): Promise<boolean> {
  const cached = pipedHealthCache.get(instance);
  if (cached && Date.now() - cached.checkedAt < PIPED_HEALTH_TTL_MS) {
    return cached.healthy;
  }
  let healthy = true;
  try {
    await fetch(`${instance}/healthcheck`, { signal: AbortSignal.timeout(2_500) });
  } catch {
    healthy = false;
  }
  pipedHealthCache.set(instance, { healthy, checkedAt: Date.now() });
  return healthy;
}

/**
 * Fetch the current registered Piped instances from the official registry
 * (cached for PIPED_REGISTRY_TTL_MS). Returns [] on any failure so callers
 * simply fall back to the static list.
 */
async function discoverRegisteredPipedInstances(): Promise<string[]> {
  const now = Date.now();
  if (pipedRegistryCache && now - pipedRegistryCache.fetchedAt < PIPED_REGISTRY_TTL_MS) {
    return pipedRegistryCache.instances;
  }
  try {
    const resp = await fetch(PIPED_INSTANCE_REGISTRY_URL, {
      signal: AbortSignal.timeout(PIPED_REGISTRY_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`registry HTTP ${resp.status}`);
    const data = (await resp.json()) as unknown;
    const instances: string[] = [];
    if (Array.isArray(data)) {
      for (const entry of data) {
        if (typeof entry === "object" && entry !== null) {
          const url = (entry as Record<string, unknown>).api_url;
          if (typeof url === "string" && url.startsWith("http")) {
            instances.push(url.replace(/\/+$/, ""));
          }
        }
      }
    }
    pipedRegistryCache = { instances, fetchedAt: now };
    return instances;
  } catch (err) {
    console.error(
      `[ClipFlow] Piped instance registry unreachable (${err instanceof Error ? err.message : String(err)}) — using static list`
    );
    pipedRegistryCache = { instances: [], fetchedAt: now }; // don't hammer a dead registry
    return [];
  }
}

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
 *   1. Piped public API (free, no key) — primary. Try registered instances
 *      first (live registry, cached), then the static `PIPED_INSTANCES`
 *      fallback. Each instance gets a health probe, retry/backoff on
 *      transient failures, and HTML/size validation so garbage is never
 *      written to disk. The first instance that yields a real muxed mp4 wins.
 *   2. If Piped failed on every instance, ask Supadata's download API for a
 *      direct video URL (or the bytes) and stream them to disk.
 *   3. If Supadata's API call failed with a plan/limit error (limit-exceeded
 *      or another 4xx), return a clear error — no fallback, because yt-dlp is
 *      bot-blocked from this host anyway.
 *   4. Only if Supadata gave us a URL but the download from it failed do we
 *      fall back to yt-dlp.
 */
export async function downloadSourceVideo(
  videoUrl: string,
  rawClipPath: string,
  cookieHeader: string | null = null
): Promise<DownloadOutcome> {
  // ── Primary: Piped public API (free, no key) ──
  const piped = await downloadViaPiped(videoUrl, rawClipPath);
  if (piped.ok) return piped;
  // Fallback 1 (new): Authenticated yt-dlp using the owner's YouTube OAuth.
  // The free Piped network is near-dead and its lone live instance anonymously
  // bot-blocks the owner's source videos (HTTP 500 SignInConfirmNotBotException).
  // YouTube treats authenticated requests differently, so retry directly with
  // the owner's OAuth access token (read from the youtube_auth request cookie),
  // which bypasses the bot-check. Only attempted when a valid token exists.
  const authenticated = await tryYtDlpAuthenticated(
    videoUrl,
    rawClipPath,
    cookieHeader
  );
  if (authenticated.ok) return authenticated;
  if (authenticated.tried) {
    console.error(
      `[ClipFlow] Authenticated yt-dlp download failed: ${authenticated.error}`
    );
  }

  // ── Fallback 2: Supadata download API ──
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
        await streamResponseToFile(res.response, rawClipPath);
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
  // NOTE: on the free Supadata tier the download endpoint returns 404 with
  // body `{"error":"Not Found"}` — that is expected and logged here; the
  // Piped path is the primary download mechanism and Supadata only works
  // once the plan is upgraded (or the endpoint becomes available).
  console.error(`[ClipFlow] Supadata download API error: ${res.error}`);
  if (res.kind === "limit" || res.kind === "4xx") {
    return { ok: false, error: res.error };
  }
  // 5xx / network failure: try the yt-dlp fallback as a last resort.
  return await downloadViaYtDlpFallback(videoUrl, rawClipPath);
}

/**
 * Extract a YouTube video ID from a watch/shorts/youtu.be/embed URL.
 * Returns null if the URL doesn't look like a YouTube video URL.
 */
function extractYouTubeVideoId(videoUrl: string): string | null {
  const m = videoUrl.match(
    /(?:[?&]v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

/** Minimum plausible size (bytes) of a real muxed mp4 stream. */
const MIN_MUXED_STREAM_BYTES = 50_000;

/**
 * Pick the best muxed mp4 stream from a Piped `/streams/<id>` response.
 * Piped's `videoStreams` are muxed (video+audio); prefer 720p, then 360p,
 * then any other real YouTube mp4. LBRY/Odysee mirrors (player.odycdn.com)
 * are excluded — they are unrelated re-uploads and are not YouTube content.
 * Streams whose reported `contentLength` is implausibly small (< 50 KB) are
 * rejected: HTML/error responses and broken entries are tiny, a real muxed
 * mp4 never is.
 */
function pickBestPipedMp4Stream(
  streams: unknown
): { url: string } | null {
  if (!Array.isArray(streams)) return null;
  let best: { url: string; rank: number } | null = null;
  for (const s of streams) {
    if (typeof s !== "object" || s === null) continue;
    const entry = s as Record<string, unknown>;
    const mime = typeof entry.mimeType === "string" ? entry.mimeType : "";
    const url = typeof entry.url === "string" ? entry.url : "";
    const quality = typeof entry.quality === "string" ? entry.quality : "";
    if (!mime.includes("mp4") || !url) continue;
    if (url.includes("player.odycdn.com") || quality === "LBRY") continue;
    // Reject implausibly small muxed streams. Missing/string contentLength is
    // fine — not every instance reports it (guard with the > 0 check).
    const contentLength = Number(entry.contentLength ?? entry.size ?? 0);
    if (
      Number.isFinite(contentLength) &&
      contentLength > 0 &&
      contentLength < MIN_MUXED_STREAM_BYTES
    ) {
      continue;
    }
    const rank = quality.includes("720") ? 3 : quality.includes("360") ? 2 : 1;
    if (!best || rank > best.rank) best = { url, rank };
  }
  return best ? { url: best.url } : null;
}

/**
 * Quick sanity check that the downloaded file is actually video bytes and not
 * an HTML error/challenge page (which some Piped/Invidious endpoints return
 * with a 200 status). mp4/mkv files never start with '<' or a JSON brace.
 */
async function looksLikeVideoFile(path: string): Promise<boolean> {
  // Real video files are always > 100 KB; HTML/challenge/error pages are
  // ~7-60 KB. A pure size check avoids fragile content sniffing on files
  // that were just written by the same process (Bun quirk: reading back the
  // first bytes immediately can misbehave). Anything that slips through
  // fails loudly at the ffmpeg step with a clear error.
  try {
    const file = Bun.file(path);
    return (await file.exists()) && file.size >= 100_000;
  } catch {
    return false;
  }
}

/** Attempts per instance: 1 initial + 2 retries with backoff. */
const PIPED_MAX_ATTEMPTS = 3;
const PIPED_RETRY_BACKOFFS_MS = [500, 1000];

interface PipedAttemptFailure {
  /** True when the failure is likely transient and worth a retry. */
  transient: boolean;
  reason: string;
}

/**
 * Primary (free) download path: Piped public API, no key required.
 *
 * Order of attempts:
 *   1. Instances currently registered in the official Piped registry
 *      (cached 10 min) — the list self-heals as instances come and go.
 *   2. Static `PIPED_INSTANCES` fallback list (deduped against the registry).
 *
 * Per instance:
 *   - skip when the instance failed within the last 60s (cooldown) and skip
 *     dead hosts via a <2.5s /healthcheck probe instead of a 20s timeout;
 *   - `tryDownloadFromInstance` retries transient failures (HTTP 5xx/429,
 *     network errors, HTML/unparseable bodies) up to 2 extra times with
 *     500ms/1000ms backoff, and never writes HTML or implausibly small
 *     streams to disk.
 *
 * Total runtime stays bounded: dead instances are skipped by the probe (≤2.5s
 * each, cached 5 min) and a retry is only attempted when the previous attempt
 * failed fast — a 20s timeout is treated as "instance is effectively dead".
 */
async function downloadViaPiped(
  videoUrl: string,
  rawClipPath: string
): Promise<DownloadOutcome> {
  const videoId = extractYouTubeVideoId(videoUrl);
  if (!videoId) {
    console.error(`[ClipFlow] Could not extract a YouTube video ID from: ${videoUrl}`);
    return { ok: false, error: "Invalid YouTube URL." };
  }

  const registered = await discoverRegisteredPipedInstances();
  const orderedInstances = [
    ...registered,
    ...PIPED_INSTANCES.filter((inst) => !registered.includes(inst)),
  ];

  for (const instance of orderedInstances) {
    if (isPipedInstanceInCooldown(instance)) {
      console.log(`[ClipFlow] Skipping ${instance} (in 60s failure cooldown)`);
      continue;
    }
    if (!(await pipedInstanceIsReachable(instance))) {
      console.log(`[ClipFlow] Skipping ${instance} (health probe failed)`);
      markPipedInstanceFailed(instance);
      continue;
    }

    const outcome = await tryDownloadFromInstance(instance, videoId, rawClipPath);
    if (outcome.ok) return outcome;
    markPipedInstanceFailed(instance);
  }

  return {
    ok: false,
    error: "Piped download failed on all instances — trying Supadata.",
  };
}

/**
 * Try to download the video from one Piped instance, retrying transient
 * failures (HTTP 5xx/429, network errors, HTML/unparseable bodies) with a
 * short backoff. Deterministic failures (4xx, no muxed stream, bad file) are
 * not retried.
 */
async function tryDownloadFromInstance(
  instance: string,
  videoId: string,
  rawClipPath: string
): Promise<DownloadOutcome> {
  for (let attempt = 1; attempt <= PIPED_MAX_ATTEMPTS; attempt++) {
    const failure = await attemptPipedStreamsFetch(instance, videoId, rawClipPath);
    if (failure === null) return { ok: true };

    console.error(
      `[ClipFlow] Piped attempt ${attempt}/${PIPED_MAX_ATTEMPTS} on ${instance} failed: ${failure.reason}`
    );
    if (attempt < PIPED_MAX_ATTEMPTS && failure.transient) {
      const backoff = PIPED_RETRY_BACKOFFS_MS[attempt - 1] ?? 1000;
      await new Promise((resolve) => setTimeout(resolve, backoff));
      continue;
    }
    return {
      ok: false,
      error: `Piped download failed on ${instance}: ${failure.reason}`,
    };
  }
  return { ok: false, error: `Piped download failed on ${instance}` };
}

/**
 * One full attempt against one instance: GET /streams, validate the body,
 * pick the best muxed mp4, download it, and verify the written file. Returns
 * null on success, or a failure descriptor (with `transient` set when a retry
 * is likely to help).
 */
async function attemptPipedStreamsFetch(
  instance: string,
  videoId: string,
  rawClipPath: string
): Promise<PipedAttemptFailure | null> {
  try {
    const apiUrl = `${instance}/streams/${videoId}`;
    const resp = await fetch(apiUrl, { signal: AbortSignal.timeout(20_000) });
    if (!resp.ok) {
      const transient = resp.status === 429 || resp.status >= 500;
      return { transient, reason: `HTTP ${resp.status}` };
    }

    // Some instances answer HTML error/challenge pages with HTTP 200 —
    // never treat those as a valid stream response.
    const contentType = (resp.headers.get("content-type") || "").toLowerCase();
    const text = await resp.text();
    if (contentType.includes("text/html") || /^\s*</.test(text)) {
      return { transient: true, reason: "instance returned an HTML error page" };
    }

    let data: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(text) as unknown;
      data = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      data = null;
    }
    if (!data || data.error) {
      return { transient: true, reason: "response was not usable Piped JSON" };
    }

    const stream = pickBestPipedMp4Stream(data.videoStreams);
    if (!stream) {
      return { transient: false, reason: "no usable muxed mp4 stream in response" };
    }

    // Some instances return relative stream URLs that are served by their
    // own proxy — resolve them against the instance proxy (or the API host).
    let downloadUrl = stream.url;
    if (downloadUrl.startsWith("/")) {
      const proxy = typeof data.proxyUrl === "string" ? data.proxyUrl : instance;
      downloadUrl = `${proxy}${downloadUrl}`;
    }

    // Never let a previous failed attempt's partial/garbage bytes linger.
    await Bun.$`rm -f ${rawClipPath}`.quiet().nothrow();

    await downloadVideoBytes(downloadUrl, rawClipPath);
    if (await looksLikeVideoFile(rawClipPath)) {
      const size = Bun.file(rawClipPath).size;
      console.log(`[ClipFlow] Source video downloaded via Piped (${instance}, ${size} bytes)`);
      return null;
    }
    return { transient: false, reason: "downloaded file was not a valid video (HTML/tiny/empty)" };
  } catch (err) {
    // Network error / timeout / aborted stream write. 4xx on the stream URL
    // itself is deterministic — don't retry it; everything else may be
    // transient (5xx, connection reset, timeout).
    const msg = err instanceof Error ? err.message : String(err);
    const transient = !msg.includes("Video download failed (HTTP 4");
    return { transient, reason: msg };
  }
}

/**
 * Authenticated yt-dlp download: retry the source video directly against
 * YouTube using the owner's YouTube OAuth access token (from the `youtube_auth`
 * request cookie). YouTube treats authenticated requests differently from the
 * anonymous ones Piped/Supadata make, so this bypasses the "Sign in to confirm
 * you're not a bot" block that Piped's lone live instance currently hits for
 * the owner's source videos.
 *
 * Returns `tried: false` when no valid token is present (caller skips straight
 * to Supadata); `tried: true` once a real authenticated attempt has been made.
 */
export async function tryYtDlpAuthenticated(
  videoUrl: string,
  rawClipPath: string,
  cookieHeader: string | null
): Promise<DownloadOutcome & { tried: boolean }> {
  const auth = cookieHeader ? await getValidAccessToken(cookieHeader) : null;
  if (!auth) {
    console.log(
      "[ClipFlow] No YouTube OAuth token in cookie - skipping authenticated yt-dlp path."
    );
    return { ok: false, error: "No YouTube OAuth token in cookie.", tried: false };
  }
  console.log(
    "[ClipFlow] Piped failed; retrying download via AUTHENTICATED yt-dlp with the owner's YouTube OAuth."
  );
  const outcome = await downloadViaYtDlpFallback(
    videoUrl,
    rawClipPath,
    auth.accessToken
  );
  return { ...outcome, tried: true };
}
/** yt-dlp download of the full video (best <=1080p) to rawClipPath.
 *  When `authBearer` is provided, the owner's YouTube OAuth access token is
 *  attached as an Authorization: Bearer header so the request is treated as
 *  authenticated (bypassing the anonymous bot-check). */
export async function downloadViaYtDlpFallback(
  videoUrl: string,
  rawClipPath: string,
  authBearer: string | null = null
): Promise<DownloadOutcome> {
  try {
    // Pass --add-header and its full value ("Authorization: Bearer <token>") as
    // SEPARATE argv elements (Bun.$ spreads arrays in the template literal).
    // Inlining them into one quoted string made yt-dlp treat the whole thing as
    // a single option ("no such option: --add-header \"Authorization:...\"") and
    // would split the header value on spaces.
    const headerArgs = authBearer
      ? ["--add-header", `Authorization: Bearer ${authBearer}`]
      : [];
    const dlResult = await Bun.$`yt-dlp \
      -f "best[height<=1080]" \
      -o ${rawClipPath} \
      --no-playlist \
      --no-warnings \
      ${headerArgs} \
      ${videoUrl}`
      .nothrow();
    if (dlResult.exitCode !== 0) {
      const stderr = (
        dlResult.stderr?.toString?.() ?? String(dlResult.stderr ?? "")
      ).toLowerCase();
      if (authBearer) {
        if (stderr.includes("sign in to confirm")) {
          return {
            ok: false,
            error:
              "Download failed even while signed in with your connected YouTube account. The video may be age-restricted or otherwise restricted from direct download (YouTube still enforced a sign-in/membership wall).",
          };
        }
        if (
          stderr.includes("members-only") ||
          stderr.includes("private video")
        ) {
          return {
            ok: false,
            error:
              "This video is members-only/private and cannot be downloaded even when signed in with your connected account.",
          };
        }
        return {
          ok: false,
          error:
            "Authenticated download failed. The video could not be downloaded even with your connected YouTube account.",
        };
      }
      return {
        ok: false,
        error:
          "Failed to download the video. Supadata download failed and the anonymous yt-dlp fallback is blocked on this host (YouTube bot detection).",
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
      const raw = JSON.parse(bodyText);
      if (raw && typeof raw === "object") {
        parsed = raw as { error?: string; message?: string; details?: string };
      }
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

/**
 * Stream a direct video URL to disk (large files — no full in-memory buffer).
 *
 * NOTE: `Bun.write(destPath, resp)` (Response) HANGS on this Bun version when
 * the body is large — the fetch resolves but the write never completes. So we
 * drain the body manually through a Bun file writer, which streams properly.
 */
async function downloadVideoBytes(url: string, destPath: string): Promise<void> {
  // 10-minute cap: a full-length video at a decent bitrate fits well inside it.
  const resp = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!resp.ok) {
    throw new Error(`Video download failed (HTTP ${resp.status})`);
  }
  // Some Piped proxies answer error/challenge pages with HTTP 200 and
  // text/html — reject those BEFORE streaming so HTML is never written to
  // disk. (A real mp4 is video/mp4 or application/octet-stream.)
  const contentType = (resp.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("text/html") || contentType.includes("text/plain")) {
    throw new Error("Stream URL returned an HTML/text error page instead of video bytes");
  }
  await streamResponseToFile(resp, destPath);
}

/** Drain a fetch Response body to disk via a Bun file writer (streaming). */
async function streamResponseToFile(resp: Response, destPath: string): Promise<void> {
  const writer = Bun.file(destPath).writer();
  try {
    for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
      await writer.write(chunk);
    }
  } finally {
    try {
      // Bun's FileSink.end() is not a promise on this version — await is a
      // no-op if it returns void, and works if it ever returns a promise.
      await writer.end();
    } catch {
      // Ignore end() failures; the chunk writes already happened.
    }
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

  // Sanitize metadata BEFORE truncation so we never split a surrogate pair
  // (a lone surrogate makes JSON.stringify emit \uD83D-style escapes, which
  // Google rejects with "The string did not match the expected pattern").
  // The description gets the same treatment: Google's Data API also rejects
  // control characters in snippet.description with 400 "The string did not
  // match the expected pattern" — sanitizeDescription strips them while
  // keeping legitimate newlines, tabs, emojis and format chars intact.
  const safeTitle = truncateToCodePoints(sanitizeTitle(title), 100);
  const safeDescription = truncateToCodePoints(sanitizeDescription(description), 5000);

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
      privacyStatus: "public",
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
      const googleError = parseGoogleError(errText);
      logRejectedMetadata(
        "initiation POST",
        initResp.status,
        googleError,
        safeTitle,
        safeDescription,
        tags
      );
      console.error("[ClipFlow] Upload initiation failed:", errText);
      return {
        success: false,
        code: "UPLOAD_FAILED",
        error: `YouTube rejected the upload (${initResp.status}): ${googleError}`,
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
      const googleError = parseGoogleError(errText);
      logRejectedMetadata(
        "video PUT",
        uploadResp.status,
        googleError,
        safeTitle,
        safeDescription,
        tags
      );
      console.error("[ClipFlow] Upload failed:", errText);
      return {
        success: false,
        code: "UPLOAD_FAILED",
        error: `Failed to upload video (${uploadResp.status}): ${googleError}`,
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
   Burned-in Captions (ASS)
   ───────────────────────────────────────────── */

/**
 * ASS rendering constants for 1080×1920 Shorts captions.
 * Chosen so captions are large and readable, never overflow the frame, and
 * sit safely above the bottom UI (progress bar / buttons):
 *   - Fontsize 78 on a 1080×1920 canvas (≈ big, TikTok-style captions)
 *   - White text with BorderStyle=1 outline (5px) + shadow (2px) for contrast
 *   - Alignment=2 (bottom center) with MarginV=160 — clear of the bottom edge
 *   - WrapStyle=2 (no auto-wrap) + explicit \N wrapping at ≤ 30 chars/line,
 *     max 2 lines per event, so a caption can never run off the 1080px width
 */
const ASS_FONT = "Arial";
const ASS_FONT_SIZE = 78;
const ASS_OUTLINE = 5;
const ASS_SHADOW = 2;
const ASS_MARGIN_V = 160;
const ASS_MAX_LINE_CHARS = 30;
const ASS_MAX_LINES = 2;

/** ffmpeg libass filter availability, checked once per process. */
let assFilterAvailableCache: boolean | null = null;

async function assFilterAvailable(): Promise<boolean> {
  if (assFilterAvailableCache !== null) return assFilterAvailableCache;
  try {
    const out = await Bun.$`ffmpeg -hide_banner -filters`.quiet().text();
    assFilterAvailableCache = /\bass\s+V->V\b/.test(out);
  } catch {
    assFilterAvailableCache = false;
  }
  if (!assFilterAvailableCache) {
    console.log(
      "[ClipFlow] ffmpeg has no ass filter (libass missing) — captions will be skipped"
    );
  }
  return assFilterAvailableCache;
}

/**
 * Normalize the client-supplied caption segments defensively. Anything that
 * is not a well-formed {text, start, duration} entry is dropped; a non-array
 * (undefined, null, garbage) becomes [] so subtitles degrade gracefully.
 */
function normalizeCaptionSegments(raw: unknown): CaptionSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: CaptionSegment[] = [];
  for (const s of raw) {
    if (typeof s !== "object" || s === null) continue;
    const seg = s as Record<string, unknown>;
    if (
      typeof seg.text === "string" &&
      seg.text.trim().length > 0 &&
      typeof seg.start === "number" &&
      Number.isFinite(seg.start) &&
      typeof seg.duration === "number" &&
      Number.isFinite(seg.duration)
    ) {
      out.push({ text: seg.text, start: seg.start, duration: seg.duration });
    }
  }
  return out;
}

/**
 * Escape ASS override-block characters in caption text: `{`/`}` delimit
 * override blocks and a lone `\` starts a tag, so they must be escaped or
 * the text would be interpreted as styling (or swallowed entirely). Existing
 * newlines are collapsed to single spaces (line breaks come from \N only).
 */
function escapeAssText(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}");
}

/**
 * Wrap caption text into at most ASS_MAX_LINES lines of at most
 * ASS_MAX_LINE_CHARS characters each, joined with ASS \N breaks, so text can
 * never overflow the 1080px canvas. Words are packed greedily; a single word
 * longer than a line is hard-split across lines; anything that does not fit
 * on the last line is truncated with an ellipsis.
 */
function wrapAssText(raw: string): string {
  const words = raw.split(/\s+/).filter(Boolean);
  const lines: string[] = [];

  for (let i = 0; i < words.length; i++) {
    let word = words[i];

    // Unbreakable token longer than a whole line: hard-split it.
    while (word.length > ASS_MAX_LINE_CHARS && lines.length < ASS_MAX_LINES) {
      lines.push(word.slice(0, ASS_MAX_LINE_CHARS));
      word = word.slice(ASS_MAX_LINE_CHARS);
    }
    if (word.length === 0) continue;

    const lastIdx = lines.length - 1;
    const current = lines.length > 0 ? lines[lastIdx] : "";
    const candidate = current ? `${current} ${word}` : word;

    if (lines.length === 0) {
      lines.push(word);
    } else if (candidate.length <= ASS_MAX_LINE_CHARS) {
      lines[lastIdx] = candidate;
    } else if (lines.length < ASS_MAX_LINES) {
      lines.push(word);
    } else {
      // Both lines are full — truncate the last line with an ellipsis.
      lines[lastIdx] = truncateToCodePoints(lines[lastIdx], ASS_MAX_LINE_CHARS - 1) + "…";
      break;
    }
  }

  return lines.join("\\N");
}

/** ASS timestamp H:MM:SS.cc (centiseconds). */
function formatAssTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(c, 2)}`;
}

/**
 * Build an ASS subtitle file for a clip from source-relative caption segments
 * and write it to `assPath`.
 *
 * Timestamps are shifted by -clipStart (so they align with the clip timeline,
 * which starts at 0 after the ffmpeg -ss cut) and clamped to [0, clipDuration];
 * segments that fall entirely outside the window are dropped. Returns the
 * number of Dialogue events written (0 = nothing to render, no file created).
 */
export async function buildAssFile(
  segments: CaptionSegment[],
  clipStart: number,
  clipDuration: number,
  assPath: string
): Promise<number> {
  const clipEnd = clipStart + clipDuration;
  const events: string[] = [];

  for (const seg of segments) {
    const text = escapeAssText(seg.text);
    if (!text) continue;

    const segEnd = seg.start + Math.max(0, seg.duration);
    // Drop segments entirely outside the clip window.
    if (segEnd <= clipStart || seg.start >= clipEnd) continue;

    let start = Math.max(0, seg.start - clipStart);
    let end = Math.min(clipDuration, segEnd - clipStart);
    // ASS needs start < end; guarantee a minimal renderable duration.
    if (end - start < 0.1) end = Math.min(clipDuration, start + 0.1);
    if (end <= start) continue;

    const wrapped = wrapAssText(text);
    if (!wrapped) continue;

    events.push(
      `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,${wrapped}`
    );
  }

  if (events.length === 0) return 0;

  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${ASS_FONT},${ASS_FONT_SIZE},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${ASS_OUTLINE},${ASS_SHADOW},2,60,60,${ASS_MARGIN_V},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;

  await Bun.write(assPath, ass);
  return events.length;
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
 * Log the exact sanitized metadata that was sent to YouTube when a request
 * is rejected with a 4xx, so any future rejection (invalidDescription,
 * invalidValue, pattern mismatch, ...) is diagnosable from .run/server.log
 * without guessing. JSON.stringify is used so invisible/control characters
 * surface as \u escapes in the log. User-facing errors are NOT changed here.
 */
function logRejectedMetadata(
  phase: string,
  status: number,
  googleError: string,
  title: string,
  description: string,
  tags: string[]
): void {
  console.error(
    `[ClipFlow] ${phase} rejected with HTTP ${status}: ${googleError}`
  );
  console.error(
    `[ClipFlow] FAILING SANITIZED METADATA: title=${JSON.stringify(title)} description=${JSON.stringify(description)} tags=${JSON.stringify(tags)}`
  );
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
