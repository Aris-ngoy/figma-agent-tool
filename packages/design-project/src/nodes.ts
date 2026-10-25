// Screens ↔ the node trees the Plugin applies and reads. Push turns a
// Screen into ScreenNodes; Pull turns the SyncedNodes it reads back into
// elements, and is its exact inverse for everything in the Screen Subset.
import {
	type Paint,
	prototypeLink,
	type ScreenFill,
	type ScreenNode,
	type SyncedNode,
} from "@figma-agent-tool/protocol";
import { instanceProperties } from "./components";
import { elementBindings, type TokenBindings } from "./design-system";
import {
	formatTransition,
	linkedScreen,
	parseTransition,
	screenHref,
} from "./link";
import { formatPath, parsePath } from "./path";
import {
	defaultName,
	type ResolveContext,
	resolveElement,
	resolveProp,
	vectorGeometry,
	vectorPath,
} from "./resolve";
import { componentSetRoot, type Element } from "./screen";
import {
	COMPONENT_SET_TAG,
	COMPONENT_TAG,
	DEFAULT_TAGS,
	FIGMA_OWNED_TAG,
	fontStyle,
	type Kind,
	type Prop,
	parseFontStyle,
} from "./subset";

export type PushContext = ResolveContext & {
	/** The layer each element key was pushed to before. */
	nodeIds: Record<string, string>;
	/** The fill an image `src` pushes as. */
	imageFill: (src: string, scaleMode: "FILL" | "FIT") => ScreenFill;
	/** The Design System's variables and text styles elements bind to. */
	bindings?: TokenBindings;
	/**
	 * Whether the Screen moved, resized or renamed a Figma-owned Element
	 * (or put it in another frame) since the Baseline.
	 */
	placed?: (element: Element, parent: Element | undefined) => boolean;
};

const PRIMARY_ALIGN = {
	"flex-start": "MIN",
	center: "CENTER",
	"flex-end": "MAX",
	"space-between": "SPACE_BETWEEN",
} as const;

const COUNTER_ALIGN = {
	"flex-start": "MIN",
	center: "CENTER",
	"flex-end": "MAX",
} as const;

const TEXT_ALIGN = {
	left: "LEFT",
	center: "CENTER",
	right: "RIGHT",
	justify: "JUSTIFIED",
} as const;

const NODE_TYPES = {
	frame: "FRAME",
	text: "TEXT",
	rect: "RECTANGLE",
	image: "RECTANGLE",
	vector: "VECTOR",
	instance: "INSTANCE",
	owned: "OWNED",
} as const;

const STROKE_CAPS = { butt: "NONE", round: "ROUND", square: "SQUARE" } as const;

const STROKE_JOINS = {
	miter: "MITER",
	round: "ROUND",
	bevel: "BEVEL",
} as const;

/** Layers that read as a kind of element (images are rectangles). */
const SUPPORTED_TYPES = ["FRAME", "TEXT", "RECTANGLE", "VECTOR"];

/** The node tree a checked Screen with keys on every element pushes as. */
export function toScreenNode(root: Element, context: PushContext): ScreenNode {
	return convert(root, undefined, context);
}

