import { Client, Message } from "discord.js-selfbot-v13";
import { Streamer, Utils, prepareStream, playStream } from "@dank074/discord-video-stream";
import fs from 'fs';
import { execFile, spawn, ChildProcessWithoutNullStreams } from "child_process";
import config from "../config.js";
import { MediaService } from './media.js';
import { QueueService } from './queue.js';
import { getVideoParams } from "../utils/ffmpeg.js";
import logger from '../utils/logger.js';
import { DiscordUtils, ErrorUtils } from '../utils/shared.js';
import { QueueItem, StreamStatus } from '../types/index.js';

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

	constructor(client: Client, streamStatus: StreamStatus) {
		this.streamer = new Streamer(client);
		this.mediaService = new MediaService();
		this.queueService = new QueueService();
		this.streamStatus = streamStatus;
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
				await DiscordUtils.sendSuccess(message, `Added to queue: \`${queueItem.title}\``);
				return true;
			}

			const mediaSource = await this.mediaService.resolveMediaSource(videoSource);

			if (mediaSource) {
				const queueItem = await this.queueService.addToQueue(mediaSource, username);
				await DiscordUtils.sendSuccess(message, `Added to queue: \`${queueItem.title}\``);
				return true;
			} else {
				const queueItem = await this.queueService.add(
					videoSource,
					title || videoSource,
					username,
					'url',
					false,
					videoSource
				);
				await DiscordUtils.sendSuccess(message, `Added to queue: \`${queueItem.title}\``);
				return true;
			}
		} catch (error) {
			await ErrorUtils.handleError(error, `adding to queue: ${videoSource}`, message);
			return false;
		}
	}

	private getTempBufferDir(): string {
		return config.previewCacheDir || "./tmp";
	}
	
	private sanitizeFileName(name: string): string {
		return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "").trim().slice(0, 80) || "stream";
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
	
	private async startHttpPrebuffer(videoSource: string, title?: string): Promise<string> {
		const dir = this.getTempBufferDir();
		await fs.promises.mkdir(dir, { recursive: true });
	
		const tempFile = `${dir}/${Date.now()}-${this.sanitizeFileName(title || "movie")}.mkv`;
	
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
	
		child.on("exit", (code, signal) => {
			logger.info(`Prebuffer process exited (code=${code}, signal=${signal}) for ${tempFile}`);
		});
	
		this.activeBufferProcess = child;
		this.activeBufferTempFile = tempFile;
	
		return tempFile;
	}
	
	private async stopActivePrebuffer(): Promise<void> {
		if (this.activeBufferProcess && !this.activeBufferProcess.killed) {
			this.activeBufferProcess.kill("SIGKILL");
		}
		this.activeBufferProcess = null;
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
	
	private setupStreamConfiguration(videoParams?: { width: number, height: number, fps?: number, bitrate?: number }): any {
		let frameRate = videoParams?.fps || config.fps;
		let bitrateVideo = config.bitrateKbps;
	
		if (videoParams && videoParams.bitrate && !config.bitrateOverride) {
			bitrateVideo = videoParams.bitrate;
		}
	
		return {
			width: undefined,
			height: undefined,
			frameRate,
			bitrateVideo,
			bitrateVideoMax: config.maxBitrateKbps,
			videoCodec: Utils.normalizeVideoCodec(config.videoCodec),
			hardwareAcceleratedDecoding: config.hardwareAcceleratedDecoding,
			minimizeLatency: false,
			h26xPreset: config.h26xPreset
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
		const downloadMessage = await message.reply(`📥 Downloading \`${title || 'YouTube video'}\`...`).catch(e => {
			logger.warn("Failed to send 'Downloading...' message:", e);
			return null;
		});

		try {
			logger.info(`Downloading ${title || videoSource}...`);
			const tempFilePath = await this.mediaService.downloadYouTubeVideo(videoSource);

			if (tempFilePath) {
				logger.info(`Finished downloading ${title || videoSource}`);
				if (downloadMessage) {
					await downloadMessage.delete().catch(e => logger.warn("Failed to delete 'Downloading...' message:", e));
				}
				return tempFilePath;
			}
			throw new Error('Download failed, no temp file path returned.');
		} catch (error) {
			logger.error(`Failed to download YouTube video: ${videoSource}`, error);
			const errorMessage = `❌ Failed to download \`${title || 'YouTube video'}\`.`;
			if (downloadMessage) {
				await downloadMessage.edit(errorMessage).catch(e => logger.warn("Failed to edit 'Downloading...' message:", e));
			} else {
				await DiscordUtils.sendError(message, `Failed to download video: ${error instanceof Error ? error.message : String(error)}`);
			}
			return null;
		}
	}

	private async prepareVideoSource(
		message: Message,
		videoSource: string,
		title?: string
	): Promise<{ inputForFfmpeg: any, tempFilePath: string | null }> {
		if (this.isHttpUrl(videoSource) && !this.isYouTubeUrl(videoSource)) {
			const tempFilePath = await this.startHttpPrebuffer(videoSource, title);
	
			// ~200 MB initial buffer; change if you want
			await this.waitForFileSize(tempFilePath, 200 * 1024 * 1024, 120000);
	
			return { inputForFfmpeg: tempFilePath, tempFilePath };
		}
	
		const mediaSource = await this.mediaService.resolveMediaSource(videoSource);
	
		if (mediaSource && mediaSource.type === 'youtube' && !mediaSource.isLive) {
			const tempFilePath = await this.handleDownload(message, videoSource, title);
			if (tempFilePath) {
				return { inputForFfmpeg: tempFilePath, tempFilePath };
			}
			throw new Error('Failed to prepare video source due to download failure.');
		}
	
		return { inputForFfmpeg: mediaSource ? mediaSource.url : videoSource, tempFilePath: null };
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

	private async finalizeStream(message: Message, tempFile: string | null): Promise<void> {
		if (!this.streamStatus.manualStop && this.controller && !this.controller.signal.aborted) {
			await this.handleQueueAdvancement(message);
		} else {
			this.queueService.setPlaying(false);
			this.queueService.resetCurrentIndex();
			await this.cleanupStreamStatus();
		}
	
		await this.stopActivePrebuffer();
	
		if (tempFile) {
			try {
				await fs.promises.unlink(tempFile);
				logger.info(`Deleted temp file: ${tempFile}`);
			} catch (cleanupError) {
				logger.error(`Failed to delete temp file ${tempFile}:`, cleanupError);
			}
		}
	
		await this.cleanupActivePrebufferFile();
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

		let tempFile: string | null = null;
		try {
			const { inputForFfmpeg, tempFilePath } = await this.prepareVideoSource(message, videoSource, title);
			tempFile = tempFilePath;

			logger.info(`FFmpeg input source: ${inputForFfmpeg}`);

			await this.ensureVoiceConnection(guildId, channelId, title);
			await DiscordUtils.sendPlaying(message, title || videoSource);

			let audioStreamIndex: number | null = null;

			if (typeof inputForFfmpeg === "string" && !this.isYouTubeUrl(inputForFfmpeg)) {
				audioStreamIndex = await this.getPreferredEnglishAudioIndex(inputForFfmpeg);

				if (audioStreamIndex === null) {
					audioStreamIndex = this.getManualPreferredAudioIndexFromTitle(title || videoSource);
				}
			}

			logger.info(`Final selected audio stream index: ${audioStreamIndex}`);

			const streamOpts = this.setupStreamConfiguration(videoParams);
			await this.executeStreamWorkflow(
				inputForFfmpeg,
				streamOpts,
				message,
				title || videoSource,
				videoSource,
				audioStreamIndex
			);

		} catch (error) {
			await ErrorUtils.handleError(error, `playing video: ${title || videoSource}`);
			if (this.controller && !this.controller.signal.aborted) this.controller.abort();
			this.markVideoAsFailed(videoSource);
		} finally {
			await this.finalizeStream(message, tempFile);
		}
	}

	public async cleanupStreamStatus(): Promise<void> {
		try {
			this.controller?.abort();
			this.streamer.stopStream();

			await this.stopActivePrebuffer();
			await this.cleanupActivePrebufferFile();

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
