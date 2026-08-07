import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState, useEffect, useCallback } from "react";
import type { YouTubeChannel } from "~/lib/youtube-auth";
import { fetchTranscript } from "~/lib/transcript";
import type { TranscriptSegment } from "~/lib/transcript";

interface ClipSuggestion {
  startTime: number;
  endTime: number;
  duration: number;
  title: string;
  description: string;
  viralScore: number;
  transcriptSnippet: string;
}

interface AnalysisResult {
  videoTitle: string;
  videoId: string;
  thumbnailUrl: string;
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
    const d = data as { url: string };
    if (!d.url || typeof d.url !== "string" || d.url.trim().length === 0) {
      throw new Error("URL is required");
    }
    return { url: d.url.trim() };
  })
  .handler(async ({ data }): Promise<AnalysisResult> => {
    const { url } = data;

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
      throw new Error(msg);
    }

    if (!segments || segments.length < 5) {
      throw new Error("Transcript too short for analysis. Try a longer video.");
    }

    // 3. Analyze for viral moments
    const clips = analyzeViralMoments(segments);

    if (clips.length === 0) {
      throw new Error("Could not identify clear viral moments in this video.");
    }

    // 4. Fetch video metadata
    const metadata = await fetchVideoMetadata(videoId);

    return {
      videoTitle: metadata.title,
      videoId,
      thumbnailUrl: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
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
      { signal: AbortSignal.timeout(5000) }
    );
    if (resp.ok) {
      const data = (await resp.json()) as { title?: string };
      return { title: data.title || "Untitled Video" };
    }
  } catch {
    // fallback
  }
  return { title: "YouTube Video" };
}

/* ─────────────────────────────────────────────
   Viral Moment Analysis
   ───────────────────────────────────────────── */

