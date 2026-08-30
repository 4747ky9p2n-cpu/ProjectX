import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState, useEffect, useCallback } from "react";
import type { YouTubeChannel } from "~/lib/youtube-auth";
import type { TikTokUser } from "~/lib/tiktok-auth";
import type { ChannelInfo, ChannelVideoItem } from "~/lib/channel-handler";
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

type UploadStatus =
  | "idle"
  | "uploading"
  | "background"
  | "success"
  | "error"
  | "partial";

interface ClipUploadState {
  status: UploadStatus;
  videoUrl?: string;
  videoId?: string;
  errorMessage?: string;
  /** Where this upload was sent (echoed from the server). */
  destination?: "youtube" | "tiktok" | "both";
  /** Per-destination results (present for "both" uploads). */
  youtube?: { videoId: string; videoUrl: string };
  tiktok?: { publishId?: string; videoUrl?: string };
  /** "both" upload where one destination failed — message for the failed one. */
  partialError?: string;
}

type Destination = "youtube" | "tiktok" | "both";

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

function formatChannelDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
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

type TikTokConnectionInfo = {
  connected: boolean;
  /** True when TIKTOK_CLIENT_KEY/SECRET are missing — show a setup hint. */
  setupPending: boolean;
  user?: TikTokUser;
  loading: boolean;
};

type AppState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "success"; result: AnalysisResult };

type InputMode = "url" | "channel";

type ChannelFetchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string; notConnected?: boolean }
  | { kind: "success"; channel: ChannelInfo; videos: ChannelVideoItem[] };

