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

const implementations: CommandImplementations = {
	ping: () => ({ pong: true }),
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
				const result = await implementations[command](params.data);
				return { type: "response", id, ok: true, result };
			} catch (error) {
				return failure(
					id,
					"command_failed",
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
