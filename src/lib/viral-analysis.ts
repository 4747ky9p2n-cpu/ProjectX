/* ─────────────────────────────────────────────
   Viral Moment Analysis
   ─────────────────────────────────────────────
   Pure analysis logic (no React / no server deps):
   - scores sliding transcript windows for "viral" moments
   - picks the top non-overlapping windows
   - snaps each clip to a user-selectable length (15/30/45/60s)

   Extracted from the /app route so it can be unit-tested in isolation.
   The clip upload pipeline consumes `startTime` / `endTime` from the
   produced clips, so nothing below touches download/upload/encode code.
   ───────────────────────────────────────────── */

import type { TranscriptSegment } from "./transcript";

export interface ClipSuggestion {
  startTime: number;
  endTime: number;
  duration: number;
  title: string;
  description: string;
  viralScore: number;
  transcriptSnippet: string;
  /**
   * Transcript segments overlapping [startTime, endTime] (source-relative,
   * start/duration unchanged). Sent to the upload pipeline so the Short
   * can be encoded with burned-in captions.
   */
  captions: TranscriptSegment[];
}

/** Selectable clip lengths (seconds). Default = 30s (owner preference). */
export const CLIP_LENGTHS = [15, 30, 45, 60] as const;
export type ClipLength = (typeof CLIP_LENGTHS)[number];
export const DEFAULT_CLIP_LENGTH: ClipLength = 30;

