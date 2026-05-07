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

async function runDiscordOperation(label: string, operation: () => Promise<unknown>): Promise<void> {
	const timeoutMs = Number(config.discordSendTimeoutMs) > 0 ? Number(config.discordSendTimeoutMs) : 1500;

	const guardedOperation = operation()
		.catch(error => {
			logger.warn(`${label} failed: ${formatDiscordSendError(error)}`);
		});

	const timeout = new Promise<"timeout">(resolve => {
		setTimeout(() => resolve("timeout"), timeoutMs);
	});

	const result = await Promise.race([guardedOperation, timeout]);
	if (result === "timeout") {
		logger.warn(`${label} timed out after ${timeoutMs}ms`);
	}
}

async function safeReact(message: Message, emoji: string): Promise<void> {
	if (!config.discordReactionsEnabled) {
		return;
	}

	await runDiscordOperation(
		`Discord reaction (${emoji})`,
		() => message.react(emoji)
	);
}

async function safeReply(message: Message, content: any): Promise<void> {
	await runDiscordOperation(
		"Discord reply",
		() => message.reply(content)
	);
}

async function safeChannelSend(message: Message, content: string): Promise<void> {
	await runDiscordOperation(
		"Discord channel send",
		() => message.channel.send(content)
	);
}

export const DiscordUtils = {
	async react(message: Message, emoji: string): Promise<void> {
		void safeReact(message, emoji);
	},

	async reply(message: Message, content: any): Promise<void> {
		await safeReply(message, content);
	},

	status_idle(): ActivityOptions {
		return {
			name: config.prefix + "help",
			type: "WATCHING"
		};
	},

	status_watch(name: string): ActivityOptions {
		return {
			name: `${name}`,
			type: "WATCHING"
		};
	},

	async sendError(message: Message, error: string): Promise<void> {
		void safeReact(message, "x");
		await safeReply(message, `Error: ${error}`);
	},

	async sendSuccess(message: Message, description: string): Promise<void> {
		void safeReact(message, "white_check_mark");
		await safeChannelSend(message, `Success: ${description}`);
	},

	async sendInfo(message: Message, title: string, description: string): Promise<void> {
		void safeReact(message, "information_source");
		await safeChannelSend(message, `${title}: ${description}`);
	},

	async sendPlaying(message: Message, title: string): Promise<void> {
		void safeReact(message, "arrow_forward");
		await safeReply(message, `Now Playing: \`${title}\``);
	},

	async sendFinishMessage(message: Message): Promise<void> {
		await safeChannelSend(message, "Finished: Finished playing video.");
	},

	async sendList(message: Message, items: string[], type?: string): Promise<void> {
		void safeReact(message, "clipboard");
		if (type == "ytsearch") {
			await safeReply(message, `Search Results:\n${items.join("\n")}`);
		} else if (type == "refresh") {
			await safeReply(message, `Video list refreshed:\n${items.join("\n")}`);
		} else {
			await safeChannelSend(message, `Local Videos List:\n${items.join("\n")}`);
		}
	}
};

export const ErrorUtils = {
	async handleError(error: any, context: string, message?: Message): Promise<void> {
		logger.error(`Error in ${context}:`, error);

		if (message) {
			await DiscordUtils.sendError(message, `An error occurred: ${error.message || "Unknown error"}`);
		}
	},

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

export const GeneralUtils = {
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

	isLocalFile(filePath: string): boolean {
		try {
			return fs.existsSync(filePath) && fs.lstatSync(filePath).isFile();
		} catch (error) {
			return false;
		}
	}
};
