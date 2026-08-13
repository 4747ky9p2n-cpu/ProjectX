/**
 * Channel Mode Handler
 *
 * Handles GET /api/youtube/channel/videos — resolves a channel from a handle,
 * channel URL, or name via the YouTube Data API using the connected user's
 * OAuth token, then lists the channel's recent uploads so the user can pick a
 * video to run through the normal analyze → clip → upload flow.
 *
 * Called directly from serve.ts (this version of TanStack Start doesn't
 * support API routes, so we wire plain fetch-handler branches there).
 */

import { getValidAccessToken } from "./youtube-auth";

/* ─────────────────────────────────────────────
   Types
   ───────────────────────────────────────────── */

/** A normalized channel query: how we should resolve the channel. */
export type ChannelResolution =
  | { kind: "channelId"; value: string } // UC... channel id
  | { kind: "handle"; value: string } // @handle (value WITHOUT the @)
  | { kind: "username"; value: string } // legacy /user/ or /c/ name
  | { kind: "search"; value: string }; // plain name → search fallback

export interface ChannelVideoItem {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  publishedAt: string;
}

export interface ChannelInfo {
  id: string;
  title: string;
  thumbnailUrl: string;
}

export type ChannelVideosResult =
  | { status: "ok"; channel: ChannelInfo; videos: ChannelVideoItem[] }
  | { status: "not_found" }
  | { status: "api_error"; message: string };

/* ─────────────────────────────────────────────
   Query Normalization
   ───────────────────────────────────────────── */

/**
 * Normalize a user-supplied channel query into a typed resolution strategy.
 * Accepts channel URLs (youtube.com/@handle, /channel/UC..., /c/Name,
 * /user/Name), bare @handles, bare channel IDs, and plain names.
 */
export function normalizeChannelQuery(raw: string): ChannelResolution | null {
  if (!raw) return null;
  const input = raw.trim();
  if (!input) return null;

  // Channel URL forms
  try {
    const parsed = new URL(
      /^https?:\/\//i.test(input) ? input : `https://${input}`
    );
    const host = parsed.hostname.replace(/^(www\.|m\.)/, "");
    if (
      host === "youtube.com" ||
      host === "youtu.be" ||
      host === "music.youtube.com"
    ) {
      const path = parsed.pathname;
      const handle = path.match(/^\/@([^/]+)/);
      if (handle) return { kind: "handle", value: handle[1] };
      const channelId = path.match(/^\/channel\/(UC[\w-]+)/);
      if (channelId) return { kind: "channelId", value: channelId[1] };
      const user = path.match(/^\/(?:user|c)\/([\w.-]+)/);
      if (user) return { kind: "username", value: user[1] };
    }
  } catch {
    // Not a parseable URL — fall through to the bare forms below.
  }

  // Bare @handle
  if (input.startsWith("@")) return { kind: "handle", value: input.slice(1) };

  // Bare channel ID
  if (/^UC[\w-]{22}$/.test(input)) return { kind: "channelId", value: input };

  // Plain name → search
  return { kind: "search", value: input };
}

/* ─────────────────────────────────────────────
   YouTube Data API calls
   ───────────────────────────────────────────── */

const YT_API = "https://www.googleapis.com/youtube/v3";

interface RawThumbnails {
  medium?: { url?: string };
  high?: { url?: string };
  default?: { url?: string };
}

interface RawChannel {
  id: string;
  snippet?: {
    title?: string;
    thumbnails?: RawThumbnails;
  };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}

function pickThumbnail(thumbnails?: RawThumbnails): string {
  return (
    thumbnails?.medium?.url ??
    thumbnails?.high?.url ??
    thumbnails?.default?.url ??
    ""
  );
}

