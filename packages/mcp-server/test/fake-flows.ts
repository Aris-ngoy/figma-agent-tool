// The fake plugin's flow commands, applied to its copy of the document
// fixture. The plugin tests replay the same fixture exchanges against the
// real handler.
import {
	type BridgeError,
	type CommandParams,
	type CommandResult,
	type FlowNode,
	flowStartError,
	type SerializedNode,
	type SyncedNode,
} from "@figma-agent-tool/protocol";
import {
	type DocumentFixture,
	findNode,
	pageNotFoundResponse,
} from "@figma-agent-tool/protocol/fixtures";

type Page = DocumentFixture["pages"][number];

/** Frames Push made (see fake-screens), by ID, with the page they're on. */
type PushedFrames = Map<string, { pageId: string; frame: SyncedNode }>;

export function createFakeFlows(
	doc: DocumentFixture,
	pushed: PushedFrames = new Map(),
) {
	const pageRef = (page: Page) => ({ id: page.id, name: page.name });

	const pageFlows = (page: Page) =>
		page.flows.map(({ nodeId, name }) => ({
			nodeId,
			name,
			page: pageRef(page),
		}));

	function contains(node: SerializedNode, id: string): boolean {
		return node.id === id || (node.children ?? []).some((c) => contains(c, id));
	}

	/** The page a node is on (a page is on itself). */
	const pageOf = (id: string) =>
		doc.pages.find(
			(page) => page.id === id || page.children.some((c) => contains(c, id)),
		);

	function subtreeReactions(node: SerializedNode): FlowNode["reactions"] {
		const reactions = doc.reactions[node.id] ?? [];
		const own =
			reactions.length > 0
				? [
						{
							nodeId: node.id,
							nodeName: node.name,
							reactions: structuredClone(reactions),
						},
					]
				: [];
		return [...own, ...(node.children ?? []).flatMap(subtreeReactions)];
	}

	function pushedReactions(node: SyncedNode): FlowNode["reactions"] {
		const own = node.reactions?.length
			? [
					{
						nodeId: node.id,
						nodeName: node.name,
						reactions: structuredClone(node.reactions),
					},
				]
			: [];
		return [...own, ...(node.children ?? []).flatMap(pushedReactions)];
	}

	/** A layer of a pushed frame, as get_flow_nodes reports it. */
	function pushedFlowNode(id: string): FlowNode | undefined {
		const find = (node: SyncedNode): SyncedNode | undefined =>
			node.id === id ? node : (node.children ?? []).map(find).find(Boolean);
		for (const { pageId, frame } of pushed.values()) {
			const node = find(frame);
			const page = doc.pages.find((p) => p.id === pageId);
			if (!node || !page) continue;
			return {
				id,
				name: node.name,
				type: node.type,
				page: pageRef(page),
				topLevel: node === frame,
				width: node.width,
				height: node.height,
				reactions: pushedReactions(node),
			};
		}
		return undefined;
	}

	return {
		list_flows({
			pageId,
		}: CommandParams<"list_flows">): CommandResult<"list_flows"> | BridgeError {
			if (!pageId) return { flows: doc.pages.flatMap(pageFlows) };
			const page = doc.pages.find((p) => p.id === pageId);
			if (!page) return pageNotFoundResponse("", pageId).error;
			return { flows: pageFlows(page) };
		},

		set_flow_start({
			nodeId,
			name,
		}: CommandParams<"set_flow_start">):
			| CommandResult<"set_flow_start">
			| BridgeError {
			const node = findNode(nodeId, doc);
			const page = doc.pages.find((p) =>
				p.children.some((child) => child.id === nodeId),
			);
			const error = flowStartError(
				nodeId,
				node && { type: node.type, topLevel: page !== undefined },
			);
			if (error || !page) return error as BridgeError;
			const existing = page.flows.find((flow) => flow.nodeId === nodeId);
			if (existing) existing.name = name;
			else page.flows.push({ nodeId, name });
			return {
				flow: { nodeId, name, page: pageRef(page) },
				created: !existing,
			};
		},

		get_flow_nodes({
			nodeIds,
		}: CommandParams<"get_flow_nodes">): CommandResult<"get_flow_nodes"> {
			const nodes: FlowNode[] = [];
			const missing: string[] = [];
			for (const id of nodeIds) {
				const node = findNode(id, doc);
				const page = pageOf(id);
				if (!node || !page) {
					const layer = pushedFlowNode(id);
					if (layer) nodes.push(layer);
					else missing.push(id);
					continue;
				}
				nodes.push({
					id,
					name: node.name,
					type: node.type,
					page: pageRef(page),
					topLevel: page.children.some((child) => child.id === id),
					...(node.width !== undefined && {
						width: node.width,
						height: node.height,
					}),
					reactions: node.type === "PAGE" ? [] : subtreeReactions(node),
				});
			}
			return { nodes, missing };
		},
	};
}
