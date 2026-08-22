/* ─────────────────────────────────────────────
   Types
   ───────────────────────────────────────────── */

export interface TranscriptSegment {
  text: string;
  start: number;
  duration: number;
}

/* ─────────────────────────────────────────────
   Main entry point — multi-strategy transcript fetch
   ───────────────────────────────────────────── */

const SUPADATA_API_KEY =
  process.env.SUPADATA_API_KEY || "sd_f8518e4e6943014d9d87d2012fa004a6";

/**
 * yt-dlp fallback is DISABLED: YouTube blocks this datacenter IP with bot
 * detection, so the strategy always fails after a ~45s timeout — pure waste.
 * Flip to true to re-enable if the hosting environment stops being blocked.
 */
const ENABLE_YT_DLP_FALLBACK = false;

/**
 * Fetch transcript for a YouTube video using the best available strategy.
 * Uses Supadata API as primary (works from any IP, with timeout + retry),
 * followed by YouTube page scraping as a last resort.
 */
export async function fetchTranscript(
  videoId: string
): Promise<TranscriptSegment[]> {
  let sawNoCaptions = false;

  // Strategy 1: Supadata API (primary — works from datacenter IPs)
  try {
    return await fetchViaSupadata(videoId);
  } catch (err) {
    const msg = (err as Error).message;
    console.log("[transcript] Supadata failed:", msg);
    if (isNoCaptionsError(msg)) sawNoCaptions = true;
  }

  // Strategy 2: yt-dlp (disabled — see ENABLE_YT_DLP_FALLBACK above)
  if (ENABLE_YT_DLP_FALLBACK) {
    try {
      return await fetchViaYtDlp(videoId, true);
    } catch (err) {
      console.log("[transcript] yt-dlp android failed:", (err as Error).message);
    }
  }

  // Strategy 3: YouTube page scraping (last resort)
  try {
    return await fetchViaYouTubePage(videoId);
  } catch (err) {
    const msg = (err as Error).message;
    console.log("[transcript] page scraping failed:", msg);
    if (isNoCaptionsError(msg)) sawNoCaptions = true;
  }

  // Distinguish "video has no captions" from "service is down" so the UI
  // can show a useful message instead of a raw API error.
  if (sawNoCaptions) {
    throw new Error("No transcript available — this video has no captions.");
  }
  throw new Error(
    "Transcript service temporarily unavailable. Please try again in a moment."
  );
}

/** Heuristic: does this error mean the video simply has no usable captions? */
function isNoCaptionsError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("no captions") ||
    lower.includes("no transcript") ||
    lower.includes("captions are disabled") ||
    lower.includes("empty transcript") ||
    lower.includes("404")
  );
}

/* ─────────────────────────────────────────────
   Strategy 1: Supadata API (primary)
   ───────────────────────────────────────────── */

interface SupadataChunk {
  text: string;
  start: number;
  duration: number;
}

interface SupadataResponse {
  content: SupadataChunk[] | string;
  lang: string;
  availableLanguages?: { lang: string; name: string }[];
}

async function fetchViaSupadata(
  videoId: string
): Promise<TranscriptSegment[]> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const apiUrl = `https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(url)}&text=false`;

  const MAX_ATTEMPTS = 2;
  const RETRY_DELAY_MS = 1000;
  const TIMEOUT_MS = 30_000;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      // Wait 1s before retrying (single retry on any transient failure)
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }

    try {
      const resp = await fetch(apiUrl, {
        headers: { "x-api-key": SUPADATA_API_KEY },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        lastError = new Error(
          `Supadata API returned ${resp.status}: ${body.slice(0, 200)}`
        );
        // Retry transient server errors (429/5xx); deterministic 4xx
        // (e.g. 404 = no captions) won't get better on retry.
        if (resp.status === 429 || resp.status >= 500) {
          console.log(
            `[transcript] Supadata attempt ${attempt}/${MAX_ATTEMPTS} failed (HTTP ${resp.status}); retrying...`
          );
          continue;
        }
        break;
      }

      const data = (await resp.json()) as SupadataResponse;

      // Handle plain text response (when text=true is used as fallback)
      if (typeof data.content === "string") {
        const text = data.content.trim();
        if (!text) throw new Error("Supadata returned empty transcript.");
        // Create a single segment from the full text
        return [{ text, start: 0, duration: 60 }];
      }

      // Handle chunked response (text=false)
      if (!Array.isArray(data.content) || data.content.length === 0) {
        throw new Error("Supadata returned empty transcript.");
      }

      return data.content.map((chunk: any) => ({
        text: (chunk.text || "").trim(),
        // Supadata uses 'offset' (in ms) and 'duration' (in ms)
        start: Math.round(((chunk.offset ?? chunk.start ?? 0) / 1000) * 100) / 100,
        duration: Math.round(((chunk.duration || 1000) / 1000) * 100) / 100,
      })).filter((seg: TranscriptSegment) => seg.text.length > 0);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.log(
        `[transcript] Supadata attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastError.message}`
      );
      // Network error or timeout — try once more.
    }
  }

  throw lastError ?? new Error("Supadata request failed.");
}