function analyzeViralMoments(
  segments: TranscriptSegment[]
): ClipSuggestion[] {
  const WINDOW_SEC = 50; // look at 50-second windows
  const STEP_SEC = 12; // slide by 12 seconds
  const MIN_DURATION = 22; // minimum clip length
  const MAX_DURATION = 65; // maximum clip length
  const MAX_CLIPS = 5;

  // Combine full text for topic extraction
  const fullText = segments.map((s) => s.text).join(" ");

  interface WindowCandidate {
    startIdx: number;
    endIdx: number;
    score: number;
  }

  const candidates: WindowCandidate[] = [];

  for (let i = 0; i < segments.length; i++) {
    const windowStart = segments[i].start;
    const windowEnd = windowStart + WINDOW_SEC;

    // Find all segments in this window
    let endIdx = i;
    while (
      endIdx < segments.length &&
      segments[endIdx].start < windowEnd
    ) {
      endIdx++;
    }

    const windowSegs = segments.slice(i, endIdx);
    if (windowSegs.length < 3) continue;

    const actualDuration =
      windowSegs[windowSegs.length - 1].start +
      windowSegs[windowSegs.length - 1].duration -
      windowStart;

    if (actualDuration < MIN_DURATION || actualDuration > MAX_DURATION) continue;

    const windowText = windowSegs.map((s) => s.text).join(" ");
    const score = scoreWindow(windowText, windowSegs, actualDuration);

    candidates.push({ startIdx: i, endIdx, score });

    // Step forward
    i += Math.max(1, Math.floor(STEP_SEC / 5)); // rough step
  }

  if (candidates.length === 0) {
    // Fallback: take first, middle, and last chunks
    const chunkSize = Math.ceil(segments.length / MAX_CLIPS);
    for (let c = 0; c < MAX_CLIPS; c++) {
      const startIdx = c * chunkSize;
      const endIdx = Math.min(startIdx + chunkSize, segments.length);
      if (endIdx - startIdx < 3) continue;

      const windowSegs = segments.slice(startIdx, endIdx);
      const windowText = windowSegs.map((s) => s.text).join(" ");
      const startTime = segments[startIdx].start;
      const endTime =
        segments[endIdx - 1].start + segments[endIdx - 1].duration;
      const duration = endTime - startTime;

      candidates.push({
        startIdx,
        endIdx,
        score: 50 + Math.random() * 20, // random baseline
      });
    }
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  // Pick top clips, avoiding overlaps
  const selected: ClipSuggestion[] = [];
  const usedRanges: Array<[number, number]> = [];

  for (const cand of candidates) {
    if (selected.length >= MAX_CLIPS) break;

    const windowSegs = segments.slice(cand.startIdx, cand.endIdx);
    const startTime = segments[cand.startIdx].start;
    const endTime =
      segments[cand.endIdx - 1].start + segments[cand.endIdx - 1].duration;
    const duration = Math.round(endTime - startTime);

    // Check overlap with already selected
    const overlaps = usedRanges.some(
      ([s, e]) => startTime < e && endTime > s
    );
    if (overlaps) continue;

    const windowText = windowSegs.map((s) => s.text).join(" ");
    const title = generateTitle(windowText, windowSegs);
    const description = generateDescription(windowText, fullText, duration);

    selected.push({
      startTime,
      endTime,
      duration,
      title,
      description,
      viralScore: Math.min(100, Math.round(cand.score)),
      transcriptSnippet: windowText.slice(0, 200) + "...",
    });

    usedRanges.push([startTime, endTime]);
  }

  return selected;
}

/* ─────────────────────────────────────────────
   Scoring Algorithm
   ───────────────────────────────────────────── */

// Words/phrases that indicate a strong hook (first few seconds of a clip)
const HOOK_PATTERNS = [
  /\b(this|here'?s|watch|look|see|check)\b/i,
  /\b(secret|trick|hack|never|always|worst|best|insane|crazy|shocking)\b/i,
  /\b(did you know|what if|imagine|stop|wait)\b/i,
  /\b(you need to|you have to|you must|everyone|nobody)\b/i,
  /\b(why|how|when|where|who)\b.+\?/i,
  /\b(exposed|truth|real reason|nobody talks about)\b/i,
];

// Words indicating emotional peaks
const EMOTION_WORDS = [
  "amazing",
  "incredible",
  "unbelievable",
  "terrible",
  "horrible",
  "awesome",
  "insane",
  "crazy",
  "wild",
  "ridiculous",
  "hilarious",
  "brilliant",
  "genius",
  "stunning",
  "breathtaking",
  "disgusting",
  "outrageous",
  "devastating",
  "spectacular",
  "extraordinary",
  "mind-blowing",
  "game-changing",
  "life-changing",
  "unprecedented",
  "massive",
  "huge",
  "enormous",
  "insane",
];

// Words indicating information density / value
const INFO_DENSITY_WORDS = [
  "actually",
  "basically",
  "essentially",
  "specifically",
  "importantly",
  "crucial",
  "critical",
  "key",
  "fundamental",
  "research",
  "study",
  "data",
  "evidence",
  "proven",
  "discovered",
  "found",
  "revealed",
  "according to",
  "scientists",
  "experts",
  "years",
  "percent",
  "million",
  "billion",
  "thousand",
  "dollars",
];

// Strong closing/punchline phrases
const PUNCHLINE_PATTERNS = [
  /\b(that'?s why|that'?s how|and that'?s|so yeah|there you go|boom)\b/i,
  /\b(mind blown|blew my mind|changed everything|game over)\b/i,
  /\b(remember that|don'?t forget|mark my words|trust me)\b/i,
  /\b(let that sink in|think about that|wrap your head around)\b/i,
];

function scoreWindow(
  text: string,
  segs: TranscriptSegment[],
  duration: number
): number {
  let score = 0;

  // 1. Hook score (first ~5 seconds of the window)
  const first5Words = segs.slice(0, 3).map((s) => s.text).join(" ");
  for (const pattern of HOOK_PATTERNS) {
    if (pattern.test(first5Words)) {
      score += 18;
      break;
    }
  }

  // Check if the clip starts with a question
  if (segs.length > 0 && segs[0].text.trim().endsWith("?")) {
    score += 12;
  }

  // 2. Information density score
  const words = text.split(/\s+/);
  const wordCount = words.length;
  if (wordCount === 0) return score;

  // Count info-dense words
  let infoHits = 0;
  for (const w of INFO_DENSITY_WORDS) {
    const regex = new RegExp(`\\b${w}\\b`, "gi");
    const matches = text.match(regex);
    if (matches) infoHits += matches.length;
  }
  const infoDensity = (infoHits / wordCount) * 100;
  score += Math.min(25, infoDensity * 8);

  // Count numbers / statistics
  const numberMatches = text.match(/\d+(\.\d+)?/g);
  if (numberMatches) {
    score += Math.min(15, numberMatches.length * 4);
  }

  // 3. Emotional peaks
  let emotionHits = 0;
  for (const w of EMOTION_WORDS) {
    const regex = new RegExp(`\\b${w}\\b`, "gi");
    const matches = text.match(regex);
    if (matches) emotionHits += matches.length;
  }
  score += Math.min(20, emotionHits * 6);

  // Exclamation marks indicate strong emotion
  const exclamCount = (text.match(/!/g) || []).length;
  score += Math.min(10, exclamCount * 3);

  // 4. Question density (engagement)
  const questionCount = (text.match(/\?/g) || []).length;
  score += Math.min(8, questionCount * 2);

  // 5. Punchline/conclusion score (last ~5 seconds)
  const lastSegs = segs.slice(-3);
  const lastText = lastSegs.map((s) => s.text).join(" ");
  for (const pattern of PUNCHLINE_PATTERNS) {
    if (pattern.test(lastText)) {
      score += 15;
      break;
    }
  }

  // 6. Duration bonus — sweet spot is 30-55 seconds for Shorts
  if (duration >= 30 && duration <= 55) {
    score += 12;
  } else if (duration >= 25 && duration <= 60) {
    score += 8;
  }

  // 7. Structural completeness — has clear beginning, middle, end
  // (approximated by having segments spread across the window)
  if (segs.length >= 5 && duration >= 28) {
    score += 6;
  }

  // Base randomness to differentiate similar clips
  score += Math.random() * 8;

  return score;
}

/* ─────────────────────────────────────────────
   Title & Description Generation
   ───────────────────────────────────────────── */

const TITLE_TEMPLATES = [
  (subject: string, topic: string) =>
    `The moment ${subject} revealed the truth about ${topic}`,
  (subject: string, topic: string) =>
    `${subject} explains why ${topic} is a game-changer`,
  (_s: string, topic: string) =>
    `You need to hear this about ${topic} 💡`,
  (_s: string, topic: string) =>
    `This ${topic} changed how I think forever`,
  (subject: string, topic: string) =>
    `${subject} just exposed everything about ${topic}`,
  (_s: string, topic: string) =>
    `Why everyone is wrong about ${topic}`,
  (subject: string, _t: string) =>
    `${subject} dropped some serious knowledge 🔥`,
  (_s: string, topic: string) =>
    `The ${topic} secret nobody talks about`,
  (subject: string, topic: string) =>
    `${subject} on ${topic}: mind = blown 🤯`,
  (subject: string, _t: string) =>
    `${subject} said what we were all thinking`,
  (_s: string, topic: string) =>
    `Stop scrolling — this ${topic} take is wild`,
  (subject: string, topic: string) =>
    `${subject}'s hot take on ${topic} is going viral`,
];

// Emojis for variety
const EMOJIS = ["🔥", "💡", "🤯", "😱", "💯", "🚀", "⚡", "🎯", "👀", "🧠"];

function generateTitle(
  windowText: string,
  _segs: TranscriptSegment[]
): string {
  // Extract key subject and topic
  const { subject, topic } = extractSubjectTopic(windowText);

  // Pick a random template
  const template =
    TITLE_TEMPLATES[Math.floor(Math.random() * TITLE_TEMPLATES.length)];
  let title = template(subject, topic);

  // Ensure max 60 chars
  if (title.length > 60) {
    title = title.slice(0, 57) + "...";
  }

  return title;
}

function extractSubjectTopic(text: string): {
  subject: string;
  topic: string;
} {
  // Try to find "X about Y" or "X is Y" patterns
  const words = text.split(/\s+/);
  const properNouns: string[] = [];

  for (const w of words) {
    const clean = w.replace(/[^a-zA-Z0-9]/g, "");
    if (clean.length > 2 && /^[A-Z][a-z]/.test(clean)) {
      properNouns.push(clean);
    }
  }

  // Common nouns that work well as topics
  const topicKeywords = [
    "AI",
    "money",
    "success",
    "failure",
    "business",
    "life",
    "productivity",
    "health",
    "mindset",
    "growth",
    "marketing",
    "content",
    "creativity",
    "happiness",
    "wealth",
    "learning",
    "habit",
    "routine",
    "strategy",
    "mistake",
    "opportunity",
    "truth",
    "reality",
    "future",
    "mind",
  ];

  let topic = "this";
  for (const kw of topicKeywords) {
    if (text.toLowerCase().includes(kw.toLowerCase())) {
      topic = kw;
      break;
    }
  }

  // If no keyword found, use a meaningful word from the text
  if (topic === "this") {
    const meaningful = words.find(
      (w) =>
        w.replace(/[^a-zA-Z]/g, "").length > 4 &&
        !["this", "that", "there", "about", "their", "would", "could", "should"].includes(
          w.toLowerCase().replace(/[^a-zA-Z]/g, "")
        )
    );
    if (meaningful) {
      topic = meaningful.replace(/[^a-zA-Z]/g, "").toLowerCase();
    }
  }

  let subject = "They";
  if (properNouns.length > 0) {
    subject = properNouns[0];
  } else {
    // Extract a subject-like word
    const subjectCandidates = words.filter(
      (w) =>
        w.replace(/[^a-zA-Z]/g, "").length > 3 &&
        w === w.replace(/[^a-zA-Z]/g, "") &&
        !["this", "that", "there", "about", "their", "would", "could", "should"].includes(
          w.toLowerCase()
        )
    );
    if (subjectCandidates.length > 0) {
      subject =
        subjectCandidates[Math.floor(Math.random() * subjectCandidates.length)];
      subject = subject.charAt(0).toUpperCase() + subject.slice(1);
    }
  }

  return { subject, topic };
}

function generateDescription(
  windowText: string,
  _fullText: string,
  _duration: number
): string {
  // Extract hashtags from key terms
  const hashtags = generateHashtags(windowText);

  // Generate a short description
  const firstSentence =
    windowText.split(/[.!?]/)[0]?.trim().slice(0, 100) || "";

  const description = `${firstSentence}...\n\n${hashtags}`;
  return description;
}

function generateHashtags(text: string): string {
  const lower = text.toLowerCase();

  const tagMap: Record<string, string> = {
    money: "#money",
    business: "#business",
    success: "#success",
    life: "#life",
    productivity: "#productivity",
    mindset: "#mindset",
    growth: "#growth",
    marketing: "#marketing",
    content: "#content",
    ai: "#ai",
    health: "#health",
    learning: "#learning",
    strategy: "#strategy",
    future: "#future",
    tech: "#tech",
    startup: "#startup",
    motivation: "#motivation",
    inspiration: "#inspiration",
    creativity: "#creativity",
  };

  const matched: string[] = [];
  for (const [key, tag] of Object.entries(tagMap)) {
    if (lower.includes(key) && !matched.includes(tag)) {
      matched.push(tag);
    }
  }

  // Always include some generic ones
  const genericTags = ["#shorts", "#viral", "#clipflow", "#youtube"];
  const tags = [...matched, ...genericTags];

  // Deduplicate & limit to 5
  const unique = [...new Set(tags)].slice(0, 5);
  return unique.join(" ");
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

function viralScoreLabel(score: number): string {
  if (score >= 85) return "🔥 Viral";
  if (score >= 70) return "🔥 Hot";
  if (score >= 55) return "⚡ Good";
  return "👀 Decent";
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
      const result = await analyzeVideo({ data: { url: url.trim() } });
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
  // Per-clip upload states — initialized to idle
  const [uploadStates, setUploadStates] = useState<ClipUploadState[]>(
    () => result.clips.map(() => ({ status: "idle" }))
  );

  const handleUpload = useCallback(
    async (clipIndex: number) => {
      const clip = result.clips[clipIndex];
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
      } catch (err) {
        setUploadStates((prev) => {
          const next = [...prev];
          next[clipIndex] = {
            status: "error",
            errorMessage:
              err instanceof Error ? err.message : "Network error. Check your connection.",
          };
          return next;
        });
      }
    },
    [result.clips, result.videoId]
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
              {result.clips.length} viral moments
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
        {result.clips.map((clip, i) => (
          <ClipCard
            key={i}
            clip={clip}
            index={i + 1}
            isConnected={isConnected}
            uploadState={uploadStates[i] || { status: "idle" }}
            onUpload={() => handleUpload(i)}
            onRetry={() => handleRetry(i)}
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
}: {
  clip: ClipSuggestion;
  index: number;
  isConnected: boolean;
  uploadState: ClipUploadState;
  onUpload: () => void;
  onRetry: () => void;
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

  if (status === "success" && videoUrl) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-green-500/10 px-3 py-2 text-sm font-medium text-green-400">
          <CheckIconSolid />
          Uploaded!
        </span>
        <a
          href={videoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 py-2 text-sm font-medium text-white transition-all hover:bg-white/[0.12]"
        >
          <LinkIcon />
          View on YouTube
        </a>
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
