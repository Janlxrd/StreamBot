import { BaseCommand } from "./base.js";
import { CommandContext } from "../types/index.js";
import { MediaService } from "../services/media.js";
import StremioAddonService from "../services/stremio-addon.js";
import CinemetaService from "../services/cinemeta.js";
import { ErrorUtils, GeneralUtils } from "../utils/shared.js";
import fs from "fs";
import path from "path";
import config from "../config.js";

export default class PlayCommand extends BaseCommand {
	name = "play";
	description = "Play local video, URL, IMDb/Stremio movie, or search YouTube videos";
	usage = "play <video_name|url|movie_title|imdb_url|tt1234567|search_query>";

	private mediaService: MediaService;
	private stremioService: StremioAddonService;
	private cinemetaService: CinemetaService;

	constructor() {
		super();
		this.mediaService = new MediaService();
		this.stremioService = new StremioAddonService(config.stremioAddonUrl);
		this.cinemetaService = new CinemetaService();
	}

	async execute(context: CommandContext): Promise<void> {
		const input = context.args.join(" ").trim();

		if (!input) {
			await this.sendError(
				context.message,
				"Please provide a video name, URL, IMDb URL/ID, movie title, or search query."
			);
			return;
		}

		// 1) Direct URL
		if (GeneralUtils.isValidUrl(input)) {
			const imdbIdFromUrl = this.stremioService.extractImdbId(input);
			if (imdbIdFromUrl) {
				const playedFromStremio = await this.tryHandleStremioMovie(
					context,
					imdbIdFromUrl,
					input
				);
				if (playedFromStremio) return;
			}

			await this.handleUrl(context, input);
			return;
		}

		// 2) Direct IMDb ID like tt0063350
		const directImdbId = this.stremioService.extractImdbId(input);
		if (directImdbId) {
			const playedFromStremio = await this.tryHandleStremioMovie(
				context,
				directImdbId,
				input
			);
			if (playedFromStremio) return;
		}

		// 3) Refresh and check local file exact match
		this.refreshVideoList(context);

		const localVideo = context.videos.find(
			m => m.name.toLowerCase() === input.toLowerCase()
		);

		if (localVideo) {
			await this.handleLocalVideo(context, localVideo);
			return;
		}

		// 4) Try resolving title -> IMDb ID with Cinemeta, then play through Stremio
		const resolvedImdbId = await this.tryResolveImdbId(input);
		if (resolvedImdbId) {
			const playedFromStremio = await this.tryHandleStremioMovie(
				context,
				resolvedImdbId,
				input
			);
			if (playedFromStremio) return;
		}

		// 5) Fallback to your existing search logic
		await this.handleSearchQuery(context, input);
	}

	private refreshVideoList(context: CommandContext): void {
		const videoFiles = fs.readdirSync(config.videosDir);
		const refreshedVideos = videoFiles.map(file => ({
			name: path.parse(file).name,
			path: path.join(config.videosDir, file)
		}));

		context.videos.length = 0;
		context.videos.push(...refreshedVideos);
	}

	private async tryResolveImdbId(input: string): Promise<string | null> {
		try {
			const parsed = this.parseTitleAndYear(input);

			return await this.cinemetaService.resolveTitleToImdbId(
				parsed.title,
				"movie",
				parsed.year
			);
		} catch (error) {
			console.error(`Cinemeta resolve failed for "${input}":`, error);
			return null;
		}
	}

	private parseTitleAndYear(input: string): { title: string; year?: number } {
		const trimmed = input.trim();

		let title = trimmed;
		let year: number | undefined;

		const parenMatch = trimmed.match(/\((19|20)\d{2}\)\s*$/);
		if (parenMatch) {
			year = Number(parenMatch[0].replace(/[^\d]/g, ""));
			title = trimmed.replace(/\((19|20)\d{2}\)\s*$/, "").trim();
			return { title, year };
		}

		const trailingYearMatch = trimmed.match(/\b(19|20)\d{2}\s*$/);
		if (trailingYearMatch) {
			year = Number(trailingYearMatch[0].trim());
			title = trimmed.replace(/\b(19|20)\d{2}\s*$/, "").trim();
			return { title, year };
		}

		return { title };
	}

