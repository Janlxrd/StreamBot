import dotenv from "dotenv"

dotenv.config({ quiet: true });

const VALID_VIDEO_CODECS = ['VP8', 'H264', 'H265', 'VP9', 'AV1'];

export function parseVideoCodec(value: string): "VP8" | "H264" | "H265" {
	if (typeof value === "string") {
		value = value.trim().toUpperCase();
	}
	if (VALID_VIDEO_CODECS.includes(value)) {
		return value as "VP8" | "H264" | "H265";
	}
	return "H264";
}

export function parsePreset(value: string): "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium" | "slow" | "slower" | "veryslow" {
	if (typeof value === "string") {
		value = value.trim().toLowerCase();
	}
	switch (value) {
		case "ultrafast":
		case "superfast":
		case "veryfast":
		case "faster":
		case "fast":
		case "medium":
		case "slow":
		case "slower":
		case "veryslow":
			return value as "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium" | "slow" | "slower" | "veryslow";
		default:
			return "ultrafast";
	}
}

export function parseBoolean(value: string | undefined): boolean {
	if (typeof value === "string") {
		value = value.trim().toLowerCase();
	}
	switch (value) {
		case "true":
			return true;
		default:
			return false;
	}
}

function parseAdminIds(value: string): string[] {
	try {
		// Try to parse as JSON array first
		const parsed = JSON.parse(value);
		if (Array.isArray(parsed)) {
			return parsed.filter(id => typeof id === 'string' && id.trim() !== '');
		}
	} catch {
		// If not JSON, try comma-separated values
		if (value.includes(',')) {
			return value.split(',').map(id => id.trim()).filter(id => id !== '');
		}
	}
	// Single value
	return value.trim() ? [value.trim()] : [];
}