function convert(
	element: Element,
	parent: Element | undefined,
	context: PushContext,
): ScreenNode {
	const isRoot = parent === undefined;
	const parentDirection =
		parent && resolveProp(parent, "flex-direction", context.tokens);
	const r = resolveElement(element, context, isRoot);
	const key = element.key;
	if (!key)
		throw new Error("Push gives every element a key before converting it.");
	const row = parentDirection === "row";
	const absolute = r.position === "absolute";
	const sizing = (axis: "width" | "height") => {
		// A component set hugs its variants.
		if (isRoot && element.tag === COMPONENT_SET_TAG) return "HUG" as const;
		if (isRoot) return "FIXED" as const;
		const main = (axis === "width") === row;
		if (!absolute && (main ? r.flex === "1" : r["align-self"] === "stretch"))
			return "FILL" as const;
		return r[axis] ? ("FIXED" as const) : ("HUG" as const);
	};
	const geometry = {
		width: Number(r.width) || 100,
		height: Number(r.height) || 100,
		sizing: { horizontal: sizing("width"), vertical: sizing("height") },
		...(absolute && { position: { x: Number(r.left), y: Number(r.top) } }),
	};
	if (element.kind === "owned") {
		const id = context.nodeIds[key];
		if (!id) throw new Error(`Figma-owned Element ${key} has no layer.`);
		const owned: ScreenNode = {
			key,
			id,
			type: "OWNED",
			fills: [],
			...geometry,
		};
		if (context.placed?.(element, parent)) {
			owned.place = true;
			if (element.name) owned.name = element.name;
		}
		return owned;
	}
	if (element.kind === "instance") {
		const instance: ScreenNode = {
			key,
			type: "INSTANCE",
			component: element.tag,
			properties: instanceProperties(
				context.components?.(element.tag),
				element.properties,
			),
			name: element.name ?? element.tag,
			fills: [],
			...geometry,
		};
		if (context.nodeIds[key]) instance.id = context.nodeIds[key];
		const link = screenLink(element);
		if (link) instance.link = link;
		return instance;
	}
	const node: ScreenNode = {
		key,
		type: componentType(element) ?? NODE_TYPES[element.kind],
		...geometry,
		fills: fills(element, r, context),
		opacity: Number(r.opacity),
	};
	if (context.nodeIds[key]) node.id = context.nodeIds[key];
	const bindings =
		context.bindings && elementBindings(element, r, context.bindings);
	if (bindings) node.bindings = bindings;
	const link = screenLink(element);
	if (link) node.link = link;
	if (element.kind !== "text") {
		node.name = element.name ?? defaultName(element, context, isRoot);
	} else if (element.name !== undefined) {
		node.name = element.name;
	}
	if (r["border-radius"] !== undefined)
		node.cornerRadius = cornerRadius(r["border-radius"]);
	const stroke = screenStroke(element, r);
	if (stroke) node.stroke = stroke;
	if (element.kind === "vector") {
		node.vector = { paths: vectorGeometry(element, r).paths };
	}
	if (element.property) node.property = element.property;
	if (element.kind === "text") {
		node.text = {
			characters: element.text ?? "",
			fontName: {
				family: r["font-family"] as string,
				style: fontStyle(
					r["font-weight"] as string,
					r["font-style"] === "italic",
				),
			},
			fontSize: Number(r["font-size"]),
			textAlignHorizontal:
				TEXT_ALIGN[r["text-align"] as keyof typeof TEXT_ALIGN],
		};
	}
	if (element.kind === "frame") {
		node.layout = {
			mode: r["flex-direction"] === "column" ? "VERTICAL" : "HORIZONTAL",
			itemSpacing: Number(r.gap),
			padding: {
				top: Number(r["padding-top"]),
				right: Number(r["padding-right"]),
				bottom: Number(r["padding-bottom"]),
				left: Number(r["padding-left"]),
			},
			primaryAxisAlignItems:
				PRIMARY_ALIGN[r["justify-content"] as keyof typeof PRIMARY_ALIGN],
			counterAxisAlignItems:
				COUNTER_ALIGN[r["align-items"] as keyof typeof COUNTER_ALIGN],
			wrap: r["flex-wrap"] === "wrap",
		};
		node.clips = isRoot || r.overflow === "hidden";
		node.children = element.children.map((child) =>
			convert(child, element, context),
		);
	}
	return node;
}

/** A Defined Component's set and variants are a component set and components. */
function componentType(element: Element): ScreenNode["type"] | undefined {
	if (element.tag === COMPONENT_SET_TAG) return "COMPONENT_SET";
	if (element.tag === COMPONENT_TAG) return "COMPONENT";
	return undefined;
}

/** A checked element's Prototype Link, as Push sends it. */
function screenLink(element: Element): ScreenNode["link"] {
	const screen = element.href && linkedScreen(element.href);
	if (!screen) return undefined;
	const parsed = parseTransition(element.transition);
	return {
		screen,
		transition: "transition" in parsed ? parsed.transition : null,
	};
}

