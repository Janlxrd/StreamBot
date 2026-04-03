import { BaseCommand } from "./base.js";
import { CommandContext } from "../types/index.js";
import Start247StreamingCommand from "./start247streaming.js";
import { DiscordUtils } from "../utils/shared.js";

export default class Stop247StreamingCommand extends BaseCommand {
	name = "stop247streaming";
	description = "Stop continuous random movie streaming";
	usage = "stop247streaming";

	async execute(context: CommandContext): Promise<void> {
		Start247StreamingCommand.stopLoop();
		await DiscordUtils.sendInfo(context.message, "247 Streaming", "Stopped.");
	}
}
