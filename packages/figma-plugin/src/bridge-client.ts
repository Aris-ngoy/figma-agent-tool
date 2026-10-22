// The UI iframe's connection to the MCP server's bridge. Handshakes on every
// connection, reconnects with exponential backoff when the server goes away,
// and stays down when a newer plugin instance has replaced it.
import {
	CLOSE_CODE_REPLACED,
	type CommandName,
	type Handshake,
	parseServerMessage,
	type Request,
	type Response,
} from "@figma-agent-tool/protocol";

export type BridgeClientState = {
	url: string;
	status: "connecting" | "connected" | "waiting" | "replaced";
	/** Set while waiting: how long until the next connection attempt. */
	retryInMs?: number;
	lastCommand?: { command: CommandName; status: "running" | "ok" | "failed" };
};

export type Backoff = { initialMs: number; maxMs: number };

export const DEFAULT_BACKOFF: Backoff = { initialMs: 500, maxMs: 10_000 };

export function createBridgeClient({
	url,
	backoff = DEFAULT_BACKOFF,
	onRequest,
	onChange,
}: {
	url: string;
	backoff?: Backoff;
	onRequest: (request: Request) => void;
	onChange: (state: BridgeClientState) => void;
}) {
	let state: BridgeClientState = { url, status: "connecting" };
	let handshake: Handshake | undefined;
	let socket: WebSocket | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let failedAttempts = 0;
	let runningRequestId: string | undefined;

	function update(patch: Partial<BridgeClientState>) {
		state = { ...state, ...patch };
		onChange(state);
	}

	function connect() {
		clearTimeout(retryTimer);
		update({ status: "connecting", retryInMs: undefined });
		const ws = new WebSocket(state.url);
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
				failedAttempts = 0;
				update({ status: "connected" });
				return;
			}
			runningRequestId = message.id;
			update({ lastCommand: { command: message.command, status: "running" } });
			onRequest(message);
		});
		ws.addEventListener("close", (event) => {
			// A socket we've already moved on from (reconnect or close).
			if (socket !== ws) return;
			socket = undefined;
			if (event.code === CLOSE_CODE_REPLACED) {
				update({ status: "replaced", retryInMs: undefined });
				return;
			}
			const retryInMs = Math.min(
				backoff.maxMs,
				backoff.initialMs * 2 ** failedAttempts,
			);
			failedAttempts++;
			update({ status: "waiting", retryInMs });
			retryTimer = setTimeout(connect, retryInMs);
		});
	}

	function disconnect() {
		clearTimeout(retryTimer);
		const ws = socket;
		socket = undefined;
		ws?.close();
	}

	connect();

	return {
		state: () => state,

		setHandshake(next: Handshake) {
			handshake = next;
			if (socket?.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify(handshake));
			}
		},

		respond(response: Response) {
			if (response.id === runningRequestId) {
				runningRequestId = undefined;
				const command = state.lastCommand?.command;
				if (command) {
					update({
						lastCommand: { command, status: response.ok ? "ok" : "failed" },
					});
				}
			}
			socket?.send(JSON.stringify(response));
		},

		/** Connects again now, optionally to a different bridge URL. */
		reconnect(nextUrl = state.url) {
			disconnect();
			failedAttempts = 0;
			state = { ...state, url: nextUrl };
			connect();
		},

		close: disconnect,
	};
}