function fills(
	element: Element,
	r: Record<string, string>,
	context: PushContext,
): ScreenFill[] {
	switch (element.kind) {
		case "text":
			return [{ type: "SOLID", color: r.color as string }];
		case "image":
			return [
				context.imageFill(
					element.src ?? "",
					r["object-fit"] === "contain" ? "FIT" : "FILL",
				),
			];
		case "vector":
			return r.fill !== "none"
				? [{ type: "SOLID", color: r.fill as string }]
				: [];
		default:
			return r["background-color"]
				? [{ type: "SOLID", color: r["background-color"] }]
				: [];
	}
}

/** A border as an inside stroke; a vector's stroke centered, as SVG draws it. */
function screenStroke(
	element: Element,
	r: Record<string, string>,
): ScreenNode["stroke"] {
	if (element.kind === "vector") {
		if (r.stroke === "none") return undefined;
		return {
			color: r.stroke as string,
			weight: Number(r["stroke-width"]),
			align: "CENTER",
			cap: STROKE_CAPS[r["stroke-linecap"] as keyof typeof STROKE_CAPS],
			join: STROKE_JOINS[r["stroke-linejoin"] as keyof typeof STROKE_JOINS],
		};
	}
	const weight = Number(r["border-width"]);
	if (!weight || !r["border-color"]) return undefined;
	return { color: r["border-color"], weight, align: "INSIDE" };
}

function cornerRadius(radius: string): ScreenNode["cornerRadius"] {
	const corners = radius.split(" ").map(Number);
	const [
		topLeft = 0,
		topRight = topLeft,
		bottomRight = topLeft,
		bottomLeft = topRight,
	] = corners;
	if (corners.length === 1) return topLeft;
	return { topLeft, topRight, bottomRight, bottomLeft };
}

export type PullContext = ResolveContext & {
	/** The key a layer belongs to, from its plugin data and the node ID map. */
	keyFor: (node: SyncedNode) => string | undefined;
	/** The tag the Design Project already uses for an element. */
	tagFor: (key: string | undefined, kind: Kind) => string | undefined;
	/** An image fill's `src`; undefined if Pull doesn't have the image. */
	srcFor: (imageHash: string) => string | undefined;
	/** The Baseline's version of an element, kept when its layer can't be read. */
	baseElement: (key: string) => Element | undefined;
	/** The Screen a frame is (or was) the frame of, for Prototype Links. */
	screenOf: (frameId: string) => string | undefined;
	/** The Component an instance is of, if it's one of the Design Project's. */
	componentOf?: (instance: SyncedInstance) => string | undefined;
};

type SyncedInstance = NonNullable<SyncedNode["instance"]>;

/** A layer Pull can't express in the Screen Subset, which stays Figma's. */
export type FigmaOwnedLayer = {
	/** Its Figma-owned Element's key; none for a Screen's own frame. */
	key?: string;
	nodeId: string;
	name: string;
	reason: string;
};

/**
 * The Defined Component a component set (or lone component) reads as. A
 * variant Pull can't express keeps its Baseline.
 */
export function fromComponentNode(
	node: SyncedNode,
	context: PullContext,
): { root: Element; figmaOwned: FigmaOwnedLayer[] } {
	const figmaOwned: FigmaOwnedLayer[] = [];
	const isSet = node.type === "COMPONENT_SET";
	const variants = isSet ? (node.children ?? []) : [node];
	const children = variants.flatMap((variant) => {
		const count = figmaOwned.length;
		const read = readElement(
			{ ...variant, type: "FRAME" },
			"row",
			context,
			figmaOwned,
		);
		if (read?.kind === "owned") {
			// Not a frame Screens can express: it keeps its Baseline.
			const owned = figmaOwned[count] as FigmaOwnedLayer;
			owned.reason = `is a variant that ${owned.reason}, so Pull keeps its version from the last Push or Pull`;
			const base = read.key ? context.baseElement(read.key) : undefined;
			return base ? [{ ...structuredClone(base), nodeId: variant.id }] : [];
		}
		if (!read) return [];
		read.tag = COMPONENT_TAG;
		if (isSet) read.name = variant.name;
		else delete read.name;
		delete read.href;
		delete read.transition;
		return [read];
	});
	const root = componentSetRoot(children);
	root.nodeId = node.id;
	return { root, figmaOwned };
}

