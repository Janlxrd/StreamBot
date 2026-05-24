import { Client, Message } from "discord.js-selfbot-v13";
import { Streamer, Utils, prepareStream, playStream, Encoders } from "@dank074/discord-video-stream";
import fs from 'fs';
import path from 'path';
import { execFile, spawn, ChildProcessWithoutNullStreams } from "child_process";
import config from "../config.js";
import { MediaService } from './media.js';
import { QueueService } from './queue.js';
import { getVideoParams } from "../utils/ffmpeg.js";
import logger from '../utils/logger.js';
import { DiscordUtils, ErrorUtils } from '../utils/shared.js';
import { QueueItem, StreamStatus } from '../types/index.js';

type TranscodeProgress = {
	encodedSeconds?: number;
	frame?: string;
	fps?: string;
	speed?: string;
	totalSizeBytes?: number;
};

export class StreamingService {
	private streamer: Streamer;
	private mediaService: MediaService;
	private queueService: QueueService;
	private controller: AbortController | null = null;
	private streamStatus: StreamStatus;
	private failedVideos: Set<string> = new Set();
	private isSkipping: boolean = false;
	private activeBufferProcess: ChildProcessWithoutNullStreams | null = null;
	private activeBufferTempFile: string | null = null;
	private activeTranscodeProcess: ChildProcessWithoutNullStreams | null = null;
	private activeTranscodeTempFile: string | null = null;

	constructor(client: Client, streamStatus: StreamStatus) {
		this.streamer = new Streamer(client);
		this.mediaService = new MediaService();
		this.queueService = new QueueService();
		this.streamStatus = streamStatus;
		this.cleanupOrphanedPrebufferFiles().catch(err =>
			logger.warn(`Startup temp cleanup failed: ${String(err)}`)
		);
		this.cleanupOrphanedTranscodeFiles().catch(err =>
			logger.warn(`Startup transcode temp cleanup failed: ${String(err)}`)
		);
	}

	public getStreamer(): Streamer {
		return this.streamer;
	}

	public getQueueService(): QueueService {
		return this.queueService;
	}

	private isHttpUrl(value: string): boolean {
		return /^https?:\/\//i.test(value);
	}

	private isYouTubeUrl(value: string): boolean {
		return /(?:youtube\.com|youtu\.be)/i.test(value);
	}

	private isProxyLikeStreamUrl(value: string): boolean {
		if (!this.isHttpUrl(value)) return false;

		return (
			/\/play\//i.test(value) ||
			/midnightignite\.me/i.test(value) ||
			/stremio/i.test(value) ||
			/meteor/i.test(value)
		);
	}

	private async getPreferredEnglishAudioIndex(videoUrl: string): Promise<number | null> {
		try {
			const result: string = await new Promise((resolve, reject) => {
				execFile(
					"ffprobe",
					[
						"-v", "error",
						"-show_streams",
						"-select_streams", "a",
						"-of", "json",
						videoUrl
					],
					(error, stdout) => {
						if (error) {
							reject(error);
							return;
						}
						resolve(stdout);
					}
				);
			});

			const data = JSON.parse(result);
			const streams = Array.isArray(data.streams) ? data.streams : [];

			if (!streams.length) return null;

			const scored = streams.map((stream: any, audioOrderIndex: number) => {
				const lang = String(stream.tags?.language || "").toLowerCase();
				const title = String(stream.tags?.title || "").toLowerCase();
				const handler = String(stream.tags?.handler_name || "").toLowerCase();
				const text = `${lang} ${title} ${handler}`;

				let score = 0;

				if (lang === "eng" || lang === "en") score += 100;
				if (text.includes("english")) score += 80;
				if (text.includes(" eng ") || text.includes("eng")) score += 40;
				if (lang === "ukr" || lang === "uk") score -= 120;
				if (text.includes("ukrain")) score -= 100;
				if (lang === "ita" || lang === "it") score -= 40;
				if (text.includes("ital")) score -= 30;
				if (lang === "rus" || lang === "ru") score -= 80;
				if (text.includes("russian")) score -= 80;

				return {
					audioOrderIndex,
					ffprobeIndex: stream.index,
					score,
					lang,
					title,
					handler
				};
			});

			scored.sort((a, b) => b.score - a.score);
			logger.info(`Detected audio streams: ${JSON.stringify(scored, null, 2)}`);

			const best = scored[0];
			if (!best) return null;
			
			if (best.score <= 0) {
				return null;
			}
			
			return best.audioOrderIndex;
		} catch (error) {
			logger.warn("Failed to detect English audio track:", error);
			return null;
		}
	}

	private getManualPreferredAudioIndexFromTitle(title?: string): number | null {
		if (!title) return null;

		const normalized = title.toLowerCase();

		// Very common release naming:
		// "ITA 5.1 ENG" often means first track is ITA, second is ENG
		if (normalized.includes(" ita ") && normalized.includes(" eng ")) {
			return 2;
		}

		return null;
	}

	private markVideoAsFailed(videoSource: string): void {
		this.failedVideos.add(videoSource);
		logger.info(`Marked video as failed: ${videoSource}`);
	}