function ytGet(accessToken: string, path: string): Promise<Response> {
  return fetch(`${YT_API}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
}

type ResolveOutcome =
  | { status: "ok"; channel: ChannelInfo; uploadsPlaylistId: string }
  | { status: "not_found" }
  | { status: "api_error"; message: string };

/**
 * Resolve a channel reference to a channel id + its uploads playlist id.
 * Strategy (fewest requests first): forHandle → forUsername → search.
 * A search hit needs one extra channels.list call to learn the uploads playlist.
 */
async function resolveChannel(
  accessToken: string,
  ref: ChannelResolution
): Promise<ResolveOutcome> {
  const part = "snippet,contentDetails";

  const attempts: Array<() => Promise<Response>> = [];
  if (ref.kind === "channelId") {
    attempts.push(() =>
      ytGet(accessToken, `/channels?part=${part}&id=${encodeURIComponent(ref.value)}`)
    );
  } else {
    // 1. Handle (the modern canonical form)
    attempts.push(() =>
      ytGet(
        accessToken,
        `/channels?part=${part}&forHandle=${encodeURIComponent("@" + ref.value)}`
      )
    );
    // 2. Legacy username (also covers /c/ and /user/ URLs)
    attempts.push(() =>
      ytGet(accessToken, `/channels?part=${part}&forUsername=${encodeURIComponent(ref.value)}`)
    );
    // 3. Search fallback for plain names / handles that didn't resolve above
    attempts.push(() =>
      ytGet(
        accessToken,
        `/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(ref.value)}`
      )
    );
  }

  let sawOkResponse = false;
  let lastError = "YouTube API error";

  for (const attempt of attempts) {
    let resp: Response;
    try {
      resp = await attempt();
    } catch (err) {
      lastError = err instanceof Error ? err.message : "network error";
      continue;
    }
    if (!resp.ok) {
      lastError = `YouTube API error (status ${resp.status})`;
      continue;
    }
    sawOkResponse = true;

    const data = (await resp.json()) as { items?: RawChannel[] };
    const item = data.items?.[0];
    if (!item) continue; // ok but empty — try the next strategy

    // Search hits lack contentDetails; fetch them by id (one extra request).
    if (!item.contentDetails?.relatedPlaylists?.uploads) {
      const detailResp = await ytGet(
        accessToken,
        `/channels?part=${part}&id=${encodeURIComponent(item.id)}`
      );
      if (!detailResp.ok) {
        lastError = `YouTube API error (status ${detailResp.status})`;
        continue;
      }
      const detailData = (await detailResp.json()) as { items?: RawChannel[] };
      const detailItem = detailData.items?.[0];
      if (!detailItem?.contentDetails?.relatedPlaylists?.uploads) continue;
      return {
        status: "ok",
        channel: {
          id: detailItem.id,
          title: detailItem.snippet?.title ?? "Unknown Channel",
          thumbnailUrl: pickThumbnail(detailItem.snippet?.thumbnails),
        },
        uploadsPlaylistId: detailItem.contentDetails.relatedPlaylists.uploads,
      };
    }

    return {
      status: "ok",
      channel: {
        id: item.id,
        title: item.snippet?.title ?? "Unknown Channel",
        thumbnailUrl: pickThumbnail(item.snippet?.thumbnails),
      },
      uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads,
    };
  }

  // At least one call succeeded but found no channel → genuinely not found.
  // Every call failed at the HTTP level → an API/network problem, not a miss.
  return sawOkResponse
    ? { status: "not_found" }
    : { status: "api_error", message: lastError };
}

/**
 * Fetch up to 25 recent uploads for a channel's uploads playlist.
 */
async function fetchUploads(
  accessToken: string,
  uploadsPlaylistId: string
): Promise<ChannelVideoItem[]> {
  const resp = await ytGet(
    accessToken,
    `/playlistItems?part=snippet&playlistId=${encodeURIComponent(uploadsPlaylistId)}&maxResults=25`
  );
  if (!resp.ok) {
    throw new Error(`YouTube API error (status ${resp.status})`);
  }
  const data = (await resp.json()) as {
    items?: Array<{
      snippet?: {
        title?: string;
        publishedAt?: string;
        resourceId?: { videoId?: string };
        thumbnails?: RawThumbnails;
      };
    }>;
  };
  return (data.items ?? [])
    .map((item) => ({
      videoId: item.snippet?.resourceId?.videoId ?? "",
      title: item.snippet?.title ?? "Untitled Video",
      thumbnailUrl: pickThumbnail(item.snippet?.thumbnails),
      publishedAt: item.snippet?.publishedAt ?? "",
    }))
    .filter((v) => v.videoId.length > 0);
}

/**
 * Resolve a channel and list its recent videos. Pure of request/cookie logic
 * so it is unit-testable with a fake access token.
 */
export async function fetchChannelVideos(
  accessToken: string,
  ref: ChannelResolution
): Promise<ChannelVideosResult> {
  const resolved = await resolveChannel(accessToken, ref);
  if (resolved.status === "not_found") return { status: "not_found" };
  if (resolved.status === "api_error") {
    return { status: "api_error", message: resolved.message };
  }
  try {
    const videos = await fetchUploads(accessToken, resolved.uploadsPlaylistId);
    return { status: "ok", channel: resolved.channel, videos };
  } catch (err) {
    return {
      status: "api_error",
      message: err instanceof Error ? err.message : "YouTube API error",
    };
  }
}

/* ─────────────────────────────────────────────
   In-process response cache (5 min per query)
   ───────────────────────────────────────────── */

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; payload: unknown }>();

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * GET /api/youtube/channel/videos?query=<channel>[&refresh=1]
 * Reads the youtube_auth cookie and lists a channel's recent videos.
 */
export async function handleChannelVideos(req: Request): Promise<Response> {
  const headers = { "Content-Type": "application/json" };

  const url = new URL(req.url);
  const rawQuery = url.searchParams.get("query") ?? "";
  const refresh = url.searchParams.get("refresh") === "1";

  const ref = normalizeChannelQuery(rawQuery);
  if (!ref) {
    return jsonResponse(
      {
        success: false,
        code: "API_ERROR",
        error: "Query parameter 'query' is required.",
      },
      400,
      headers
    );
  }

  const cacheKey = ref.value.toLowerCase();
  if (!refresh) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return jsonResponse(hit.payload, 200, headers);
    }
  }

  const cookieHeader = req.headers.get("cookie");
  const token = await getValidAccessToken(cookieHeader);
  if (!token) {
    return jsonResponse(
      { success: false, code: "NO_AUTH", error: "Not connected to YouTube." },
      401,
      headers
    );
  }

  const result = await fetchChannelVideos(token.accessToken, ref);

  if (result.status === "not_found") {
    return jsonResponse(
      {
        success: false,
        code: "NOT_FOUND",
        error: "Channel not found — check the handle or URL.",
      },
      404,
      headers
    );
  }
  if (result.status === "api_error") {
    return jsonResponse(
      { success: false, code: "API_ERROR", error: result.message },
      502,
      headers
    );
  }

  const payload = {
    success: true,
    channel: result.channel,
    videos: result.videos,
  };
  cache.set(cacheKey, { at: Date.now(), payload });
  return jsonResponse(payload, 200, headers);
}
