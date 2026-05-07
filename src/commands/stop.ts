import { BaseCommand } from "./base.js";
import { CommandContext } from "../types/index.js";
import logger from '../utils/logger.js';

export default class StopCommand extends BaseCommand {
 	name = "stop";
 	description = "Stop current video playback and clear queue";
 	usage = "stop";
	aliases = ["leave", "s"];

	async execute(context: CommandContext): Promise<void> {
		const queueService = context.streamingService.getQueueService();
		const hasActiveQueueWork = queueService.getLength() > 0 || queueService.getQueueStatus().isPlaying;

		if (!context.streamStatus.joined && !context.streamStatus.playing && !hasActiveQueueWork) {
			await this.sendError(context.message, '**Already Stopped!**');
			return;
		}

		try {
			context.streamStatus.manualStop = true;

			await this.sendSuccess(context.message, 'Stopped playing video and cleared queue.');
			logger.info("Stopped playing video and cleared queue.");

			// Use streaming service to handle the stop and clear queue
			await context.streamingService.stopAndClearQueue();

		} catch (error) {
			logger.error("Error during force termination:", error);
		}
	}
}