/* ─────────────────────────────────────────────
   Strategy 2: yt-dlp (fallback)
   ───────────────────────────────────────────── */

import { spawn } from "node:child_process";
import { readFile, unlink, readdir } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

async function fetchViaYtDlp(
  videoId: string,
  useAndroid: boolean
): Promise<TranscriptSegment[]> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const lang = "en";
  const tmpDir = os.tmpdir();
  const outputBase = path.join(tmpDir, `clipflow_${videoId}`);

  const args = [
    "--skip-download",
    "--write-auto-subs",
    "--write-subs",
    "--sub-format", "srt",
    "--sub-lang", lang,
    "-o", outputBase,
    "--no-warnings",
  ];

  if (useAndroid) {
    args.push("--extractor-args", "youtube:player_client=android");
  }

  args.push(url);

  const { exitCode, stderr } = await spawnYtDlp(args);

  if (exitCode !== 0) {
    throw new Error(`yt-dlp exited with code ${exitCode}: ${stderr.slice(-200)}`);
  }

  const srtPath = await findSrtFile(tmpDir, videoId);
  if (!srtPath) {
    throw new Error("No subtitle file was generated by yt-dlp.");
  }

  const content = await readFile(srtPath, "utf-8");

  await unlink(srtPath).catch(() => {});
  const tmpFiles = await readdir(tmpDir);
  for (const f of tmpFiles) {
    if (f.startsWith(`clipflow_${videoId}`)) {
      await unlink(path.join(tmpDir, f)).catch(() => {});
    }
  }

  if (!content?.trim()) throw new Error("Subtitle file is empty.");

  const segments = parseSrt(content);
  if (segments.length === 0) {
    throw new Error("Could not extract any captions from subtitle file.");
  }

  return segments;
}

function spawnYtDlp(
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 45_000,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("error", (err) => reject(new Error(`Failed to spawn yt-dlp: ${err.message}`)));
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
}

async function findSrtFile(
  tmpDir: string,
  videoId: string
): Promise<string | null> {
  const tmpFiles = await readdir(tmpDir);
  const srtFiles = tmpFiles
    .filter((f) => f.startsWith(`clipflow_${videoId}`) && f.endsWith(".srt"))
    .sort((a, b) => (a.includes(".en") ? -1 : b.includes(".en") ? 1 : 0));
  return srtFiles.length > 0 ? path.join(tmpDir, srtFiles[0]) : null;
}

/* ─────────────────────────────────────────────
   SRT Parser
   ───────────────────────────────────────────── */

/**
 * Parse SRT subtitle format into TranscriptSegment array.
 * Handles standard SRT with optional index numbers and millisecond timestamps.
 *
 * SRT format:
 *   1
 *   00:00:00,320 --> 00:00:14,580
 *   [Music]
 *
 *   2
 *   00:00:18,800 --> 00:00:25,960
 *   We're no strangers to
 */
