import { Message, ActivityOptions } from "discord.js-selfbot-v13";
import config from "../config.js";
import logger from "./logger.js";
import fs from "fs";

function formatDiscordSendError(error: any): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

async function safeReact(message: Message, emoji: string): Promise<void> {
	try {
		await message.react(emoji);
	} catch (error) {
		logger.warn(`Discord reaction failed (${emoji}): ${formatDiscordSendError(error)}`);
	}
}

async function safeReply(message: Message, content: any): Promise<void> {
	try {
		await message.reply(content);
	} catch (error) {
		logger.warn(`Discord reply failed: ${formatDiscordSendError(error)}`);
	}
}

async function safeChannelSend(message: Message, content: string): Promise<void> {
	try {
		await message.channel.send(content);
	} catch (error) {
		logger.warn(`Discord channel send failed: ${formatDiscordSendError(error)}`);
	}
}

/**
 * Shared utility functions for Discord bot operations
 */
export const DiscordUtils = {
	async react(message: Message, emoji: string): Promise<void> {
		await safeReact(message, emoji);
	},

	async reply(message: Message, content: any): Promise<void> {
		await safeReply(message, content);
	},

	/**
	 * Create idle status for Discord bot
	 */
	status_idle(): ActivityOptions {
		return {
			name: config.prefix + "help",
			type: "WATCHING"
		};
	},

	/**
	 * Create watching status for Discord bot
	 */
	status_watch(name: string): ActivityOptions {
		return {
			name: `${name}`,
			type: "WATCHING"
		};
	},

	/**
	 * Send error message with reaction
	 */
	async sendError(message: Message, error: string): Promise<void> {
		await safeReact(message, "❌");
		await safeReply(message, `❌ **Error**: ${error}`);
	},

	/**
	 * Send success message with reaction
	 */
	async sendSuccess(message: Message, description: string): Promise<void> {
		await safeReact(message, "✅");
		await safeChannelSend(message, `✅ **Success**: ${description}`);
	},

	/**
	 * Send info message with reaction
	 */
	async sendInfo(message: Message, title: string, description: string): Promise<void> {
		await safeReact(message, "ℹ️");
		await safeChannelSend(message, `ℹ️ **${title}**: ${description}`);
	},

	/**
	 * Send playing message with reaction
	 */
	async sendPlaying(message: Message, title: string): Promise<void> {
		const content = `📽 **Now Playing**: \`${title}\``;
		await safeReact(message, "▶️");
		await safeReply(message, content);
	},

	/**
	 * Send finish message
	 */
	async sendFinishMessage(message: Message): Promise<void> {
		const content = "⏹️ **Finished**: Finished playing video.";
		await safeChannelSend(message, content);
	},

	/**
	 * Send list message with reaction
	 */
	async sendList(message: Message, items: string[], type?: string): Promise<void> {
		await safeReact(message, "📋");
		if (type == "ytsearch") {
			await safeReply(message, `📋 **Search Results**:\n${items.join("\n")}`);
		} else if (type == "refresh") {
			await safeReply(message, `📋 **Video list refreshed**:\n${items.join("\n")}`);
		} else {
			await safeChannelSend(message, `📋 **Local Videos List**:\n${items.join("\n")}`);
		}
	}
};

/**
 * Error handling utilities
 */
export const ErrorUtils = {
	/**
	 * Handle and log errors consistently
	 */
	async handleError(error: any, context: string, message?: Message): Promise<void> {
		logger.error(`Error in ${context}:`, error);

		if (message) {
			await DiscordUtils.sendError(message, `An error occurred: ${error.message || "Unknown error"}`);
		}
	},

	/**
	 * Handle async operation errors
	 */
	async withErrorHandling<T>(
		operation: () => Promise<T>,
		context: string,
		message?: Message
	): Promise<T | null> {
		try {
			return await operation();
		} catch (error) {
			await this.handleError(error, context, message);
			return null;
		}
	}
};

/**
 * General utility functions
 */
export const GeneralUtils = {
	/**
	 * Check if input is a valid streaming URL
	 */
	isValidUrl(input: string): boolean {
		if (!input || typeof input !== "string") {
			return false;
		}

		return input.includes("youtube.com/") ||
			   input.includes("youtu.be/") ||
			   input.includes("twitch.tv/") ||
			   input.startsWith("http://") ||
			   input.startsWith("https://");
	},

	/**
	 * Check if a path is a local file
	 */
	isLocalFile(filePath: string): boolean {
		try {
			return fs.existsSync(filePath) && fs.lstatSync(filePath).isFile();
		} catch (error) {
			return false;
		}
	}
};