/** The Screen a frame reads as; layers outside the subset are listed. */
export function fromSyncedNode(
	frame: SyncedNode,
	context: PullContext,
): { root?: Element; figmaOwned: FigmaOwnedLayer[] } {
	const figmaOwned: FigmaOwnedLayer[] = [];
	const root = readElement(frame, undefined, context, figmaOwned);
	return { root, figmaOwned };
}

function readElement(
	node: SyncedNode,
	parentDirection: string | undefined,
	context: PullContext,
	figmaOwned: FigmaOwnedLayer[],
): Element | undefined {
	const isRoot = parentDirection === undefined;
	const key = context.keyFor(node);
	const component = node.instance && context.componentOf?.(node.instance);
	if (component && parentDirection !== undefined && !instanceReason(node))
		return instanceElement(node, key, component, parentDirection, context);
	const reason =
		node.type === "INSTANCE"
			? (instanceReason(node) ??
				"is an instance of a component that isn't one of the Design Project's Components")
			: unsupportedReason(node, context);
	if (reason || (isRoot && node.type !== "FRAME")) {
		figmaOwned.push({
			nodeId: node.id,
			name: node.name,
			reason: reason ?? "isn't a frame",
		});
		if (!isRoot) return figmaOwnedElement(node, key, parentDirection, context);
		// A Screen is a frame, so one that isn't keeps its Baseline.
		const base = key ? context.baseElement(key) : undefined;
		return base && { ...structuredClone(base), nodeId: node.id };
	}
	const kind = kindOf(node);
	const props: Element["props"] = {};
	const set = (prop: Prop, value: string | undefined) => {
		if (value !== undefined) props[prop] = value;
	};
	const element: Element = {
		kind,
		tag: isRoot ? "body" : (context.tagFor(key, kind) ?? DEFAULT_TAGS[kind]),
		props,
		children: [],
		nodeId: node.id,
	};
	if (key) element.key = key;
	if (kind === "frame") readLayout(node, set);
	if (kind === "frame" && !isRoot && node.clips) set("overflow", "hidden");
	readPosition(node, set);
	readSize(node, kind, parentDirection, context, set);
	const [fill] = node.fills as Paint[];
	if (kind === "text") {
		const text = node.text as NonNullable<SyncedNode["text"]>;
		element.text = text.characters;
		const font = text.fontName as { family: string; style: string };
		const style = parseFontStyle(font.style) as {
			weight: string;
			italic: boolean;
		};
		set(
			"color",
			fill?.type === "SOLID" && fill.color !== "#000000"
				? fill.color
				: undefined,
		);
		set("font-family", font.family !== "Inter" ? font.family : undefined);
		set(
			"font-size",
			text.fontSize !== 16 ? px(text.fontSize as number) : undefined,
		);
		set("font-weight", style.weight !== "400" ? style.weight : undefined);
		set("font-style", style.italic ? "italic" : undefined);
		const align = text.textAlignHorizontal ?? "LEFT";
		set("text-align", align !== "LEFT" ? keyOf(TEXT_ALIGN, align) : undefined);
	} else if (kind === "image" && fill?.type === "IMAGE") {
		element.src = context.srcFor(fill.imageHash as string);
		set("object-fit", fill.scaleMode === "FIT" ? "contain" : undefined);
	} else if (kind === "vector") {
		readVector(node, element, set);
	} else if (fill?.type === "SOLID") {
		set("background-color", fill.color);
	}
	if (kind !== "text" && kind !== "vector")
		set("border-radius", radius(node.cornerRadius));
	if (kind !== "text" && kind !== "vector" && node.stroke) {
		set("border-width", px(node.stroke.weight as number));
		set("border-color", (node.stroke.paint as { color: string }).color);
	}
	set("opacity", node.opacity !== 1 ? String(round(node.opacity)) : undefined);
	const isDefaultName = node.name === defaultName(element, context, isRoot);
	if (!isDefaultName) element.name = node.name;
	if (!isRoot) readLink(node, element, context);
	if (node.property) element.property = node.property;
	if (kind === "frame") {
		const direction = props["flex-direction"] ?? "row";
		// A detached instance's layers are new to the Screen, whatever keys
		// they carry from its Component.
		const detached = key && context.baseElement(key)?.kind === "instance";
		const childContext = detached
			? { ...context, keyFor: () => undefined }
			: context;
		for (const child of node.children ?? []) {
			const childElement = readElement(
				child,
				direction,
				childContext,
				figmaOwned,
			);
			if (childElement) element.children.push(childElement);
		}
	}
	return element;
}

