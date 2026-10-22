// UI iframe: owns the bridge connection to the MCP server and relays bridge
// messages between it and the sandbox.
import type { Handshake } from "@figma-agent-tool/protocol";
import { type BridgeClientState, createBridgeClient } from "./bridge-client";
import type { SandboxToUi, UiToSandbox } from "./messages";
import { parsePort } from "./settings";

let handshake: Handshake | undefined;
let client: ReturnType<typeof createBridgeClient> | undefined;

function toSandbox(message: UiToSandbox) {
	parent.postMessage({ pluginMessage: message }, "*");
}

function bridgeUrl(port: number): string {
	return `ws://127.0.0.1:${port}`;
}

function element<T extends HTMLElement>(id: string): T {
	const found = document.getElementById(id);
	if (!found) throw new Error(`#${id} missing from ui.html`);
	return found as T;
}

function render() {
	const state = client?.state();
	const connected = state?.status === "connected";
	const status = element("state");
	status.textContent = connected ? "Connected" : "Disconnected";
	status.dataset.connected = String(connected);
	element("file").textContent = state ? fileStatus(state) : "";
	element("command").textContent = commandStatus(state);
	element("reconnect").hidden = state?.status !== "replaced";
}

function fileStatus(state: BridgeClientState): string {
	switch (state.status) {
		case "connected":
			return handshake ? `Bridging “${handshake.file.name}”` : "";
		case "replaced":
			return "Another plugin window took over the bridge.";
		case "waiting":
			return `Waiting for the MCP server on ${state.url}, retrying in ${Math.ceil((state.retryInMs ?? 0) / 1000)}s`;
		case "connecting":
			return `Connecting to ${state.url}…`;
	}
}

function commandStatus(state: BridgeClientState | undefined): string {
	const last = state?.lastCommand;
	if (!last) return "";
	const outcome = { running: "running…", ok: "done", failed: "failed" };
	return `Last command: ${last.command} (${outcome[last.status]})`;
}

function start(port: number) {
	element<HTMLInputElement>("port").value = String(port);
	client = createBridgeClient({
		url: bridgeUrl(port),
		onRequest: toSandbox,
		onChange: render,
	});
	if (handshake) client.setHandshake(handshake);
	render();
}

window.addEventListener("message", (event: MessageEvent) => {
	const message = (event.data as { pluginMessage?: SandboxToUi })
		?.pluginMessage;
	if (!message) return;
	switch (message.type) {
		case "settings":
			if (!client) start(message.settings.port);
			return;
		case "handshake":
			handshake = message;
			client?.setHandshake(handshake);
			render();
			return;
		default:
			client?.respond(message);
	}
});

element("settings").addEventListener("submit", (event) => {
	event.preventDefault();
	const input = element<HTMLInputElement>("port");
	const port = parsePort(input.value);
	input.setCustomValidity(port ? "" : "Enter a port between 1 and 65535");
	if (!port || !client) return;
	toSandbox({ type: "save_settings", settings: { port } });
	client.reconnect(bridgeUrl(port));
});

element("reconnect").addEventListener("click", () => client?.reconnect());

toSandbox({ type: "ui_ready" });
