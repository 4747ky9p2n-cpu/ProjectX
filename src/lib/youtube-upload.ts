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
  rawClipPath: string
): Promise<DownloadOutcome> {
  // ── Primary: Piped public API (free, no key) ──
  const piped = await downloadViaPiped(videoUrl, rawClipPath);
  if (piped.ok) return piped;

  // ── Fallback 1: Supadata download API ──
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

/**
 * Strip everything the YouTube Data API rejects in snippet.description while
 * keeping the description readable. Google rejects invisible control/format
 * characters and noncharacters in snippet.description with 400
 * "invalidDescription" / "The string did not match the expected pattern".
 *
 * REMOVED (in order):
 *  - All C0/C1 control chars EXCEPT \n (0A), \r (0D), \t (09) — newlines,
 *    carriage returns and tabs are legitimate in descriptions and kept.
 *  - Line/paragraph separators U+2028 / U+2029 (control-like line breaks;
 *    \n already covers newlines).
 *  - ALL Unicode format characters (General Category \p{Cf}): zero-width
 *    space U+200B, ZWJ U+200D, bidi marks U+200E/U+200F/U+202A—U+202E, word
 *    joiner U+2060, soft hyphen U+00AD, BOM/ZWNBSP U+FEFF, Arabic letter
 *    mark U+061C, tag characters U+E0000—U+E007F, etc. These invisible chars
 *    are the most likely cause of the observed invalidDescription 400s
 *    (transcript-derived text is full of them). Trade-off: emoji ZWJ
 *    sequences (U+200D-joined, e.g. family emoji) render as side-by-side
 *    emojis — still valid, readable text; a lone ZWJ is invisible and useless
 *    anyway. NOTHING in Cf is allowlisted — prefer rejecting anything not
 *    clearly needed.
 *  - Replacement char U+FFFD and ALL Unicode noncharacters: U+FDD0—U+FDEF,
 *    U+FFFE/U+FFFF, and U+xFFFE/U+xFFFF for every plane 1—16
 *    (U+1FFFE—U+10FFFF).
 *  - Lone surrogates (via stripLoneSurrogates) — an unpaired surrogate makes
 *    JSON.stringify emit \uD83D-style escapes, which Google also rejects.
 *
 * KEPT: \n \r \t, normal whitespace, letters, digits, punctuation, emojis
 * (minus their ZWJ joiners per the rule above), variation selectors
 * (U+FE00—U+FE0F, U+E0100—U+E01EF — Mn marks that make emoji render as
 * emoji; harmless to the validator). Nothing is collapsed: internal
 * whitespace and line structure survive as-is, only the edges are trimmed.
 */
export function sanitizeDescription(desc: string): string {
  return stripLoneSurrogates(desc)
    // All C0/C1 control chars EXCEPT \n (0A), \r (0D), \t (09)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    // Line/paragraph separators (U+2028/U+2029) — control-like line breaks
    // that some validators reject; \n already covers newlines.
    .replace(/[\u2028\u2029]/g, "")
    // ALL format characters (Category Cf): ZWSP U+200B, ZWJ U+200D, bidi
    // marks U+200E/U+200F/U+202A-U+202E, word joiner U+2060, soft hyphen
    // U+00AD, BOM U+FEFF, tag chars U+E0000-U+E007F, etc. Invisible chars
    // are the prime suspect for Google's invalidDescription 400s. Requires
    // the `u` flag; supported in Bun and Node.
    .replace(/\p{Cf}/gu, "")
    // Replacement char + ALL Unicode noncharacters (U+FDD0-U+FDEF, plus
    // U+FFFE/U+FFFF and each plane's last two code points
    // U+1FFFE/U+1FFFF — U+10FFFE/U+10FFFF).
    .replace(
      /[\uFFFD\uFDD0-\uFDEF\uFFFE\uFFFF\u{1FFFE}\u{1FFFF}\u{2FFFE}\u{2FFFF}\u{3FFFE}\u{3FFFF}\u{4FFFE}\u{4FFFF}\u{5FFFE}\u{5FFFF}\u{6FFFE}\u{6FFFF}\u{7FFFE}\u{7FFFF}\u{8FFFE}\u{8FFFF}\u{9FFFE}\u{9FFFF}\u{AFFFE}\u{AFFFF}\u{BFFFE}\u{BFFFF}\u{CFFFE}\u{CFFFF}\u{DFFFE}\u{DFFFF}\u{EFFFE}\u{EFFFF}\u{FFFFE}\u{FFFFF}\u{10FFFE}\u{10FFFF}]/gu,
      ""
    )
    // Trim edges only (never collapses internal whitespace/newlines) so a
    // removed control char at the start/end doesn't leave a stray space.
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
export function truncateToCodePoints(s: string, max: number): string {
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
