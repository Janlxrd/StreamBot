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
- Hugging Face CPU Basic has 2 vCPU, 16 GB RAM, and 50 GB ephemeral disk. The profile therefore favors full remote cache, pre-transcoding, and smaller playback files over live 720p encoding.
- For `hf-cpu-basic`, unset stream values default to 854x480, 24 FPS, 1400 Kbps average, 2000 Kbps max, `STREAM_FFMPEG_THREADS=2`, `STREAM_FULL_CACHE_REMOTE=true`, `STREAM_PRETRANSCODE_BEFORE_PLAYBACK=true`, and `STREAM_REMOTE_PREBUFFER_MB=50`.
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
STREAM_REMOTE_PREBUFFER_MB="50"
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
STREAM_REMOTE_PREBUFFER_MB="50"
STREAM_REMOTE_CACHE_DIR="/tmp/streambot-remote-cache"
STREAM_TRANSCODE_CACHE_DIR="/tmp/streambot-transcode-cache"
```

Confirmation checklist for an existing Hugging Face Space:

- `STREAM_FFMPEG_VIDEO_ENCODER` should not exist, or should be empty.
- `STREAM_REMOTE_PREBUFFER_MB` should be `50` on CPU Basic unless startup buffering is too small.
- After the Space rebuilds, run the Discord `config` command and confirm `streamProfile=hf-cpu-basic`, `width=854`, `height=480`, `fps=24`, `bitrateKbps=1400`, `maxBitrateKbps=2000`, `fullCacheRemote=true`, `preTranscodeBeforePlayback=true`, `remotePrebufferMb=50`, `noTranscoding=false`, and `ffmpegThreads=2`.

Docker Compose note: when running outside Hugging Face, Spaces Variables/Secrets are not automatically available. If the compose file references `.env`, create `/path/to/project/.env` on that machine with the same values before running `docker compose up`.

Space metadata note: Hugging Face Spaces requires YAML front matter at the very top of `README.md`. The repo README now declares `sdk: docker`, `app_port: 3000`, and `suggested_hardware: cpu-basic`. Keep `app_port` aligned with `SERVER_PORT`.

## 2026-05-07 Discord Abort Handling

- Observed Hugging Face logs with `The operation was aborted` while acknowledging commands such as `help` and queue additions.
- The queue URL path adds the item before sending the Discord success message, so the abort is usually a failed Discord reaction/reply rather than a media resolution failure.
- Updated shared Discord send helpers so reactions, replies, and channel sends are best-effort. A transient Discord API abort now logs a warning instead of making the command fail.
- Updated `help`, `ping`, `preview`, `queue`, and unknown-command handling to use the safer helpers where practical.
- Added `DISCORD_REACTIONS_ENABLED`, defaulting to `false` for `hf-cpu-basic`, because reaction requests were timing out and delaying command replies.
- Added `DISCORD_SEND_TIMEOUT_MS`, with a 10000ms default so a stuck library send can fall back instead of making commands look dead.
- Made streaming status messages fire-and-forget in remote cache, YouTube download, and pre-transcode paths. Playback preparation now continues even when those acknowledgements fail.
- Added `DISCORD_SUPPRESS_ABORT_WARNINGS`; leave it unset while debugging so real Discord send failures remain visible.

## 2026-05-08 Command/Startup Recovery

- Kept the `hf-cpu-basic` full cache and pre-transcode path, but changed playback startup so the bot joins voice before remote cache/pre-transcode preparation.
- Set the `hf-cpu-basic` remote prebuffer default to 50 MB for cases where full cache is disabled.
- Changed command replies to prefer plain channel sends, then try `message.reply`, then try a raw Discord REST text-message fallback.
- Raised the default Discord send timeout from the failed 1500ms experiment to 10000ms so normal slow sends can finish while truly stuck sends still fall back.
- Added a `Command received: ...` log line in message handling so Discord receive failures can be separated from Discord send failures.

## 2026-05-24 FFmpeg Alternatives Check

- Rechecked the media pipeline after asking whether there is a better option than FFmpeg for this bot.
- No better drop-in replacement was found for the current architecture. `@dank074/discord-video-stream` still exposes `prepareStream` as a fluent-ffmpeg command plus output stream, and its current README requires an FFmpeg build for full functionality.
- The best near-term path is still to reduce expensive live transcoding: use full remote cache, pre-transcode on weak CPU hosts, enable no-transcoding only for verified Discord-friendly H.264/AAC/Opus sources, and use NVENC/QSV/VAAPI only on hosts that actually have supported hardware.
- GStreamer is a capable alternative media framework, but adopting it here would mean replacing or forking the Discord media preparation layer, not swapping one binary. That is a larger rewrite with higher deployment complexity.
- HandBrakeCLI is suitable for offline pre-encoding, but not for the live/remux/probe/control flow in this bot.
- MediaMTX, OBS, or VLC can help in a separate ingest/restream setup, but they do not remove the need to feed Discord through the current Discord streaming library.
- `node-av` is already part of `@dank074/discord-video-stream`; it is useful inside that stack, but it is still FFmpeg/libav-based rather than an alternative to FFmpeg.
- Separate maintenance note: `fluent-ffmpeg` itself is archived/deprecated upstream. If the bot needs more control, prefer direct `spawn("ffmpeg", args)` for our own code paths, but the dependency remains inside `@dank074/discord-video-stream` unless we fork/replace that library.

## 2026-05-24 GStreamer Replacement Decision

- Replacing FFmpeg with GStreamer is not a good near-term choice for this repo.
- GStreamer could technically build the decode/scale/encode/remux pipeline, and it may be attractive for a dedicated media server or a custom low-level streamer, but it does not plug into the current `@dank074/discord-video-stream` path.
- A real GStreamer migration would require replacing or forking the Discord stream preparation layer, recreating FFmpeg's current NUT/Opus/H.264 output behavior, redoing probe/preview/cache/transcode code, updating Docker images with GStreamer plugins, and retesting Discord packet compatibility.
- Expected benefit on CPU-only Hugging Face Basic is low. The bottleneck is H.264 encoding work, and GStreamer would still need to encode unless the source can be copied through. The existing FFmpeg no-transcoding and pre-transcode modes already target that bottleneck with much less risk.
- Reconsider GStreamer only if the project moves away from `@dank074/discord-video-stream`, needs a full custom WebRTC/RTP media engine, or targets hosts where a tested GStreamer hardware-acceleration stack is clearly better than FFmpeg.

## 2026-05-24 Playback Recovery

- Fixed Node.js command loading on Windows by importing command modules through `file://` URLs. The previous absolute `C:\...` dynamic import path made the command registry load `0` commands, so commands could be received but never executed.
- Made command execution wait for the async command registry load before looking up the command.
- Aligned the runtime command prefix default with `.env.example` and the README: if `PREFIX` is missing or empty, commands now use `$` instead of an empty prefix.
- Fixed the live FFmpeg encoder setup so `STREAM_H26X_PRESET` is passed into `@dank074/discord-video-stream` through `Encoders.software(...)`; the old `h26xPreset` option was ignored by version 6.0.0.
- Set the software encoder tune to `zerolatency` for x264/x265 so weak CPU hosts start emitting frames more reliably.
- Fixed the pre-transcode cache used by `STREAM_PRETRANSCODE_BEFORE_PLAYBACK=true` to be Discord streaming friendly before it is streamed with `noTranscoding`: B-frames are disabled, scene-cut keyframes are disabled, and keyframes are forced every second.
- Prevented `STREAM_FFMPEG_VIDEO_ENCODER` from overriding video copy mode when the prepared cache is streamed with `noTranscoding`.

