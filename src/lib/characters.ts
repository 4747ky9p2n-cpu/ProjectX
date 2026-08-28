/* ─────────────────────────────────────────────
   KI-Sprach-Kategorie — Character Library
   ─────────────────────────────────────────────
   A library of FREE, ORIGINAL PARODY characters ("voices") that the voice
   render pipeline uses for text-to-speech.

   OWNER CONSTRAINT: these MUST be original/parody-like voices with fun,
   invented names — never a literal clone of a real copyrighted cartoon
   character or a real celebrity. Every entry below is an invented persona
   mapped to a public, openly-licensed Piper voice; we do NOT clone any
   person's voice to sound like them.

   TTS PROVIDER: Piper (self-hosted, open-source, MIT-licensed neural TTS).
   Chosen over edge-tts / ElevenLabs:
     - edge-tts (Microsoft's free read-aloud endpoint) is high quality and
       keyless, but relies on a WebSocket (wss://speech.platform.bing.com).
       On this host outbound WebSocket is blocked (even a public echo server
       fails with close 1006), so it is NOT a viable default here.
     - ElevenLabs has an excellent free tier but caps free characters per
       month and requires an API key (owner activation).
     - Piper is genuinely free (open-source), unlimited usage, tiny/fast
       (fits ~4GB RAM box), works fully offline once a model is downloaded,
       and needs no API key. ~dozens of pre-trained open voices → plenty of
       distinct character voices. First use of a new voice triggers a
       one-time model download (~25-120MB) from HuggingFace.

   Voice pitch/rate are baked per character via ffmpeg (asetrate/atempo) so
   the same open voice can be differentiated into distinct persona colors.

   This module is pure data + small validation helpers (no network/ffmpeg),
   so it is fully unit-testable in isolation.
   ───────────────────────────────────────────── */

export type CharacterLanguage = "de" | "en";

export interface VoiceCharacter {
  /** Stable unique id used by the API (also the prefered UI key). */
  id: string;
  /** The character's display name (original, parody — not trademarked). */
  name: string;
  /** Short fun bio shown in the picker. */
  bio: string;
  /** Emoji avatar string. */
  emoji: string;
  /** Style hint (how the voice should feel). */
  style: string;
  /** Piper voice model id (what TTS engine is called with). */
  voiceId: string;
  /** Language the voice speaks. Piper models are monolingual. */
  language: CharacterLanguage;
  /**
   * The language Piper should speak in / auto-download group. For Piper this
   * is derived from `language` ("de" → de_DE, "en" → en_US/en_GB resolved via
   * the voiceId itself). Kept explicit for provider compatibility.
   */
  langCode: string;
  /**
   * Pitch shift in SEMITONES applied at render time (ffmpeg asetrate).
   * Negative = deeper, positive = higher. 0 = natural.
   */
  pitch: number;
  /**
   * Playback speed multiplier (ffmpeg atempo) — e.g. 1.08 for a fast hype
   * voice, <1 for a slow, dramatic documentary voice.
   */
  rate: number;
}

/**
 * The initial parody character library. Count/validity enforced by unit tests
 * (tests/characters.test.ts): every voiceId must exist in the validated Piper
 * catalog, no two entries share an id, and no name/emoji is a reserved or
 * trademarked real figure.
 */
