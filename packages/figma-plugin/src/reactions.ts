// Prototype reactions: read, write and remove them on one node. Destinations
// are checked before anything is written, and every write is one undo step.
import {
	type CommandParams,
	type CommandResult,
	destinationError,
	matchesReaction,
	nodeActions,
	type Reaction,
} from "@figma-agent-tool/protocol";
import { CommandError, nodeNotFound } from "./errors";

export type ReactiveNode = BaseNode & ReactionMixin;

export async function getReactions({
	nodeId,
}: CommandParams<"get_reactions">): Promise<CommandResult<"get_reactions">> {
	const node = await reactiveNode(nodeId);
	return { nodeId, reactions: readReactions(node) };
}

export async function setReactions({
	nodeId,
	reactions,
	mode,
}: CommandParams<"set_reactions">): Promise<CommandResult<"set_reactions">> {
	const node = await reactiveNode(nodeId);
	await checkDestinations(reactions);
	const next =
		mode === "append" ? [...readReactions(node), ...reactions] : reactions;
	return { nodeId, reactions: await writeReactions(node, next) };
}

export async function removeReactions({
	nodeId,
	match,
}: CommandParams<"remove_reactions">): Promise<
	CommandResult<"remove_reactions">
> {
	const node = await reactiveNode(nodeId);
	const current = readReactions(node);
	const kept = match
		? current.filter((reaction) => !matchesReaction(reaction, match))
		: [];
	return {
		nodeId,
		removed: current.length - kept.length,
		reactions: await writeReactions(node, kept),
	};
}

async function reactiveNode(id: string): Promise<ReactiveNode> {
	const node = await figma.getNodeByIdAsync(id);
	if (!node) throw nodeNotFound(id);
	if (!("reactions" in node)) {
		throw new CommandError(
			"no_reactions",
			`Node ${id} is a ${node.type}, which can't have reactions. Use a frame or another layer on the canvas.`,
		);
	}
	return node;
}

/** The node's reactions, without the deprecated single `action`. */
export function readReactions(node: ReactiveNode): Reaction[] {
	return node.reactions.map(({ trigger, actions, action }) => ({
		trigger,
		actions: actions ?? (action ? [action] : []),
	})) as Reaction[];
}

async function writeReactions(node: ReactiveNode, reactions: Reaction[]) {
	// Our schema mirrors the Plugin API's; it only types `readonly` looser.
	await node.setReactionsAsync(reactions as unknown as globalThis.Reaction[]);
	figma.commitUndo();
	return readReactions(node);
}

async function checkDestinations(reactions: Reaction[]) {
	for (const action of nodeActions(reactions.flatMap((r) => r.actions))) {
		const id = action.destinationId;
		const node = id === null ? null : await figma.getNodeByIdAsync(id);
		const error = destinationError(
			action,
			node
				? { type: node.type, topLevel: node.parent?.type === "PAGE" }
				: undefined,
		);
		if (error) throw new CommandError(error.code, error.message);
	}
}