	public async addToQueue(
		message: Message,
		videoSource: string,
		title?: string
	): Promise<boolean> {
		try {
			const username = message.author.username;

			// If this is already a direct HTTP stream URL, do not re-resolve it.
			if (this.isHttpUrl(videoSource) && !this.isYouTubeUrl(videoSource)) {
				const queueItem = await this.queueService.add(
					videoSource,
					title || videoSource,
					username,
					'url',
					true,
					videoSource
				);
				void DiscordUtils.sendSuccess(message, `Added to queue: \`${queueItem.title}\``);
				return true;
			}

			const mediaSource = await this.mediaService.resolveMediaSource(videoSource);

			if (mediaSource) {
				const queueItem = await this.queueService.add(
					mediaSource.url,
					title || mediaSource.title || videoSource,
					username,
					mediaSource.type || 'url',
					true,
					videoSource
				);
				void DiscordUtils.sendSuccess(message, `Added to queue: \`${queueItem.title}\``);
				return true;
			}
				
			else {
				const queueItem = await this.queueService.add(
					videoSource,
					title || videoSource,
					username,
					'url',
					false,
					videoSource
				);
				void DiscordUtils.sendSuccess(message, `Added to queue: \`${queueItem.title}\``);
				return true;
			}
		} catch (error) {
			await ErrorUtils.handleError(error, `adding to queue: ${videoSource}`, message);
			return false;
		}
	}

	private getTempBufferDir(): string {
		return config.remoteCacheDir || config.previewCacheDir || "./tmp";
	}

	private getTranscodeCacheDir(): string {
		return config.transcodeCacheDir || "./tmp/transcode-cache";
	}
	
