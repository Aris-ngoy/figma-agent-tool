// The fake plugin's reaction commands, applied to its copy of the document
// fixture. The plugin tests replay the same fixture exchanges against the
// real handler.
import {
	type BridgeError,
	type CommandParams,
	type CommandResult,
	destinationError,
	matchesReaction,
	nodeActions,
	type Reaction,
} from "@figma-agent-tool/protocol";
import {
	type DocumentFixture,
	findNode,
	nodeNotFoundResponse,
} from "@figma-agent-tool/protocol/fixtures";

export function createFakeReactions(doc: DocumentFixture) {
	/** The node's reactions, or why it has none to read or write. */
	function reactionsOf(nodeId: string): Reaction[] | BridgeError {
		const node = findNode(nodeId, doc);
		if (!node) return nodeNotFoundResponse("", nodeId).error;
		if (node.type === "PAGE") {
			return {
				code: "no_reactions",
				message: `Node ${nodeId} is a PAGE, which can't have reactions. Use a frame or another layer on the canvas.`,
			};
		}
		return doc.reactions[nodeId] ?? [];
	}

	function invalidDestination(reactions: Reaction[]) {
		for (const action of nodeActions(reactions.flatMap((r) => r.actions))) {
			const id = action.destinationId;
			const node = id === null ? undefined : findNode(id, doc);
			const topLevel = doc.pages.some((page) =>
				page.children.some((child) => child.id === id),
			);
			const error = destinationError(
				action,
				node && { type: node.type, topLevel },
			);
			if (error) return error;
		}
		return undefined;
	}

	function write(nodeId: string, reactions: Reaction[]) {
		doc.reactions[nodeId] = structuredClone(reactions);
		return structuredClone(reactions);
	}

	return {
		get_reactions({
			nodeId,
		}: CommandParams<"get_reactions">):
			| CommandResult<"get_reactions">
			| BridgeError {
			const reactions = reactionsOf(nodeId);
			if (!Array.isArray(reactions)) return reactions;
			return { nodeId, reactions: structuredClone(reactions) };
		},

		set_reactions({
			nodeId,
			reactions,
			mode,
		}: CommandParams<"set_reactions">):
			| CommandResult<"set_reactions">
			| BridgeError {
			const current = reactionsOf(nodeId);
			if (!Array.isArray(current)) return current;
			const error = invalidDestination(reactions);
			if (error) return error;
			const next = mode === "append" ? [...current, ...reactions] : reactions;
			return { nodeId, reactions: write(nodeId, next) };
		},

		remove_reactions({
			nodeId,
			match,
		}: CommandParams<"remove_reactions">):
			| CommandResult<"remove_reactions">
			| BridgeError {
			const current = reactionsOf(nodeId);
			if (!Array.isArray(current)) return current;
			const kept = match
				? current.filter((reaction) => !matchesReaction(reaction, match))
				: [];
			return {
				nodeId,
				removed: current.length - kept.length,
				reactions: write(nodeId, kept),
			};
		},
	};
}
