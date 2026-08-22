// Production server for the built site. The TanStack Start build emits a portable
// fetch handler (dist/server/server.js) plus static client assets (dist/client);
// this wraps them in a Bun server on port 3000 — static files first, SSR for the
// rest. Run `bun run build` before starting. Restart it with `bun run publish`.
//
// Starting a new instance supersedes the old one: it frees the port no matter
// which user owns the current server (provisioning starts it as `engine`; a team
// member's `bun run publish` runs as their own user), so publish never collides
// with an already-running server. Every sandbox user has passwordless sudo, so
// the takeover works across user boundaries.
import handler from "./dist/server/server.js";
import {
  handleAuthInitiate,
  handleAuthCallback,
  handleDisconnect,
  handleChannelInfo,
} from "./src/lib/oauth-handlers";
import { handleUploadClip } from "./src/lib/upload-handler";
import { getToolStatus } from "./src/lib/youtube-upload";
import { handleChannelVideos } from "./src/lib/channel-handler";
import {
  handleTikTokAuthInitiate,
  handleTikTokAuthCallback,
  handleTikTokDisconnect,
  handleTikTokChannelInfo,
} from "./src/lib/tiktok-handlers";

// Pinned, NOT read from the environment. The published preview URL
// (<label>.<PUBLIC_SITE_DOMAIN>) is reverse-proxied to 0.0.0.0:3000 inside the
// sandbox, so the default site MUST bind there. Bun auto-loads .env files, so
// honouring process.env.PORT/HOST would let a stray env var or a .env in the site
// dir silently move the site off :3000 (or onto loopback) and break the public URL.
const PORT = 3000;
const HOST = "0.0.0.0";
const CLIENT_DIR = `${import.meta.dir}/dist/client`;

// Free PORT regardless of which user owns the current listener. lsof runs under
// sudo so it can see (and the kill can signal) a process owned by another user;
// the loop waits for the socket to actually release before we bind.
const freePort =
  `for _ in $(seq 1 25); do ` +
  `pids=$(lsof -t -iTCP:${String(PORT)} -sTCP:LISTEN 2>/dev/null || true); ` +
  `if [ -z "$pids" ]; then exit 0; fi; ` +
  `kill $pids 2>/dev/null || true; sleep 0.2; ` +
  `done`;

// Take over the port, re-freeing and retrying if another publish grabbed it in the
// gap between freeing and binding (last publish wins). Bun.serve throws EADDRINUSE
// synchronously, so without this a raced publish would die while the shell already
// reported success.
for (let attempt = 1; ; attempt++) {
  await Bun.$`sudo sh -c ${freePort}`.quiet().nothrow();
  try {
    Bun.serve({
      port: PORT,
      hostname: HOST,
      async fetch(req) {
        const { pathname } = new URL(req.url);

        // ── OAuth API routes ──
        if (pathname === "/api/auth/youtube" && req.method === "GET") {
          return handleAuthInitiate();
        }
        if (pathname === "/api/auth/youtube/callback" && req.method === "GET") {
          return handleAuthCallback(req);
        }
        if (pathname === "/api/auth/youtube/disconnect" && req.method === "GET") {
          return handleDisconnect();
        }
        if (pathname === "/api/auth/youtube/channel" && req.method === "GET") {
          return handleChannelInfo(req);
        }
        if (pathname === "/api/auth/tiktok" && req.method === "GET") {
          return handleTikTokAuthInitiate();
        }
        if (pathname === "/api/auth/tiktok/callback" && req.method === "GET") {
          return handleTikTokAuthCallback(req);
        }
        if (pathname === "/api/auth/tiktok/disconnect" && req.method === "GET") {
          return handleTikTokDisconnect();
        }
        if (pathname === "/api/auth/tiktok/channel" && req.method === "GET") {
          return handleTikTokChannelInfo(req);
        }
        if (pathname === "/api/upload/clip" && req.method === "POST") {
          return handleUploadClip(req);
        }
        if (
          pathname === "/api/youtube/channel/videos" &&
          req.method === "GET"
        ) {
          return handleChannelVideos(req);
        }

        if (pathname !== "/") {
          const file = Bun.file(CLIENT_DIR + pathname);
          if (await file.exists()) return new Response(file);
        }
        return (
          handler as { fetch: (r: Request) => Response | Promise<Response> }
        ).fetch(req);
      },
    });
    break;
  } catch (err) {
    if (attempt >= 10) throw err;
    await Bun.sleep(200);
  }
}

console.log(`team-site serving on http://${HOST}:${String(PORT)}`);
void startupDiagnostics();

/**
 * Run once on server start to make a machine swap (which silently removes
 * ffmpeg/yt-dlp and stops the server) loudly detectable the MOMENT the site is
 * re-published — a clear WARNING lands in .run/server.log immediately instead
 * of only surfacing when a user hits a failed upload. Also sweeps stale
 * /tmp/clipflow-* dirs left behind by an upload that was interrupted by a
 * process kill/swap (the pipeline itself already cleans up on normal paths).
 */
async function startupDiagnostics(): Promise<void> {
  try {
    const tools = await getToolStatus();
    if (tools.ffmpeg && tools.ytdlp) {
      console.log(`[ClipFlow] Startup tool check OK: ${tools.message}`);
    } else {
      console.error(
        `[ClipFlow] STARTUP WARNING: ${tools.message}. ` +
        `${tools.ffmpeg ? "" : "Install ffmpeg with: sudo apt-get update && sudo apt-get install -y ffmpeg. "}` +
        `${tools.ytdlp ? "" : "Install yt-dlp with: sudo pip3 install --break-system-packages yt-dlp. "}` +
        "Uploads will fail with MISSING_TOOLS until both are installed. See SETUP.md."
      );
    }
  } catch (err) {
    console.error("[ClipFlow] Startup tool check failed:", err);
  }
  try {
    const { stdout } = await Bun
      .$`find /tmp -maxdepth 1 -type d -name "clipflow-*" -mmin +60`
      .quiet()
      .nothrow();
    const dirs = String(stdout ?? "")
      .split("\n")
      .map((d) => d.trim())
      .filter(Boolean);
    for (const d of dirs) {
      await Bun.$`rm -rf ${d}`.quiet().nothrow();
    }
    if (dirs.length > 0) {
      console.log(`[ClipFlow] Cleaned ${dirs.length} stale clipflow temp dir(s) at startup`);
    }
  } catch {
    // Non-fatal: temp cleanup must never prevent the server from starting.
  }
}