	private async resolvePlayableUrl(url: string): Promise<string | null> {
		try {
			const response = await fetch(url, {
				method: "GET",
				redirect: "follow",
				headers: {
					"user-agent": "Mozilla/5.0",
					"accept": "*/*"
				}
			});

			if (!response.ok) {
				return null;
			}

			const contentType = response.headers.get("content-type") || "";
			const finalUrl = response.url || url;

			console.log("Resolved stream URL:", {
				originalUrl: url,
				finalUrl,
				contentType
			});

			if (
				contentType.includes("text/html") ||
				contentType.includes("application/json") ||
				contentType.includes("text/plain")
			) {
				return null;
			}

			return finalUrl;
		} catch (error) {
			console.error("resolvePlayableUrl failed:", error);
			return null;
		}
	}

	private async tryHandleStremioMovie(
		context: CommandContext,
		imdbId: string,
		originalInput: string
	): Promise<boolean> {
		try {
			const streams = await this.stremioService.getMovieStreams(imdbId);

			if (!streams.length) {
				return false;
			}

			const englishStreams = this.stremioService.filterEnglishStreams(streams);

			if (!englishStreams.length) {
				await this.sendError(
					context.message,
					`No English streams were found for "${originalInput}".`
				);
				return true;
			}

			const bestStream =
				this.stremioService.pickBestPlayableHighQualityEnglishStream(englishStreams);

			if (!bestStream) {
				await this.sendError(
					context.message,
					`No high quality English streams were found for "${originalInput}". Only 1080p or 720p are allowed.`
				);
				return true;
			}

			const playableInput = this.stremioService.toPlayableInput(bestStream);
			if (!playableInput) {
				await this.sendError(
					context.message,
					`No playable high quality English stream was found for "${originalInput}".`
				);
				return true;
			}

			let finalPlayableInput = playableInput;

			if (/^https?:\/\//i.test(playableInput) && !playableInput.includes("youtube.com")) {
				const resolved = await this.resolvePlayableUrl(playableInput);

				if (!resolved) {
					await this.sendError(
						context.message,
						`The selected stream is not a direct playable media file.`
					);
					return true;
				}

				finalPlayableInput = resolved;
			}

			const displayName =
				bestStream.name ||
				bestStream.title ||
				`Stremio: ${imdbId}`;

			const success = await context.streamingService.addToQueue(
				context.message,
				finalPlayableInput,
				displayName
			);

			if (success && !context.streamStatus.playing) {
				await context.streamingService.playFromQueue(context.message);
			}

			return success;
		} catch (error) {
			console.error(`Stremio playback failed for ${originalInput}:`, error);
			return false;
		}
	}

	private async handleLocalVideo(context: CommandContext, video: any): Promise<void> {
		const success = await context.streamingService.addToQueue(
			context.message,
			video.path,
			video.name
		);

		if (success && !context.streamStatus.playing) {
			await context.streamingService.playFromQueue(context.message);
		}
	}

	private async handleUrl(context: CommandContext, url: string): Promise<void> {
		try {
			const success = await context.streamingService.addToQueue(
				context.message,
				url
			);

			if (success && !context.streamStatus.playing) {
				await context.streamingService.playFromQueue(context.message);
			}
		} catch (error) {
			await ErrorUtils.handleError(
				error,
				`processing URL: ${url}`,
				context.message
			);
		}
	}

	private async handleSearchQuery(context: CommandContext, query: string): Promise<void> {
		try {
			const success = await context.streamingService.addToQueue(
				context.message,
				query,
				`Search: ${query}`
			);

			if (success && !context.streamStatus.playing) {
				await context.streamingService.playFromQueue(context.message);
			}
		} catch (error) {
			await ErrorUtils.handleError(
				error,
				"adding search query to queue",
				context.message
			);
		}
	}
}