/** Coerce an arbitrary value (e.g. from a client payload) to a valid length. */
export function normalizeClipLength(value: unknown): ClipLength {
  return CLIP_LENGTHS.includes(value as ClipLength)
    ? (value as ClipLength)
    : DEFAULT_CLIP_LENGTH;
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

/**
 * Position (seconds from window start) of the first strong signal in the
 * window: a hook phrase, a question, or an exclamation. `null` when the
 * window has none of these. Used by the hook-first positional weighting.
 */
function firstStrongSignalTime(segs: TranscriptSegment[]): number | null {
  if (segs.length === 0) return null;
  const windowStart = segs[0].start;
  for (const seg of segs) {
    const t = seg.text.trim();
    const hasHook = HOOK_PATTERNS.some((p) => p.test(t));
    const isQuestion = t.endsWith("?");
    const hasExclamation = t.includes("!");
    if (hasHook || isQuestion || hasExclamation) {
      return seg.start - windowStart;
    }
  }
  return null;
}

export interface ScoreWindowOptions {
  /** Segment directly before this window — lets us reward sentence-aligned starts. */
  prevSegment?: TranscriptSegment | null;
}

/**
 * Score a candidate window. Returns the score WITHOUT the random tiebreaker
 * (the caller adds that after computing momentum, so momentum deltas only
 * carry real signal differences, not random noise).
 *
 * New signals vs the original scorer:
 *  - Hook-first positional weighting (+8 early signal, −5 late signal)
 *  - Punctuation-aware window boundaries (+4 end-of-sentence, +4 start-of-sentence)
 * The original signals (hooks, questions, info density, numbers, emotion,
 * exclamations, punchlines, duration sweet spot, structure) are unchanged.
 * Exported for the test harness (per-window before/after comparison).
 */
export function scoreWindow(
  text: string,
  segs: TranscriptSegment[],
  duration: number,
  opts: ScoreWindowOptions = {}
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

  // 1b. Hook-first positional weighting — a hook that lands in the FIRST
  // ~20% of the window makes a punchy short; a window whose only strong
  // signal arrives late is mostly setup, so it scores lower.
  const firstSignal = firstStrongSignalTime(segs);
  if (firstSignal !== null) {
    if (firstSignal <= Math.min(8, duration * 0.25)) {
      score += 8; // strong signal inside the first ~5–8s
    } else if (firstSignal >= duration * 0.7) {
      score -= 5; // strong signal is late — weak hook
    }
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

  // 8. Punctuation-aware windowing — clips that start/end on sentence
  // boundaries feel like complete moments. +4 if the window's last segment
  // ends a sentence, +4 if the window starts at a sentence boundary.
  const lastSegText = segs[segs.length - 1].text.trim();
  if (/[.!?…]$/.test(lastSegText)) {
    score += 4;
  }
  const prevSegText = opts.prevSegment?.text.trim();
  if (prevSegText && /[.!?…]$/.test(prevSegText)) {
    score += 4;
  }

  return score;
}

/* ─────────────────────────────────────────────
   Main Analysis
   ───────────────────────────────────────────── */

/**
 * Find the most viral moments in a transcript and snap each one to the
 * requested clip length.
 *
 * @param clipLength user-selected length in seconds (15/30/45/60; default 30)
 */
export function analyzeViralMoments(
  segments: TranscriptSegment[],
  clipLengthInput: number = DEFAULT_CLIP_LENGTH
): ClipSuggestion[] {
  const clipLength = normalizeClipLength(clipLengthInput);

  const WINDOW_SEC = 50; // look at 50-second windows
  const STEP_SEC = 12; // slide by ~12 seconds
  const MIN_DURATION = 22; // minimum natural window length
  const MAX_WINDOW_SEC = 65; // natural windows longer than this are dropped
  const MAX_CLIP_SEC = 60; // hard cap on produced clip length (Shorts limit)
  const MAX_CLIPS = 5;
  const OVERLAP_TOLERANCE_SEC = 5; // allow picking a candidate that starts
  // up to 5s before a previously picked clip's end — strong nearby moments
  // are no longer both discarded by strict non-overlap.

  // Combine full text for topic extraction
  const fullText = segments.map((s) => s.text).join(" ");

  // Video end = end of the last transcript segment. Clip ends are clamped
  // to this so we never extend beyond available content.
  const videoEnd =
    segments[segments.length - 1].start + segments[segments.length - 1].duration;

  interface WindowCandidate {
    startIdx: number;
    endIdx: number;
    score: number;
  }

  const candidates: WindowCandidate[] = [];
  // Scores of previously scored windows (start time -> score), used to
  // compute the momentum bonus (score rising vs ~2 windows earlier).
  const scoredHistory: Array<{ start: number; score: number }> = [];

  const advance = Math.max(1, Math.floor(STEP_SEC / 5)); // ≈2 segments (~12s)

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

    // A window is usable if it can supply at least a meaningful chunk of the
    // chosen length. For short clips (15s) this admits shorter natural
    // windows than before; for long clips it still enforces MIN_DURATION.
    if (actualDuration < Math.min(MIN_DURATION, clipLength)) continue;
    if (actualDuration > MAX_WINDOW_SEC) continue;

    const windowText = windowSegs.map((s) => s.text).join(" ");
    let score = scoreWindow(windowText, windowSegs, actualDuration, {
      prevSegment: i > 0 ? segments[i - 1] : null,
    });

    // Momentum: reward windows whose score is rising vs ~2 windows earlier
    // (~24s back). "Something is building" moments hook viewers better than
    // flat stretches. +10 for a steep rise (Δ ≥ 15), +5 for a solid rise
    // (Δ ≥ 8).
    const targetTime = windowStart - 2 * STEP_SEC;
    let prevScored: { start: number; score: number } | null = null;
    for (const h of scoredHistory) {
      if (h.start >= windowStart - STEP_SEC) continue; // must be ≥1 window back
      if (
        !prevScored ||
        Math.abs(h.start - targetTime) < Math.abs(prevScored.start - targetTime)
      ) {
        prevScored = h;
      }
    }
    if (prevScored) {
      const delta = score - prevScored.score;
      if (delta >= 15) score += 10;
      else if (delta >= 8) score += 5;
    }

    // Base randomness to differentiate similar clips (added AFTER momentum so
    // momentum deltas only carry real signal differences).
    score += Math.random() * 8;

    scoredHistory.push({ start: windowStart, score });
    candidates.push({ startIdx: i, endIdx, score });

    // Step forward
    i += advance;
  }

  if (candidates.length === 0) {
    // Fallback: take first, middle, and last chunks (still snapped to length)
    const chunkSize = Math.ceil(segments.length / MAX_CLIPS);
    for (let c = 0; c < MAX_CLIPS; c++) {
      const startIdx = c * chunkSize;
      const endIdx = Math.min(startIdx + chunkSize, segments.length);
      if (endIdx - startIdx < 3) continue;

      candidates.push({
        startIdx,
        endIdx,
        score: 50 + Math.random() * 20, // random baseline
      });
    }
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  // Pick top clips with overlap tolerance, snapping each to clipLength
  const selected: ClipSuggestion[] = [];
  const usedRanges: Array<[number, number]> = [];

  for (const cand of candidates) {
    if (selected.length >= MAX_CLIPS) break;

    const startTime = segments[cand.startIdx].start;
    // Snap to the chosen length — keep the hook at the START of the window,
    // trim the end. Clamp to the video length and to the 60s Shorts cap.
    // If the natural window is shorter than the chosen length (e.g. a 20s
    // window with 45s selected), the natural end is used — never extend
    // beyond available content.
    const endTime = Math.min(
      startTime + clipLength,
      videoEnd,
      startTime + MAX_CLIP_SEC
    );
    const duration = Math.round(endTime - startTime);
    if (duration < Math.min(10, clipLength)) continue; // too short to be usable

    // Overlap check with tolerance: allow a candidate that starts at most
    // OVERLAP_TOLERANCE_SEC before a previously picked clip's end.
    const conflicts = usedRanges.some(
      ([s, e]) => startTime < e - OVERLAP_TOLERANCE_SEC && endTime > s
    );
    if (conflicts) continue;

    // Segments actually inside the (snapped) clip — what the viewer sees.
    const clipSegs = segments.filter(
      (seg) => seg.start + seg.duration > startTime && seg.start < endTime
    );
    const clipText = clipSegs.map((s) => s.text).join(" ");
    const title = generateTitle(clipText, clipSegs);
    const description = generateDescription(clipText, fullText, duration);

    selected.push({
      startTime,
      endTime,
      duration,
      title,
      description,
      viralScore: Math.min(100, Math.round(cand.score)),
      transcriptSnippet: clipText.slice(0, 200) + "...",
      captions: clipSegs.map((s) => ({
        text: s.text,
        start: s.start,
        duration: s.duration,
      })),
    });

    usedRanges.push([startTime, endTime]);
  }

  return selected;
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
