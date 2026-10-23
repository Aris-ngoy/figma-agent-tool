// Restructuring commands: delete, duplicate, reparent, group and ungroup.
// Whole-call problems (a bad parent or index) fail the call; otherwise each
// node succeeds or fails on its own. Every call is one undo step.
import {
	type BridgeError,
	type CommandParams,
	type CommandResult,
	indexError,
	layerError,
	moveError,
	type NodeOutcome,
	notAGroupError,
	parentError,
	type UngroupedNode,
} from "@figma-agent-tool/protocol";
import { CommandError, nodeNotFound, toBridgeError } from "./errors";

type Container = BaseNode & ChildrenMixin;

export async function deleteNodes({
	ids,
}: CommandParams<"delete_nodes">): Promise<CommandResult<"delete_nodes">> {
	// Look every node up first: one deleted with its ancestor still counts.
	const found = await Promise.all(ids.map((id) => figma.getNodeByIdAsync(id)));
	const nodes = ids.map((id, i): NodeOutcome => {
		try {
			const node = found[i];
			if (!node) throw nodeNotFound(id);
			if (!node.removed) {
				check(layerError(node, "delete"));
				node.remove();
			}
			return { id, ok: true };
		} catch (error) {
			return { id, ok: false, error: toBridgeError(error) };
		}
	});
	figma.commitUndo();
	return { nodes };
}

export async function duplicateNode({
	id,
	count,
	parentId,
	index,
}: CommandParams<"duplicate_node">): Promise<CommandResult<"duplicate_node">> {
	const found = await findNode(id);
	check(layerError(found, "duplicate"));
	const node = found as SceneNode;
	const parent = await container(parentId ?? (node.parent?.id as string));
	check(indexError(index, parent, parent.children.length));
	let at =
		index ??
		(parent === node.parent
			? parent.children.indexOf(node) + 1
			: parent.children.length);
	const copies: SceneNode[] = [];
	for (let i = 0; i < count; i++) {
		const copy = node.clone();
		moveTo(parent, copy, at++);
		copies.push(copy);
	}
	figma.commitUndo();
	return {
		nodes: copies.map(({ id, name, type }) => ({ id, name, type })),
	};
}

export async function reparentNodes({
	parentId,
	ids,
	index,
}: CommandParams<"reparent_nodes">): Promise<CommandResult<"reparent_nodes">> {
	const parent = await container(parentId);
	check(indexError(index, parent, parent.children.length));
	let at = index;
	const nodes: NodeOutcome[] = [];
	for (const id of ids) {
		try {
			const node = (await findNode(id)) as SceneNode;
			check(moveError(node, parent));
			moveTo(parent, node, at ?? parent.children.length);
			if (at !== undefined) at = parent.children.indexOf(node) + 1;
			nodes.push({ id, ok: true });
		} catch (error) {
			nodes.push({ id, ok: false, error: toBridgeError(error) });
		}
	}
	figma.commitUndo();
	return { nodes };
}

export async function groupNodes({
	ids,
	name,
}: CommandParams<"group_nodes">): Promise<CommandResult<"group_nodes">> {
	const nodes: SceneNode[] = [];
	for (const id of ids) {
		const node = await findNode(id);
		check(layerError(node, "group"));
		nodes.push(node as SceneNode);
	}
	for (const node of nodes) {
		const ancestor = nodes.find(
			(other) => other !== node && contains(other, node),
		);
		if (ancestor) {
			throw new CommandError(
				"cannot_group",
				`Node ${node.id} is inside ${ancestor.id}, which is grouped too. Group one or the other.`,
			);
		}
	}
	// Like Figma's own Group command, the group goes in the first node's parent.
	const group = figma.group(nodes, nodes[0]?.parent as Container);
	if (name !== undefined) group.name = name;
	figma.commitUndo();
	return { node: { id: group.id, name: group.name, type: group.type } };
}

export async function ungroupNodes({
	ids,
}: CommandParams<"ungroup_nodes">): Promise<CommandResult<"ungroup_nodes">> {
	const nodes: UngroupedNode[] = [];
	for (const id of ids) {
		try {
			const node = await findNode(id);
			if (node.type !== "GROUP") throw toCommandError(notAGroupError(node));
			check(layerError(node, "move"));
			const children = figma.ungroup(node);
			nodes.push({ id, ok: true, children: children.map((child) => child.id) });
		} catch (error) {
			nodes.push({ id, ok: false, error: toBridgeError(error) });
		}
	}
	figma.commitUndo();
	return { nodes };
}

async function findNode(id: string): Promise<BaseNode> {
	const node = await figma.getNodeByIdAsync(id);
	if (!node) throw nodeNotFound(id);
	return node;
}

/** The node by ID, if it can take new children. */
async function container(id: string): Promise<Container> {
	const node = await findNode(id);
	check(parentError(node, "appendChild" in node));
	const parent = node as Container;
	if (parent.type === "PAGE") await parent.loadAsync();
	return parent;
}

/**
 * Puts `node` at `index` among the parent's children. The Plugin API doesn't
 * say how insertChild counts when the node is already a child, so the
 * position is checked and, if Figma counted it before taking the node out,
 * corrected.
 */
function moveTo(parent: Container, node: SceneNode, index: number) {
	const last = parent.children.length - (node.parent === parent ? 1 : 0);
	const target = Math.min(index, last);
	parent.insertChild(target, node);
	const placed = parent.children.indexOf(node);
	if (placed < target) parent.insertChild(target + 1, node);
}

function contains(ancestor: BaseNode, node: BaseNode): boolean {
	for (let up = node.parent; up; up = up.parent) {
		if (up === ancestor) return true;
	}
	return false;
}

function check(error: BridgeError | undefined) {
	if (error) throw toCommandError(error);
}

function toCommandError({ code, message }: BridgeError) {
	return new CommandError(code, message);
}
