/* ─────────────────────────────────────────────
   KI-Sprach-Kategorie — Viral-fact generation
   ─────────────────────────────────────────────
   Produces the short spoken "viral fact" text that gets voiced and burned
   onto the background video.

   AI path (factSource === "ai"): when no user text is given, generate the
   fact from the video's transcript:
     1. fetch the transcript (reuses the existing `fetchTranscript` pipeline),
     2. run the existing viral-moment analysis and take the highest-scoring
        clip's snippet as the factual seed,
     3. phrase it as a curiosity-style "viral fact" sentence appropriate to
        the character's language.

   Local fallback: if the transcript is unavailable (no captions, service
   down, or the URL is malformed), fall back to a lightweight local template
   so the pipeline still returns spoken text instead of erroring.

   The transcript fetch is injectable so unit tests can stub it (no network).
   ───────────────────────────────────────────── */

import { analyzeViralMoments, type ClipSuggestion } from "./viral-analysis";
import { fetchTranscript, type TranscriptSegment } from "./transcript";
import type { CharacterLanguage } from "./characters";

export interface FactOptions {
  /** Source video URL. */
  videoUrl: string;
  /** Language the fact should be phrased in (from the character). */
  language: CharacterLanguage;
  /** Injectable transcript fetcher (defaults to the real one). */
  fetchTranscriptFn?: (videoId: string) => Promise<TranscriptSegment[]>;
}

export interface FactResult {
  /** The spoken text. */
  text: string;
  /** Where it came from — "ai" (transcript-derived) or "fallback" (local). */
  source: "ai" | "fallback";
  /** Used to detect malformed URLs without leaking anything. */
  videoId?: string;
}

/** Extract a YouTube video id from common URL shapes. */
export function extractVideoId(videoUrl: string): string | null {
  const m = videoUrl.match(
    /(?:[?&]v=|youtu\.be\/|shorts\/|embed\/|live\/|^)([A-Za-z0-9_-]{11})(?:[?&#]|$)/
  );
  return m && /^[A-Za-z0-9_-]{11}$/.test(m[1]!) ? m[1]! : null;
}

/**
 * Phrase a raw transcript snippet as a spoken "viral fact" in the requested
 * language. Keeps it terse (1-3 sentences) so the TTS stays a Short-length.
 * Exported for unit tests.
 */
export function phraseFact(snippet: string, language: CharacterLanguage): string {
  const clean = snippet
    .replace(/[.!?]+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (language === "de") {
    return `Wusstest du, dass ${lowerFirst(clean)}?`;
  }
  return `Did you know that ${lowerFirst(clean)}?`;
}

/** Lowercase the first rune (for embedding a phrase mid-sentence). */
function lowerFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * Pick the most "viral" factual snippet from the analysis. We take the top
 * scored clip's transcript snippet (the analysis already ranks moments) and
 * trim to a Short-sized read (~≤180 chars). Exported for unit tests.
 */
export function pickFactualSnippet(
  clips: ClipSuggestion[],
  maxChars: number = 180
): string {
  if (!clips || clips.length === 0) return "";
  const top = clips[0];
  let s = (top.transcriptSnippet || top.captions.map((c) => c.text).join(" "))
    .replace(/\.\.\.$/, "")
    .replace(/\.\.\./g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // End on a sentence boundary if possible.
  const boundary = s.search(/[.!?](?:\s|$)/);
  if (boundary > 20 && boundary < s.length - 10) {
    s = s.slice(0, boundary + 1);
  }
  if (s.length > maxChars) {
    const cut = s.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(" ");
    s = cut.slice(0, lastSpace > maxChars * 0.7 ? lastSpace : maxChars);
  }
  return s.trim();
}

/**
 * Local fallback facts (used when no transcript is available). Pure template
 * text in the character's language — a safe, generic curiosity hook.
 */
export function localFallbackFact(language: CharacterLanguage): string {
  if (language === "de") {
    return (
      "Wusstest du, dass die meisten viralen Videos in den ersten drei " +
      "Sekunden entscheiden, ob man weiterschaut? Das ist der Grund, " +
      "warum dieser Moment so gut funktioniert."
    );
  }
  return (
    "Did you know that most viral videos are won or lost in the first three " +
    "seconds? That is exactly why this moment works so well."
  );
}

/**
 * Generate a spoken viral-fact string for a video. Throws nothing — on any
 * transcript failure it returns the local fallback (source: "fallback").
 */
export async function generateViralFact(
  opts: FactOptions
): Promise<FactResult> {
  const videoId = extractVideoId(opts.videoUrl);
  if (!videoId) {
    return { text: localFallbackFact(opts.language), source: "fallback" };
  }
  const fetchFn = opts.fetchTranscriptFn ?? fetchTranscript;
  try {
    const segments = await fetchFn(videoId);
    const clips = analyzeViralMoments(segments, 30);
    const snippet = pickFactualSnippet(clips);
    if (!snippet) {
      return { text: localFallbackFact(opts.language), source: "fallback", videoId };
    }
    return {
      text: phraseFact(snippet, opts.language),
      source: "ai",
      videoId,
    };
  } catch {
    return { text: localFallbackFact(opts.language), source: "fallback", videoId };
  }
}
