// Runs in Figma's sandbox: turns bridge requests into Plugin API calls.
import {
	type CommandName,
	type CommandParams,
	type CommandResult,
	commands,
	type Handshake,
	isFrameType,
	PROTOCOL_VERSION,
	Request,
	type Response,
} from "@figma-agent-tool/protocol";
import { getDesignSystem } from "./design-system";
import { createNodes, updateNodes } from "./edit";
import {
	CommandError,
	type Deadline,
	NO_DEADLINE,
	nodeNotFound,
	pageNotFound,
	toBridgeError,
} from "./errors";
import { getFlowNodes, listFlows, setFlowStart } from "./flows";
import { getMotion, motionSupported, setMotion } from "./motion";
import { getReactions, removeReactions, setReactions } from "./reactions";
import {
	deleteNodes,
	duplicateNode,
	groupNodes,
	reparentNodes,
	ungroupNodes,
} from "./restructure";
import {
	fileLinkId,
	getImage,
	linkFile,
	pushExplorations,
	pushScreens,
	readComponents,
	readScreens,
} from "./screens";
import { serializeNode } from "./serialize";
import { readDesignSystem } from "./tokens";

type CommandImplementations = {
	[C in CommandName]: (
		params: CommandParams<C>,
		deadline: Deadline,
	) => CommandResult<C> | Promise<CommandResult<C>>;
};

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
		if (!node) throw nodeNotFound(id);
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
		if (page?.type !== "PAGE") throw pageNotFound(pageId);
		await page.loadAsync();
		return {
			page: pageRef(page),
			frames: page.children
				.filter((node) => isFrameType(node.type))
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

	async export_node_image({ nodeId, scale }) {
		const node = await figma.getNodeByIdAsync(nodeId);
		if (!node) throw nodeNotFound(nodeId);
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

	create_nodes: createNodes,
	update_nodes: updateNodes,
	delete_nodes: deleteNodes,
	duplicate_node: duplicateNode,
	reparent_nodes: reparentNodes,
	group_nodes: groupNodes,
	ungroup_nodes: ungroupNodes,
	get_reactions: getReactions,
	set_reactions: setReactions,
	remove_reactions: removeReactions,
	get_design_system: getDesignSystem,
	list_flows: listFlows,
	set_flow_start: setFlowStart,
	get_flow_nodes: getFlowNodes,
	get_motion: getMotion,
	set_motion: setMotion,
	push_screens: pushScreens,
	push_explorations: pushExplorations,
	read_screens: readScreens,
	read_components: readComponents,
	read_design_system: readDesignSystem,
	link_file: linkFile,
	get_image: getImage,
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
				capabilities: { motion: motionSupported() },
				linkId: fileLinkId(),
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
			const deadline = deadlineFor(request.data.timeoutMs);
			try {
				// `params` was parsed with this command's schema; TypeScript can't
				// correlate the two through the union, hence the cast.
				const implementation = implementations[command] as (
					params: unknown,
					deadline: Deadline,
				) => unknown;
				const result = await implementation(params.data, deadline);
				return { type: "response", id, ok: true, result };
			} catch (error) {
				const { code, message } = toBridgeError(error);
				return failure(id, code, message);
			}
		},
	};
}

/**
 * When to stop: a little before the server gives up, so an edit can't land
 * after the agent was told it timed out.
 */
function deadlineFor(timeoutMs: number | undefined): Deadline {
	if (timeoutMs === undefined) return NO_DEADLINE;
	const end = Date.now() + timeoutMs * 0.8;
	return { passed: () => Date.now() > end };
}

function requestId(message: unknown): string {
	const id = (message as { id?: unknown } | null)?.id;
	return typeof id === "string" && id.length > 0 ? id : "unknown";
}

function failure(id: string, code: string, message: string): Response {
	return { type: "response", id, ok: false, error: { code, message } };
}
