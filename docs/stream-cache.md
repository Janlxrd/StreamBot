# Remote Stream Cache

## 2026-05-07

- Added `STREAM_FULL_CACHE_REMOTE` for remote HTTP movie sources. When enabled, StreamBot downloads/remuxes the whole remote source into `STREAM_REMOTE_CACHE_DIR` before playback starts, then streams from that local temp file.
- Kept the existing partial-buffer behavior as the default. `STREAM_REMOTE_PREBUFFER_MB` controls the initial buffer size when full caching is disabled.
- Added `STREAM_REMOTE_CACHE_DIR` so remote movie cache files are separate from preview thumbnails.
- Updated the runtime `config` command so admins can view and set `fullCacheRemote`, `remotePrebufferMb`, and `remoteCacheDir`.
- Adjusted `stop` so it can cancel queued/preparing cache work before the bot has joined voice.

Tradeoff: full caching prevents network slowdown during playback, but playback will not begin until the entire movie has downloaded and enough disk space is available.

## 2026-05-07 CPU/Quality Follow-up

- Kept FFmpeg as the active media pipeline because `@dank074/discord-video-stream` is built around FFmpeg for `prepareStream`.
- Fixed stream preparation so `STREAM_WIDTH`/`STREAM_HEIGHT` now cap the actual FFmpeg output size instead of passing `undefined` dimensions. This avoids accidentally transcoding 1080p/4K source video at full source size.
- Added both `frameRate` and `fps` to stream options so the configured FPS cap applies across library option naming differences.
- When source parameters are probed, FPS and bitrate are capped by `STREAM_FPS` and `STREAM_MAX_BITRATE_KBPS` instead of blindly inheriting high source values.
- Added `STREAM_NO_TRANSCODING` for already Discord-friendly sources. This is the lowest-CPU path, but it is opt-in because incompatible files can produce broken or glitchy playback.
- Aligned the code default bitrate with the documented 2000 Kbps default, so running without a `.env` does not fall back to a visibly low-quality 1000 Kbps stream.

Practical quality target for this bot: full remote cache on, H.264, 720p, 24-30 FPS, 2000-3500 Kbps, ultrafast/superfast preset. Use no-transcoding only after testing a known-good source format.

## 2026-05-07 CPU-only VPS Follow-up

- Added `STREAM_PRETRANSCODE_BEFORE_PLAYBACK` for hosts without a GPU. When enabled, StreamBot waits up front and creates a 720p-ish H.264/AAC temp file in `STREAM_TRANSCODE_CACHE_DIR`, then streams that prepared file with video transcoding disabled.
- This mode trades startup time and disk space for smoother playback on weak CPUs. It is better for movie nights than realtime transcoding when the VPS cannot keep up.
- Added `STREAM_FFMPEG_THREADS` for optional CPU limiting. Keep it at `0` for auto unless the VPS needs a hard cap.
- Added `STREAM_FFMPEG_VIDEO_ENCODER` as an optional FFmpeg encoder override, but leave it empty on CPU-only VPS hosts.

CPU-only recommended profile:

```env
STREAM_FULL_CACHE_REMOTE="true"
STREAM_PRETRANSCODE_BEFORE_PLAYBACK="true"
STREAM_NO_TRANSCODING="false"
STREAM_VIDEO_CODEC="H264"
STREAM_WIDTH="1280"
STREAM_HEIGHT="720"
STREAM_FPS="24"
STREAM_BITRATE_KBPS="2500"
STREAM_MAX_BITRATE_KBPS="3500"
STREAM_H26X_PRESET="ultrafast"
```

## 2026-05-07 Hugging Face CPU Basic Follow-up

- Added `STREAM_PROFILE`. When unset, StreamBot auto-selects `hf-cpu-basic` on Hugging Face Spaces CPU-only environments using `SPACE_ID`/`SPACE_HOST`, `ACCELERATOR`, and `CPU_CORES`.
- Hugging Face CPU Basic has 2 vCPU, 16 GB RAM, and 50 GB ephemeral disk. The profile therefore favors pre-transcoding and smaller playback files over live 720p encoding.
- For `hf-cpu-basic`, unset stream values default to 854x480, 24 FPS, 1400 Kbps average, 2000 Kbps max, `STREAM_FFMPEG_THREADS=2`, `STREAM_FULL_CACHE_REMOTE=true`, and `STREAM_PRETRANSCODE_BEFORE_PLAYBACK=true`.
- Cache directories default to `/tmp/streambot-remote-cache` and `/tmp/streambot-transcode-cache` on Spaces, so temp files stay on the ephemeral runtime disk and are cleaned on startup/stop.
- Keep `STREAM_FFMPEG_VIDEO_ENCODER` empty on CPU Basic because there is no GPU encoder.