export const CHARACTERS: VoiceCharacter[] = [
  {
    id: "blaubeer-papa",
    name: "Blaubeer-Papa",
    bio: "Gemütlicher Typ, der gute Geschichten kennt und Milch bei 3% mag.",
    emoji: "🫐",
    style: "Deep, relaxed storyteller — warm and unhurried",
    voiceId: "de_DE-thorsten-high",
    language: "de",
    langCode: "de-DE",
    pitch: -1.0,
    rate: 0.97,
  },
  {
    id: "sarkastischer-erklaerer",
    name: "Sarkastischer Erklärer",
    bio: "Trocken, britisch und innerlich genervt von schlechten Hooks.",
    emoji: "😏",
    style: "Dry sarcastic narrator — deadpan, slightly flat",
    voiceId: "en_GB-alan-medium",
    language: "en",
    langCode: "en-GB",
    pitch: -0.2,
    rate: 1.0,
  },
  {
    id: "extrovertierter-coach",
    name: "Extrovertierter Coach",
    bio: "Energie. Leidenschaft. Drei Ausrufezeichen pro Satz!",
    emoji: "🔥",
    style: "Energetic hype man — fast, bright, motivating",
    voiceId: "en_US-ryan-high",
    language: "en",
    langCode: "en-US",
    pitch: 0.25,
    rate: 1.08,
  },
  {
    id: "falsett-dudebro",
    name: "Falsett-Dudebro",
    bio: "Höchste Tonlage der Nation. Kopfhörer warnen vor ihm.",
    emoji: "🤪",
    style: "Cartoon-ish high-pitch goofball",
    voiceId: "en_US-lessac-medium",
    language: "en",
    langCode: "en-US",
    pitch: 0.55,
    rate: 1.03,
  },
  {
    id: "mystery-doku-stimme",
    name: "Mystery-Doku-Stimme",
    bio: "Als ob ein Doku-Sprecher jede Antwort mit einem Fragezeichen meint.",
    emoji: "🕵️",
    style: "Deep documentary voice — dramatic, suspended",
    voiceId: "en_GB-northern_english_male-medium",
    language: "en",
    langCode: "en-GB",
    pitch: -0.8,
    rate: 0.95,
  },
  {
    id: "frau-kuehl",
    name: "Frau Kühl",
    bio: "Ruhig, klar und ein kleines bisschen nordisch unterkühlt.",
    emoji: "🧊",
    style: "Calm female storyteller — composed and steady",
    voiceId: "de_DE-eva_k-x_low",
    language: "de",
    langCode: "de-DE",
    pitch: 0.1,
    rate: 0.98,
  },
  {
    id: "chef-ketzer",
    name: "Chef Ketzer",
    bio: "Kocht mit links, räumt mit Küchen-Mythen auf und will Applaus.",
    emoji: "🍳",
    style: "Excited cooking-show host — quick, upbeat, witty",
    voiceId: "en_GB-southern_english_female-low",
    language: "en",
    langCode: "en-GB",
    pitch: 0.3,
    rate: 1.06,
  },
  {
    id: "mister-schleier",
    name: "Mister Schleier",
    bio: "Mysteriöser Amerikaner, der jede Zahl wie ein Geheimnis klingt.",
    emoji: "🎩",
    style: "Smooth conspiratorial narrator — hushed, a little slow",
    voiceId: "en_US-ryan-low",
    language: "en",
    langCode: "en-US",
    pitch: -0.2,
    rate: 0.96,
  },
];

/** Look up a character by id. Returns undefined when unknown. */
export function findCharacter(id: string): VoiceCharacter | undefined {
  return CHARACTERS.find((c) => c.id === id);
}

/** All character ids (used by handlers/tests for quick membership checks). */
export function characterIds(): string[] {
  return CHARACTERS.map((c) => c.id);
}

/** True when every character id is unique. */
export function allIdsUnique(): boolean {
  const ids = characterIds();
  return new Set(ids).size === ids.length;
}

/**
 * Reserved / trademarked names we must NEVER use for a character. The library
 * is checked against this list so a future edit can't accidentally ship a
 * literal cartoon/celebrity clone.
 */
export const RESERVED_NAMES: string[] = [
  "peter griffin",
  "stewie",
  "family guy",
  "homer",
  "bart simpson",
  "spongebob",
  "mickey mouse",
  "donald trump",
  "elon musk",
  "mr beast",
  "pewdiepie",
  "dr disney",
  "shrek",
  "minions",
];

/**
 * True when `name` is not (case-insensitive) a reserved/trademarked name.
 * Each entry (name, and name split into words) is checked so combined names
 * still trip the guard.
 */
export function isAllowedName(name: string): boolean {
  const lower = name.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  return RESERVED_NAMES.every(
    (r) => !lower.includes(r) && !words.includes(r)
  );
}
