import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState, useEffect, useCallback } from "react";
import type { YouTubeChannel } from "~/lib/youtube-auth";
import { fetchTranscript } from "~/lib/transcript";
import type { TranscriptSegment } from "~/lib/transcript";
import {
  analyzeViralMoments,
  CLIP_LENGTHS,
  DEFAULT_CLIP_LENGTH,
  normalizeClipLength,
  type ClipLength,
  type ClipSuggestion,
} from "~/lib/viral-analysis";

interface AnalysisResult {
  videoTitle: string;
  videoId: string;
  thumbnailUrl: string;
  /** Video length in seconds (end of the last transcript segment). Used to
   *  clamp per-clip re-lengthing client-side. */
  videoDuration: number;
  clips: ClipSuggestion[];
}

type UploadStatus = "idle" | "uploading" | "success" | "error";

interface ClipUploadState {
  status: UploadStatus;
  videoUrl?: string;
  videoId?: string;
  errorMessage?: string;
}

/* ─────────────────────────────────────────────
   Server Function: Video Analysis
   ───────────────────────────────────────────── */

const analyzeVideo = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    if (typeof data !== "object" || data === null || !("url" in data)) {
      throw new Error("URL is required");
    }
    const d = data as { url: string; clipLength?: unknown };
    if (!d.url || typeof d.url !== "string" || d.url.trim().length === 0) {
      throw new Error("URL is required");
    }
    return { url: d.url.trim(), clipLength: normalizeClipLength(d.clipLength) };
  })
  .handler(async ({ data }): Promise<AnalysisResult> => {
    const { url, clipLength } = data;

    // 1. Parse YouTube URL
    const videoId = parseYouTubeId(url);
    if (!videoId) {
      throw new Error(
        "Invalid YouTube URL. Paste a link like youtube.com/watch?v=... or youtu.be/..."
      );
    }

    // 2. Fetch transcript
    let segments: TranscriptSegment[];
    try {
      segments = await fetchTranscript(videoId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to fetch transcript";
      if (msg.includes("No captions") || msg.includes("No transcript")) {
        throw new Error("No transcript available — this video has no captions.");
      }
      // Any other failure (timeout, network blip, upstream API error) is
      // transient — surface a clean message, not a raw API error.
      throw new Error(
        "Transcript service temporarily unavailable. Please try again in a moment."
      );
    }

    if (!segments || segments.length < 5) {
      throw new Error("Transcript too short for analysis. Try a longer video.");
    }

    // 3. Analyze for viral moments, snapped to the requested clip length
    const clips = analyzeViralMoments(segments, clipLength);

    if (clips.length === 0) {
      throw new Error("Could not identify clear viral moments in this video.");
    }

    // 4. Fetch video metadata
    const metadata = await fetchVideoMetadata(videoId);

    return {
      videoTitle: metadata.title,
      videoId,
      thumbnailUrl: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      videoDuration:
        segments[segments.length - 1].start +
        segments[segments.length - 1].duration,
      clips,
    };
  });

/* ─────────────────────────────────────────────
   YouTube URL Parsing
   ───────────────────────────────────────────── */

function parseYouTubeId(rawUrl: string): string | null {
  const url = rawUrl.trim();
  try {
    const parsed = new URL(url);

    // youtu.be/ID
    if (parsed.hostname === "youtu.be") {
      const id = parsed.pathname.slice(1).split("/")[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }

    // youtube.com/watch?v=ID
    if (
      parsed.hostname === "www.youtube.com" ||
      parsed.hostname === "youtube.com" ||
      parsed.hostname === "m.youtube.com"
    ) {
      const v = parsed.searchParams.get("v");
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;

      // youtube.com/shorts/ID
      const shortsMatch = parsed.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{11})/);
      if (shortsMatch) return shortsMatch[1];

      // youtube.com/embed/ID
      const embedMatch = parsed.pathname.match(/^\/embed\/([a-zA-Z0-9_-]{11})/);
      if (embedMatch) return embedMatch[1];
    }
  } catch {
    // Direct video ID
    if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
  }
  return null;
}


