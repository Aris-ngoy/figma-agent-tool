// The fake plugin's write commands: applies create_nodes and update_nodes to
// its copy of the document fixture, in serialized form, the way the real
// plugin's edits read back through get_node. The plugin tests replay the
// same fixture exchanges against the real handler.
import type {
	BridgeError,
	CommandParams,
	CommandResult,
	CreatedNode,
	NodeProps,
	NodeSpec,
	PaintInput,
	SerializedNode,
	UpdatedNode,
} from "@figma-agent-tool/protocol";
import {
	availableFonts,
	createdNodeId,
	type DocumentFixture,
	findNode,
	fontNotFoundError,
	nodeNotFoundResponse,
	notAComponentError,
} from "@figma-agent-tool/protocol/fixtures";

class FakeCommandError extends Error {
	constructor(readonly error: BridgeError) {
		super(error.message);
	}
}

const DEFAULT_FONT = { family: "Inter", style: "Regular" };
const NEW_NODES: Record<
	Exclude<NodeSpec["type"], "INSTANCE">,
	Omit<SerializedNode, "id">
> = {
	FRAME: {
		name: "Frame",
		type: "FRAME",
		x: 0,
		y: 0,
		width: 100,
		height: 100,
		fills: [{ type: "SOLID", color: "#ffffff" }],
		children: [],
	},
	RECTANGLE: {
		name: "Rectangle",
		type: "RECTANGLE",
		x: 0,
		y: 0,
		width: 100,
		height: 100,
		fills: [{ type: "SOLID", color: "#d9d9d9" }],
	},
	TEXT: {
		name: "Text",
		type: "TEXT",
		x: 0,
		y: 0,
		width: 0,
		height: 0,
		fills: [{ type: "SOLID", color: "#000000" }],
		text: { characters: "", fontName: DEFAULT_FONT, fontSize: 12 },
	},
};

/** Returns a failure for the whole command, or the command's result. */
export function createFakeEditor(doc: DocumentFixture) {
	let created = 0;

	function find(id: string) {
		const node = findNode(id, doc);
		if (!node) throw new FakeCommandError(nodeNotFoundResponse("", id).error);
		return node;
	}

	function createNode(
		{ type, componentId, children, ...props }: NodeSpec,
		siblings: SerializedNode[],
	): CreatedNode {
		try {
			if (type === "TEXT") checkFont(props.text?.fontName ?? DEFAULT_FONT);
			const node =
				type === "INSTANCE"
					? instantiate(componentId as string)
					: structuredClone({
							id: createdNodeId(++created),
							...NEW_NODES[type],
						});
			applyProps(node, props);
			siblings.push(node);
			const result: CreatedNode = {
				ok: true,
				id: node.id,
				name: node.name,
				type: node.type,
			};
			if (children) {
				const nested = node.children as SerializedNode[];
				result.children = children.map((child) => createNode(child, nested));
			}
			return result;
		} catch (error) {
			if (!(error instanceof FakeCommandError)) throw error;
			return { ok: false, error: error.error };
		}
	}

	function instantiate(componentId: string): SerializedNode {
		const component = findNode(componentId, doc);
		if (component?.type !== "COMPONENT") {
			throw new FakeCommandError(
				notAComponentError(componentId, component?.type),
			);
		}
		const id = createdNodeId(++created);
		const { component: _, children, ...rest } = structuredClone(component);
		return {
			...rest,
			id,
			type: "INSTANCE",
			x: 0,
			y: 0,
			instance: {
				mainComponent: { id: component.id, name: component.name },
				properties: {},
			},
			children: children?.map((child) => prefixIds(child, `I${id};`)),
		};
	}

	return {
		create_nodes({
			parentId,
			nodes,
		}: CommandParams<"create_nodes">):
			| CommandResult<"create_nodes">
			| BridgeError {
			try {
				const parent = find(parentId ?? doc.currentPageId);
				const siblings = parent.children;
				if (!siblings || parent.type === "INSTANCE") {
					return {
						code: "invalid_parent",
						message: `Node ${parent.id} is a ${parent.type}, which can't hold children.`,
					};
				}
				return { nodes: nodes.map((spec) => createNode(spec, siblings)) };
			} catch (error) {
				if (!(error instanceof FakeCommandError)) throw error;
				return error.error;
			}
		},

		update_nodes({
			updates,
		}: CommandParams<"update_nodes">): CommandResult<"update_nodes"> {
			return {
				nodes: updates.map(({ id, ...props }): UpdatedNode => {
					try {
						const node = find(id);
						if (props.text?.fontName) checkFont(props.text.fontName);
						applyProps(node, props);
						return { id, ok: true };
					} catch (error) {
						if (!(error instanceof FakeCommandError)) throw error;
						return { id, ok: false, error: error.error };
					}
				}),
			};
		},
	};
}

function checkFont(font: { family: string; style: string }) {
	const installed = availableFonts.some(
		(f) => f.family === font.family && f.style === font.style,
	);
	if (!installed) throw new FakeCommandError(fontNotFoundError(font));
}

/** Writes props the way they read back: defaults omitted, hex lowercase. */
function applyProps(node: SerializedNode, props: NodeProps) {
	const { text, layout, cornerRadius, fills, strokes, ...plain } = props;
	Object.assign(node, plain);
	if (node.rotation === 0) delete node.rotation;
	if (node.opacity === 1) delete node.opacity;
	if (node.visible) delete node.visible;
	if (typeof cornerRadius === "number") node.cornerRadius = cornerRadius;
	else if (cornerRadius) {
		const radii = new Set(Object.values(cornerRadius));
		node.cornerRadius =
			radii.size === 1 ? cornerRadius.topLeft : { ...cornerRadius };
	}
	if (node.cornerRadius === 0) delete node.cornerRadius;
	if (fills) node.fills = fills.map(paint);
	if (strokes) {
		node.strokes = strokes.map(paint);
		node.strokeWeight ??= 1;
	}
	if (node.fills?.length === 0) delete node.fills;
	if (node.strokes?.length === 0) {
		delete node.strokes;
		delete node.strokeWeight;
	}
	if (text && node.text) {
		Object.assign(node.text, text);
		if (node.text.textAlignHorizontal === "LEFT") {
			delete node.text.textAlignHorizontal;
		}
	}
	if (layout) applyLayout(node, layout);
}

function applyLayout(
	node: SerializedNode,
	{ mode, padding, sizing, ...rest }: NonNullable<NodeProps["layout"]>,
) {
	if (mode === "NONE") {
		delete node.layout;
		return;
	}
	if (!node.layout && !mode) return;
	const current = node.layout ?? {
		mode: mode as "HORIZONTAL" | "VERTICAL",
		itemSpacing: 0,
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		primaryAxisAlignItems: "MIN",
		counterAxisAlignItems: "MIN",
		wrap: false,
		sizing: { horizontal: "FIXED", vertical: "FIXED" },
	};
	node.layout = {
		...current,
		...rest,
		...(mode && { mode }),
		padding: { ...current.padding, ...padding },
		sizing: { ...current.sizing, ...sizing },
	};
}

function paint(input: PaintInput) {
	const out = { ...input };
	if (out.opacity === 1) delete out.opacity;
	return out;
}

function prefixIds(node: SerializedNode, prefix: string): SerializedNode {
	return {
		...node,
		id: `${prefix}${node.id}`,
		children: node.children?.map((child) => prefixIds(child, prefix)),
	};
}
