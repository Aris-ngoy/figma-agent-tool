// Write commands: create and update nodes in batches. Each item succeeds or
// fails on its own, and every batch lands as one undoable step in Figma.
import type {
	CommandParams,
	CommandResult,
	CreatedNode,
	NodeProps,
	NodeSpec,
	PaintInput,
	UpdatedNode,
} from "@figma-agent-tool/protocol";
import { CommandError, nodeNotFound, toBridgeError } from "./errors";

/** The font Figma gives new text nodes. */
const DEFAULT_FONT: FontName = { family: "Inter", style: "Regular" };

type Container = BaseNode & ChildrenMixin;

export async function createNodes({
	parentId,
	nodes,
}: CommandParams<"create_nodes">): Promise<CommandResult<"create_nodes">> {
	const parent = parentId
		? await figma.getNodeByIdAsync(parentId)
		: figma.currentPage;
	if (!parent) throw nodeNotFound(parentId as string);
	if (!("appendChild" in parent) || parent.type === "DOCUMENT") {
		throw new CommandError(
			"invalid_parent",
			`Node ${parent.id} is a ${parent.type}, which can't hold children. Create nodes under a page, frame, group, section or component.`,
		);
	}
	if (parent.type === "PAGE") await parent.loadAsync();
	const results: CreatedNode[] = [];
	for (const spec of nodes) results.push(await createNode(spec, parent));
	figma.commitUndo();
	return { nodes: results };
}

async function createNode(
	{ type, componentId, children, ...props }: NodeSpec,
	parent: Container,
): Promise<CreatedNode> {
	let node: SceneNode | undefined;
	try {
		if (children && type !== "FRAME") {
			throw new CommandError(
				"cannot_have_children",
				`A ${type} can't hold children; nest them in a FRAME instead.`,
			);
		}
		node = await instantiate(type, componentId, props);
		parent.appendChild(node);
		await applyProps(node, props);
		const result: CreatedNode = {
			ok: true,
			id: node.id,
			name: node.name,
			type: node.type,
		};
		if (children) {
			const container = node as FrameNode;
			result.children = [];
			for (const child of children) {
				result.children.push(await createNode(child, container));
			}
		}
		return result;
	} catch (error) {
		node?.remove();
		return { ok: false, error: toBridgeError(error) };
	}
}