	private sanitizeFileName(name: string): string {
		return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "").trim().slice(0, 80) || "stream";
	}

	private getRemotePrebufferBytes(): number {
		const prebufferMb = Number(config.remotePrebufferMb);
		const safePrebufferMb = Number.isFinite(prebufferMb) && prebufferMb > 0 ? prebufferMb : 200;

		return safePrebufferMb * 1024 * 1024;
	}
	
	private async wait(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
	
	private async waitForFileSize(filePath: string, minBytes: number, timeoutMs: number): Promise<void> {
		const started = Date.now();
	
		while (true) {
			try {
				const stat = await fs.promises.stat(filePath);
				if (stat.size >= minBytes) return;
			} catch {}
	
			if (Date.now() - started > timeoutMs) {
				throw new Error(`Timed out waiting for prebuffer file to reach ${minBytes} bytes`);
			}
	
			await this.wait(1000);
		}
	}

	private async getMediaDurationSeconds(inputFile: string): Promise<number | undefined> {
		return new Promise(resolve => {
			execFile(
				"ffprobe",
				[
					"-v", "error",
					"-show_entries", "format=duration",
					"-of", "default=noprint_wrappers=1:nokey=1",
					inputFile
				],
				{ timeout: 30000 },
				(error, stdout) => {
					if (error) {
						logger.warn(`Unable to probe media duration for ${inputFile}: ${error.message}`);
						resolve(undefined);
						return;
					}

					const duration = Number.parseFloat(String(stdout).trim());
					resolve(Number.isFinite(duration) && duration > 0 ? duration : undefined);
				}
			);
		});
	}

	private parseFfmpegTimestampToSeconds(value: string): number | undefined {
		const match = value.trim().match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
		if (!match) {
			return undefined;
		}

		const hours = Number.parseInt(match[1], 10);
		const minutes = Number.parseInt(match[2], 10);
		const seconds = Number.parseFloat(match[3]);
		if (![hours, minutes, seconds].every(Number.isFinite)) {
			return undefined;
		}

		return hours * 3600 + minutes * 60 + seconds;
	}

	private formatDuration(seconds?: number): string {
		if (!Number.isFinite(seconds) || seconds === undefined || seconds < 0) {
			return "unknown";
		}

		const totalSeconds = Math.floor(seconds);
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const remainingSeconds = totalSeconds % 60;

		if (hours > 0) {
			return `${hours}h ${minutes}m ${remainingSeconds}s`;
		}

		if (minutes > 0) {
			return `${minutes}m ${remainingSeconds}s`;
		}

		return `${remainingSeconds}s`;
	}

	private formatBytes(bytes?: number): string {
		if (!Number.isFinite(bytes) || bytes === undefined || bytes < 0) {
			return "unknown";
		}

		const units = ["B", "KB", "MB", "GB"];
		let value = bytes;
		let unitIndex = 0;

		while (value >= 1024 && unitIndex < units.length - 1) {
			value /= 1024;
			unitIndex += 1;
		}

		return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
	}

	private updateTranscodeProgressFromLine(line: string, progress: TranscodeProgress): "continue" | "end" | undefined {
		const separatorIndex = line.indexOf("=");
		if (separatorIndex === -1) {
			return undefined;
		}

		const key = line.slice(0, separatorIndex).trim();
		const value = line.slice(separatorIndex + 1).trim();

		switch (key) {
			case "frame":
				progress.frame = value;
				break;
			case "fps":
				progress.fps = value;
				break;
			case "speed":
				progress.speed = value;
				break;
			case "total_size": {
				const bytes = Number.parseInt(value, 10);
				if (Number.isFinite(bytes)) {
					progress.totalSizeBytes = bytes;
				}
				break;
			}
			case "out_time": {
				const seconds = this.parseFfmpegTimestampToSeconds(value);
				if (seconds !== undefined) {
					progress.encodedSeconds = seconds;
				}
				break;
			}
			case "out_time_us":
			case "out_time_ms": {
				const rawTime = Number.parseInt(value, 10);
				if (Number.isFinite(rawTime) && rawTime >= 0) {
					progress.encodedSeconds = rawTime / 1_000_000;
				}
				break;
			}
			case "progress":
				return value === "end" ? "end" : "continue";
		}

		return undefined;
	}

	private buildTranscodeProgressMessage(title: string | undefined, progress: TranscodeProgress, totalDurationSeconds?: number): string {
		const encodedSeconds = progress.encodedSeconds;
		const percent = totalDurationSeconds && encodedSeconds !== undefined
			? ` ${Math.min(100, Math.max(0, (encodedSeconds / totalDurationSeconds) * 100)).toFixed(1)}%`
			: "";
		const duration = totalDurationSeconds
			? `${this.formatDuration(encodedSeconds)} / ${this.formatDuration(totalDurationSeconds)}`
			: this.formatDuration(encodedSeconds);
		const speed = progress.speed ? `, speed ${progress.speed}` : "";
		const fps = progress.fps ? `, encode fps ${progress.fps}` : "";
		const outputSize = progress.totalSizeBytes ? `, output ${this.formatBytes(progress.totalSizeBytes)}` : "";

		return `Pre-transcode progress${percent} for ${title || "movie"}: ${duration}${speed}${fps}${outputSize}`;
	}
	
	private waitForBufferProcess(child: ChildProcessWithoutNullStreams, tempFile: string): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				if (this.activeBufferProcess === child) {
					this.activeBufferProcess = null;
				}
				if (error) {
					reject(error);
					return;
				}
				resolve();
			};

			child.once("error", (error) => {
				finish(error instanceof Error ? error : new Error(String(error)));
			});

			child.once("exit", (code, signal) => {
				logger.info(`Prebuffer process exited (code=${code}, signal=${signal}) for ${tempFile}`);

				if (code === 0) {
					finish();
					return;
				}

				if (this.streamStatus.manualStop || signal) {
					finish(new Error("Remote cache was stopped before it completed."));
					return;
				}

				finish(new Error(`Remote cache ffmpeg failed with exit code ${code ?? "unknown"}.`));
			});
		});
	}

	private async startHttpPrebuffer(videoSource: string, title?: string): Promise<{ tempFile: string, completion: Promise<void> }> {
		const dir = this.getTempBufferDir();
		await fs.promises.mkdir(dir, { recursive: true });

		const tempFile = path.join(dir, `${Date.now()}-${this.sanitizeFileName(title || "movie")}.mkv`);

		const args = [
			"-y",
			"-rw_timeout", "15000000",
			"-i", videoSource,
			"-map", "0:v:0",
			"-map", "0:a?",
			"-c", "copy",
			"-f", "matroska",
			tempFile
		];

		const child = spawn("ffmpeg", args, {
			stdio: ["ignore", "ignore", "pipe"]
		});

		child.stderr.on("data", (chunk) => {
			logger.debug?.(`prebuffer ffmpeg: ${chunk.toString()}`);
		});

		this.activeBufferProcess = child;
		this.activeBufferTempFile = tempFile;

		const completion = this.waitForBufferProcess(child, tempFile);
		void completion.catch(error => {
			logger.warn(`Remote cache process did not complete cleanly for ${tempFile}: ${String(error)}`);
		});

		return { tempFile, completion };
	}

	private async stopActivePrebuffer(): Promise<void> {
		if (this.activeBufferProcess && !this.activeBufferProcess.killed) {
			this.activeBufferProcess.kill("SIGKILL");
		}
		this.activeBufferProcess = null;
	}

	private async stopActiveTranscode(): Promise<void> {
		if (this.activeTranscodeProcess && !this.activeTranscodeProcess.killed) {
			this.activeTranscodeProcess.kill("SIGKILL");
		}
		this.activeTranscodeProcess = null;
	}
	
	private async cleanupActivePrebufferFile(): Promise<void> {
		const tempFile = this.activeBufferTempFile;
		this.activeBufferTempFile = null;
	
		if (!tempFile) return;
	
		try {
			await fs.promises.unlink(tempFile);
			logger.info(`Deleted prebuffer temp file: ${tempFile}`);
		} catch (error) {
			logger.warn(`Failed to delete prebuffer temp file ${tempFile}: ${String(error)}`);
		}
	}

	private async cleanupActiveTranscodeFile(): Promise<void> {
		const tempFile = this.activeTranscodeTempFile;
		this.activeTranscodeTempFile = null;

		if (!tempFile) return;

		try {
			await fs.promises.unlink(tempFile);
			logger.info(`Deleted transcode temp file: ${tempFile}`);
		} catch (error) {
			logger.warn(`Failed to delete transcode temp file ${tempFile}: ${String(error)}`);
		}
	}

	public async playFromQueue(message: Message): Promise<void> {
		if (this.streamStatus.playing) {
			await DiscordUtils.sendError(message, 'Already playing a video. Use skip command to skip current video.');
			return;
		}

		const nextItem = this.queueService.getNext();
		if (!nextItem) {
			await DiscordUtils.sendError(message, 'Queue is empty.');
			return;
		}

		this.queueService.setPlaying(true);
		await this.playVideoFromQueueItem(message, nextItem);
	}

	public async skipCurrent(message: Message): Promise<void> {
		if (!this.streamStatus.playing) {
			await DiscordUtils.sendError(message, 'No video is currently playing.');
			return;
		}

		const queueLength = this.queueService.getLength();
		const isLastItem = queueLength <= 1;

		if (this.isSkipping && !isLastItem) {
			await DiscordUtils.sendError(message, 'Skip already in progress.');
			return;
		}

		this.isSkipping = true;

		try {
			this.streamStatus.manualStop = true;
			this.controller?.abort();
			this.streamer.stopStream();

			await this.stopActivePrebuffer();
			await this.stopActiveTranscode();

			const currentItem = this.queueService.getCurrent();
			const nextItem = this.queueService.skip();

			if (!nextItem) {
				await DiscordUtils.sendInfo(message, 'Queue', 'No more videos in queue.');
				this.queueService.setPlaying(false);
				await this.cleanupStreamStatus();
				return;
			}

			const currentTitle = currentItem ? currentItem.title : 'current video';
			await DiscordUtils.sendInfo(message, 'Skipping', `Skipping \`${currentTitle}\`. Playing next: \`${nextItem.title}\``);

			this.streamStatus.manualStop = false;
			await this.playVideoFromQueueItem(message, nextItem);
		} finally {
			this.isSkipping = false;
		}
	}

	private async playVideoFromQueueItem(message: Message, queueItem: QueueItem): Promise<void> {
		this.queueService.setPlaying(true);

		let videoParams = undefined;

		const shouldProbe =
			config.respect_video_params &&
			!this.isProxyLikeStreamUrl(queueItem.url);

		if (shouldProbe) {
			videoParams = await this.getVideoParameters(queueItem.url);
		} else if (config.respect_video_params) {
			logger.info(`Skipping video parameter probe for proxy-like stream URL: ${queueItem.url}`);
		}

		logger.info(`Playing from queue: ${queueItem.title} (${queueItem.url})`);
		await this.playVideo(message, queueItem.url, queueItem.title, videoParams);
	}

	private async getVideoParameters(videoUrl: string): Promise<{ width: number, height: number, fps?: number, bitrate?: number } | undefined> {
		try {
			const resolution = await getVideoParams(videoUrl);
			logger.info(`Video parameters: ${resolution.width}x${resolution.height}, FPS: ${resolution.fps || 'unknown'}, Bitrate: ${resolution.bitrate || 'unknown'}`);

			let bitrateKbps: number | undefined;
			if (resolution.bitrate) {
				bitrateKbps = Math.round(parseInt(resolution.bitrate) / 1000);
			}

			return {
				width: resolution.width,
				height: resolution.height,
				fps: resolution.fps,
				bitrate: bitrateKbps
			};
		} catch (error) {
			await ErrorUtils.handleError(error, 'determining video parameters');
			return undefined;
		}
	}

	private async ensureVoiceConnection(guildId: string, channelId: string, title?: string): Promise<void> {
		if (!this.streamStatus.joined || !this.streamer.voiceConnection) {
			await this.streamer.joinVoice(guildId, channelId);
			this.streamStatus.joined = true;
		}
		this.streamStatus.playing = true;
		this.streamStatus.channelInfo = { guildId, channelId, cmdChannelId: config.cmdChannelId! };

		if (title) {
			this.streamer.client.user?.setActivity(DiscordUtils.status_watch(title));
		}

		await new Promise(resolve => setTimeout(resolve, 2000));

		if (!this.streamer.voiceConnection) {
			throw new Error('Voice connection is not established');
		}
	}

	private getPositiveNumber(value: number | undefined): number | undefined {
		if (!Number.isFinite(value) || !value || value <= 0) {
			return undefined;
		}

		return value;
	}

	private getOutputDimensions(videoParams?: { width: number, height: number }): { width?: number, height?: number } {
		const configuredWidth = this.getPositiveNumber(config.width);
		const configuredHeight = this.getPositiveNumber(config.height);
		const maxWidth = this.getPositiveNumber(config.maxWidth);
		const maxHeight = this.getPositiveNumber(config.maxHeight);
		const targetWidth = maxWidth && configuredWidth ? Math.min(configuredWidth, maxWidth) : configuredWidth || maxWidth;
		const targetHeight = maxHeight && configuredHeight ? Math.min(configuredHeight, maxHeight) : configuredHeight || maxHeight;

		if (videoParams && targetWidth && targetHeight) {
			const widthScale = targetWidth / videoParams.width;
			const heightScale = targetHeight / videoParams.height;

			if (widthScale >= 1 && heightScale >= 1) {
				return {};
			}

			return widthScale < heightScale
				? { width: targetWidth }
				: { height: targetHeight };
		}

		if (targetHeight) {
			return { height: targetHeight };
		}

		if (targetWidth) {
			return { width: targetWidth };
		}

		return {};
	}

	private getCustomFfmpegFlags(skipVideoEncoder: boolean = false): string[] | undefined {
		const flags: string[] = [];
		const encoder = String(config.ffmpegVideoEncoder || "").trim();
		const threads = this.getPositiveNumber(config.ffmpegThreads);

		if (encoder && !skipVideoEncoder) {
			flags.push("-c:v", encoder);
		}

		if (threads) {
			flags.push("-threads", String(threads));
		}

		return flags.length ? flags : undefined;
	}

	private getStreamEncoder(): any {
		const preset = config.h26xPreset || "ultrafast";

		return Encoders.software({
			x264: {
				preset,
				tune: "zerolatency"
			},
			x265: {
				preset,
				tune: "zerolatency"
			}
		});
	}

	private getTranscodeVideoFilter(): string {
		const targetWidth = this.getPositiveNumber(config.maxWidth) || this.getPositiveNumber(config.width) || 1280;
		const targetHeight = this.getPositiveNumber(config.maxHeight) || this.getPositiveNumber(config.height) || 720;

		return `scale='min(${targetWidth},iw)':'min(${targetHeight},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
	}

	private async waitForTranscodeProcess(child: ChildProcessWithoutNullStreams, tempFile: string): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				if (this.activeTranscodeProcess === child) {
					this.activeTranscodeProcess = null;
				}
				if (error) {
					reject(error);
					return;
				}
				resolve();
			};

			child.once("error", (error) => {
				finish(error instanceof Error ? error : new Error(String(error)));
			});

			child.once("exit", (code, signal) => {
				logger.info(`Pre-transcode process exited (code=${code}, signal=${signal}) for ${tempFile}`);

				if (code === 0) {
					finish();
					return;
				}

				if (this.streamStatus.manualStop || signal) {
					finish(new Error("Pre-transcode was stopped before it completed."));
					return;
				}

				finish(new Error(`Pre-transcode ffmpeg failed with exit code ${code ?? "unknown"}.`));
			});
		});
	}

	private async transcodeForPlayback(message: Message, inputFile: string, title?: string): Promise<string> {
		const dir = this.getTranscodeCacheDir();
		await fs.promises.mkdir(dir, { recursive: true });

		const outputFile = path.join(dir, `${Date.now()}-${this.sanitizeFileName(title || "movie")}.mp4`);
		const bitrate = this.getPositiveNumber(config.bitrateKbps) || 2000;
		const maxBitrate = this.getPositiveNumber(config.maxBitrateKbps) || bitrate;
		const fps = this.getPositiveNumber(config.fps) || 24;
		const keyframeInterval = Math.max(1, Math.round(fps));
		const preset = config.h26xPreset || "ultrafast";
		const threads = this.getPositiveNumber(config.ffmpegThreads);
		const totalDurationSeconds = await this.getMediaDurationSeconds(inputFile);

		void DiscordUtils.reply(
			message,
			`Preparing optimized playback cache for \`${title || "movie"}\`... Playback will start after this CPU transcode finishes.`
		);
		logger.info(
			`Starting pre-transcode for ${title || inputFile}: duration=${this.formatDuration(totalDurationSeconds)}, ` +
			`target=${this.getPositiveNumber(config.maxWidth) || this.getPositiveNumber(config.width) || 1280}x` +
			`${this.getPositiveNumber(config.maxHeight) || this.getPositiveNumber(config.height) || 720}, ` +
			`fps=${fps}, bitrate=${bitrate}k, maxrate=${maxBitrate}k, preset=${preset}, threads=${threads || "auto"}`
		);

		const args = [
			"-y",
			"-hide_banner",
			"-nostats",
			"-progress", "pipe:2",
			"-i", inputFile,
			"-map", "0:v:0",
			"-map", "0:a?",
			"-vf", this.getTranscodeVideoFilter(),
			"-r", String(fps),
			"-c:v", "libx264",
			"-preset", preset,
			"-tune", "zerolatency",
			"-b:v", `${bitrate}k`,
			"-maxrate", `${maxBitrate}k`,
			"-bufsize", `${maxBitrate * 2}k`,
			"-bf", "0",
			"-g", String(keyframeInterval),
			"-keyint_min", String(keyframeInterval),
			"-sc_threshold", "0",
			"-force_key_frames", "expr:gte(t,n_forced*1)",
			"-pix_fmt", "yuv420p",
			"-c:a", "aac",
			"-b:a", "128k",
			"-ac", "2",
			"-movflags", "+faststart"
		];

		if (threads) {
			args.push("-threads", String(threads));
		}

		args.push(outputFile);

		const child = spawn("ffmpeg", args, {
			stdio: ["ignore", "ignore", "pipe"]
		});

		const progress: TranscodeProgress = {};
		let progressBuffer = "";
		let lastProgressLogAt = 0;
		let lastProgressReplyAt = Date.now();
		const maybeReportProgress = (force: boolean = false) => {
			const now = Date.now();
			if (!force && now - lastProgressLogAt < 30000) {
				return;
			}

			lastProgressLogAt = now;
			const progressMessage = this.buildTranscodeProgressMessage(title, progress, totalDurationSeconds);
			logger.info(progressMessage);

			if (now - lastProgressReplyAt >= 5 * 60 * 1000) {
				lastProgressReplyAt = now;
				void DiscordUtils.reply(message, progressMessage);
			}
		};

		child.stderr.on("data", (chunk) => {
			const text = chunk.toString();
			logger.debug?.(`pre-transcode ffmpeg: ${text}`);
			progressBuffer += text;

			const lines = progressBuffer.split(/\r?\n/);
			progressBuffer = lines.pop() || "";

			for (const line of lines) {
				const progressEvent = this.updateTranscodeProgressFromLine(line, progress);
				if (progressEvent) {
					maybeReportProgress(progressEvent === "end");
				}
			}
		});

		this.activeTranscodeProcess = child;
		this.activeTranscodeTempFile = outputFile;

		try {
			await this.waitForTranscodeProcess(child, outputFile);
			await this.waitForFileSize(outputFile, 1, 5000);
			return outputFile;
		} catch (error) {
			void DiscordUtils.reply(
				message,
				`Failed to prepare optimized playback cache for \`${title || "movie"}\`.`
			);
			throw error;
		}
	}
	
	private setupStreamConfiguration(videoParams?: { width: number, height: number, fps?: number, bitrate?: number }, forceNoTranscoding: boolean = false): any {
		const sourceFps = videoParams?.fps && videoParams.fps > 0 ? videoParams.fps : undefined;
		const configuredFps = this.getPositiveNumber(config.fps) || 30;
		const configuredBitrate = this.getPositiveNumber(config.bitrateKbps) || 2000;
		const maxBitrate = this.getPositiveNumber(config.maxBitrateKbps) || configuredBitrate;
		let frameRate = sourceFps ? Math.min(sourceFps, configuredFps) : configuredFps;
		let bitrateVideo = configuredBitrate;
		const dimensions = this.getOutputDimensions(videoParams);
		const noTranscoding = forceNoTranscoding || config.noTranscoding;
	
		if (videoParams && videoParams.bitrate && !config.bitrateOverride) {
			bitrateVideo = Math.min(videoParams.bitrate, maxBitrate);
		}
	
		return {
			noTranscoding,
			width: dimensions.width,
			height: dimensions.height,
			frameRate,
			fps: frameRate,
			bitrateVideo,
			bitrateVideoMax: maxBitrate,
			videoCodec: Utils.normalizeVideoCodec(config.videoCodec),
			encoder: this.getStreamEncoder(),
			hardwareAcceleratedDecoding: config.hardwareAcceleratedDecoding,
			minimizeLatency: false,
			customFfmpegFlags: this.getCustomFfmpegFlags(noTranscoding)
		};
	}
	
	private async executeStream(inputForFfmpeg: any, streamOpts: any, message: Message, title: string, videoSource: string, audioStreamIndex?: number | null): Promise<void> {
	const { command, output: ffmpegOutput } = prepareStream(
		inputForFfmpeg,
		streamOpts,
		this.controller!.signal
	);
	
	command.inputOptions([
		"-fflags", "+genpts"
	]);

	if (audioStreamIndex !== null && audioStreamIndex !== undefined) {
		command.outputOptions([
			"-map", "-0:a:0",
			"-map", `0:a:${audioStreamIndex}`
		]);
		logger.info(`Using English audio track order index: ${audioStreamIndex}`);
	}

	command.on("start", (cmdline) => {
		logger.info(`ffmpeg command: ${cmdline}`);
	});

		command.on("error", (err, stdout, stderr) => {
			if (!this.streamStatus.manualStop && this.controller && !this.controller.signal.aborted) {
				logger.error("An error happened with ffmpeg:", err.message);
				if (stdout) {
					logger.error("ffmpeg stdout:", stdout);
				}
				if (stderr) {
					logger.error("ffmpeg stderr:", stderr);
				}
				this.controller.abort();
			}
		});

		await playStream(ffmpegOutput, this.streamer, undefined, this.controller!.signal)
			.catch((err) => {
				if (this.controller && !this.controller.signal.aborted) {
					logger.error('playStream error:', err);
					DiscordUtils.sendError(message, `Stream error: ${err.message || 'Unknown error'}`).catch(e =>
						logger.error('Failed to send error message:', e)
					);
				}
				if (this.controller && !this.controller.signal.aborted) this.controller.abort();
			});

		if (this.controller && !this.controller.signal.aborted && !this.streamStatus.manualStop) {
			logger.info(`Finished playing: ${title || videoSource}`);
		} else if (this.streamStatus.manualStop) {
			logger.info(`Stopped playing: ${title || videoSource}`);
		} else {
			logger.info(`Failed playing: ${title || videoSource}`);
		}
	}

	private async handleQueueAdvancement(message: Message): Promise<void> {
		await DiscordUtils.sendFinishMessage(message);

		const finishedItem = this.queueService.getCurrent();
		if (finishedItem) {
			this.queueService.removeFromQueue(finishedItem.id);
		}

		const nextItem = this.queueService.getNext();

		if (nextItem) {
			logger.info(`Auto-playing next item from queue: ${nextItem.title}`);
			setTimeout(() => {
				this.playVideoFromQueueItem(message, nextItem).catch(err =>
					ErrorUtils.handleError(err, 'auto-playing next item')
				);
			}, 1000);
		} else {
			this.queueService.setPlaying(false);
			logger.info('No more items in queue, playback stopped');
			await this.cleanupStreamStatus();
		}
	}

	private async handleDownload(message: Message, videoSource: string, title?: string): Promise<string | null> {
		void DiscordUtils.reply(message, `Downloading \`${title || "YouTube video"}\`...`);

		try {
			logger.info(`Downloading ${title || videoSource}...`);
			const tempFilePath = await this.mediaService.downloadYouTubeVideo(videoSource);

			if (tempFilePath) {
				logger.info(`Finished downloading ${title || videoSource}`);
				return tempFilePath;
			}
			throw new Error('Download failed, no temp file path returned.');
		} catch (error) {
			logger.error(`Failed to download YouTube video: ${videoSource}`, error);
			void DiscordUtils.sendError(message, `Failed to download video: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
	}

	private async cleanupOrphanedPrebufferFiles(): Promise<void> {
		try {
			const dir = this.getTempBufferDir();
			await fs.promises.mkdir(dir, { recursive: true });
	
			const files = await fs.promises.readdir(dir);
	
			for (const file of files) {
				if (!file.endsWith(".mkv")) continue;
	
				const fullPath = path.join(dir, file);
	
				try {
					await fs.promises.unlink(fullPath);
					logger.info(`Deleted orphaned prebuffer temp file: ${fullPath}`);
				} catch (error) {
					logger.warn(`Failed to delete orphaned prebuffer temp file ${fullPath}: ${String(error)}`);
				}
			}
		} catch (error) {
			logger.warn(`Failed to clean orphaned prebuffer files: ${String(error)}`);
		}
	}

	private async cleanupOrphanedTranscodeFiles(): Promise<void> {
		try {
			const dir = this.getTranscodeCacheDir();
			await fs.promises.mkdir(dir, { recursive: true });

			const files = await fs.promises.readdir(dir);

			for (const file of files) {
				if (!file.endsWith(".mp4")) continue;

				const fullPath = path.join(dir, file);

				try {
					await fs.promises.unlink(fullPath);
					logger.info(`Deleted orphaned transcode temp file: ${fullPath}`);
				} catch (error) {
					logger.warn(`Failed to delete orphaned transcode temp file ${fullPath}: ${String(error)}`);
				}
			}
		} catch (error) {
			logger.warn(`Failed to clean orphaned transcode files: ${String(error)}`);
		}
	}
	
	private async prepareVideoSource(
		message: Message,
		videoSource: string,
		title?: string
	): Promise<{ inputForFfmpeg: any, tempFilePaths: string[], forceNoTranscoding: boolean }> {
		const maybePreTranscode = async (input: string, tempFilePaths: string[] = []) => {
			if (!config.preTranscodeBeforePlayback) {
				return { inputForFfmpeg: input, tempFilePaths, forceNoTranscoding: false };
			}

			const outputFile = await this.transcodeForPlayback(message, input, title);
			return {
				inputForFfmpeg: outputFile,
				tempFilePaths: [...tempFilePaths, outputFile],
				forceNoTranscoding: true
			};
		};

		if (this.isHttpUrl(videoSource) && !this.isYouTubeUrl(videoSource)) {
			const { tempFile: tempFilePath, completion } = await this.startHttpPrebuffer(videoSource, title);

			if (config.fullCacheRemote || config.preTranscodeBeforePlayback) {
				void DiscordUtils.reply(
					message,
					`Downloading \`${title || "remote movie"}\` to cache before playback starts...`
				);

				try {
					await completion;
					await this.waitForFileSize(tempFilePath, 1, 5000);
				} catch (error) {
					void DiscordUtils.reply(
						message,
						`Failed to cache \`${title || "remote movie"}\` before playback.`
					);
					throw error;
				}
			} else {
				await this.waitForFileSize(tempFilePath, this.getRemotePrebufferBytes(), 120000);
			}
	
			return maybePreTranscode(tempFilePath, [tempFilePath]);
		}
	
		const mediaSource = await this.mediaService.resolveMediaSource(videoSource);
	
		if (mediaSource && mediaSource.type === 'youtube' && !mediaSource.isLive) {
			const tempFilePath = await this.handleDownload(message, videoSource, title);
			if (tempFilePath) {
				return maybePreTranscode(tempFilePath, [tempFilePath]);
			}
			throw new Error('Failed to prepare video source due to download failure.');
		}

		const resolvedInput = mediaSource ? mediaSource.url : videoSource;

		if (typeof resolvedInput === "string" && fs.existsSync(resolvedInput) && fs.lstatSync(resolvedInput).isFile()) {
			return maybePreTranscode(resolvedInput);
		}
	
		return { inputForFfmpeg: resolvedInput, tempFilePaths: [], forceNoTranscoding: false };
	}
	
	private async executeStreamWorkflow(
		input: any,
		options: any,
		message: Message,
		title: string,
		source: string,
		audioStreamIndex?: number | null
	): Promise<void> {
		this.controller = new AbortController();
		await this.executeStream(input, options, message, title, source, audioStreamIndex);
	}

	private async finalizeStream(message: Message, tempFiles: string[]): Promise<void> {
		const activePrebufferFile = this.activeBufferTempFile;
		const activeTranscodeFile = this.activeTranscodeTempFile;

		if (!this.streamStatus.manualStop && this.controller && !this.controller.signal.aborted) {
			await this.handleQueueAdvancement(message);
		} else {
			this.queueService.setPlaying(false);
			this.queueService.resetCurrentIndex();
			await this.cleanupStreamStatus();
		}
	
		await this.stopActivePrebuffer();
		await this.stopActiveTranscode();
	
		for (const tempFile of tempFiles) {
			if (tempFile === activePrebufferFile || tempFile === activeTranscodeFile) {
				continue;
			}

			try {
				await fs.promises.unlink(tempFile);
				logger.info(`Deleted temp file: ${tempFile}`);
			} catch (cleanupError) {
				logger.error(`Failed to delete temp file ${tempFile}:`, cleanupError);
			}
		}
	
		await this.cleanupActivePrebufferFile();
		await this.cleanupActiveTranscodeFile();
	}

	public async playVideo(message: Message, videoSource: string, title?: string, videoParams?: { width: number, height: number, fps?: number, bitrate?: number }): Promise<void> {
		const [guildId, channelId] = [config.guildId, config.videoChannelId];
		this.streamStatus.manualStop = false;

		if (title) {
			const currentQueueItem = this.queueService.getCurrent();
			if (currentQueueItem?.title === title) {
				this.queueService.setPlaying(true);
			}
		}

		let tempFiles: string[] = [];
		try {
			await this.ensureVoiceConnection(guildId, channelId, title);
			void DiscordUtils.sendInfo(message, "Preparing", `Preparing \`${title || videoSource}\`...`);

			const { inputForFfmpeg, tempFilePaths, forceNoTranscoding } = await this.prepareVideoSource(message, videoSource, title);
			tempFiles = tempFilePaths;

			logger.info(`FFmpeg input source: ${inputForFfmpeg}`);

			let audioStreamIndex: number | null = null;

			if (typeof inputForFfmpeg === "string" && !this.isYouTubeUrl(inputForFfmpeg)) {
				audioStreamIndex = await this.getPreferredEnglishAudioIndex(inputForFfmpeg);

				if (audioStreamIndex === null) {
					audioStreamIndex = this.getManualPreferredAudioIndexFromTitle(title || videoSource);
				}
			}

			logger.info(`Final selected audio stream index: ${audioStreamIndex}`);

			const streamOpts = this.setupStreamConfiguration(videoParams, forceNoTranscoding);
			void DiscordUtils.sendPlaying(message, title || videoSource);
			await this.executeStreamWorkflow(
				inputForFfmpeg,
				streamOpts,
				message,
				title || videoSource,
				videoSource,
				audioStreamIndex
			);

		} catch (error) {
			if (this.streamStatus.manualStop) {
				logger.info(`Stopped before or during playback: ${title || videoSource}`);
			} else {
				await ErrorUtils.handleError(error, `playing video: ${title || videoSource}`);
				this.markVideoAsFailed(videoSource);
			}

			if (this.controller && !this.controller.signal.aborted) this.controller.abort();
		} finally {
			await this.finalizeStream(message, tempFiles);
		}
	}

	public async cleanupStreamStatus(): Promise<void> {
		try {
			this.controller?.abort();
			this.streamer.stopStream();
	
			await this.stopActivePrebuffer();
			await this.stopActiveTranscode();
			await this.cleanupActivePrebufferFile();
			await this.cleanupActiveTranscodeFile();
			await this.cleanupOrphanedPrebufferFiles();
			await this.cleanupOrphanedTranscodeFiles();
	
			const hasQueueItems = !this.queueService.isEmpty();
			if (!hasQueueItems) {
				this.streamer.leaveVoice();
				this.streamStatus.joined = false;
				this.streamStatus.joinsucc = false;
			}
	
			this.streamer.client.user?.setActivity(DiscordUtils.status_idle());
	
			this.streamStatus.playing = false;
			this.streamStatus.manualStop = false;
			this.streamStatus.channelInfo = {
				guildId: "",
				channelId: "",
				cmdChannelId: "",
			};
		} catch (error) {
			await ErrorUtils.handleError(error, "cleanup stream status");
		}
	}

	public async stopAndClearQueue(): Promise<void> {
		this.queueService.clearQueue();
		logger.info("Queue cleared by stop command");
		await this.cleanupStreamStatus();
	}
}
