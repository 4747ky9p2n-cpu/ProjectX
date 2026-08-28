/**
 * Character library tests.
 *
 * Enforces the KI-Sprach-Kategorie constraints:
 *   - at least 6 characters,
 *   - unique ids,
 *   - every voiceId is a valid, freely-available Piper voice (all voices the
 *     app pre-downloads for the character library),
 *   - NO reserved/trademarked names or real-figure clones (owner constraint:
 *     parody voices only, never a literal copyright/celebrity copy),
 *   - every character has bio, emoji, style, language and sane pitch/rate.
 */
import { describe, test, expect } from "bun:test";
import {
  CHARACTERS,
  RESERVED_NAMES,
  allIdsUnique,
  characterIds,
  findCharacter,
  isAllowedName,
} from "../src/lib/characters";

/**
 * The set of freely-licensed Piper voices the app uses. Tests assert every
 * library entry maps to one of these (so a future edit can't silently point at
 * a non-existent or non-downloaded voice). These match what the app
 * pre-downloads into the voices dir.
 */
const VALID_PIPER_VOICES = [
  "de_DE-thorsten-high",
  "en_GB-alan-medium",
  "en_US-ryan-high",
  "en_US-lessac-medium",
  "en_GB-northern_english_male-medium",
  "de_DE-eva_k-x_low",
  "en_GB-southern_english_female-low",
  "en_US-ryan-low",
];

describe("character library", () => {
  test("has at least 6 parody characters", () => {
    expect(CHARACTERS.length).toBeGreaterThanOrEqual(6);
  });

  test("all character ids are unique", () => {
    expect(allIdsUnique()).toBe(true);
    expect(new Set(characterIds()).size).toBe(CHARACTERS.length);
  });

  test("every voiceId is a valid, distinct Piper voice", () => {
    const used = CHARACTERS.map((c) => c.voiceId);
    expect(new Set(used).size).toBe(CHARACTERS.length);
    for (const voiceId of used) {
      const known = VALID_PIPER_VOICES.includes(voiceId);
      expect(known).toBe(true);
    }
  });

  test("no reserved / trademarked / real-figure names", () => {
    for (const c of CHARACTERS) {
      expect(isAllowedName(c.name), `${c.name} must not be reserved`).toBe(true);
      expect(
        RESERVED_NAMES.some((r) => c.name.toLowerCase().includes(r))
      ).toBe(false);
    }
    // Sanity: the guard actually catches a known-bad clone name.
    expect(isAllowedName("Peter Griffin")).toBe(false);
  });

  test("every character has bio, emoji, style and a valid language", () => {
    for (const c of CHARACTERS) {
      expect(c.bio.trim().length).toBeGreaterThan(0);
      expect(c.emoji.trim().length).toBeGreaterThan(0);
      expect(c.style.trim().length).toBeGreaterThan(0);
      expect(["de", "en"]).toContain(c.language);
      expect(c.langCode.startsWith(c.language)).toBe(true);
    }
  });

  test("pitch and rate are within safe ffmpeg bounds", () => {
    for (const c of CHARACTERS) {
      expect(c.pitch).toBeGreaterThanOrEqual(-2);
      expect(c.pitch).toBeLessThanOrEqual(2);
      expect(c.rate).toBeGreaterThanOrEqual(0.5);
      expect(c.rate).toBeLessThanOrEqual(1.5);
    }
  });

  test("findCharacter resolves ids and returns undefined for unknowns", () => {
    const c = findCharacter(CHARACTERS[0]!.id);
    expect(c).toBeDefined();
    expect(c!.id).toBe(CHARACTERS[0]!.id);
    expect(findCharacter("does-not-exist")).toBeUndefined();
  });
});