/** Why an instance can't be an instance element, if it can't. */
function instanceReason(node: SyncedNode): string | undefined {
	if (!node.visible) return "is hidden";
	if (node.rotation !== 0) return "is rotated";
	if (
		node.absolute &&
		(node.absolute.horizontal !== "MIN" || node.absolute.vertical !== "MIN")
	)
		return "is pinned to its parent's right, bottom or center";
	return undefined;
}

/**
 * An instance: its Component, the properties it sets other than to their
 * defaults, its place and size, and its name and link. Overrides of its
 * own layers stay Figma's.
 */
function instanceElement(
	node: SyncedNode,
	key: string | undefined,
	component: string,
	parentDirection: string,
	context: PullContext,
): Element {
	const props: Element["props"] = {};
	const set = (prop: Prop, value: string | undefined) => {
		if (value !== undefined) props[prop] = value;
	};
	readPosition(node, set);
	readSize(node, "instance", parentDirection, context, set);
	const definition = context.components?.(component);
	const properties: Record<string, string> = {};
	for (const [name, value] of Object.entries(node.instance?.properties ?? {})) {
		const property = definition?.properties[name];
		if (definition ? property && value !== property.default : true)
			properties[name] = value;
	}
	const element: Element = {
		kind: "instance",
		tag: component,
		...(key && { key }),
		props,
		children: [],
		nodeId: node.id,
	};
	if (node.name !== component) element.name = node.name;
	if (Object.keys(properties).length > 0) element.properties = properties;
	readLink(node, element, context);
	return element;
}

/** A Figma-owned Element for a layer: its place and size, and its name. */
function figmaOwnedElement(
	node: SyncedNode,
	key: string | undefined,
	parentDirection: string,
	context: PullContext,
): Element {
	const props: Element["props"] = {};
	const set = (prop: Prop, value: string | undefined) => {
		if (value !== undefined) props[prop] = value;
	};
	readPosition(node, set);
	readSize(node, "owned", parentDirection, context, set);
	return {
		kind: "owned",
		tag: FIGMA_OWNED_TAG,
		...(key && { key }),
		name: node.name,
		props,
		children: [],
		nodeId: node.id,
	};
}

/** The layer's Prototype Link: its first on-click NAVIGATE to a Screen's frame. */
function readLink(node: SyncedNode, element: Element, context: PullContext) {
	for (const reaction of node.reactions ?? []) {
		const link = prototypeLink(reaction);
		const screen = link && context.screenOf(link.destinationId);
		if (!link || !screen) continue;
		element.href = screenHref(screen);
		const transition = formatTransition(link.transition);
		if (transition) element.transition = transition;
		return;
	}
	// An <a> without its link is the element it is.
	if (element.tag === "a") element.tag = DEFAULT_TAGS[element.kind];
}

function readPosition(
	node: SyncedNode,
	set: (prop: Prop, value: string | undefined) => void,
) {
	if (!node.absolute) return;
	set("position", "absolute");
	set("left", px(node.x));
	set("top", px(node.y));
}

function readVector(
	node: SyncedNode,
	element: Element,
	set: (prop: Prop, value: string | undefined) => void,
) {
	const [fill] = node.fills as Paint[];
	const color = fill?.type === "SOLID" ? fill.color : "none";
	set("fill", color !== "#000000" ? color : undefined);
	const { stroke } = node;
	if (stroke?.paint.type === "SOLID") {
		set("stroke", stroke.paint.color);
		set(
			"stroke-width",
			stroke.weight !== 1 ? px(stroke.weight as number) : undefined,
		);
		const cap = keyOf(STROKE_CAPS, stroke.cap as string);
		set("stroke-linecap", cap !== "butt" ? cap : undefined);
		const join = keyOf(STROKE_JOINS, stroke.join as string);
		set("stroke-linejoin", join !== "miter" ? join : undefined);
	}
	element.paths = (node.vector?.paths ?? []).map(({ data, windingRule }) => {
		const commands = parsePath(data);
		return vectorPath(
			"problem" in commands ? data : formatPath(commands),
			windingRule,
		);
	});
}