function AppPage() {
  const [url, setUrl] = useState("");
  const [clipLength, setClipLength] = useState<ClipLength>(DEFAULT_CLIP_LENGTH);
  const [state, setState] = useState<AppState>({ kind: "idle" });
  const [mode, setMode] = useState<InputMode>("url");
  const [view, setView] = useState<"clip" | "voice">("clip");
  const [channelQuery, setChannelQuery] = useState("");
  const [channelState, setChannelState] = useState<ChannelFetchState>({
    kind: "idle",
  });
  const [connection, setConnection] = useState<ConnectionInfo>({
    connected: false,
    loading: true,
  });
  const [tiktokConnection, setTiktokConnection] =
    useState<TikTokConnectionInfo>({
      connected: false,
      setupPending: false,
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
    async function checkTikTokConnection() {
      try {
        const resp = await fetch("/api/auth/tiktok/channel");
        const result = await resp.json() as {
          connected: boolean;
          setupPending?: boolean;
          user?: TikTokUser;
        };
        setTiktokConnection({
          connected: result.connected,
          setupPending: result.setupPending === true,
          user: result.user,
          loading: false,
        });
      } catch {
        setTiktokConnection({ connected: false, setupPending: false, loading: false });
      }
    }
    checkConnection();
    checkTikTokConnection();
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
      if (params.get("tiktok") === "connected") {
        // Re-check TikTok connection to get the user profile
        fetch("/api/auth/tiktok/channel")
          .then((r) => r.json())
          .then((result: { connected: boolean; setupPending?: boolean; user?: TikTokUser }) => {
            setTiktokConnection({
              connected: result.connected,
              setupPending: result.setupPending === true,
              user: result.user,
              loading: false,
            });
          });
        window.history.replaceState({}, "", "/app");
      }
      if (params.get("tiktok") === "disconnected") {
        setTiktokConnection({ connected: false, setupPending: false, loading: false });
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

  function handleTikTokDisconnect() {
    window.location.href = "/api/auth/tiktok/disconnect";
  }

  /** Fetch a channel's recent videos from the new channel endpoint. */
  async function loadChannelVideos(bypassCache = false) {
    if (!channelQuery.trim()) return;

    setChannelState({ kind: "loading" });

    try {
      const resp = await fetch(
        `/api/youtube/channel/videos?query=${encodeURIComponent(
          channelQuery.trim()
        )}${bypassCache ? "&refresh=1" : ""}`
      );
      const data = (await resp.json()) as {
        success: boolean;
        code?: string;
        error?: string;
        channel?: ChannelInfo;
        videos?: ChannelVideoItem[];
      };

      if (resp.status === 401 || data.code === "NO_AUTH") {
        setChannelState({
          kind: "error",
          message:
            "Connect your YouTube account first, then load the channel's videos.",
          notConnected: true,
        });
        return;
      }

      if (!resp.ok || !data.success || !data.channel || !data.videos) {
        setChannelState({
          kind: "error",
          message: data.error || "Could not load this channel's videos.",
        });
        return;
      }

      setChannelState({
        kind: "success",
        channel: data.channel,
        videos: data.videos,
      });
    } catch {
      setChannelState({
        kind: "error",
        message: "Could not load the channel. Please try again.",
      });
    }
  }

  function handleChannelSubmit(e: React.FormEvent) {
    e.preventDefault();
    loadChannelVideos();
  }

  /** Pick a listed video and run the SAME analysis flow as URL mode. */
  async function handlePickVideo(videoId: string) {
    setState({ kind: "loading" });
    try {
      const result = await analyzeVideo({
        data: {
          url: `https://www.youtube.com/watch?v=${videoId}`,
          clipLength,
        },
      });
      setState({ kind: "success", result });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Something went wrong. Try again.";
      setState({ kind: "error", message });
    }
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
            {/* TikTok Connect Button */}
            {!tiktokConnection.loading && (
              tiktokConnection.setupPending ? (
                <span
                  className="hidden items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-gray-500 sm:inline-flex"
                  title="TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET fehlen — der Owner muss die TikTok Developer App für Content Posting einrichten"
                >
                  TikTok: Setup ausstehend
                  <span className="text-gray-600">(TIKTOK_CLIENT_KEY fehlt)</span>
                </span>
              ) : tiktokConnection.connected ? (
                <div className="flex items-center gap-3">
                  {tiktokConnection.user && (
                    <div className="hidden items-center gap-2 sm:flex">
                      {tiktokConnection.user.avatarUrl && (
                        <img
                          src={tiktokConnection.user.avatarUrl}
                          alt=""
                          className="h-7 w-7 rounded-full"
                        />
                      )}
                      <span className="text-sm text-gray-300 max-w-[120px] truncate">
                        {tiktokConnection.user.displayName}
                      </span>
                    </div>
                  )}
                  <span className="hidden sm:inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2.5 py-0.5 text-xs font-medium text-green-400">
                    <CheckIcon /> Connected
                  </span>
                  <button
                    onClick={handleTikTokDisconnect}
                    className="text-xs text-gray-500 hover:text-red-400 transition-colors"
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <a
                  href="/api/auth/tiktok"
                  className="inline-flex items-center gap-2 rounded-lg border border-white/20 bg-[#161616] px-4 py-2 text-sm font-semibold text-white transition-all hover:border-[#25F4EE] hover:bg-[#1f1f1f] active:scale-95"
                >
                  <TikTokIcon />
                  Connect TikTok
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
        {/* ── Category tabs: Clip-Auto vs KI-Stimme ── */}
        <div className="mb-8 flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] p-1">
          <button
            type="button"
            onClick={() => setView("clip")}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-all ${
              view === "clip"
                ? "bg-gradient-to-r from-red-600 to-purple-600 text-white shadow"
                : "text-gray-400 hover:text-white"
            }`}
          >
            ✂️ Clip-Auto
          </button>
          <button
            type="button"
            onClick={() => setView("voice")}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-all ${
              view === "voice"
                ? "bg-gradient-to-r from-red-600 to-purple-600 text-white shadow"
                : "text-gray-400 hover:text-white"
            }`}
          >
            🎙️ KI-Stimme
          </button>
        </div>
        {view === "clip" ? (
        <>
        {/* ── Input Section ── */}
        <section className="mb-12">
          <h1 className="mb-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Analyze a{" "}
            <span className="bg-gradient-to-r from-red-500 to-purple-500 bg-clip-text text-transparent">
              YouTube Video
            </span>
          </h1>
          <p className="mb-6 text-gray-400">
            {mode === "url"
              ? "Paste a YouTube URL below. We'll find the most viral moments and suggest ready-to-clip Shorts."
              : "Enter a YouTuber's channel (handle or URL). We'll list their recent videos — pick one and we'll clip it."}
          </p>

          {/* Mode toggle: single video URL vs whole channel */}
          <div className="mb-4 inline-flex rounded-xl border border-white/10 bg-white/[0.04] p-1">
            <button
              type="button"
              onClick={() => setMode("url")}
              className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-all ${
                mode === "url"
                  ? "bg-gradient-to-r from-red-600 to-purple-600 text-white shadow"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              Video URL
            </button>
            <button
              type="button"
              onClick={() => setMode("channel")}
              className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-all ${
                mode === "channel"
                  ? "bg-gradient-to-r from-red-600 to-purple-600 text-white shadow"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              Channel
            </button>
          </div>

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

          {mode === "url" ? (
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
          ) : (
            <form onSubmit={handleChannelSubmit} className="flex gap-3">
              <input
                type="text"
                value={channelQuery}
                onChange={(e) => setChannelQuery(e.target.value)}
                placeholder="Channel handle or URL (e.g. @MrBeast)..."
                className="flex-1 rounded-xl border border-white/10 bg-white/[0.05] px-5 py-3.5 text-white placeholder-gray-500 outline-none transition-all focus:border-red-500/50 focus:bg-white/[0.08]"
              />
              <button
                type="submit"
                disabled={
                  channelState.kind === "loading" || !channelQuery.trim()
                }
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-red-600 to-purple-600 px-6 py-3.5 font-semibold text-white shadow-lg shadow-red-600/20 transition-all hover:from-red-500 hover:to-purple-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {channelState.kind === "loading" ? (
                  <>
                    <Spinner />
                    Loading...
                  </>
                ) : (
                  <>
                    <ChannelIcon />
                    Load Videos
                  </>
                )}
              </button>
            </form>
          )}
        </section>

        {/* ── Channel Mode: loading / error / video list ── */}
        {mode === "channel" && channelState.kind === "loading" && (
          <div className="flex flex-col items-center gap-4 py-16">
            <div className="h-10 w-10 animate-spin rounded-full border-3 border-red-500/30 border-t-red-500" />
            <p className="text-gray-400">Loading channel videos...</p>
          </div>
        )}

        {mode === "channel" && channelState.kind === "error" && (
          <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-500/10">
              <AlertIcon />
            </div>
            <h2 className="mb-2 text-xl font-semibold">Could not load channel</h2>
            <p className="text-gray-400">{channelState.message}</p>
            {channelState.notConnected ? (
              <a
                href="/api/auth/youtube"
                className="mt-6 inline-flex items-center gap-2 rounded-lg bg-[#FF0000] px-5 py-2.5 text-sm font-semibold text-white transition-all hover:bg-[#E00000] active:scale-95"
              >
                <YouTubeIcon />
                Connect YouTube
              </a>
            ) : (
              <button
                onClick={() => setChannelState({ kind: "idle" })}
                className="mt-6 text-sm font-medium text-red-400 transition-colors hover:text-red-300"
              >
                Try a different channel
              </button>
            )}
          </div>
        )}

        {mode === "channel" && channelState.kind === "success" && (
          <ChannelSection
            channel={channelState.channel}
            videos={channelState.videos}
            analyzing={state.kind === "loading"}
            onPick={handlePickVideo}
            onRefresh={() => loadChannelVideos(true)}
          />
        )}

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
            tiktokConnected={tiktokConnection.connected}
            tiktokSetupPending={tiktokConnection.setupPending}
            onReset={() => {
              setState({ kind: "idle" });
              setUrl("");
            }}
          />
        )}
        </>
        ) : (
          <VoiceSection
            isConnected={connection.connected}
            tiktokConnected={tiktokConnection.connected}
            tiktokSetupPending={tiktokConnection.setupPending}
          />
        )}
      </main>
    </div>
  );
}


/* ─────────────────────────────────────────────
   AI-Voice Category (KI-Sprach-Kategorie)
   Reuses the existing /api/upload/clip 202 contract + UploadButton so the
   rendered Short is posted through the same honest-status pipeline as
   Clip-Auto.
   ───────────────────────────────────────────── */
interface VoiceCharacter {
  id: string;
  name: string;
  bio: string;
  emoji: string;
  style: string;
  language: string;
}
/** Map Phase-1 render error codes to human-friendly German messages. */
function voiceErrorLabel(code: string | undefined, fallback: string | undefined): string {
  switch (code) {
    case "MISSING_TOOLS":
      return "TTS-Modell nicht installiert – Piper & ffmpeg fehlen auf dem Server.";
    case "TTS_MODEL_UNAVAILABLE":
      return "Die Stimme des Charakters konnte nicht geladen werden (Modell fehlt).";
    case "TTS_FAILED":
      return "Die Sprachsynthese ist fehlgeschlagen. Bitte versuch es erneut.";
    case "DOWNLOAD_FAILED":
      return "Das Hintergrundvideo konnte nicht heruntergeladen werden.";
    case "RENDER_FAILED":
    case "RENDER_CRASHED":
      return "Die Erstellung des Shorts ist fehlgeschlagen.";
    case "FACT_GEN_FAILED":
      return "Der KI-Fakt konnte nicht generiert werden – bitte Text manuell eingeben.";
    case "UNKNOWN_CHARACTER":
      return "Der gewählte Charakter existiert nicht.";
    case "MISSING_TEXT":
      return "Bitte gib einen Text ein oder lass die KI einen Fakt generieren.";
    default:
      return fallback || "Ein Fehler ist aufgetreten. Bitte versuch es erneut.";
  }
}
function VoiceSection({
  isConnected,
  tiktokConnected,
  tiktokSetupPending,
}: {
  isConnected: boolean;
  tiktokConnected: boolean;
  tiktokSetupPending: boolean;
}) {
  const [videoUrl, setVideoUrl] = useState("");
  const [characters, setCharacters] = useState<VoiceCharacter[] | null>(null);
  const [charsError, setCharsError] = useState("");
  const [characterId, setCharacterId] = useState("");
  const [text, setText] = useState("");
  const [genState, setGenState] = useState<"idle" | "loading" | "error">("idle");
  const [genError, setGenError] = useState("");
  const [renderState, setRenderState] = useState<
    "idle" | "loading" | "error" | "done"
  >("idle");
  const [renderPath, setRenderPath] = useState("");
  const [renderText, setRenderText] = useState("");
  const [renderError, setRenderError] = useState("");
  const [durationSec, setDurationSec] = useState(0);
  const [destination, setDestination] = useState<Destination>("youtube");
  const [uploadState, setUploadState] = useState<ClipUploadState>({
    status: "idle",
  });

  useEffect(() => {
    let active = true;
    fetch("/api/voice/characters")
      .then((r) => r.json())
      .then((d: { success?: boolean; characters?: VoiceCharacter[]; error?: string }) => {
        if (!active) return;
        if (d.success && d.characters) setCharacters(d.characters);
        else setCharsError(d.error || "Konnte Charaktere nicht laden.");
      })
      .catch(() => {
        if (active) setCharsError("Keine Verbindung zum Server.");
      });
    return () => {
      active = false;
    };
  }, []);

  const selectedCharacter = characters?.find((c) => c.id === characterId);

  async function handleGenerateFact() {
    if (!videoUrl.trim() || !characterId) return;
    setGenState("loading");
    setGenError("");
    try {
      const resp = await fetch("/api/voice/fact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoUrl: videoUrl.trim(), characterId }),
      });
      const data = (await resp.json()) as {
        success?: boolean;
        text?: string;
        code?: string;
        error?: string;
      };
      if (data.success && data.text) {
        setText(data.text);
        setGenState("idle");
      } else {
        setGenError(
          data.code === "FACT_GEN_FAILED"
            ? "Der KI-Fakt konnte nicht generiert werden – bitte Text manuell eingeben."
            : data.error || "Fakt-Generierung fehlgeschlagen."
        );
        setGenState("error");
      }
    } catch {
      setGenError("Keine Verbindung zum Server.");
      setGenState("error");
    }
  }

  async function handleRender() {
    if (!videoUrl.trim() || !characterId) return;
    setRenderState("loading");
    setRenderError("");
    setUploadState({ status: "idle" });
    setRenderPath("");
    setRenderText("");
    const hasUserText = text.trim().length > 0;
    try {
      const resp = await fetch("/api/voice/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoUrl: videoUrl.trim(),
          characterId,
          ...(hasUserText
            ? { text: text.trim(), factSource: "user" }
            : { factSource: "ai" }),
          maxDuration: 60,
        }),
      });
      const data = (await resp.json()) as {
        success?: boolean;
        path?: string;
        text?: string;
        durationSec?: number;
        code?: string;
        error?: string;
      };
      if (data.success && data.path) {
        setRenderPath(data.path);
        setRenderText(data.text || text);
        setDurationSec(data.durationSec || 0);
        setRenderState("done");
      } else {
        setRenderError(voiceErrorLabel(data.code, data.error));
        setRenderState("error");
      }
    } catch {
      setRenderError("Keine Verbindung zum Server.");
      setRenderState("error");
    }
  }

  const mediaUrl = renderPath
    ? `/api/voice/media?path=${encodeURIComponent(renderPath)}`
    : "";

  async function handleUpload() {
    if (!renderPath) return;
    setUploadState({ status: "uploading", destination });
    try {
      const resp = await fetch("/api/upload/clip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoUrl: videoUrl.trim(),
          startTime: 0,
          endTime: Math.max(durationSec || 5, 5),
          title: `${selectedCharacter ? selectedCharacter.name + " – " : ""}KI-Stimme Short`,
          description: renderText
            ? `${renderText}\n#shorts #clipflow #kistimme`
            : "#shorts #clipflow #kistimme",
          destination,
          renderedPath: renderPath,
        }),
      });
      const data = (await resp.json()) as {
        success?: boolean;
        background?: boolean;
        accepted?: boolean;
        videoId?: string;
        videoUrl?: string;
        destination?: Destination;
        youtube?: { videoId: string; videoUrl: string };
        tiktok?: { publishId?: string; videoUrl?: string };
        partialError?: string;
        error?: string;
      };
      if (resp.status === 202 && data.background) {
        setUploadState({
          status: "background",
          destination: data.destination ?? destination,
        });
      } else if (data.success) {
        setUploadState({
          status: data.partialError ? "partial" : "success",
          videoUrl: data.videoUrl,
          videoId: data.videoId,
          destination: data.destination,
          youtube: data.youtube,
          tiktok: data.tiktok,
          partialError: data.partialError,
        });
      } else {
        setUploadState({
          status: "error",
          errorMessage: data.error || "Upload fehlgeschlagen. Versuch es erneut.",
        });
      }
    } catch {
      setUploadState({
        status: "error",
        errorMessage:
          "Upload konnte nicht gesendet werden – keine Verbindung zum Server. Versuch es erneut.",
      });
    }
  }
  const handleRetry = () => setUploadState({ status: "idle" });

  return (
    <section className="space-y-10">
      <div>
        <h2 className="mb-2 text-2xl font-bold tracking-tight sm:text-3xl">
          <span className="bg-gradient-to-r from-purple-500 to-pink-500 bg-clip-text text-transparent">
            KI-Sprach-Kategorie
          </span>
        </h2>
        <p className="max-w-2xl text-gray-400">
          Wähle ein Hintergrundvideo und eine Parodie-Stimme – ClipFlow rendert
          daraus ein fertiges 9:16-Short mit eingesprochenem Fakt und Untertitel,
          das du direkt als YouTube/TikTok-Short posten kannst.
        </p>
      </div>

      {/* 1. Background video */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-purple-400">
          1 · Hintergrundvideo
        </h3>
        <input
          type="text"
          value={videoUrl}
          onChange={(e) => setVideoUrl(e.target.value)}
          placeholder="YouTube-URL einfügen (z. B. https://youtube.com/watch?v=...)"
          className="w-full rounded-xl border border-white/10 bg-white/[0.05] px-5 py-3.5 text-white placeholder-gray-500 outline-none transition-all focus:border-purple-500/50 focus:bg-white/[0.08]"
        />
      </div>

      {/* 2. Character picker */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-purple-400">
          2 · Stimme / Charakter
        </h3>
        {charsError ? (
          <p className="text-sm text-red-400">{charsError}</p>
        ) : !characters ? (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Spinner /> Lade Charaktere...
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {characters.map((c) => {
              const active = c.id === characterId;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCharacterId(c.id)}
                  className={`rounded-xl border p-4 text-left transition-all ${
                    active
                      ? "border-purple-500/60 bg-purple-500/10"
                      : "border-white/10 bg-white/[0.02] hover:border-white/25"
                  }`}
                >
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-2xl">{c.emoji}</span>
                    <span className="font-semibold text-white">{c.name}</span>
                    <span className="ml-auto rounded-md bg-white/[0.06] px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-400">
                      {c.language}
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed text-gray-400">{c.bio}</p>
                  {active && selectedCharacter && (
                    <p className="mt-2 text-[11px] text-purple-300/80">
                      Stil: {selectedCharacter.style}
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 3. Text / AI fact */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-purple-400">
          3 · Text
        </h3>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Gib deinen Text ein – oder lass die KI einen viralen Fakt aus dem Video generieren."
          rows={3}
          className="w-full rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3 text-white placeholder-gray-500 outline-none transition-all focus:border-purple-500/50 focus:bg-white/[0.08]"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleGenerateFact}
            disabled={genState === "loading" || !videoUrl.trim() || !characterId}
            className="inline-flex items-center gap-2 rounded-lg border border-purple-500/40 bg-purple-500/10 px-4 py-2 text-sm font-medium text-purple-300 transition-all hover:bg-purple-500/20 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {genState === "loading" ? (
              <>
                <Spinner /> Generiere Fakt...
              </>
            ) : (
              "🎲 KI-Fakt generieren"
            )}
          </button>
          {renderState === "done" && renderText && (
            <span className="text-[11px] text-gray-500">
              Generierter Text wurde unten übernommen – du kannst ihn vor dem
              Rendern bearbeiten.
            </span>
          )}
        </div>
        {genState === "error" && (
          <p className="mt-2 text-xs text-red-400">{genError}</p>
        )}
        {(genState === "idle" || genState === "loading") && (text.trim().length > 0 && genState === "idle") && (
          <p className="mt-2 text-[11px] text-gray-500">
            Aktuell: eigener Text ({text.length} Zeichen). Ein leerer Text lässt
            die KI beim Rendern automatisch einen Fakt generieren.
          </p>
        )}
      </div>

      {/* 4. Render */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-purple-400">
          4 · Short rendern
        </h3>
        <button
          type="button"
          onClick={handleRender}
          disabled={
            renderState === "loading" || !videoUrl.trim() || !characterId
          }
          className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-purple-600 to-pink-600 px-6 py-3.5 font-semibold text-white shadow-lg shadow-purple-600/20 transition-all hover:from-purple-500 hover:to-pink-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {renderState === "loading" ? (
            <>
              <Spinner /> Rendere Short (Download + TTS + ffmpeg)...
            </>
          ) : renderState === "done" ? (
            "↻ Erneut rendern"
          ) : (
            "▶ Short rendern"
          )}
        </button>
        {renderState === "loading" && (
          <p className="mt-3 text-xs text-gray-500">
            Das kann einige Sekunden dauern – Hintergrundvideo wird geladen und
            die Stimme erzeugt.
          </p>
        )}
        {renderState === "error" && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
            <AlertIcon />
            <span>{renderError}</span>
          </div>
        )}
      </div>

      {/* 5. Preview */}
      {renderState === "done" && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-purple-400">
              5 · Vorschau
            </h3>
            <span className="rounded-md bg-white/[0.06] px-2 py-0.5 font-mono text-[11px] text-gray-400">
              {durationSec ? `${Math.round(durationSec)}s` : "Short"} · 9:16
            </span>
          </div>
          <div className="mb-4 max-w-sm overflow-hidden rounded-xl border border-white/5 bg-black">
            <div className="relative aspect-[9/16] w-full">
              <video
                key={mediaUrl}
                src={mediaUrl}
                controls
                playsInline
                className="absolute inset-0 h-full w-full"
              >
                Dein Browser unterstützt kein Video-Playback.
              </video>
            </div>
          </div>
          {renderText && (
            <p className="mb-4 max-w-lg text-sm leading-relaxed text-gray-300">
              <span className="text-gray-500">Gesprochener Text:</span>{" "}
              {renderText}
            </p>
          )}
        </div>
      )}

      {/* 6. Post */}
      {renderState === "done" && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-purple-400">
            6 · Posten
          </h3>
          <div className="mb-4 inline-flex rounded-xl border border-white/10 bg-white/[0.04] p-1">
            {(
              [
                { key: "youtube", label: "YouTube" },
                { key: "tiktok", label: "TikTok" },
                { key: "both", label: "Beide" },
              ] as { key: Destination; label: string }[]
            ).map((d) => (
              <button
                key={d.key}
                type="button"
                onClick={() => setDestination(d.key)}
                className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-all ${
                  destination === d.key
                    ? "bg-gradient-to-r from-purple-600 to-pink-600 text-white shadow"
                    : "text-gray-400 hover:text-white"
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
          {isConnected || tiktokConnected ? (
            <UploadButton
              uploadState={uploadState}
              destination={destination}
              previewed={renderState === "done"}
              onUpload={handleUpload}
              onRetry={handleRetry}
            />
          ) : (
            <p className="text-xs text-gray-600">
              {tiktokSetupPending ? (
                "TikTok: Setup ausstehend (TIKTOK_CLIENT_KEY fehlt) – verbinde zuerst einen Kanal."
              ) : (
                <>
                  <a
                    href="/api/auth/youtube"
                    className="text-red-400 hover:text-red-300 transition-colors"
                  >
                    Connect YouTube
                  </a>{" "}
                  or{" "}
                  <a
                    href="/api/auth/tiktok"
                    className="text-[#25F4EE] hover:underline transition-colors"
                  >
                    Connect TikTok
                  </a>{" "}
                  to post the rendered Short.
                </>
              )}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/* ─────────────────────────────────────────────
   Channel Section
   ───────────────────────────────────────────── */

function ChannelSection({
  channel,
  videos,
  analyzing,
  onPick,
  onRefresh,
}: {
  channel: ChannelInfo;
  videos: ChannelVideoItem[];
  analyzing: boolean;
  onPick: (videoId: string) => void;
  onRefresh: () => void;
}) {
  return (
    <section>
      {/* Channel header + refresh */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {channel.thumbnailUrl && (
            <img
              src={channel.thumbnailUrl}
              alt=""
              className="h-10 w-10 rounded-full border border-white/10"
            />
          )}
          <div>
            <h2 className="text-lg font-semibold text-white">
              {channel.title}
            </h2>
            <p className="text-xs text-gray-500">
              {videos.length} recent videos — pick one to clip
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={analyzing}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-gray-400 transition-all hover:border-white/20 hover:text-white active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshIcon />
          Refresh
        </button>
      </div>

      {/* Video grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {videos.map((v) => (
          <div
            key={v.videoId}
            className="flex flex-col overflow-hidden rounded-2xl border border-white/5 bg-white/[0.02] transition-all hover:border-red-500/20 hover:bg-white/[0.04]"
          >
            <div className="relative aspect-video w-full overflow-hidden bg-black/40">
              <img
                src={v.thumbnailUrl}
                alt={v.title}
                loading="lazy"
                className="h-full w-full object-cover"
                onError={(e) => {
                  const img = e.target as HTMLImageElement;
                  if (!img.src.includes("hqdefault")) {
                    img.src = `https://img.youtube.com/vi/${v.videoId}/hqdefault.jpg`;
                  }
                }}
              />
            </div>
            <div className="flex flex-1 flex-col gap-3 p-4">
              <h3 className="line-clamp-2 text-sm font-medium leading-snug text-white">
                {v.title}
              </h3>
              <p className="text-xs text-gray-500">
                {formatChannelDate(v.publishedAt)}
              </p>
              <button
                type="button"
                onClick={() => onPick(v.videoId)}
                disabled={analyzing}
                className="mt-auto inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.05] px-4 py-2 text-sm font-medium text-white transition-all hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ScissorsIcon />
                Analyze & Clip
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────
   Results Section
   ───────────────────────────────────────────── */

function ResultsSection({
  result,
  isConnected,
  tiktokConnected,
  tiktokSetupPending,
  onReset,
}: {
  result: AnalysisResult;
  isConnected: boolean;
  tiktokConnected: boolean;
  tiktokSetupPending: boolean;
  onReset: () => void;
}) {
  // Local copy of the clips so per-clip re-lengthing can re-snap endTime
  // client-side without re-running the analysis.
  const [clips, setClips] = useState<ClipSuggestion[]>(() => result.clips);
  // Per-clip upload states — initialized to idle
  const [uploadStates, setUploadStates] = useState<ClipUploadState[]>(
    () => result.clips.map(() => ({ status: "idle" }))
  );
  // Global upload destination (YouTube / TikTok / Both). Defaults to the
  // first channel that is connected; clamped when a channel disconnects.
  const [destination, setDestination] = useState<Destination>(
    () => (isConnected ? "youtube" : tiktokConnected ? "tiktok" : "youtube")
  );

  // If the selected destination becomes unavailable (channel disconnected
  // while the results stay on screen), fall back to an available one.
  useEffect(() => {
    setDestination((prev) => {
      if (prev === "youtube" && !isConnected) {
        return tiktokConnected ? "tiktok" : "youtube";
      }
      if (prev === "tiktok" && !tiktokConnected) {
        return isConnected ? "youtube" : "tiktok";
      }
      if (prev === "both" && !(isConnected && tiktokConnected)) {
        return isConnected ? "youtube" : tiktokConnected ? "tiktok" : "youtube";
      }
      return prev;
    });
  }, [isConnected, tiktokConnected]);

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

  // Preview gating: a clip's upload stays disabled until the user has seen
  // the exact clip range. `previewed[i]` records that the user watched it;
  // `previewIndex` controls which clip's player is currently expanded.
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [previewed, setPreviewed] = useState<boolean[]>(
    () => result.clips.map(() => false)
  );

  const handlePreview = useCallback((clipIndex: number) => {
    // Mark this clip as previewed and expand its player (only one at a time).
    setPreviewed((prev) => {
      const next = [...prev];
      next[clipIndex] = true;
      return next;
    });
    setPreviewIndex((cur) => (cur === clipIndex ? null : clipIndex));
  }, []);

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
            // Where to publish: "youtube" | "tiktok" | "both"
            destination,
            // Caption segments for this clip time window (optional;
            // the server burns them in when present).
            segments: clip.captions ?? [],
          }),
        });

        const data = (await resp.json()) as {
          success: boolean;
          background?: boolean;
          accepted?: boolean;
          videoId?: string;
          videoUrl?: string;
          destination?: Destination;
          youtube?: { videoId: string; videoUrl: string };
          tiktok?: { publishId?: string; videoUrl?: string };
          partialError?: string;
          error?: string;
        };

        // The server CONFIRMED acceptance and is processing the upload in the
        // background. This is honest only because it is a real server
        // response (202): success is never inferred from a fetch failure.
        if (resp.status === 202 && data.background) {
          setUploadStates((prev) => {
            const next = [...prev];
            next[clipIndex] = {
              status: "background",
              destination: data.destination ?? destination,
            };
            return next;
          });
        } else if (data.success) {
          // Confirmed success (non-background path, kept for compatibility)
          // — including partial success for "both" uploads where one
          // destination failed (data.partialError).
          setUploadStates((prev) => {
            const next = [...prev];
            next[clipIndex] = {
              status: data.partialError ? "partial" : "success",
              videoUrl: data.videoUrl,
              videoId: data.videoId,
              destination: data.destination,
              youtube: data.youtube,
              tiktok: data.tiktok,
              partialError: data.partialError,
            };
            return next;
          });
        } else {
          // The server answered with an error (e.g. NO_AUTH 401, bad body).
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
        // No server response at all (network failure, connection refused,
        // wrong host, request never sent). The upload was NOT accepted by the
        // server, so it must never be shown as success.
        setUploadStates((prev) => {
          const next = [...prev];
          next[clipIndex] = {
            status: "error",
            errorMessage:
              "Upload konnte nicht gesendet werden – keine Verbindung zum Server. Prüfe, dass du die ClipFlow-App über die richtige URL öffnest, und versuch es erneut.",
          };
          return next;
        });
      }
    },
    [clips, result.videoId, destination]
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

      {/* Destination selector — where uploaded clips should go */}
      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-400">Upload to:</span>
          <div className="inline-flex rounded-xl border border-white/10 bg-white/[0.04] p-1">
            <button
              type="button"
              onClick={() => setDestination("youtube")}
              disabled={!isConnected}
              title={isConnected ? undefined : "Connect YouTube first"}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
                destination === "youtube"
                  ? "bg-[#FF0000]/20 text-red-400"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              YouTube
            </button>
            <button
              type="button"
              onClick={() => setDestination("tiktok")}
              disabled={!tiktokConnected}
              title={tiktokConnected ? undefined : "Connect TikTok first"}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
                destination === "tiktok"
                  ? "bg-[#25F4EE]/10 text-[#25F4EE]"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              TikTok
            </button>
            <button
              type="button"
              onClick={() => setDestination("both")}
              disabled={!(isConnected && tiktokConnected)}
              title={
                isConnected && tiktokConnected
                  ? undefined
                  : "Connect YouTube and TikTok to upload to both"
              }
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
                destination === "both"
                  ? "bg-white/[0.12] text-white"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              Both
            </button>
          </div>
        </div>
        {tiktokSetupPending ? (
          <span
            className="text-xs text-gray-600"
            title="TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET fehlen — der Owner muss die TikTok Developer App für Content Posting einrichten"
          >
            TikTok: Setup ausstehend (TIKTOK_CLIENT_KEY fehlt)
          </span>
        ) : (
          !tiktokConnected && (
            <span className="text-xs text-gray-600">
              <a
                href="/api/auth/tiktok"
                className="text-[#25F4EE] hover:underline transition-colors"
              >
                Connect TikTok
              </a>{" "}
              to upload there too.
            </span>
          )
        )}
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
            videoId={result.videoId}
            isConnected={isConnected}
            tiktokConnected={tiktokConnected}
            tiktokSetupPending={tiktokSetupPending}
            destination={destination}
            uploadState={uploadStates[i] || { status: "idle" }}
            previewOpen={previewIndex === i}
            previewed={previewed[i]}
            onPreview={() => handlePreview(i)}
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
  videoId,
  isConnected,
  tiktokConnected,
  tiktokSetupPending,
  destination,
  uploadState,
  previewOpen,
  previewed,
  onPreview,
  onUpload,
  onRetry,
  onRelength,
}: {
  clip: ClipSuggestion;
  index: number;
  videoId: string;
  isConnected: boolean;
  tiktokConnected: boolean;
  tiktokSetupPending: boolean;
  destination: Destination;
  uploadState: ClipUploadState;
  previewOpen: boolean;
  previewed: boolean;
  onPreview: () => void;
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

          {/* Preview step — the user sees the exact clip range before upload.
              The player is only rendered once the user asks for a preview. */}
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-red-400">
                Preview deines Clips / Preview your clip
              </span>
              <span className="rounded-md bg-white/[0.06] px-2 py-0.5 font-mono text-[11px] text-gray-400">
                {formatTime(clip.startTime)} → {formatTime(clip.endTime)} ·{" "}
                {formatDuration(clip.duration)} · Short
              </span>
            </div>

            {previewOpen ? (
              <ClipVideoPreview
                videoId={videoId}
                startTime={clip.startTime}
                endTime={clip.endTime}
              />
            ) : (
              <button
                type="button"
                onClick={onPreview}
                className="mb-4 inline-flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-400 transition-all hover:bg-red-500/20 hover:text-red-300 active:scale-95"
              >
                <PlayIcon />
                Preview clip
              </button>
            )}

            <p className="mb-4 max-w-md text-[11px] leading-relaxed text-gray-500">
              So wird dein Clip als Short gepostet. Prüfe den Ausschnitt, bevor
              du ihn hochlädst — der Upload bleibt erst nach der Vorschau
              möglich.
            </p>
          </div>

          {/* Upload button — available when at least one channel is connected.
              Gated: disabled until the clip has been previewed. */}
          {isConnected || tiktokConnected ? (
            <UploadButton
              uploadState={uploadState}
              destination={destination}
              previewed={previewed}
              onUpload={onUpload}
              onRetry={onRetry}
            />
          ) : (
            <p className="text-xs text-gray-600">
              {tiktokSetupPending ? (
                "TikTok: Setup ausstehend (TIKTOK_CLIENT_KEY fehlt)"
              ) : (
                <>
                  <a
                    href="/api/auth/youtube"
                    className="text-red-400 hover:text-red-300 transition-colors"
                  >
                    Connect YouTube
                  </a>{" "}
                  or{" "}
                  <a
                    href="/api/auth/tiktok"
                    className="text-[#25F4EE] hover:underline transition-colors"
                  >
                    Connect TikTok
                  </a>{" "}
                  to upload clips directly.
                </>
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   Clip Video Preview
   ───────────────────────────────────────────── */

function ClipVideoPreview({
  videoId,
  startTime,
  endTime,
}: {
  videoId: string;
  startTime: number;
  endTime: number;
}) {
  // YouTube has no public direct .mp4 URL a browser <video> tag can use, so we
  // reuse the platform's own embed player, seeked to the exact clip range via
  // the start/end query params. This is what the upload pipeline clips.
  const src =
    `https://www.youtube.com/embed/${videoId}` +
    `?start=${Math.floor(startTime)}` +
    `&end=${Math.max(Math.floor(endTime), Math.floor(startTime) + 1)}` +
    `&autoplay=1&rel=0&modestbranding=1`;
  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-white/5 bg-black">
      <div className="relative aspect-video w-full sm:max-w-lg">
        <iframe
          src={src}
          title="Clip preview"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          className="absolute inset-0 h-full w-full"
        />
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   Upload Button
   ───────────────────────────────────────────── */

function UploadButton({
  uploadState,
  destination,
  previewed,
  onUpload,
  onRetry,
}: {
  uploadState: ClipUploadState;
  destination: Destination;
  previewed: boolean;
  onUpload: () => void;
  onRetry: () => void;
}) {
  const { status, videoUrl, errorMessage, youtube, tiktok, partialError } =
    uploadState;

  const destLabel =
    uploadState.destination || destination || "youtube";
  const successLabel =
    destLabel === "both"
      ? "Uploaded to both!"
      : destLabel === "tiktok"
        ? "Uploaded to TikTok!"
        : "Uploaded to YouTube!";

  if (status === "success") {
    const hasYtLink =
      youtube?.videoUrl || (destLabel !== "tiktok" ? videoUrl : undefined);
    const hasTtLink = tiktok?.videoUrl;
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-green-500/10 px-3 py-2 text-sm font-medium text-green-400">
            <CheckIconSolid />
            {successLabel}
          </span>
          {hasYtLink && (
            <a
              href={hasYtLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 py-2 text-sm font-medium text-white transition-all hover:bg-white/[0.12]"
            >
              <LinkIcon />
              View on YouTube
            </a>
          )}
          {hasTtLink && (
            <a
              href={hasTtLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 py-2 text-sm font-medium text-white transition-all hover:bg-white/[0.12]"
            >
              <LinkIcon />
              View on TikTok
            </a>
          )}
        </div>
        {!hasYtLink && !hasTtLink && (
          <p className="text-xs text-white/50 max-w-md">
            Running in the background — check your {destLabel === "tiktok" ? "TikTok" : "channel"}
          </p>
        )}
      </div>
    );
  }

  if (status === "partial") {
    // "both" upload where one destination succeeded and the other failed.
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-green-500/10 px-3 py-2 text-sm font-medium text-green-400">
            <CheckIconSolid />
            {youtube && !tiktok
              ? "Uploaded to YouTube ✓"
              : tiktok && !youtube
                ? "Uploaded to TikTok ✓"
                : "Partially uploaded"}
          </span>
          {youtube?.videoUrl && (
            <a
              href={youtube.videoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 py-2 text-sm font-medium text-white transition-all hover:bg-white/[0.12]"
            >
              <LinkIcon />
              View on YouTube
            </a>
          )}
          <button
            onClick={onRetry}
            className="inline-flex items-center gap-2 rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-400 transition-all hover:bg-red-500/20 hover:text-red-300 active:scale-95"
          >
            <RetryIcon />
            Retry failed
          </button>
        </div>
        {partialError && (
          <p className="text-xs text-red-400/70 max-w-md">{partialError}</p>
        )}
      </div>
    );
  }

  if (status === "background") {
    // Server accepted the upload (202) and is processing it in the background.
    // Deliberately distinct from "success": the Short is NOT up yet.
    return (
      <div className="space-y-2">
        <span className="inline-flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-300">
          <Spinner />
          Upload angenommen – läuft im Hintergrund
        </span>
        <p className="text-xs text-white/50 max-w-md">
          Das Short erscheint gleich in deinem Kanal.
        </p>
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

  // idle — label reflects the selected destination. Disabled until the clip
  // has been previewed.
  const idleLabel =
    destLabel === "both"
      ? "Upload to YouTube + TikTok"
      : destLabel === "tiktok"
        ? "Upload to TikTok"
        : "Upload to YouTube";
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        onClick={onUpload}
        disabled={!previewed}
        title={previewed ? idleLabel : "Preview the clip first to unlock upload"}
        className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-all active:scale-95 ${
          previewed
            ? "border-white/10 bg-white/[0.05] text-white hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400"
            : "cursor-not-allowed border-white/5 bg-white/[0.02] text-gray-600"
        }`}
      >
        {destLabel === "tiktok" ? <TikTokIcon /> : <UploadToYouTubeIcon />}
        {idleLabel}
      </button>
      {!previewed && (
        <span className="text-[11px] text-gray-600">
          Preview zuerst / preview first
        </span>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────
   Icons
   ───────────────────────────────────────────── */

function PlayIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M8 5.14v13.72c0 .8.87 1.3 1.56.9l10.98-6.86a1.05 1.05 0 0 0 0-1.8L9.56 4.24A1.05 1.05 0 0 0 8 5.14Z" />
    </svg>
  );
}

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

function ChannelIcon() {
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
        d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182"
      />
    </svg>
  );
}

function ScissorsIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7.848 8.25l1.536.887M7.848 8.25a3 3 0 11-4.121-4.121 3 3 0 014.121 4.121zm0 7.5l1.536-.887m-1.536.887a3 3 0 11-4.121 4.121 3 3 0 014.121-4.121zm8.616-2.016l-5.294-3.055m5.294 3.055l5.294-3.055m-5.294 3.055v.002a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm0-6.106v-.002a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0z"
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

function TikTokIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z" />
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
