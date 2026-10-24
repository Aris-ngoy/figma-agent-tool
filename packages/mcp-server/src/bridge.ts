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
	DEADLINE_COMMANDS,
	type FileInfo,
	type HandshakeAck,
	parsePluginMessage,
	type Request,
} from "@figma-agent-tool/protocol";
import type { ServerWebSocket } from "bun";
import packageJson from "../package.json" with { type: "json" };

// The plugin dials ws://localhost, which may resolve to either loopback
// (macOS tries ::1 first), so the bridge listens on both.
export const BRIDGE_HOSTNAME = "127.0.0.1";
export const BRIDGE_HOSTNAME_IPV6 = "::1";

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
			/** The Link ID stored in the Bridged File, if a Design Project linked it. */
			linkId: string | null;
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
				`Agent Tool); it connects to ws://localhost:${port} automatically.`,
		);
		this.name = "BridgeNotConnectedError";
	}
}

/** The plugin didn't answer a command within its timeout. */
export class BridgeTimeoutError extends BridgeRequestError {
	constructor(command: CommandName, timeoutMs: number) {
		super(
			`The Figma plugin did not answer \`${command}\` within ${timeoutMs} ms, ` +
				"so the command timed out. Figma slows plugins down sharply while " +
				"its window is hidden (minimized, covered, or with the screen " +
				"locked), so bring the Figma window to the front, check the plugin " +
				"is still open, then retry." +
				(DEADLINE_COMMANDS.includes(command)
					? ` \`${command}\` stops without changing the document once its ` +
						"time is up, so retrying won't duplicate anything."
					: ""),
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
	linkId: string | null;
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

	const serve = (hostname: string, port: number) =>
		Bun.serve({
			hostname,
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
							linkId: message.linkId ?? null,
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
	const server = serve(BRIDGE_HOSTNAME, port);
	const boundPort = server.port ?? port;
	let serverIpv6: typeof server | undefined;
	try {
		serverIpv6 = serve(BRIDGE_HOSTNAME_IPV6, boundPort);
	} catch (error) {
		// No IPv6 loopback on this machine: localhost resolves to 127.0.0.1.
		log(`[bridge] not listening on [${BRIDGE_HOSTNAME_IPV6}]: ${error}`);
	}

	return {
		port: boundPort,

		status(): BridgeStatus {
			if (!session) return { connected: false, port: boundPort };
			const { file, pluginVersion, capabilities, linkId } = session;
			return {
				connected: true,
				port: boundPort,
				file,
				pluginVersion,
				capabilities,
				linkId,
			};
		},

		/** Records the Link ID a link_file request stored in the Bridged File. */
		setLinkId(linkId: string) {
			if (session) session.linkId = linkId;
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
				timeoutMs: requestTimeoutMs,
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
			void serverIpv6?.stop(true);
		},
	};
}
