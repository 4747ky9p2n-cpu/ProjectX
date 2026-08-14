/**
 * Metadata Sanitization (shared by YouTube + TikTok uploads)
 *
 * The YouTube Data API rejects control/format characters, noncharacters,
 * emojis (in titles) and unpaired surrogates with 400 "The string did not
 * match the expected pattern". TikTok's Content Posting API is more lenient,
 * but the same sanitizers keep titles/descriptions clean everywhere and make
 * the exact payload that was sent diagnosable from the server log.
 */

/**
 * Strip anything the YouTube Data API rejects in a snippet.title:
 * emojis, variation selectors, control/format chars, replacement
 * characters and unpaired surrogates. Keeps letters, digits and
 * punctuation (incl. non-ASCII letters like ä/é/ß).
 */
export function sanitizeTitle(title: string): string {
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
export function stripLoneSurrogates(s: string): string {
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
