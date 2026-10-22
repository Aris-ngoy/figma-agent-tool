// Runs in Figma's sandbox: turns bridge requests into Plugin API calls.
import {
	type CommandName,
	type CommandParams,
	type CommandResult,
	commands,
	type Handshake,
	PROTOCOL_VERSION,
	Request,
	type Response,
} from "@figma-agent-tool/protocol";

type CommandImplementations = {
	[C in CommandName]: (
		params: CommandParams<C>,
	) => CommandResult<C> | Promise<CommandResult<C>>;
};

/** A command failure with a machine-readable code for the server. */
class CommandError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

const implementations: CommandImplementations = {
	ping: () => ({ pong: true }),

	async export_node_image({ nodeId, scale }) {
		const node = await figma.getNodeByIdAsync(nodeId);
		if (!node) {
			throw new CommandError(
				"node_not_found",
				`No node with ID ${nodeId} exists in this file.`,
			);
		}
		if (!("exportAsync" in node)) {
			throw new CommandError(
				"not_exportable",
				`Node ${nodeId} is a ${node.type} and cannot be exported. Export a ` +
					"frame, component or other layer on the canvas instead.",
			);
		}
		const bytes = await node.exportAsync({
			format: "PNG",
			constraint: { type: "SCALE", value: scale },
		});
		return { png: figma.base64Encode(bytes) };
	},
};

export function createCommandHandler({
	pluginVersion,
}: {
	pluginVersion: string;
}) {
	return {
		handshake(): Handshake {
			return {
				type: "handshake",
				protocolVersion: PROTOCOL_VERSION,
				pluginVersion,
				file: { key: figma.fileKey ?? null, name: figma.root.name },
				// Motion detection lands with the capability-gated Motion tools.
				capabilities: { motion: false },
			};
		},

		async handle(message: unknown): Promise<Response> {
			const id = requestId(message);
			const request = Request.safeParse(message);
			if (!request.success) {
				return failure(id, "invalid_request", request.error.message);
			}
			const { command } = request.data;
			const params = commands[command].params.safeParse(request.data.params);
			if (!params.success) {
				return failure(id, "invalid_params", params.error.message);
			}
			try {
				// `params` was parsed with this command's schema; TypeScript can't
				// correlate the two through the union, hence the cast.
				const implementation = implementations[command] as (
					params: unknown,
				) => unknown;
				const result = await implementation(params.data);
				return { type: "response", id, ok: true, result };
			} catch (error) {
				return failure(
					id,
					error instanceof CommandError ? error.code : "command_failed",
					error instanceof Error ? error.message : String(error),
				);
			}
		},
	};
}

function requestId(message: unknown): string {
	const id = (message as { id?: unknown } | null)?.id;
	return typeof id === "string" && id.length > 0 ? id : "unknown";
}

function failure(id: string, code: string, message: string): Response {
	return { type: "response", id, ok: false, error: { code, message } };
}