/** Makes the bare node, checking fonts and components before it exists. */
async function instantiate(
	type: NodeSpec["type"],
	componentId: string | undefined,
	props: NodeProps,
): Promise<SceneNode> {
	switch (type) {
		case "FRAME":
			return figma.createFrame();
		case "RECTANGLE":
			return figma.createRectangle();
		case "TEXT":
			await loadFonts([props.text?.fontName ?? DEFAULT_FONT]);
			return figma.createText();
		case "INSTANCE": {
			if (!componentId) {
				throw new CommandError(
					"invalid_spec",
					"An INSTANCE needs the componentId of the COMPONENT to instantiate.",
				);
			}
			const component = await figma.getNodeByIdAsync(componentId);
			if (component?.type !== "COMPONENT") {
				throw new CommandError(
					"component_not_found",
					`${component ? `Node ${componentId} is a ${component.type}, not` : `No node with ID "${componentId}" exists, so it isn't`} a COMPONENT. Use a component's ID (a variant's, for component sets); list_frames lists the components on each page.`,
				);
			}
			return component.createInstance();
		}
	}
}

export async function updateNodes({
	updates,
}: CommandParams<"update_nodes">): Promise<CommandResult<"update_nodes">> {
	const results: UpdatedNode[] = [];
	for (const { id, ...props } of updates) {
		try {
			const node = await figma.getNodeByIdAsync(id);
			if (!node) throw nodeNotFound(id);
			await applyProps(node, props);
			results.push({ id, ok: true });
		} catch (error) {
			results.push({ id, ok: false, error: toBridgeError(error) });
		}
	}
	figma.commitUndo();
	return { nodes: results };
}

/**
 * Sets the given properties. Unsupported properties and missing fonts are
 * caught before anything changes. Order matters: auto-layout before sizing,
 * and explicit sizes after text, which can resize the node.
 */
async function applyProps(target: BaseNode, props: NodeProps) {
	const missing = unsupportedProp(target, props);
	if (missing) {
		throw new CommandError(
			"unsupported_property",
			`Node ${target.id} is a ${target.type}, which has no ${missing}.`,
		);
	}
	if (props.text) await applyText(target as TextNode, props.text);

	// Every property below was checked to exist on the node.
	const node = target as FrameNode;
	if (props.name !== undefined) node.name = props.name;
	const { sizing, ...layout } = props.layout ?? {};
	applyAutoLayout(node, layout);
	if (props.width !== undefined || props.height !== undefined) {
		node.resize(props.width ?? node.width, props.height ?? node.height);
	}
	if (props.x !== undefined) node.x = props.x;
	if (props.y !== undefined) node.y = props.y;
	if (props.rotation !== undefined) node.rotation = props.rotation;
	if (props.opacity !== undefined) node.opacity = props.opacity;
	if (props.visible !== undefined) node.visible = props.visible;
	const radius = props.cornerRadius;
	if (typeof radius === "number") node.cornerRadius = radius;
	else if (radius) {
		node.topLeftRadius = radius.topLeft;
		node.topRightRadius = radius.topRight;
		node.bottomRightRadius = radius.bottomRight;
		node.bottomLeftRadius = radius.bottomLeft;
	}
	if (props.fills) node.fills = props.fills.map(figmaPaint);
	if (props.strokes) node.strokes = props.strokes.map(figmaPaint);
	if (props.strokeWeight !== undefined) node.strokeWeight = props.strokeWeight;
	if (sizing?.horizontal) node.layoutSizingHorizontal = sizing.horizontal;
	if (sizing?.vertical) node.layoutSizingVertical = sizing.vertical;
}

/** Which Plugin API member each property needs on the node. */
const REQUIRED_MEMBERS: [keyof NodeProps, string][] = [
	["x", "x"],
	["y", "y"],
	["width", "resize"],
	["height", "resize"],
	["rotation", "rotation"],
	["opacity", "opacity"],
	["visible", "visible"],
	["cornerRadius", "cornerRadius"],
	["fills", "fills"],
	["strokes", "strokes"],
	["strokeWeight", "strokeWeight"],
];

function unsupportedProp(node: BaseNode, props: NodeProps): string | undefined {
	for (const [prop, member] of REQUIRED_MEMBERS) {
		if (props[prop] !== undefined && !(member in node)) return prop;
	}
	if (props.text && node.type !== "TEXT") return "text";
	const { sizing, ...layout } = props.layout ?? {};
	if (Object.keys(layout).length > 0 && !("layoutMode" in node)) {
		return "layout";
	}
	if (sizing && !("layoutSizingHorizontal" in node)) return "layout.sizing";
	return undefined;
}

async function applyText(node: TextNode, text: NonNullable<NodeProps["text"]>) {
	// Switching font needs only the new one; other edits need the current ones.
	await loadFonts(text.fontName ? [text.fontName] : currentFonts(node));
	if (text.fontName) node.fontName = text.fontName;
	if (text.fontSize !== undefined) node.fontSize = text.fontSize;
	if (text.characters !== undefined) node.characters = text.characters;
	if (text.textAlignHorizontal) {
		node.textAlignHorizontal = text.textAlignHorizontal;
	}
}

function currentFonts(node: TextNode): FontName[] {
	return node.fontName === figma.mixed
		? node.getRangeAllFontNames(0, node.characters.length)
		: [node.fontName];
}

async function loadFonts(fonts: FontName[]) {
	for (const font of fonts) {
		try {
			await figma.loadFontAsync(font);
		} catch {
			throw new CommandError(
				"font_not_found",
				`Font "${font.family} ${font.style}" isn't available in this file. Use an installed font, such as one an existing text node's fontName shows.`,
			);
		}
	}
}

function applyAutoLayout(
	node: FrameNode,
	layout: Omit<NonNullable<NodeProps["layout"]>, "sizing">,
) {
	// The mode goes first: the other settings only apply with auto-layout on.
	if (layout.mode) node.layoutMode = layout.mode;
	if (layout.itemSpacing !== undefined) node.itemSpacing = layout.itemSpacing;
	const { padding } = layout;
	if (padding?.top !== undefined) node.paddingTop = padding.top;
	if (padding?.right !== undefined) node.paddingRight = padding.right;
	if (padding?.bottom !== undefined) node.paddingBottom = padding.bottom;
	if (padding?.left !== undefined) node.paddingLeft = padding.left;
	if (layout.primaryAxisAlignItems) {
		node.primaryAxisAlignItems = layout.primaryAxisAlignItems;
	}
	if (layout.counterAxisAlignItems) {
		node.counterAxisAlignItems = layout.counterAxisAlignItems;
	}
	if (layout.wrap !== undefined) {
		node.layoutWrap = layout.wrap ? "WRAP" : "NO_WRAP";
	}
}

function figmaPaint(paint: PaintInput): Paint {
	const extras = {
		opacity: paint.opacity ?? 1,
		visible: paint.visible ?? true,
	};
	switch (paint.type) {
		case "SOLID":
			return { type: paint.type, color: rgb(paint.color), ...extras };
		case "IMAGE":
			return {
				type: paint.type,
				imageHash: paint.imageHash,
				scaleMode: paint.scaleMode as ImagePaint["scaleMode"],
				...extras,
			};
		default:
			return {
				type: paint.type,
				// Left to right, as Figma draws a new linear gradient.
				gradientTransform: [
					[1, 0, 0],
					[0, 1, 0],
				],
				gradientStops: paint.stops.map((stop) => ({
					position: stop.position,
					color: { ...rgb(stop.color), a: stop.opacity },
				})),
				...extras,
			};
	}
}

function rgb(hex: string): RGB {
	const channel = (offset: number) =>
		Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
	return { r: channel(1), g: channel(3), b: channel(5) };
}