function kindOf(node: SyncedNode): Kind {
	if (node.type === "TEXT") return "text";
	if (node.type === "FRAME") return "frame";
	if (node.type === "VECTOR") return "vector";
	const [fill] = node.fills as Paint[];
	return fill?.type === "IMAGE" ? "image" : "rect";
}

/** Why a layer isn't expressible in the basic Screen Subset, if it isn't. */
function unsupportedReason(
	node: SyncedNode,
	context: PullContext,
): string | undefined {
	if (!SUPPORTED_TYPES.includes(node.type)) return `is a ${node.type}`;
	if (!node.visible) return "is hidden";
	if (node.rotation !== 0) return "is rotated";
	if (
		node.absolute &&
		(node.absolute.horizontal !== "MIN" || node.absolute.vertical !== "MIN")
	)
		return "is pinned to its parent's right, bottom or center";
	const stroke = strokeReason(node);
	if (stroke) return stroke;
	if (node.effects > 0) return "has effects";
	if (node.type === "VECTOR") {
		const vector = vectorReason(node);
		if (vector) return vector;
	}
	if (node.type === "FRAME") {
		const mode = node.layout?.mode;
		if (mode !== "HORIZONTAL" && mode !== "VERTICAL")
			return "doesn't use auto layout";
		if (
			!Object.values(PRIMARY_ALIGN).includes(
				node.layout?.primaryAxisAlignItems as never,
			)
		)
			return `distributes its children (${node.layout?.primaryAxisAlignItems})`;
		if (node.layout?.counterAxisAlignItems === "BASELINE")
			return "aligns to text baselines";
	}
	if (node.fills === "mixed") return "has mixed fills";
	if (node.fills.length > 1) return "has more than one fill";
	const [fill] = node.fills;
	if (fill) {
		if (fill.visible === false || (fill.opacity ?? 1) !== 1)
			return "has a translucent or hidden fill";
		if (fill.type === "IMAGE") {
			if (node.type !== "RECTANGLE")
				return "has an image fill on a frame or text";
			if (fill.scaleMode !== "FILL" && fill.scaleMode !== "FIT")
				return `crops its image (${fill.scaleMode})`;
			if (!fill.imageHash || context.srcFor(fill.imageHash) === undefined)
				return "has an image Pull couldn't read";
		} else if (fill.type !== "SOLID") {
			return `has a ${fill.type} fill`;
		}
	}
	if (node.type === "TEXT") {
		const text = node.text;
		if (!text || text.fontName === "mixed" || text.fontSize === "mixed")
			return "mixes text styles";
		if (fill?.type !== "SOLID") return "has text without a solid color";
		if (/^ | $| {2}|\n | \n/.test(text.characters))
			return "has spaces HTML would collapse";
		if (!parseFontStyle(text.fontName.style))
			return `uses the font style ${text.fontName.style}`;
		if (node.sizing?.vertical === "FIXED") return "is text with a fixed height";
	}
	return undefined;
}

/** Why a layer's strokes aren't a border or an SVG stroke, if they aren't. */
function strokeReason(node: SyncedNode): string | undefined {
	const { stroke } = node;
	if (node.strokes === 0 || !stroke) return undefined;
	if (node.type === "TEXT") return "has strokes on text";
	if (node.strokes > 1) return "has more than one stroke";
	const { paint } = stroke;
	if (
		paint.type !== "SOLID" ||
		paint.visible === false ||
		(paint.opacity ?? 1) !== 1
	)
		return "has a stroke that isn't one solid color";
	if (stroke.weight === "mixed")
		return "has strokes of different widths per side";
	if (stroke.dashed) return "has a dashed stroke";
	const align = node.type === "VECTOR" ? "CENTER" : "INSIDE";
	if (stroke.align !== align)
		return `has a stroke aligned ${stroke.align.toLowerCase()}, where Screens draw it ${align.toLowerCase()}`;
	if (node.type === "FRAME" && stroke.inLayout === false)
		return "has a stroke that doesn't take up room in its auto layout";
	if (
		node.type === "VECTOR" &&
		(!Object.values(STROKE_CAPS).includes(stroke.cap as never) ||
			!Object.values(STROKE_JOINS).includes(stroke.join as never))
	)
		return "has stroke caps or joins SVG doesn't draw";
	return undefined;
}

