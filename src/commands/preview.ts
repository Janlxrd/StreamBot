import { BaseCommand } from "./base.js";
import { CommandContext } from "../types/index.js";
import { MessageAttachment } from "discord.js-selfbot-v13";
import path from "path";
import { ffmpegScreenshot } from "../utils/ffmpeg.js";
import logger from "../utils/logger.js";
import { DiscordUtils } from "../utils/shared.js";

export default class PreviewCommand extends BaseCommand {
	name = "preview";
	description = "Generate preview thumbnails for a video";
	usage = "preview <video_name>";

	async execute(context: CommandContext): Promise<void> {
		const vid = context.args.join(" ");

		if (!vid) {
			await this.sendError(context.message, "Please provide a video name.");
			return;
		}

		const vid_name = context.videos.find(m => m.name === vid);

		if (!vid_name) {
			await this.sendError(context.message, "Video not found");
			return;
		}

		await DiscordUtils.react(context.message, "📸");
		await DiscordUtils.reply(context.message, "📸 **Generating preview thumbnails...**");

		try {
			const videoFilename = vid_name.name + path.extname(vid_name.path);
			const thumbnails = await ffmpegScreenshot(videoFilename);

			if (thumbnails.length > 0) {
				const attachments: MessageAttachment[] = [];
				for (const screenshotPath of thumbnails) {
					attachments.push(new MessageAttachment(screenshotPath));
				}

				await DiscordUtils.reply(context.message, {
					content: `📸 **Preview**: \`${vid_name.name}\``,
					files: attachments
				});
			} else {
				await this.sendError(context.message, "Failed to generate preview thumbnails.");
			}
		} catch (error) {
			logger.error("Error generating preview thumbnails:", error);
			await this.sendError(context.message, "Failed to generate preview thumbnails.");
		}
	}
}