function parseSrt(content: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];

  // Split on double newlines (blank line separates entries)
  const blocks = content.trim().split(/\n\s*\n/);

  for (const block of blocks) {
    // Each block: optional index number, timestamp line, one or more text lines
    const lines = block.trim().split("\n");
    if (lines.length < 2) continue;

    // Find the timestamp line (contains "-->")
    let timestampLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("-->")) {
        timestampLineIdx = i;
        break;
      }
    }

    if (timestampLineIdx === -1) continue;

    const timeMatch = lines[timestampLineIdx].match(
      /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/
    );
    if (!timeMatch) continue;

    const startHours = parseInt(timeMatch[1], 10);
    const startMins = parseInt(timeMatch[2], 10);
    const startSecs = parseInt(timeMatch[3], 10);
    const startMs = parseInt(timeMatch[4], 10);
    const endHours = parseInt(timeMatch[5], 10);
    const endMins = parseInt(timeMatch[6], 10);
    const endSecs = parseInt(timeMatch[7], 10);
    const endMs = parseInt(timeMatch[8], 10);

    const startTime = startHours * 3600 + startMins * 60 + startSecs + startMs / 1000;
    const endTime = endHours * 3600 + endMins * 60 + endSecs + endMs / 1000;
    const duration = Math.max(0, endTime - startTime);

    // Text is everything after the timestamp line
    const textLines = lines.slice(timestampLineIdx + 1);
    let text = textLines
      .join(" ")
      .replace(/<\/?[^>]+(>|$)/g, "") // strip HTML tags
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/\s+/g, " ")
      .trim();

    // Skip empty segments and music cues (but keep short ones that might be words)
    if (text.length === 0) continue;
    if (text === "[Music]" || text === "[music]" || text === "♪" || text === "♫") continue;
    if (text === "[Applause]" || text === "[applause]") continue;

    segments.push({
      text,
      start: Math.round(startTime * 100) / 100, // round to 2 decimal places
      duration: Math.round(duration * 100) / 100,
    });
  }

  if (segments.length === 0) {
    // Try alternate format: VTT-style (no index numbers, just timestamps)
    const vttRegex = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*\n([\s\S]*?)(?=\n\d{1,2}:\d{2}:\d{2}|\n*$)/g;
    let match;
    while ((match = vttRegex.exec(content)) !== null) {
      const startTime =
        parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]) + parseInt(match[4]) / 1000;
      const endTime =
        parseInt(match[5]) * 3600 + parseInt(match[6]) * 60 + parseInt(match[7]) + parseInt(match[8]) / 1000;
      let text = match[9]
        .trim()
        .replace(/<\/?[^>]+(>|$)/g, "")
        .replace(/\s+/g, " ")
        .trim();

      if (text.length > 0 && text !== "[Music]" && text !== "[Applause]") {
        segments.push({
          text,
          start: Math.round(startTime * 100) / 100,
          duration: Math.round((endTime - startTime) * 100) / 100,
        });
      }
    }
  }

  return segments;
}

/* ─────────────────────────────────────────────
   Strategy 3: YouTube page scraping (last resort)
   ───────────────────────────────────────────── */

async function fetchViaYouTubePage(
  videoId: string
): Promise<TranscriptSegment[]> {
  const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    throw new Error("Could not reach YouTube. Try again later.");
  }

  const html = await resp.text();

  // Extract ytInitialPlayerResponse JSON
  const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/);
  if (!playerMatch) {
    throw new Error("Could not extract video data from YouTube page.");
  }

  let playerResponse: Record<string, unknown>;
  try {
    playerResponse = JSON.parse(playerMatch[1]);
  } catch {
    throw new Error("Failed to parse YouTube page data.");
  }

  const captions = (playerResponse.captions as Record<string, unknown>)
    ?.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined;

  if (!captions) {
    throw new Error("No transcript available — this video has no captions.");
  }

  const captionTracks = captions.captionTracks as Array<Record<string, unknown>> | undefined;
  if (!captionTracks || captionTracks.length === 0) {
    throw new Error("No transcript available — captions are disabled.");
  }

  // Prefer English, fall back to first available
  const track =
    captionTracks.find(
      (t) =>
        t.languageCode === "en" ||
        (typeof t.languageCode === "string" && t.languageCode.startsWith("en"))
    ) || captionTracks[0];

  const baseUrl = track.baseUrl as string;
  if (!baseUrl) {
    throw new Error("No captions URL found.");
  }

  const captionsResp = await fetch(baseUrl);
  if (!captionsResp.ok) {
    throw new Error("Failed to download captions.");
  }

  const xml = await captionsResp.text();
  return parseTimedText(xml);
}

/**
 * Parse YouTube timedtext XML format into TranscriptSegment array.
 * Handles both <text> and <p> element formats.
 */
function parseTimedText(xml: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];

  // Format 1: <text start="..." dur="...">...</text>
  const textRegex = /<text\s+start="([\d.]+)"\s+dur="([\d.]+)"[^>]*>(.*?)<\/text>/g;
  let match: RegExpExecArray | null;
  while ((match = textRegex.exec(xml)) !== null) {
    let text = decodeXmlEntities(match[3]).trim();
    if (text.length > 0) {
      segments.push({
        text,
        start: parseFloat(match[1]),
        duration: parseFloat(match[2]),
      });
    }
  }

  // Format 2: <p t="..." d="...">...</p>
  if (segments.length === 0) {
    const pRegex = /<p\s+t="([\d.]+)"\s+d="([\d.]+)"[^>]*>(.*?)<\/p>/g;
    while ((match = pRegex.exec(xml)) !== null) {
      let text = decodeXmlEntities(match[3]).trim();
      if (text.length > 0) {
        segments.push({
          text,
          start: parseFloat(match[1]),
          duration: parseFloat(match[2]),
        });
      }
    }
  }

  if (segments.length === 0) {
    throw new Error("No transcript available — could not parse captions format.");
  }

  return segments;
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/<\/?[^>]+(>|$)/g, "") // strip HTML tags
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}