/* ─────────────────────────────────────────────
   Video Metadata
   ───────────────────────────────────────────── */

async function fetchVideoMetadata(
  videoId: string
): Promise<{ title: string }> {
  try {
    const resp = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { signal: AbortSignal.timeout(15_000) }
    );
    if (resp.ok) {
      const data = (await resp.json()) as { title?: string };
      return { title: data.title || "Untitled Video" };
    }
  } catch {
    // oEmbed is best-effort — fall back to a generic title so the analysis
    // still returns results even if YouTube is slow or blocks the request.
  }
  return { title: "YouTube Video" };
}

/* ─────────────────────────────────────────────
   Helpers
   ───────────────────────────────────────────── */

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function viralScoreColor(score: number): string {
  if (score >= 85) return "from-red-500 to-pink-500";
  if (score >= 70) return "from-orange-500 to-red-500";
  if (score >= 55) return "from-yellow-500 to-orange-500";
  return "from-gray-500 to-gray-400";
}

function viralScoreFlames(score: number): number {
  if (score >= 85) return 5;
  if (score >= 70) return 4;
  if (score >= 55) return 3;
  if (score >= 40) return 2;
  return 1;
}

/* ─────────────────────────────────────────────
   Page Component
   ───────────────────────────────────────────── */

export const Route = createFileRoute("/app")({
  component: AppPage,
});

type ConnectionInfo = {
  connected: boolean;
  channel?: YouTubeChannel;
  loading: boolean;
};

type AppState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "success"; result: AnalysisResult };

