// Sandbox entry point. Only the UI iframe has network access, so the sandbox
// executes commands and relays everything else through postMessage.
import packageJson from "../package.json" with { type: "json" };
import { createCommandHandler } from "./handler";
import type { SandboxToUi, UiToSandbox } from "./messages";

const handler = createCommandHandler({ pluginVersion: packageJson.version });

function post(message: SandboxToUi) {
	figma.ui.postMessage(message);
}

figma.showUI(__html__, { width: 280, height: 112, themeColors: true });

figma.ui.onmessage = async (message: UiToSandbox) => {
	if (message.type === "ui_ready") post(handler.handshake());
	else post(await handler.handle(message));
};
