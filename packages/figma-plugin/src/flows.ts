// Prototype flows: list and set flow starting points, and read the raw
// reactions the server builds the prototype graph from.
import {
	type CommandParams,
	type CommandResult,
	type FlowNode,
	type FlowStart,
	flowStartError,
	type PageRef,
} from "@figma-agent-tool/protocol";
import { CommandError, pageNotFound } from "./errors";
import { type ReactiveNode, readReactions } from "./reactions";

export async function listFlows({
	pageId,
}: CommandParams<"list_flows">): Promise<CommandResult<"list_flows">> {
	let pages = figma.root.children;
	if (pageId) {
		const page = await figma.getNodeByIdAsync(pageId);
		if (page?.type !== "PAGE") throw pageNotFound(pageId);
		pages = [page];
	}
	return { flows: pages.flatMap(pageFlows) };
}

export async function setFlowStart({
	nodeId,
	name,
}: CommandParams<"set_flow_start">): Promise<CommandResult<"set_flow_start">> {
	const node = await figma.getNodeByIdAsync(nodeId);
	const error = flowStartError(
		nodeId,
		node
			? { type: node.type, topLevel: node.parent?.type === "PAGE" }
			: undefined,
	);
	if (error) throw new CommandError(error.code, error.message);
	// flowStartError only lets top-level nodes through.
	const page = node?.parent as PageNode;
	const flows = page.flowStartingPoints;
	const created = !flows.some((flow) => flow.nodeId === nodeId);
	page.flowStartingPoints = created
		? [...flows, { nodeId, name }]
		: flows.map((flow) => (flow.nodeId === nodeId ? { nodeId, name } : flow));
	figma.commitUndo();
	return { flow: { nodeId, name, page: pageRef(page) }, created };
}

export async function getFlowNodes({
	nodeIds,
}: CommandParams<"get_flow_nodes">): Promise<CommandResult<"get_flow_nodes">> {
	const nodes: FlowNode[] = [];
	const missing: string[] = [];
	for (const id of nodeIds) {
		const node = await figma.getNodeByIdAsync(id);
		if (node) nodes.push(flowNode(node));
		else missing.push(id);
	}
	return { nodes, missing };
}

function pageFlows(page: PageNode): FlowStart[] {
	return page.flowStartingPoints.map(({ nodeId, name }) => ({
		nodeId,
		name,
		page: pageRef(page),
	}));
}

function flowNode(node: BaseNode): FlowNode {
	const page = pageOf(node);
	return {
		id: node.id,
		name: node.name,
		type: node.type,
		page: page && pageRef(page),
		topLevel: node.parent?.type === "PAGE",
		...("width" in node && { width: node.width, height: node.height }),
		// Pages and the document hold whole files' worth of layers; only canvas
		// nodes are walked.
		reactions: page && node.type !== "PAGE" ? subtreeReactions(node) : [],
	};
}

/** Every layer in the subtree that has reactions, in document order. */
function subtreeReactions(node: BaseNode): FlowNode["reactions"] {
	const own =
		"reactions" in node && node.reactions.length > 0
			? [
					{
						nodeId: node.id,
						nodeName: node.name,
						reactions: readReactions(node as ReactiveNode),
					},
				]
			: [];
	const children = "children" in node ? node.children : [];
	return [...own, ...children.flatMap(subtreeReactions)];
}

function pageOf(node: BaseNode): PageNode | null {
	let current: BaseNode | null = node;
	while (current && current.type !== "PAGE") current = current.parent;
	return current;
}

function pageRef(page: PageNode): PageRef {
	return { id: page.id, name: page.name };
}