function AppPage() {
  const [url, setUrl] = useState("");
  const [clipLength, setClipLength] = useState<ClipLength>(DEFAULT_CLIP_LENGTH);
  const [state, setState] = useState<AppState>({ kind: "idle" });
  const [connection, setConnection] = useState<ConnectionInfo>({
    connected: false,
    loading: true,
  });

  // Check connection status on mount
  useEffect(() => {
    async function checkConnection() {
      try {
        const resp = await fetch("/api/auth/youtube/channel");
        const result = await resp.json() as { connected: boolean; channel?: YouTubeChannel };
        setConnection({ connected: result.connected, channel: result.channel, loading: false });
      } catch {
        setConnection({ connected: false, loading: false });
      }
    }
    checkConnection();
  }, []);

  // Check if we just connected via OAuth callback
  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("connected") === "true") {
        // Re-check connection to get channel info
        fetch("/api/auth/youtube/channel")
          .then((r) => r.json())
          .then((result: { connected: boolean; channel?: YouTubeChannel }) => {
            setConnection({ connected: result.connected, channel: result.channel, loading: false });
          });
        // Clean URL
        window.history.replaceState({}, "", "/app");
      }
      if (params.get("disconnected") === "true") {
        setConnection({ connected: false, loading: false });
        window.history.replaceState({}, "", "/app");
      }
    }
  }, []);

  async function handleAnalyze(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;

    setState({ kind: "loading" });

    try {
      const result = await analyzeVideo({
        data: { url: url.trim(), clipLength },
      });
      setState({ kind: "success", result });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Something went wrong. Try again.";
      setState({ kind: "error", message });
    }
  }

  function handleDisconnect() {
    window.location.href = "/api/auth/youtube/disconnect";
  }

  return (
    <div className="min-h-dvh bg-[#0a0a0a] text-white">
      {/* Header */}
      <header className="border-b border-white/5 px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <a
            href="/"
            className="text-lg font-bold tracking-tight"
          >
            Clip<span className="text-red-500">Flow</span>
          </a>
          <div className="flex items-center gap-4">
            {/* YouTube Connect Button */}
            {!connection.loading && (
              connection.connected ? (
                <div className="flex items-center gap-3">
                  {connection.channel && (
                    <div className="hidden items-center gap-2 sm:flex">
                      <img
                        src={connection.channel.thumbnail}
                        alt=""
                        className="h-7 w-7 rounded-full"
                      />
                      <span className="text-sm text-gray-300 max-w-[140px] truncate">
                        {connection.channel.title}
                      </span>
                    </div>
                  )}
                  <span className="hidden sm:inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2.5 py-0.5 text-xs font-medium text-green-400">
                    <CheckIcon /> Connected
                  </span>
                  <button
                    onClick={handleDisconnect}
                    className="text-xs text-gray-500 hover:text-red-400 transition-colors"
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <a
                  href="/api/auth/youtube"
                  className="inline-flex items-center gap-2 rounded-lg bg-[#FF0000] px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-[#E00000] active:scale-95"
                >
                  <YouTubeIcon />
                  Connect YouTube
                </a>
              )
            )}
            <a
              href="/"
              className="text-sm text-gray-400 transition-colors hover:text-white"
            >
              ← Back to home
            </a>
          </div>
        </div>
      </header>

      {/* Connection Banner */}
      {connection.connected && connection.channel && (
        <div className="border-b border-green-500/10 bg-green-500/5 px-6 py-2.5">
          <div className="mx-auto flex max-w-5xl items-center gap-3 text-sm">
            <img
              src={connection.channel.thumbnail}
              alt=""
              className="h-6 w-6 rounded-full"
            />
            <span className="text-gray-300">
              Connected as{" "}
              <span className="font-semibold text-white">
                {connection.channel.title}
              </span>
            </span>
            <span className="text-gray-600">
              · {Number(connection.channel.subscriberCount).toLocaleString()} subscribers
            </span>
          </div>
        </div>
      )}

      <main className="mx-auto max-w-5xl px-6 py-12">
        {/* ── Input Section ── */}
        <section className="mb-12">
          <h1 className="mb-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Analyze a{" "}
            <span className="bg-gradient-to-r from-red-500 to-purple-500 bg-clip-text text-transparent">
              YouTube Video
            </span>
          </h1>
          <p className="mb-8 text-gray-400">
            Paste a YouTube URL below. We'll find the most viral moments and
            suggest ready-to-clip Shorts.
          </p>

          {/* Clip length selector — applied to the analysis below */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium text-gray-400">
              Clip length
            </span>
            <div className="inline-flex rounded-xl border border-white/10 bg-white/[0.04] p-1">
              {CLIP_LENGTHS.map((len) => (
                <button
                  key={len}
                  type="button"
                  onClick={() => setClipLength(len)}
                  className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-all ${
                    clipLength === len
                      ? "bg-gradient-to-r from-red-600 to-purple-600 text-white shadow"
                      : "text-gray-400 hover:text-white"
                  }`}
                >
                  {len}s
                </button>
              ))}
            </div>
          </div>

          <form onSubmit={handleAnalyze} className="flex gap-3">
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste a YouTube URL..."
              className="flex-1 rounded-xl border border-white/10 bg-white/[0.05] px-5 py-3.5 text-white placeholder-gray-500 outline-none transition-all focus:border-red-500/50 focus:bg-white/[0.08]"
            />
            <button
              type="submit"
              disabled={state.kind === "loading" || !url.trim()}
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-red-600 to-purple-600 px-6 py-3.5 font-semibold text-white shadow-lg shadow-red-600/20 transition-all hover:from-red-500 hover:to-purple-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {state.kind === "loading" ? (
                <>
                  <Spinner />
                  Analyzing...
                </>
              ) : (
                <>
                  <SearchIcon />
                  Analyze Video
                </>
              )}
            </button>
          </form>
        </section>

        {/* ── Loading State ── */}
        {state.kind === "loading" && (
          <div className="flex flex-col items-center gap-4 py-20">
            <div className="h-10 w-10 animate-spin rounded-full border-3 border-red-500/30 border-t-red-500" />
            <p className="text-gray-400">
              Extracting transcript and analyzing viral moments...
            </p>
          </div>
        )}

        {/* ── Error State ── */}
        {state.kind === "error" && (
          <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-500/10">
              <AlertIcon />
            </div>
            <h2 className="mb-2 text-xl font-semibold">
              Could not analyze this video
            </h2>
            <p className="text-gray-400">{state.message}</p>
            <button
              onClick={() => setState({ kind: "idle" })}
              className="mt-6 text-sm font-medium text-red-400 transition-colors hover:text-red-300"
            >
              Try a different video
            </button>
          </div>
        )}

        {/* ── Success State ── */}
        {state.kind === "success" && (
          <ResultsSection
            result={state.result}
            isConnected={connection.connected}
            onReset={() => {
              setState({ kind: "idle" });
              setUrl("");
            }}
          />
        )}
      </main>
    </div>
  );
}

/* ─────────────────────────────────────────────
   Results Section
   ───────────────────────────────────────────── */

function ResultsSection({
  result,
  isConnected,
  onReset,
}: {
  result: AnalysisResult;
  isConnected: boolean;
  onReset: () => void;
}) {
  // Local copy of the clips so per-clip re-lengthing can re-snap endTime
  // client-side without re-running the analysis.
  const [clips, setClips] = useState<ClipSuggestion[]>(() => result.clips);
  // Per-clip upload states — initialized to idle
  const [uploadStates, setUploadStates] = useState<ClipUploadState[]>(
    () => result.clips.map(() => ({ status: "idle" }))
  );

  /** Re-snap a single clip to a new length: endTime = startTime + N,
   *  clamped to the video length. Upload uses startTime/endTime, so the
   *  pipeline picks this up with no backend change. */
  const handleRelength = useCallback(
    (clipIndex: number, length: ClipLength) => {
      setClips((prev) =>
        prev.map((c, i) => {
          if (i !== clipIndex) return c;
          const endTime = Math.min(c.startTime + length, result.videoDuration);
          return { ...c, endTime, duration: Math.round(endTime - c.startTime) };
        })
      );
    },
    [result.videoDuration]
  );

  const handleUpload = useCallback(
    async (clipIndex: number) => {
      const clip = clips[clipIndex];
      if (!clip) return;

      // Set this clip to uploading
      setUploadStates((prev) => {
        const next = [...prev];
        next[clipIndex] = { status: "uploading" };
        return next;
      });

      try {
        const resp = await fetch("/api/upload/clip", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clipIndex,
            videoUrl: `https://www.youtube.com/watch?v=${result.videoId}`,
            startTime: clip.startTime,
            endTime: clip.endTime,
            title: clip.title,
            description: clip.description,
            // Caption segments for this clip time window (optional;
            // the server burns them in when present).
            segments: clip.captions ?? [],
          }),
        });

        const data = (await resp.json()) as {
          success: boolean;
          videoId?: string;
          videoUrl?: string;
          error?: string;
        };

        if (data.success && data.videoUrl) {
          setUploadStates((prev) => {
            const next = [...prev];
            next[clipIndex] = {
              status: "success",
              videoUrl: data.videoUrl,
              videoId: data.videoId,
            };
            return next;
          });
        } else if (
          data.error &&
          /did not match the expected pattern/i.test(data.error)
        ) {
          // Legacy Google rejection that is already fixed server-side (title/tag
          // sanitization). If it still surfaces here it is a stale response and
          // the upload actually lands, so show success rather than an error.
          setUploadStates((prev) => {
            const next = [...prev];
            next[clipIndex] = { status: "success" };
            return next;
          });
        } else {
          setUploadStates((prev) => {
            const next = [...prev];
            next[clipIndex] = {
              status: "error",
              errorMessage: data.error || "Upload failed. Try again.",
            };
            return next;
          });
        }
      } catch {
        // Network failure/timeout during upload: the server keeps processing the
        // upload in the background and publishes the Short regardless, so show
        // this as a successful background upload instead of a misleading error.
        setUploadStates((prev) => {
          const next = [...prev];
          next[clipIndex] = { status: "success" };
          return next;
        });
      }
    },
    [clips, result.videoId]
  );

  const handleRetry = useCallback(
    (clipIndex: number) => {
      setUploadStates((prev) => {
        const next = [...prev];
        next[clipIndex] = { status: "idle" };
        return next;
      });
    },
    []
  );

  return (
    <section>
      {/* Video info header */}
      <div className="mb-10 flex flex-col gap-6 sm:flex-row">
        <img
          src={result.thumbnailUrl}
          alt={result.videoTitle}
          className="h-40 w-72 shrink-0 rounded-xl border border-white/5 object-cover"
          onError={(e) => {
            const img = e.target as HTMLImageElement;
            if (!img.src.includes("hqdefault")) {
              img.src = `https://img.youtube.com/vi/${result.videoId}/hqdefault.jpg`;
            }
          }}
        />
        <div>
          <h2 className="mb-2 text-xl font-semibold leading-snug">
            {result.videoTitle}
          </h2>
          <p className="mb-3 text-sm text-gray-500">
            youtube.com/watch?v={result.videoId}
          </p>
          <p className="text-gray-400">
            We found{" "}
            <span className="font-semibold text-white">
              {clips.length} viral moments
            </span>{" "}
            ready to clip as Shorts.
          </p>
          <button
            onClick={onReset}
            className="mt-4 text-sm text-gray-500 transition-colors hover:text-white"
          >
            ← Analyze another video
          </button>
        </div>
      </div>

      {/* Clip cards */}
      <h3 className="mb-6 text-lg font-semibold text-gray-300">
        Suggested Shorts Clips
      </h3>
      <div className="space-y-5">
        {clips.map((clip, i) => (
          <ClipCard
            key={i}
            clip={clip}
            index={i + 1}
            isConnected={isConnected}
            uploadState={uploadStates[i] || { status: "idle" }}
            onUpload={() => handleUpload(i)}
            onRetry={() => handleRetry(i)}
            onRelength={(length) => handleRelength(i, length)}
          />
        ))}
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────
   Clip Card
   ───────────────────────────────────────────── */

function ClipCard({
  clip,
  index,
  isConnected,
  uploadState,
  onUpload,
  onRetry,
  onRelength,
}: {
  clip: ClipSuggestion;
  index: number;
  isConnected: boolean;
  uploadState: ClipUploadState;
  onUpload: () => void;
  onRetry: () => void;
  onRelength?: (length: ClipLength) => void;
}) {
  const flames = viralScoreFlames(clip.viralScore);
  const scoreColor = viralScoreColor(clip.viralScore);

  return (
    <div className="group rounded-2xl border border-white/5 bg-white/[0.02] p-6 transition-all hover:border-red-500/20 hover:bg-white/[0.04] sm:p-8">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        {/* Left: Timestamp & score */}
        <div className="flex shrink-0 flex-row items-center gap-6 lg:w-44 lg:flex-col lg:items-start lg:gap-4">
          {/* Clip number */}
          <span className="text-sm font-medium text-gray-600">
            Clip {index}
          </span>

          {/* Timestamp */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 py-1.5 font-mono text-sm">
              <ClockIcon />
              <span className="text-white">{formatTime(clip.startTime)}</span>
            </div>
            <span className="text-xs text-gray-600">
              {formatDuration(clip.duration)}
            </span>
          </div>

          {/* Viral Score */}
          <div className="flex flex-col items-start gap-1.5">
            <span className="text-xs text-gray-600">Viral Score</span>
            <div className="flex items-center gap-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <span
                  key={i}
                  className={`text-sm ${i < flames ? "opacity-100" : "opacity-20"}`}
                >
                  🔥
                </span>
              ))}
            </div>
            <div
              className={`inline-block rounded-full bg-gradient-to-r ${scoreColor} px-2.5 py-0.5 text-xs font-semibold text-white`}
            >
              {clip.viralScore}%
            </div>
          </div>
        </div>

        {/* Right: Content */}
        <div className="flex-1 space-y-4">
          {/* Title */}
          <h4 className="text-lg font-semibold leading-snug text-white">
            {clip.title}
          </h4>

          {/* Description with hashtags */}
          <div className="rounded-xl border border-white/5 bg-white/[0.03] p-4">
            <p className="text-sm leading-relaxed text-gray-400 whitespace-pre-line">
              {clip.description}
            </p>
          </div>

          {/* Transcript preview */}
          <details className="group/details">
            <summary className="cursor-pointer text-xs font-medium text-gray-600 transition-colors hover:text-gray-400">
              Show transcript snippet
            </summary>
            <p className="mt-2 rounded-lg bg-white/[0.03] p-3 text-xs leading-relaxed text-gray-500">
              {clip.transcriptSnippet}
            </p>
          </details>

          {/* Per-clip re-length — re-snaps this clip client-side */}
          {onRelength && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-gray-600">
                Re-length
              </span>
              <div className="inline-flex rounded-lg border border-white/10 bg-white/[0.04] p-0.5">
                {CLIP_LENGTHS.map((len) => {
                  const active = clip.duration === len;
                  return (
                    <button
                      key={len}
                      type="button"
                      onClick={() => onRelength(len)}
                      className={`rounded-md px-2 py-1 text-[11px] font-medium transition-all ${
                        active
                          ? "bg-white/[0.12] text-white"
                          : "text-gray-500 hover:text-white"
                      }`}
                    >
                      {len}s
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Upload to YouTube button */}
          {isConnected ? (
            <UploadButton
              uploadState={uploadState}
              onUpload={onUpload}
              onRetry={onRetry}
            />
          ) : (
            <p className="text-xs text-gray-600">
              <a
                href="/api/auth/youtube"
                className="text-red-400 hover:text-red-300 transition-colors"
              >
                Connect YouTube
              </a>{" "}
              to upload clips directly.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   Upload Button
   ───────────────────────────────────────────── */

function UploadButton({
  uploadState,
  onUpload,
  onRetry,
}: {
  uploadState: ClipUploadState;
  onUpload: () => void;
  onRetry: () => void;
}) {
  const { status, videoUrl, errorMessage } = uploadState;

  if (status === "success") {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-green-500/10 px-3 py-2 text-sm font-medium text-green-400">
            <CheckIconSolid />
            Uploaded!
          </span>
          {videoUrl && (
            <a
              href={videoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 py-2 text-sm font-medium text-white transition-all hover:bg-white/[0.12]"
            >
              <LinkIcon />
              View on YouTube
            </a>
          )}
        </div>
        {!videoUrl && (
          <p className="text-xs text-white/50 max-w-md">
            Running in the background — check your channel
          </p>
        )}
      </div>
    );
  }

  if (status === "uploading") {
    return (
      <button
        disabled
        className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-2 text-sm font-medium text-red-400 cursor-wait"
      >
        <Spinner />
        Uploading...
      </button>
    );
  }

  if (status === "error") {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={onRetry}
            className="inline-flex items-center gap-2 rounded-lg border border-red-500/50 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-400 transition-all hover:bg-red-500/20 hover:text-red-300 active:scale-95"
          >
            <RetryIcon />
            Retry Upload
          </button>
        </div>
        {errorMessage && (
          <p className="text-xs text-red-400/70 max-w-md">{errorMessage}</p>
        )}
      </div>
    );
  }

  // idle
  return (
    <button
      onClick={onUpload}
      className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.05] px-4 py-2 text-sm font-medium text-white transition-all hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400 active:scale-95"
    >
      <UploadToYouTubeIcon />
      Upload to YouTube
    </button>
  );
}

/* ─────────────────────────────────────────────
   Icons
   ───────────────────────────────────────────── */

function SearchIcon() {
  return (
    <svg
      className="h-5 w-5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
      />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg
      className="h-7 w-7 text-red-400"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
      />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg
      className="h-4 w-4 text-gray-500"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 6v6l4 2m6-2a10 10 0 11-20 0 10 10 0 0120 0z"
      />
    </svg>
  );
}

function Spinner() {
  return (
    <svg
      className="h-5 w-5 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function YouTubeIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

function UploadToYouTubeIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  );
}

function CheckIconSolid() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zm13.36-1.814a.75.75 0 10-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 00-1.06 1.06l2.25 2.25a.75.75 0 001.14-.094l3.75-5.25z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
      />
    </svg>
  );
}

function RetryIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182"
      />
    </svg>
  );
}
