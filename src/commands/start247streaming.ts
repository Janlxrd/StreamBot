import { BaseCommand } from "./base.js";
import { CommandContext } from "../types/index.js";
import TmdbService from "../services/tmdb.js";
import config from "../config.js";
import logger from "../utils/logger.js";
import { DiscordUtils } from "../utils/shared.js";

export default class Start247StreamingCommand extends BaseCommand {
	name = "start247streaming";
	description = "Start continuous random movie streaming from trending/top movies";
	usage = "start247streaming";

	private tmdbService: TmdbService;
	private static loopRunning = false;

	constructor() {
		super();
		this.tmdbService = new TmdbService(config.tmdbApiKey);
	}

	async execute(context: CommandContext): Promise<void> {
		if (!config.tmdbApiKey) {
			await this.sendError(context.message, "TMDB_API_KEY is missing in your environment.");
			return;
		}

		if (Start247StreamingCommand.loopRunning) {
			await DiscordUtils.sendInfo(context.message, "247 Streaming", "Already running.");
			return;
		}

		Start247StreamingCommand.loopRunning = true;
		await DiscordUtils.sendInfo(context.message, "247 Streaming", "Started continuous random movie streaming.");

		this.runLoop(context).catch(async (error) => {
			Start247StreamingCommand.loopRunning = false;
			logger.error("247 streaming loop failed:", error);
			await this.sendError(context.message, `247 streaming stopped: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	private async runLoop(context: CommandContext): Promise<void> {
		while (Start247StreamingCommand.loopRunning) {
			// If currently playing or queue has items, wait
			if (context.streamStatus.playing || !context.streamingService.getQueueService().isEmpty()) {
				await this.sleep(config.auto247IntervalMs);
				continue;
			}

			const movies = await this.tmdbService.getTrendingMovies("week");
			if (!movies.length) {
				logger.warn("TMDb returned no trending movies");
				await this.sleep(config.auto247IntervalMs);
				continue;
			}

			const movie = this.tmdbService.pickRandomMovie(movies);
			if (!movie) {
				await this.sleep(config.auto247IntervalMs);
				continue;
			}

			const query = this.tmdbService.formatMovieQuery(movie);
			logger.info(`247 streaming picked movie: ${query}`);

			const success = await context.streamingService.addToQueue(
				context.message,
				query,
				`247: ${query}`
			);

			if (success && !context.streamStatus.playing) {
				await context.streamingService.playFromQueue(context.message);
			}

			await this.sleep(config.auto247IntervalMs);
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	static stopLoop(): void {
		Start247StreamingCommand.loopRunning = false;
	}
}
