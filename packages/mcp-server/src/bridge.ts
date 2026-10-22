// Localhost WebSocket bridge to the Figma plugin. The plugin's UI iframe
// connects as a client, handshakes, then answers correlated requests.
import {
	type BridgeError,
	type Capabilities,
	type CommandName,
	type CommandParams,
	type CommandResult,
	commands,
	type FileInfo,
	type HandshakeAck,
	parsePluginMessage,
	type Request,
} from "@figma-agent-tool/protocol";
import type { ServerWebSocket } from "bun";
import packageJson from "../package.json" with { type: "json" };

export const BRIDGE_HOSTNAME = "127.0.0.1";

export type BridgeStatus =
	| { connected: false; port: number }
	| {
			connected: true;
			port: number;
			file: FileInfo;
			pluginVersion: string;
			capabilities: Capabilities;
	  };

export type Bridge = ReturnType<typeof startBridge>;

/** Thrown when a Figma-backed command runs without a connected plugin. */
export class BridgeNotConnectedError extends Error {
	constructor(port: number) {
		super(
			"No Figma plugin is connected. Open the Figma Agent Tool plugin in " +
				"the Figma file you want to work on (Plugins → Development → Figma " +
				`Agent Tool); it connects to ws://${BRIDGE_HOSTNAME}:${port} automatically.`,
		);
		this.name = "BridgeNotConnectedError";
	}
}

/** The plugin answered a request with an error response. */
export class PluginCommandError extends Error {
	readonly code: string;
	constructor({ code, message }: BridgeError) {
		super(message);
		this.name = "PluginCommandError";
		this.code = code;
	}
}

type Session = {
	socket: ServerWebSocket<unknown>;
	file: FileInfo;
	pluginVersion: string;
	capabilities: Capabilities;
};

type Pending = {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
};

export function startBridge({ port }: { port: number }) {
	let session: Session | undefined;
	const pending = new Map<string, Pending>();

	function rejectPending(error: Error) {
		for (const { reject } of pending.values()) reject(error);
		pending.clear();
	}

	const server = Bun.serve({
		hostname: BRIDGE_HOSTNAME,
		port,
		fetch(request, server) {
			if (server.upgrade(request, { data: undefined })) return;
			return new Response("Figma Agent Tool bridge: WebSocket only", {
				status: 426,
			});
		},
		websocket: {
			message(socket, data) {
				let message: ReturnType<typeof parsePluginMessage>;
				try {
					message = parsePluginMessage(JSON.parse(String(data)));
				} catch (error) {
					console.error("[bridge] dropped invalid plugin message", error);
					return;
				}
				if (message.type === "handshake") {
					session = {
						socket,
						file: message.file,
						pluginVersion: message.pluginVersion,
						capabilities: message.capabilities,
					};
					const ack: HandshakeAck = {
						type: "handshake_ack",
						serverVersion: packageJson.version,
					};
					socket.send(JSON.stringify(ack));
					console.error(`[bridge] plugin connected: ${message.file.name}`);
					return;
				}
				const request = pending.get(message.id);
				if (!request) return;
				pending.delete(message.id);
				if (message.ok) request.resolve(message.result);
				else request.reject(new PluginCommandError(message.error));
			},
			close(socket) {
				if (session?.socket !== socket) return;
				session = undefined;
				rejectPending(new BridgeNotConnectedError(server.port ?? port));
				console.error("[bridge] plugin disconnected");
			},
		},
	});
	const boundPort = server.port ?? port;

	return {
		port: boundPort,

		status(): BridgeStatus {
			if (!session) return { connected: false, port: boundPort };
			const { file, pluginVersion, capabilities } = session;
			return {
				connected: true,
				port: boundPort,
				file,
				pluginVersion,
				capabilities,
			};
		},

		async request<C extends CommandName>(
			command: C,
			params: CommandParams<C>,
		): Promise<CommandResult<C>> {
			if (!session) throw new BridgeNotConnectedError(boundPort);
			const message: Request = {
				type: "request",
				id: crypto.randomUUID(),
				command,
				params,
			};
			const result = await new Promise<unknown>((resolve, reject) => {
				pending.set(message.id, { resolve, reject });
				session?.socket.send(JSON.stringify(message));
			});
			return commands[command].result.parse(result) as CommandResult<C>;
		},

		async stop() {
			rejectPending(new BridgeNotConnectedError(boundPort));
			await server.stop(true);
		},
	};
}
