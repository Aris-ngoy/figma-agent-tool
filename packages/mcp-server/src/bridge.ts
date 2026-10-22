// Localhost WebSocket bridge to the Figma plugin. The plugin's UI iframe
// connects as a client, handshakes, then answers correlated requests.
import {
	type BridgeError,
	type Capabilities,
	CLOSE_CODE_REPLACED,
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

/** How long a command may run before the agent gets a timeout error. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

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

/** Base class for bridge failures the agent should see as tool errors. */
export class BridgeRequestError extends Error {}

/** Thrown when a Figma-backed command runs without a connected plugin. */
export class BridgeNotConnectedError extends BridgeRequestError {
	constructor(port: number) {
		super(
			"No Figma plugin is connected. Open the Figma Agent Tool plugin in " +
				"the Figma file you want to work on (Plugins → Development → Figma " +
				`Agent Tool); it connects to ws://${BRIDGE_HOSTNAME}:${port} automatically.`,
		);
		this.name = "BridgeNotConnectedError";
	}
}

/** The plugin didn't answer a command within its timeout. */
export class BridgeTimeoutError extends BridgeRequestError {
	constructor(command: CommandName, timeoutMs: number) {
		super(
			`The Figma plugin did not answer \`${command}\` within ${timeoutMs} ms, ` +
				"so the command timed out. Check that the plugin is still open and " +
				"Figma isn't busy, then retry.",
		);
		this.name = "BridgeTimeoutError";
	}
}

/** The plugin connection went away while a command was in flight. */
export class BridgeConnectionLostError extends BridgeRequestError {
	constructor(command: CommandName, reason: string) {
		super(
			`The Figma plugin connection ${reason} while \`${command}\` was ` +
				"running, so its result is unknown. Check the document, then retry.",
		);
		this.name = "BridgeConnectionLostError";
	}
}

/** The plugin answered a request with an error response. */
export class PluginCommandError extends BridgeRequestError {
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
	command: CommandName;
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
};

export function startBridge({
	port,
	requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
	log = console.error,
}: {
	port: number;
	requestTimeoutMs?: number;
	/** Diagnostics sink; stdout belongs to MCP, so this defaults to stderr. */
	log?: (message: string) => void;
}) {
	let session: Session | undefined;
	const pending = new Map<string, Pending>();

	/** Fails every in-flight command because the plugin connection `reason`. */
	function rejectPending(reason: string) {
		for (const { command, reject } of pending.values()) {
			reject(new BridgeConnectionLostError(command, reason));
		}
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
					log(`[bridge] dropped invalid plugin message: ${error}`);
					return;
				}
				if (message.type === "handshake") {
					const replaced = session?.socket !== socket ? session : undefined;
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
					if (replaced) {
						// One bridged file at a time: the newest plugin instance wins.
						log(
							`[bridge] warning: a newer plugin connection (“${message.file.name}”) ` +
								`replaced the one for “${replaced.file.name}”`,
						);
						rejectPending("was replaced by a newer one");
						replaced.socket.close(
							CLOSE_CODE_REPLACED,
							"Replaced by a newer plugin connection",
						);
					}
					log(`[bridge] plugin connected: ${message.file.name}`);
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
				rejectPending("closed");
				log("[bridge] plugin disconnected");
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
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const result = await new Promise<unknown>((resolve, reject) => {
				pending.set(message.id, { command, resolve, reject });
				timeout = setTimeout(() => {
					pending.delete(message.id);
					reject(new BridgeTimeoutError(command, requestTimeoutMs));
				}, requestTimeoutMs);
				session?.socket.send(JSON.stringify(message));
			}).finally(() => clearTimeout(timeout));
			return commands[command].result.parse(result) as CommandResult<C>;
		},

		stop() {
			rejectPending("closed");
			// Not awaited: in Bun 1.2 the returned promise never settles once the
			// server has closed a socket itself (connection replacement), although
			// the server does stop.
			void server.stop(true);
		},
	};
}