/** Why a vector isn't expressible as an <svg>, if it isn't. */
function vectorReason(node: SyncedNode): string | undefined {
	const paths = node.vector?.paths ?? [];
	if (paths.length === 0) return "is a vector network without paths";
	if (paths.some(({ data }) => "problem" in parsePath(data)))
		return "has paths Pull couldn't read";
	const filled = node.fills !== "mixed" && node.fills.length > 0;
	if (filled && paths.some(({ windingRule }) => windingRule === "NONE"))
		return "has open paths Figma doesn't fill";
	if (node.cornerRadius !== 0) return "rounds its corners";
	const { sizing } = node;
	if (sizing?.horizontal === "FILL" || sizing?.vertical === "FILL")
		return "stretches to fill its parent, scaling its paths";
	return undefined;
}

function readLayout(
	node: SyncedNode,
	set: (prop: Prop, value: string | undefined) => void,
) {
	const layout = node.layout as NonNullable<SyncedNode["layout"]>;
	set("flex-direction", layout.mode === "VERTICAL" ? "column" : undefined);
	set("flex-wrap", layout.wrap ? "wrap" : undefined);
	const justify = keyOf(PRIMARY_ALIGN, layout.primaryAxisAlignItems);
	set("justify-content", justify !== "flex-start" ? justify : undefined);
	const align = keyOf(COUNTER_ALIGN, layout.counterAxisAlignItems);
	set("align-items", align !== "flex-start" ? align : undefined);
	set("gap", layout.itemSpacing !== 0 ? px(layout.itemSpacing) : undefined);
	const { top, right, bottom, left } = layout.padding;
	if (top || right || bottom || left) {
		set("padding-top", px(top));
		set("padding-right", px(right));
		set("padding-bottom", px(bottom));
		set("padding-left", px(left));
	}
}

function readSize(
	node: SyncedNode,
	kind: Kind,
	parentDirection: string | undefined,
	context: PullContext,
	set: (prop: Prop, value: string | undefined) => void,
) {
	if (parentDirection === undefined) {
		const { width, height } = context.screenSize;
		if (round(node.width) !== width || round(node.height) !== height) {
			set("width", px(node.width));
			set("height", px(node.height));
		}
		return;
	}
	const row = parentDirection === "row";
	for (const axis of ["width", "height"] as const) {
		const sizing =
			node.sizing?.[axis === "width" ? "horizontal" : "vertical"] ?? "FIXED";
		const main = (axis === "width") === row;
		if (sizing === "FILL")
			set(main ? "flex" : "align-self", main ? "1" : "stretch");
		// Rectangles and vectors can't hug; text heights always do.
		else if (
			sizing === "FIXED" ||
			(kind !== "frame" && kind !== "text" && kind !== "instance")
		) {
			if (!(kind === "text" && axis === "height")) set(axis, px(node[axis]));
		}
	}
}

function radius(cornerRadius: SyncedNode["cornerRadius"]): string | undefined {
	if (typeof cornerRadius === "number")
		return cornerRadius ? px(cornerRadius) : undefined;
	const corners = Object.values(cornerRadius);
	if (new Set(corners).size === 1) return radius(corners[0] as number);
	const { topLeft, topRight, bottomRight, bottomLeft } = cornerRadius;
	return [topLeft, topRight, bottomRight, bottomLeft].map(px).join(" ");
}

function keyOf<T extends Record<string, string>>(
	map: T,
	value: string,
): string {
	return (
		Object.entries(map).find(([, v]) => v === value)?.[0] ??
		(Object.keys(map)[0] as string)
	);
}

function px(value: number): string {
	return `${round(value)}px`;
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}