## 2026-05-24 Pre-transcode Visibility

- Observed runtime logs where the remote cache finished, then playback appeared stuck at `Preparing optimized playback cache...`.
- This is expected when `STREAM_PRETRANSCODE_BEFORE_PLAYBACK=true`: the bot waits for FFmpeg to create the full optimized MP4 before calling `prepareStream`/`playStream`.
- On `hf-cpu-basic`, a 1080p movie can sit in this step for many minutes because the 2 vCPU host is doing H.264 encoding up front.
- Added info-level pre-transcode progress logging using FFmpeg `-progress pipe:2`, including percent when duration probing succeeds, encoded time, speed, encode FPS, and output size.
- Updated the Discord preparation message to say playback starts after the CPU transcode finishes, and added occasional long-running progress replies.
- If faster startup matters more than smooth CPU-only playback, set `STREAM_PRETRANSCODE_BEFORE_PLAYBACK=false`. Expect live transcoding to be more likely to stutter on CPU Basic.

## 2026-05-24 247 Next-Movie Precache Direction

- For 24/7 playback, pre-caching the next movie while the current prepared MP4 is playing would improve continuity because the resolve, remote cache, and pre-transcode delay can be hidden behind the current movie.
- This is especially useful with `STREAM_PRETRANSCODE_BEFORE_PLAYBACK=true`, where the current movie plays from an already optimized MP4 with video copy mode, leaving more CPU headroom than live transcoding.
- Do not implement this by reusing `activeBufferProcess`, `activeTranscodeProcess`, or `activeTranscodeTempFile`. Those fields are tied to the currently preparing/playing item and cleanup/skip behavior can delete or kill the wrong file/process if a second item is warming in the background.
- Preferred implementation: add a single-slot 247 warm cache with its own process tracking, temp-file ownership, abort path, disk-space guard, and queue metadata for `preparedInput`, `preparedTempFiles`, and `forceNoTranscoding`.
- Keep the warm cache depth at one item on Hugging Face CPU Basic. More than one prepared movie risks filling `/tmp` and wasting CPU on items that may never play.
- If current playback is live-transcoding instead of playing a prepared no-transcode file, avoid background pre-transcode because it will compete for CPU and can cause stutter.

