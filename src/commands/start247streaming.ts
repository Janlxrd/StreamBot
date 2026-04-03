import { BaseCommand } from "./base.js";
import { CommandContext } from "../types/index.js";
import TmdbService from "../services/tmdb.js";
import CinemetaService from "../services/cinemeta.js";
import StremioAddonService from "../services/stremio-addon.js";
import config from "../config.js";
import logger from "../utils/logger.js";
import { DiscordUtils } from "../utils/shared.js";

export default class Start247StreamingCommand extends BaseCommand {
	name = "start247streaming";
	description = "Start continuous random top-movie streaming through Meteor/Stremio";
	usage = "start247streaming";

	private tmdbService: TmdbService;
	private cinemetaService: CinemetaService;
	private stremioService: StremioAddonService;

	private static loopRunning = false;

	constructor() {
		super();
		this.tmdbService = new TmdbService(config.tmdbApiKey);
		this.cinemetaService = new CinemetaService();
		this.stremioService = new StremioAddonService(config.stremioAddonUrl);
	}

	async execute(context: CommandContext): Promise<void> {
		if (!config.tmdbApiKey) {
			await this.sendError(context.message, "TMDB_API_KEY is missing in your environment.");
			return;
		}

		if (!config.stremioAddonUrl) {
			await this.sendError(context.message, "stremioAddonUrl is missing in your config.");
			return;
		}

		if (Start247StreamingCommand.loopRunning) {
			await DiscordUtils.sendInfo(context.message, "247 Streaming", "Already running.");
			return;
		}

		Start247StreamingCommand.loopRunning = true;
		await DiscordUtils.sendInfo(
			context.message,
			"247 Streaming",
			"Started continuous top-movie streaming through Meteor/Stremio."
		);

		this.runLoop(context).catch(async (error) => {
			Start247StreamingCommand.loopRunning = false;
			logger.error("247 streaming loop failed:", error);
			await this.sendError(
				context.message,
				`247 streaming stopped: ${error instanceof Error ? error.message : String(error)}`
			);
		});
	}

	private async runLoop(context: CommandContext): Promise<void> {
		while (Start247StreamingCommand.loopRunning) {
			if (context.streamStatus.playing || !context.streamingService.getQueueService().isEmpty()) {
				await this.sleep(config.auto247IntervalMs);
				continue;
			}

			try {
				const candidate = await this.pickPlayableMovieCandidate();

				if (!candidate) {
					logger.warn("247 streaming found no playable Meteor/Stremio movie candidate");
					await this.sleep(config.auto247IntervalMs);
					continue;
				}

				logger.info(`247 streaming selected ${candidate.query} -> ${candidate.imdbId}`);

				const success = await context.streamingService.addToQueue(
					context.message,
					candidate.imdbId,
					`247: ${candidate.query}`
				);

				if (success && !context.streamStatus.playing) {
					await context.streamingService.playFromQueue(context.message);
				}
			} catch (error) {
				logger.error("247 streaming iteration failed:", error);
			}

			await this.sleep(config.auto247IntervalMs);
		}
	}

	private async pickPlayableMovieCandidate(): Promise<{ imdbId: string; query: string } | null> {
		// Try a few pages and several random picks before giving up
		const pages = [1, 2, 3, 4, 5];

		for (const page of pages) {
			const movies = await this.tmdbService.getTopRatedReleasedMovies(page);
			if (!movies.length) continue;

			const shuffled = [...movies].sort(() => Math.random() - 0.5);

			for (const movie of shuffled.slice(0, 10)) {
				const year = movie.release_date ? Number(movie.release_date.slice(0, 4)) : undefined;
				const imdbId = await this.cinemetaService.resolveTitleToImdbId(movie.title, "movie", year);

				if (!imdbId) {
					logger.info(`247 skip: no IMDb ID for ${movie.title}`);
					continue;
				}

				const hasPlayable = await this.hasPlayableMeteorStream(imdbId);
				if (!hasPlayable) {
					logger.info(`247 skip: no playable Meteor stream for ${movie.title} (${imdbId})`);
					continue;
				}

				return {
					imdbId,
					query: this.tmdbService.formatMovieQuery(movie)
				};
			}
		}

		return null;
	}

	private async hasPlayableMeteorStream(imdbId: string): Promise<boolean> {
		try {
			const streams = await this.stremioService.getMovieStreams(imdbId);
			if (!streams.length) return false;

			const englishStreams = this.stremioService.filterEnglishStreams(streams);
			if (!englishStreams.length) return false;

			const best = this.stremioService.pickBestPlayableHighQualityEnglishStream(englishStreams);
			if (!best) return false;

			const playable = this.stremioService.toPlayableInput(best);
			return Boolean(playable);
		} catch (error) {
			logger.warn(`Meteor preflight failed for ${imdbId}: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	static stopLoop(): void {
		Start247StreamingCommand.loopRunning = false;
	}
}
