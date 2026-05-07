import { BaseCommand } from "./base.js";
import { CommandContext } from "../types/index.js";
import { DiscordUtils } from "../utils/shared.js";

export default class PingCommand extends BaseCommand {
	name = "ping";
	description = "Check bot latency";
	usage = "ping";

	async execute(context: CommandContext): Promise<void> {
		const timeDiff = Date.now() - context.message.createdTimestamp;
		await DiscordUtils.reply(context.message, `Pong! Latency: ${timeDiff}ms`);
	}
}
