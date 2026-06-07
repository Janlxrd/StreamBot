import { Message } from "discord.js-selfbot-v13";
import { CommandManager } from "../commands/manager.js";
import { CommandContext, Video, StreamStatus } from "../types/index.js";
import config from "../config.js";
import { DiscordUtils } from "../utils/shared.js";
import logger from "../utils/logger.js";

export async function handleMessageCreate(
	message: Message,
	videos: Video[],
	streamStatus: StreamStatus,
	streamingService: any,
	commandManager: CommandManager
): Promise<void> {
	if (
		message.author.bot ||
		message.author.id === message.client.user?.id ||
		!message.content.startsWith(config.prefix) || 
		message.channelId !== config.cmdChannelId ||
		(config.adminOnly && !config.adminIds.includes(message.author.id))
	) return;

	const args = message.content.slice(config.prefix!.length).trim().split(/ +/);

	if (args.length === 0) {
		return;
	}

	const commandName = args.shift()!.toLowerCase();
	logger.info(`Command received: ${commandName} from ${message.author.id}`);

	const context: CommandContext = {
		message,
		args,
		videos,
		streamStatus,
		streamingService
	};

	const executed = await commandManager.executeCommand(commandName, context);

	if (!executed) {
		await DiscordUtils.sendError(message, `Unknown command. Use \`${config.prefix}help\` to see available commands.`);
	}
}