## 2026-05-24 247 Warm Cache Implementation

- Added a single-slot 247 warm cache. While 247 mode is running, the loop can select the next Meteor/Stremio movie during current playback, cache the remote file, pre-transcode it, and enqueue it as a prepared queue item.
- Prepared queue items carry `preparedInput`, `preparedTempFiles`, and `forceNoTranscoding`, so auto-advance can start the local optimized MP4 without repeating the remote cache or transcode work.
- Added separate `warm247` buffer/transcode process and temp-file fields. Current playback cleanup still owns `active*` fields, while background warm-up owns `warm247*` fields until the prepared files are transferred to the queue item.
- Warm-up only starts when `STREAM_PRETRANSCODE_BEFORE_PLAYBACK=true`, current playback is already using no-transcode prepared output, no next item is queued, no other warm-up is running, and the cache directories have at least about 4 GB free when `statfs` is available.
- `stop247streaming` cancels any in-progress warm-up. `stop` cancels warm-up and deletes queued prepared files that are not the active playback item.
- Startup/orphan cleanup now protects active, warm, and queued prepared temp files so a background warm-up is not deleted while it is still being prepared.

## 2026-05-24 Discord Send Timeout Clamp

- Observed runtime logs still showing `Discord channel send timed out after 1500ms`, which means a stale `DISCORD_SEND_TIMEOUT_MS=1500` environment value was overriding the safer 10000ms default.
- Added a config clamp so nonzero Discord send timeouts below 10000ms are treated as 10000ms. `DISCORD_SEND_TIMEOUT_MS=0` still means wait forever.
- This should stop commands from immediately cycling through channel-send, reply, and raw REST fallbacks before Discord has enough time to answer on slow hosts.
- The media side of the same log looked healthy: remote cache completed, pre-transcode started, and progress reached 1.6% at about 3.84x encode speed. With `STREAM_PRETRANSCODE_BEFORE_PLAYBACK=true`, Discord playback still waits for that optimized cache to finish.
