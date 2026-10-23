// Builds the prototype graph from the raw reactions the plugin returns: a
// breadth-first walk from a starting frame, one plugin request per level.
import {
	type Action,
	type BridgeError,
	type CommandResult,
	type DanglingEdge,
	destinationError,
	type FlowEdge,
	type FlowNode,
	type FlowScreen,
	flowStartError,
	type PageRef,
	type PrototypeGraph,
	SCREEN_NAVIGATIONS,
} from "@figma-agent-tool/protocol";

/** Fetches nodes with their subtree's reactions (the `get_flow_nodes` command). */
export type FetchFlowNodes = (
	nodeIds: string[],
) => Promise<CommandResult<"get_flow_nodes">>;

/**
 * Walks every screen reachable from `startId` (NAVIGATE, OVERLAY and SWAP
 * destinations), recording each interaction as an edge or, when it goes
 * nowhere, a dangling edge. Visited screens aren't walked again, so cycles
 * end. Screens `maxDepth` interactions away are listed but not walked.
 */
export async function traceFlow(
	fetchNodes: FetchFlowNodes,
	startId: string,
	maxDepth = Number.POSITIVE_INFINITY,
): Promise<PrototypeGraph | BridgeError> {
	// Fetched nodes by ID; null when the plugin reported them missing.
	const known = new Map<string, FlowNode | null>();
	async function load(ids: string[]) {
		const unknown = [...new Set(ids)].filter((id) => !known.has(id));
		if (unknown.length === 0) return;
		const { nodes, missing } = await fetchNodes(unknown);
		for (const node of nodes) known.set(node.id, node);
		for (const id of missing) known.set(id, null);
	}

	await load([startId]);
	const start = known.get(startId);
	const startError = flowStartError(startId, start ?? undefined);
	if (startError || !start?.page) return startError as BridgeError;
	const page = start.page;

	const screens: FlowScreen[] = [];
	const edges: FlowEdge[] = [];
	const dangling: DanglingEdge[] = [];
	const visited = new Set([start.id]);
	let truncated = false;
	let frontier = [start];
	for (let depth = 0; frontier.length > 0; depth++) {
		screens.push(...frontier.map((node) => screenOf(node, depth)));
		if (depth >= maxDepth) {
			truncated = frontier.some((node) => node.reactions.length > 0);
			break;
		}
		const outgoing = frontier.flatMap(interactions);
		await load(outgoing.flatMap((edge) => (edge.to ? [edge.to] : [])));
		const next: FlowNode[] = [];
		for (const edge of outgoing) {
			const problem = whyDangling(edge, known, page);
			if (problem) {
				dangling.push({ ...edge, ...problem });
				continue;
			}
			edges.push(edge);
			const destination = edge.to && known.get(edge.to);
			if (isScreenNavigation(edge.action) && destination) {
				if (visited.has(destination.id)) continue;
				visited.add(destination.id);
				next.push(destination);
			}
		}
		frontier = next;
	}
	return {
		start: start.id,
		page,
		screens,
		edges,
		dangling,
		...(truncated && { truncated: true as const }),
	};
}

function screenOf(
	{ id, name, type, width, height }: FlowNode,
	depth: number,
): FlowScreen {
	return { id, name, type, width, height, depth };
}

function isScreenNavigation(action: FlowEdge["action"]) {
	return (SCREEN_NAVIGATIONS as readonly string[]).includes(action);
}

/** The interactions a screen's layers start, in document and reaction order. */
function interactions(screen: FlowNode): FlowEdge[] {
	return screen.reactions.flatMap(({ nodeId, nodeName, reactions }) =>
		reactions.flatMap(({ trigger, actions }) =>
			flatten(actions, false).flatMap(({ action, conditional }) => {
				const edge = edgeOf(action);
				if (!edge) return [];
				return [
					{
						from: screen.id,
						nodeId,
						nodeName,
						trigger,
						...edge,
						...(conditional && { conditional: true as const }),
					},
				];
			}),
		),
	);
}

/** Actions with those inside conditional blocks marked `conditional`. */
function flatten(
	actions: Action[],
	conditional: boolean,
): { action: Action; conditional: boolean }[] {
	return actions.flatMap((action) =>
		action.type === "CONDITIONAL"
			? action.conditionalBlocks.flatMap((block) =>
					flatten(block.actions, true),
				)
			: [{ action, conditional }],
	);
}

type EdgeAction = Pick<FlowEdge, "action" | "to" | "transition"> &
	Partial<FlowEdge>;

/** The edge an action makes; media and variable actions don't make one. */
function edgeOf(action: Action): EdgeAction | undefined {
	switch (action.type) {
		case "NODE": {
			const { type: _, navigation, destinationId, ...rest } = action;
			return { action: navigation, to: destinationId, ...rest };
		}
		case "BACK":
		case "CLOSE":
			return { action: action.type, to: null, transition: null };
		case "URL": {
			const { type: _, ...rest } = action;
			return { action: "URL", to: null, transition: null, ...rest };
		}
		default:
			return undefined;
	}
}

/** Why an edge goes nowhere, or undefined when it reaches its destination. */
function whyDangling(
	edge: FlowEdge,
	known: Map<string, FlowNode | null>,
	page: PageRef,
): Pick<DanglingEdge, "reason" | "message"> | undefined {
	const { action, to } = edge;
	if (action === "BACK" || action === "CLOSE" || action === "URL") {
		return undefined;
	}
	if (to === null) {
		return {
			reason: "no_destination",
			message: `${action} on "${edge.nodeName}" (${edge.nodeId}) has no destination set.`,
		};
	}
	const destination = known.get(to);
	const error = destinationError(
		{ type: "NODE", destinationId: to, navigation: action, transition: null },
		destination ?? undefined,
	);
	if (error) {
		return {
			reason: destination ? "invalid" : "missing",
			message: error.message,
		};
	}
	const destinationPage = destination?.page;
	if (isScreenNavigation(action) && destinationPage?.id !== page.id) {
		return {
			reason: "other_page",
			message: `${action} goes to "${destination?.name}" (${to}) on page "${destinationPage?.name}", but prototypes can't cross pages. Link to a frame on page "${page.name}".`,
		};
	}
	return undefined;
}
