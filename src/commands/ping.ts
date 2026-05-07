import { BaseCommand } from "./base.js";
import { CommandContext } from "../types/index.js";
import { DiscordUtils } from "../utils/shared.js";
import logger from "../utils/logger.js";

export default class PingCommand extends BaseCommand {
	name = "ping";
	description = "Check bot latency";
	usage = "ping";

	async execute(context: CommandContext): Promise<void> {
		try {
			const sent = await context.message.reply("Pinging...");
			const timeDiff = sent.createdTimestamp - context.message.createdTimestamp;
			await sent.edit(`Pong! Latency: ${timeDiff}ms`);
		} catch (error) {
			logger.warn(`Ping reply/edit failed: ${error instanceof Error ? error.message : String(error)}`);
			await DiscordUtils.reply(context.message, "Pong!");
		}
	}
}
