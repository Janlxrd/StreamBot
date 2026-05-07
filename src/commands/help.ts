import { BaseCommand } from "./base.js";
import { CommandContext } from "../types/index.js";
import { CommandManager } from "./manager.js";
import { DiscordUtils } from "../utils/shared.js";

export default class HelpCommand extends BaseCommand {
	name = "help";
	description = "Show available commands";
	usage = "help";

	constructor(private commandManager: CommandManager) {
		super(commandManager);
	}

	async execute(context: CommandContext): Promise<void> {
		const commandList = this.commandManager.getCommandList();

		const helpText = [
			"Available Commands",
			"",
			commandList,
		].join("\n");

		await DiscordUtils.react(context.message, "📋");
		await DiscordUtils.reply(context.message, helpText);
	}
}
