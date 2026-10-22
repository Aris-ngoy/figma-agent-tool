// Sandbox entry point. Only the UI iframe has network access, so the sandbox
// executes commands and relays everything else through postMessage.
import packageJson from "../package.json" with { type: "json" };
import { createCommandHandler } from "./handler";
import type { SandboxToUi, UiToSandbox } from "./messages";
import { loadSettings, saveSettings } from "./settings";

const handler = createCommandHandler({ pluginVersion: packageJson.version });

function post(message: SandboxToUi) {
	figma.ui.postMessage(message);
}

figma.showUI(__html__, { width: 280, height: 168, themeColors: true });

figma.ui.onmessage = async (message: UiToSandbox) => {
	switch (message.type) {
		case "ui_ready":
			post({ type: "settings", settings: await loadSettings() });
			post(handler.handshake());
			return;
		case "save_settings":
			await saveSettings(message.settings);
			return;
		default:
			post(await handler.handle(message));
	}
};
