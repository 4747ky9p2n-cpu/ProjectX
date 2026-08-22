# ClipFlow — Setup & Self-Healing

This site is a TanStack Start (React + Vite + Bun) app served on port 3000.
It downloads YouTube videos, cuts vertical Shorts clips with ffmpeg, and
uploads them to the connected channel via the YouTube Data API v3.

## Required system tools

Uploads/captions depend on two host binaries that are **not** part of the npm
bundle and can be wiped by a machine re-provisioning (which also stops the
server). If they go missing, the server logs a `[ClipFlow] STARTUP WARNING` on
the next `bun run publish` and uploads fail fast with `MISSING_TOOLS`.

Restore them with:

```bash
# ffmpeg (encoding + caption burn-in). Required for every upload.
sudo apt-get update && sudo apt-get install -y ffmpeg

# yt-dlp (authenticated source-video download fallback). Required for the
# owner's bot-blocked videos. NOTE: Debian/Ubuntu's apt yt-dlp is often stale;
# install via pip3 so the build matches current YouTube.
sudo pip3 install --break-system-packages -U yt-dlp
```

Verify:

```bash
ffmpeg -version | head -1
yt-dlp --version
```

## Environment

The `.env` file in this directory holds the secrets (Google OAuth, Supadata
key) and is auto-loaded by Bun. It is `.gitignore`d — never commit it.

## Publish / restart

```bash
bun run publish   # rebuilds dist + restarts the server on :3000
```

On start the server runs `startupDiagnostics()`:
- verifies ffmpeg/yt-dlp via the app's own tool check and logs OK or a
  `STARTUP WARNING` with the exact install commands into `.run/server.log`;
- sweeps stale `/tmp/clipflow-*` dirs left by interrupted uploads (>60 min old).

## Known limitation (owner-only)

YouTube's anti-bot wall can block downloads even for the connected account.
When this happens the error message tells the owner exactly what fixes it:
either provide full browser cookies for yt-dlp (`--cookies`), or upgrade the
Supadata plan. This is an owner action, not a code change.