function parseNumber(value: string | undefined, fallback: number): number {
	if (!value) return fallback;

	const parsed = parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

const cpuCores = parseNumber(process.env.CPU_CORES, 0);
const accelerator = (process.env.ACCELERATOR || "").trim().toLowerCase();
const isHuggingFaceSpace = Boolean(process.env.SPACE_ID || process.env.SPACE_HOST);
const isHuggingFaceCpuBasic =
	isHuggingFaceSpace &&
	(accelerator === "" || accelerator === "none") &&
	(cpuCores === 0 || cpuCores <= 2);
const streamProfile = (process.env.STREAM_PROFILE || (isHuggingFaceCpuBasic ? "hf-cpu-basic" : "default")).trim().toLowerCase();
const isHfCpuBasicProfile = streamProfile === "hf-cpu-basic";

const defaultStreamWidth = isHfCpuBasicProfile ? 854 : 1280;
const defaultStreamHeight = isHfCpuBasicProfile ? 480 : 720;
const defaultStreamFps = isHfCpuBasicProfile ? 24 : 30;
const defaultStreamBitrateKbps = isHfCpuBasicProfile ? 1400 : 2000;
const defaultStreamMaxBitrateKbps = isHfCpuBasicProfile ? 2000 : 2500;
const defaultFfmpegThreads = isHfCpuBasicProfile ? 2 : 0;
const defaultFullCacheRemote = isHfCpuBasicProfile;
const defaultPreTranscodeBeforePlayback = false;
const defaultRemotePrebufferMb = isHfCpuBasicProfile ? 50 : 200;
const defaultRemoteCacheDir = isHuggingFaceSpace ? "/tmp/streambot-remote-cache" : "./tmp/remote-cache";
const defaultTranscodeCacheDir = isHuggingFaceSpace ? "/tmp/streambot-transcode-cache" : "./tmp/transcode-cache";
const defaultDiscordSendTimeoutMs = 10000;
const minDiscordSendTimeoutMs = 10000;
const defaultDiscordSuppressAbortWarnings = false;

function parseDiscordSendTimeoutMs(value: string | undefined): number {
	const parsed = parseNumber(value, defaultDiscordSendTimeoutMs);

	if (parsed === 0) {
		return 0;
	}

	return parsed < minDiscordSendTimeoutMs ? minDiscordSendTimeoutMs : parsed;
}

export default {
	// Selfbot options
	token: process.env.TOKEN || '',
	prefix: process.env.PREFIX || '$',
	guildId: process.env.GUILD_ID ? process.env.GUILD_ID : '',
	cmdChannelId: process.env.COMMAND_CHANNEL_ID ? process.env.COMMAND_CHANNEL_ID : '',
	videoChannelId: process.env.VIDEO_CHANNEL_ID ? process.env.VIDEO_CHANNEL_ID : '',
	adminIds: process.env.ADMIN_IDS ? parseAdminIds(process.env.ADMIN_IDS) : [],
	streamProfile,
	discordReactionsEnabled: process.env.DISCORD_REACTIONS_ENABLED ? parseBoolean(process.env.DISCORD_REACTIONS_ENABLED) : !isHfCpuBasicProfile,
	discordSendTimeoutMs: parseDiscordSendTimeoutMs(process.env.DISCORD_SEND_TIMEOUT_MS),
	discordSuppressAbortWarnings: process.env.DISCORD_SUPPRESS_ABORT_WARNINGS ? parseBoolean(process.env.DISCORD_SUPPRESS_ABORT_WARNINGS) : defaultDiscordSuppressAbortWarnings,

	// General options
	videosDir: process.env.VIDEOS_DIR ? process.env.VIDEOS_DIR : './videos',
	previewCacheDir: process.env.PREVIEW_CACHE_DIR ? process.env.PREVIEW_CACHE_DIR : './tmp/preview-cache',
	remoteCacheDir: process.env.STREAM_REMOTE_CACHE_DIR ? process.env.STREAM_REMOTE_CACHE_DIR : defaultRemoteCacheDir,
	transcodeCacheDir: process.env.STREAM_TRANSCODE_CACHE_DIR ? process.env.STREAM_TRANSCODE_CACHE_DIR : defaultTranscodeCacheDir,

	// yt-dlp options
	ytdlpCookiesPath: process.env.YTDLP_COOKIES_PATH ? process.env.YTDLP_COOKIES_PATH : '',

	// Stream options
	respect_video_params: process.env.STREAM_RESPECT_VIDEO_PARAMS ? parseBoolean(process.env.STREAM_RESPECT_VIDEO_PARAMS) : false,
	bitrateOverride: process.env.STREAM_BITRATE_OVERRIDE ? parseBoolean(process.env.STREAM_BITRATE_OVERRIDE) : false,
	width: parseNumber(process.env.STREAM_WIDTH, defaultStreamWidth),
	height: parseNumber(process.env.STREAM_HEIGHT, defaultStreamHeight),
	fps: parseNumber(process.env.STREAM_FPS, defaultStreamFps),
	bitrateKbps: parseNumber(process.env.STREAM_BITRATE_KBPS, defaultStreamBitrateKbps),
	maxBitrateKbps: parseNumber(process.env.STREAM_MAX_BITRATE_KBPS, defaultStreamMaxBitrateKbps),
	maxWidth: parseNumber(process.env.STREAM_MAX_WIDTH, 0),
	maxHeight: parseNumber(process.env.STREAM_MAX_HEIGHT, 0),
	hardwareAcceleratedDecoding: process.env.STREAM_HARDWARE_ACCELERATION ? parseBoolean(process.env.STREAM_HARDWARE_ACCELERATION) : false,
	h26xPreset: process.env.STREAM_H26X_PRESET ? parsePreset(process.env.STREAM_H26X_PRESET) : 'ultrafast',
	videoCodec: process.env.STREAM_VIDEO_CODEC ? parseVideoCodec(process.env.STREAM_VIDEO_CODEC) : 'H264',
	ffmpegVideoEncoder: process.env.STREAM_FFMPEG_VIDEO_ENCODER ? process.env.STREAM_FFMPEG_VIDEO_ENCODER.trim() : '',
	ffmpegThreads: parseNumber(process.env.STREAM_FFMPEG_THREADS, defaultFfmpegThreads),
	noTranscoding: process.env.STREAM_NO_TRANSCODING ? parseBoolean(process.env.STREAM_NO_TRANSCODING) : false,
	preTranscodeBeforePlayback: process.env.STREAM_PRETRANSCODE_BEFORE_PLAYBACK ? parseBoolean(process.env.STREAM_PRETRANSCODE_BEFORE_PLAYBACK) : defaultPreTranscodeBeforePlayback,
	fullCacheRemote: process.env.STREAM_FULL_CACHE_REMOTE ? parseBoolean(process.env.STREAM_FULL_CACHE_REMOTE) : defaultFullCacheRemote,
	remotePrebufferMb: parseNumber(process.env.STREAM_REMOTE_PREBUFFER_MB, defaultRemotePrebufferMb),

	// Videos server options
	server_enabled: process.env.SERVER_ENABLED ? parseBoolean(process.env.SERVER_ENABLED) : false,
	server_username: process.env.SERVER_USERNAME ? process.env.SERVER_USERNAME : 'admin',
	server_password: process.env.SERVER_PASSWORD ? process.env.SERVER_PASSWORD : 'admin',
	server_port: parseInt(process.env.SERVER_PORT ? process.env.SERVER_PORT : '8080'),
	stremioAddonUrl: process.env.STREMIO_ADDON || "localhost:8080/stremio-addon/v1/manifest.json",
	auto247MinYear: parseInt(process.env.AUTO247_MIN_YEAR || "2020", 10),
	auto247AllowedGenres: (process.env.AUTO247_ALLOWED_GENRES || "")
		.split(",")
		.map(s => s.trim())
		.filter(Boolean),
	tmdbApiKey: process.env.TMDB_READ_ACCESS_TOKEN || "",
	auto247IntervalMs: parseInt(process.env.AUTO247_INTERVAL_MS || "2000", 10),
}
