// The fake plugin's restructuring commands, applied to its copy of the
// document fixture in serialized form. The plugin tests replay the same
// fixture exchanges against the real handler.
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
	type SerializedNode,
	type TreeNode,
	type UngroupedNode,
} from "@figma-agent-tool/protocol";
import {
	type DocumentFixture,
	nodeNotFoundResponse,
	renumber,
} from "@figma-agent-tool/protocol/fixtures";

/** A node with its place in the tree. */
type Entry = { node: SerializedNode; view: TreeNode; parent?: Entry };

class Failure extends Error {
	constructor(readonly error: BridgeError) {
		super(error.message);
	}
}

function check(error: BridgeError | undefined) {
	if (error) throw new Failure(error);
}

/** Runs one node's part of a command; a failure is that node's result. */
function outcome<T>(
	id: string,
	run: () => T,
): T | { id: string; ok: false; error: BridgeError } {
	try {
		return run();
	} catch (error) {
		if (!(error instanceof Failure)) throw error;
		return { id, ok: false, error: error.error };
	}
}

export function createFakeRestructure(
	doc: DocumentFixture,
	nextId: () => string,
) {
	function locate(id: string): Entry | undefined {
		const root: Entry = {
			node: {
				id: "0:0",
				name: doc.name,
				type: "DOCUMENT",
				children: doc.pages as unknown as SerializedNode[],
			},
			view: { id: "0:0", type: "DOCUMENT", parent: null },
		};
		const walk = (entry: Entry): Entry | undefined => {
			if (entry.node.id === id) return entry;
			for (const child of entry.node.children ?? []) {
				const type = child.type ?? "PAGE";
				const found = walk({
					node: child,
					view: { id: child.id, type, parent: entry.view },
					parent: entry,
				});
				if (found) return found;
			}
			return undefined;
		};
		return walk(root);
	}

	function find(id: string): Entry {
		const entry = locate(id);
		if (!entry) throw new Failure(nodeNotFoundResponse("", id).error);
		return entry;
	}

	function container(id: string): Entry {
		const entry = find(id);
		check(parentError(entry.view, entry.node.children !== undefined));
		return entry;
	}

	const childrenOf = (entry: Entry) => entry.node.children as SerializedNode[];

	function detach(entry: Entry) {
		const siblings = childrenOf(entry.parent as Entry);
		siblings.splice(siblings.indexOf(entry.node), 1);
	}

	/** Like the plugin's moveTo: the index counts once the node is out. */
	function moveTo(parent: Entry, entry: Entry, index: number) {
		detach(entry);
		const children = childrenOf(parent);
		children.splice(Math.min(index, children.length), 0, entry.node);
		return children.indexOf(entry.node);
	}

	function contains(ancestor: Entry, entry: Entry) {
		for (let up = entry.parent; up; up = up.parent) {
			if (up.node === ancestor.node) return true;
		}
		return false;
	}

	return {
		delete_nodes({
			ids,
		}: CommandParams<"delete_nodes">): CommandResult<"delete_nodes"> {
			const entries = ids.map((id) => locate(id));
			const removed = new Set<SerializedNode>();
			// Deleted already, or along with an ancestor.
			const isRemoved = (entry: Entry) => {
				for (let up: Entry | undefined = entry; up; up = up.parent) {
					if (removed.has(up.node)) return true;
				}
				return false;
			};
			const nodes = ids.map((id, i) =>
				outcome(id, (): NodeOutcome => {
					const entry = entries[i];
					if (!entry) throw new Failure(nodeNotFoundResponse("", id).error);
					if (!isRemoved(entry)) {
						check(layerError(entry.view, "delete"));
						detach(entry);
						removed.add(entry.node);
					}
					return { id, ok: true };
				}),
			);
			return { nodes };
		},

		duplicate_node({
			id,
			count,
			parentId,
			index,
		}: CommandParams<"duplicate_node">):
			| CommandResult<"duplicate_node">
			| BridgeError {
			try {
				const entry = find(id);
				check(layerError(entry.view, "duplicate"));
				const parent = container(parentId ?? (entry.parent as Entry).node.id);
				const children = childrenOf(parent);
				check(indexError(index, parent.view, children.length));
				let at =
					index ??
					(parent.node === entry.parent?.node
						? children.indexOf(entry.node) + 1
						: children.length);
				const copies = [];
				for (let i = 0; i < count; i++) {
					const copy = renumber(entry.node, nextId);
					children.splice(at++, 0, copy);
					copies.push({ id: copy.id, name: copy.name, type: copy.type });
				}
				return { nodes: copies };
			} catch (error) {
				if (!(error instanceof Failure)) throw error;
				return error.error;
			}
		},

		reparent_nodes({
			parentId,
			ids,
			index,
		}: CommandParams<"reparent_nodes">):
			| CommandResult<"reparent_nodes">
			| BridgeError {
			try {
				const parent = container(parentId);
				check(indexError(index, parent.view, childrenOf(parent).length));
				let at = index;
				const nodes = ids.map((id) =>
					outcome(id, (): NodeOutcome => {
						const entry = find(id);
						check(moveError(entry.view, parent.view));
						const placed = moveTo(
							parent,
							entry,
							at ?? childrenOf(parent).length,
						);
						if (at !== undefined) at = placed + 1;
						return { id, ok: true };
					}),
				);
				return { nodes };
			} catch (error) {
				if (!(error instanceof Failure)) throw error;
				return error.error;
			}
		},

		group_nodes({
			ids,
			name,
		}: CommandParams<"group_nodes">):
			| CommandResult<"group_nodes">
			| BridgeError {
			try {
				const entries = ids.map((id) => {
					const entry = find(id);
					check(layerError(entry.view, "group"));
					return entry;
				});
				for (const entry of entries) {
					const ancestor = entries.find(
						(other) => other !== entry && contains(other, entry),
					);
					if (ancestor) {
						throw new Failure({
							code: "cannot_group",
							message: `Node ${entry.node.id} is inside ${ancestor.node.id}, which is grouped too. Group one or the other.`,
						});
					}
				}
				const parent = (entries[0] as Entry).parent as Entry;
				const siblings = childrenOf(parent);
				// As in the mocked figma.group: layer order kept, the group where
				// the topmost node was.
				const inParent = entries.filter((e) => e.parent?.node === parent.node);
				const ordered =
					inParent.length === entries.length
						? [...entries].sort(
								(a, b) => siblings.indexOf(a.node) - siblings.indexOf(b.node),
							)
						: entries;
				const top = Math.max(...inParent.map((e) => siblings.indexOf(e.node)));
				const at =
					inParent.length > 0 ? top - inParent.length + 1 : siblings.length;
				const nodes = ordered.map((e) => e.node);
				for (const entry of ordered) detach(entry);
				const group: SerializedNode = {
					id: nextId(),
					name: name ?? "Group",
					type: "GROUP",
					...bounds(nodes),
					children: nodes,
				};
				siblings.splice(at, 0, group);
				return { node: { id: group.id, name: group.name, type: group.type } };
			} catch (error) {
				if (!(error instanceof Failure)) throw error;
				return error.error;
			}
		},

		ungroup_nodes({
			ids,
		}: CommandParams<"ungroup_nodes">): CommandResult<"ungroup_nodes"> {
			const nodes = ids.map((id) =>
				outcome(id, (): UngroupedNode => {
					const entry = find(id);
					if (entry.node.type !== "GROUP") {
						throw new Failure(notAGroupError(entry.view));
					}
					check(layerError(entry.view, "move"));
					const children = childrenOf(entry);
					const siblings = childrenOf(entry.parent as Entry);
					siblings.splice(siblings.indexOf(entry.node), 1, ...children);
					return { id, ok: true, children: children.map((child) => child.id) };
				}),
			);
			return { nodes };
		},
	};
}

/** The box around the nodes, in their parent's coordinates. */
function bounds(nodes: SerializedNode[]) {
	const edges = (start: "x" | "y", size: "width" | "height") => {
		const from = Math.min(...nodes.map((node) => node[start] ?? 0));
		const to = Math.max(
			...nodes.map((node) => (node[start] ?? 0) + (node[size] ?? 0)),
		);
		return [from, to - from];
	};
	const [x, width] = edges("x", "width");
	const [y, height] = edges("y", "height");
	return { x, y, width, height };
}