Hugging Face CPU Basic override profile:

```env
STREAM_PROFILE="hf-cpu-basic"
STREAM_FULL_CACHE_REMOTE="true"
STREAM_PRETRANSCODE_BEFORE_PLAYBACK="true"
STREAM_NO_TRANSCODING="false"
STREAM_VIDEO_CODEC="H264"
STREAM_WIDTH="854"
STREAM_HEIGHT="480"
STREAM_FPS="24"
STREAM_BITRATE_KBPS="1400"
STREAM_MAX_BITRATE_KBPS="2000"
STREAM_H26X_PRESET="ultrafast"
STREAM_FFMPEG_THREADS="2"
STREAM_FFMPEG_VIDEO_ENCODER=""
STREAM_REMOTE_CACHE_DIR="/tmp/streambot-remote-cache"
STREAM_TRANSCODE_CACHE_DIR="/tmp/streambot-transcode-cache"
```

Existing Hugging Face env note: if `STREAM_WIDTH`, `STREAM_HEIGHT`, `STREAM_FPS`, `STREAM_BITRATE_KBPS`, or `STREAM_MAX_BITRATE_KBPS` already exist in Space variables, they override the `hf-cpu-basic` profile defaults. Update those existing variables to the profile values above instead of only adding `STREAM_PROFILE`.

Minimum variables to add on an existing Space:

```env
STREAM_PROFILE="hf-cpu-basic"
STREAM_FULL_CACHE_REMOTE="true"
STREAM_PRETRANSCODE_BEFORE_PLAYBACK="true"
STREAM_NO_TRANSCODING="false"
STREAM_FFMPEG_THREADS="2"
STREAM_REMOTE_CACHE_DIR="/tmp/streambot-remote-cache"
STREAM_TRANSCODE_CACHE_DIR="/tmp/streambot-transcode-cache"
```

Confirmation checklist for an existing Hugging Face Space:

- `STREAM_FFMPEG_VIDEO_ENCODER` should not exist, or should be empty.
- `STREAM_REMOTE_PREBUFFER_MB` is optional.
- After the Space rebuilds, run the Discord `config` command and confirm `streamProfile=hf-cpu-basic`, `width=854`, `height=480`, `fps=24`, `bitrateKbps=1400`, `maxBitrateKbps=2000`, `fullCacheRemote=true`, `preTranscodeBeforePlayback=true`, `noTranscoding=false`, and `ffmpegThreads=2`.

Docker Compose note: when running outside Hugging Face, Spaces Variables/Secrets are not automatically available. If the compose file references `.env`, create `/path/to/project/.env` on that machine with the same values before running `docker compose up`.

Space metadata note: Hugging Face Spaces requires YAML front matter at the very top of `README.md`. The repo README now declares `sdk: docker`, `app_port: 3000`, and `suggested_hardware: cpu-basic`. Keep `app_port` aligned with `SERVER_PORT`.

## 2026-05-07 Discord Abort Handling

- Observed Hugging Face logs with `The operation was aborted` while acknowledging commands such as `help` and queue additions.
- The queue URL path adds the item before sending the Discord success message, so the abort is usually a failed Discord reaction/reply rather than a media resolution failure.
- Updated shared Discord send helpers so reactions, replies, and channel sends are best-effort. A transient Discord API abort now logs a warning instead of making the command fail.
- Updated `help`, `ping`, `preview`, `queue`, and unknown-command handling to use the safer helpers where practical.
- Added `DISCORD_REACTIONS_ENABLED`, defaulting to `false` for `hf-cpu-basic`, because reaction requests were timing out and delaying command replies.
- Added `DISCORD_SEND_TIMEOUT_MS`, defaulting to `1500` for `hf-cpu-basic`, so Discord status messages cannot block cache/transcode/playback progress for 30 seconds.
- Made streaming status messages fire-and-forget in remote cache, YouTube download, and pre-transcode paths. Playback preparation now continues even when those acknowledgements fail.
