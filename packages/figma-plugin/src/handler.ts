// Runs in Figma's sandbox: turns bridge requests into Plugin API calls.
import {
	type CommandName,
	type CommandParams,
	type CommandResult,
	commands,
	FRAME_TYPES,
	type Handshake,
	PROTOCOL_VERSION,
	Request,
	type Response,
} from "@figma-agent-tool/protocol";
import { serializeNode } from "./serialize";

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

const frameTypes: readonly string[] = FRAME_TYPES;

const implementations: CommandImplementations = {
	ping: () => ({ pong: true }),

	get_selection: async ({ depth }) => ({
		page: pageRef(figma.currentPage),
		nodes: await Promise.all(
			figma.currentPage.selection.map((node) => serializeNode(node, depth)),
		),
	}),

	get_node: async ({ id, depth }) => {
		const node = await figma.getNodeByIdAsync(id);
		if (!node) {
			throw new CommandError(
				"node_not_found",
				`No node with ID "${id}" exists in this file. Node IDs look like "12:34"; get them from get_selection, list_frames or a parent node's children.`,
			);
		}
		return { node: await serializeNode(node, depth) };
	},

	list_pages: () => ({
		pages: figma.root.children.map((page) => ({
			...pageRef(page),
			current: page.id === figma.currentPage.id,
		})),
	}),

	list_frames: async ({ pageId }) => {
		const page = pageId
			? await figma.getNodeByIdAsync(pageId)
			: figma.currentPage;
		if (page?.type !== "PAGE") {
			throw new CommandError(
				"page_not_found",
				`No page with ID "${pageId}" exists in this file. Get page IDs from list_pages.`,
			);
		}
		await page.loadAsync();
		return {
			page: pageRef(page),
			frames: page.children
				.filter((node) => frameTypes.includes(node.type))
				.map(({ id, name, type, x, y, width, height }) => ({
					id,
					name,
					type,
					x,
					y,
					width,
					height,
				})),
		};
	},
};

function pageRef(page: PageNode) {
	return { id: page.id, name: page.name };
}

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
				// `params` was parsed with this command's own schema above.
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
