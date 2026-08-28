/**
 * Viral-fact generation tests.
 *
 * Covers:
 *   - video id extraction from common URL shapes,
 *   - phrasing a snippet as a spoken fact (de + en),
 *   - choosing a factual snippet from the viral analysis,
 *   - the AI path (transcript-derived) and the local fallback path,
 *   - malformed-URL handling.
 * The transcript fetch is INJECTED (no network), per the team's no-shared-
 * module-scope-mock rule.
 */
import { describe, test, expect } from "bun:test";
import {
  extractVideoId,
  generateViralFact,
  localFallbackFact,
  phraseFact,
  pickFactualSnippet,
} from "../src/lib/factgen";
import type { TranscriptSegment } from "../src/lib/transcript";

/** A transcript that yields at least one viral clip candidate. */
const GOOD_SEGMENTS: TranscriptSegment[] = [
  { text: "This is an amazing secret trick that changed everything", start: 0, duration: 3 },
  { text: "Researchers found that this hack saves people insane amounts of money", start: 5, duration: 4 },
  { text: "Did you know the answer is actually incredibly simple", start: 11, duration: 4 },
  { text: "The whole story is mind blowing and completely unexpected today", start: 17, duration: 5 },
  { text: "And that is why everyone should know about this right now", start: 25, duration: 4 },
  { text: "Mark my words, experts agree it is a huge huge deal", start: 32, duration: 4 },
];

describe("extractVideoId", () => {
  test("parses watch, shorts, youtu.be and embed URLs", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    );
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://youtube.com/shorts/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    );
    expect(extractVideoId("https://youtube.com/embed/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    );
  });

  test("returns null for non-YouTube input", () => {
    expect(extractVideoId("not a url")).toBeNull();
    expect(extractVideoId("https://example.com/video/abc")).toBeNull();
  });
});

describe("phraseFact", () => {
  test("phrases a fact in German", () => {
    const out = phraseFact("Dies ist erstaunlich.", "de");
    expect(out).toContain("Wusstest du, dass");
    expect(out).toContain("dies ist erstaunlich");
  });
  test("phrases a fact in English", () => {
    const out = phraseFact("This is amazing.", "en");
    expect(out).toContain("Did you know that");
    expect(out).toContain("this is amazing");
  });
});

describe("pickFactualSnippet", () => {
  test("returns empty for no clips", () => {
    expect(pickFactualSnippet([])).toBe("");
  });
  test("picks the top clip and trims to a Short-sized read", () => {
    const snippet = pickFactualSnippet([
      {
        startTime: 0,
        endTime: 30,
        duration: 30,
        title: "t",
        description: "d",
        viralScore: 90,
        transcriptSnippet: "Researchers found that this hack saves people. And more text here...",
        captions: [],
      },
    ]);
    expect(snippet.length).toBeGreaterThan(0);
    expect(snippet.length).toBeLessThanOrEqual(180);
  });
});

describe("generateViralFact", () => {
  test("AI path derives a fact from a transcript (source: ai)", async () => {
    const res = await generateViralFact({
      videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      language: "en",
      fetchTranscriptFn: async () => GOOD_SEGMENTS,
    });
    expect(res.source).toBe("ai");
    expect(res.text.length).toBeGreaterThan(0);
    expect(res.videoId).toBe("dQw4w9WgXcQ");
  });

  test("AI path wraps the fact for German characters", async () => {
    const res = await generateViralFact({
      videoUrl: "https://youtu.be/dQw4w9WgXcQ",
      language: "de",
      fetchTranscriptFn: async () => GOOD_SEGMENTS,
    });
    expect(res.source).toBe("ai");
    expect(res.text).toMatch(/Wusstest du, dass/);
  });

  test("falls back to a local fact when the transcript fails", async () => {
    const res = await generateViralFact({
      videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      language: "de",
      fetchTranscriptFn: async () => {
        throw new Error("no captions");
      },
    });
    expect(res.source).toBe("fallback");
    expect(res.text).toContain("Wusstest du, dass");
    expect(localFallbackFact("de")).toBe(res.text);
  });

  test("returns the fallback for malformed URLs (never throws)", async () => {
    const res = await generateViralFact({
      videoUrl: "garbage",
      language: "en",
      fetchTranscriptFn: async () => {
        throw new Error("should not be called");
      },
    });
    expect(res.source).toBe("fallback");
    expect(localFallbackFact("en")).toBe(res.text);
  });
});
