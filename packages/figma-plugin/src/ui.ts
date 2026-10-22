// UI iframe: owns the WebSocket to the MCP server and relays bridge messages
// between it and the sandbox.
import {
	DEFAULT_BRIDGE_PORT,
	type Handshake,
	parseServerMessage,
} from "@figma-agent-tool/protocol";
import type { SandboxToUi, UiToSandbox } from "./messages";

const BRIDGE_URL = `ws://127.0.0.1:${DEFAULT_BRIDGE_PORT}`;
const RETRY_MS = 2000;

let handshake: Handshake | undefined;
let socket: WebSocket | undefined;
let acknowledged = false;

function toSandbox(message: UiToSandbox) {
	parent.postMessage({ pluginMessage: message }, "*");
}

function render() {
	const state = document.getElementById("state");
	const file = document.getElementById("file");
	if (!state || !file) return;
	state.textContent = acknowledged ? "Connected" : "Disconnected";
	state.dataset.connected = String(acknowledged);
	file.textContent = handshake
		? acknowledged
			? `Bridging “${handshake.file.name}”`
			: `Waiting for the MCP server on ${BRIDGE_URL}`
		: "";
}

function connect() {
	const ws = new WebSocket(BRIDGE_URL);
	socket = ws;
	ws.addEventListener("open", () => {
		if (handshake) ws.send(JSON.stringify(handshake));
	});
	ws.addEventListener("message", (event) => {
		let message: ReturnType<typeof parseServerMessage>;
		try {
			message = parseServerMessage(JSON.parse(String(event.data)));
		} catch (error) {
			console.error("[figma-agent-tool] invalid server message", error);
			return;
		}
		if (message.type === "handshake_ack") {
			acknowledged = true;
			render();
		} else {
			toSandbox(message);
		}
	});
	ws.addEventListener("close", () => {
		acknowledged = false;
		render();
		setTimeout(connect, RETRY_MS);
	});
}

window.addEventListener("message", (event: MessageEvent) => {
	const message = (event.data as { pluginMessage?: SandboxToUi })
		?.pluginMessage;
	if (!message) return;
	if (message.type === "handshake") {
		handshake = message;
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify(handshake));
		}
		render();
	} else {
		socket?.send(JSON.stringify(message));
	}
});

render();
connect();
toSandbox({ type: "ui_ready" });
