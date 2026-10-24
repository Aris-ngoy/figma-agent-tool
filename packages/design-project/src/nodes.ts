// Screens ↔ the node trees the Plugin applies and reads. Push turns a
// Screen into ScreenNodes; Pull turns the SyncedNodes it reads back into
// elements, and is its exact inverse for everything in the Screen Subset.
import type {
	Paint,
	ScreenFill,
	ScreenNode,
	SyncedNode,
} from "@figma-agent-tool/protocol";
import { defaultName, type ResolveContext, resolveElement } from "./resolve";
import type { Element } from "./screen";
import {
	DEFAULT_TAGS,
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
} as const;

/** The node tree a checked Screen with keys on every element pushes as. */
export function toScreenNode(root: Element, context: PushContext): ScreenNode {
	return convert(root, undefined, context);
}

function convert(
	element: Element,
	parentDirection: string | undefined,
	context: PushContext,
): ScreenNode {
	const isRoot = parentDirection === undefined;
	const r = resolveElement(element, context, isRoot);
	const key = element.key;
	if (!key)
		throw new Error("Push gives every element a key before converting it.");
	const row = parentDirection === "row";
	const sizing = (axis: "width" | "height") => {
		if (isRoot) return "FIXED" as const;
		const main = (axis === "width") === row;
		if (main ? r.flex === "1" : r["align-self"] === "stretch")
			return "FILL" as const;
		return r[axis] ? ("FIXED" as const) : ("HUG" as const);
	};
	const node: ScreenNode = {
		key,
		type: NODE_TYPES[element.kind],
		width: Number(r.width) || 100,
		height: Number(r.height) || 100,
		sizing: { horizontal: sizing("width"), vertical: sizing("height") },
		fills: fills(element, r, context),
		opacity: Number(r.opacity),
	};
	if (context.nodeIds[key]) node.id = context.nodeIds[key];
	if (element.kind !== "text") {
		node.name = element.name ?? defaultName(element, context, isRoot);
		node.cornerRadius = cornerRadius(r["border-radius"] as string);
	} else if (element.name !== undefined) {
		node.name = element.name;
	}
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
		node.children = element.children.map((child) =>
			convert(child, r["flex-direction"], context),
		);
	}
	return node;
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
		default:
			return r["background-color"]
				? [{ type: "SOLID", color: r["background-color"] }]
				: [];
	}
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
};

/** A layer Pull can't express in the Screen Subset, which stays Figma's. */
export type UnsupportedLayer = { nodeId: string; name: string; reason: string };

/** The Screen a frame reads as; layers outside the subset are listed. */
export function fromSyncedNode(
	frame: SyncedNode,
	context: PullContext,
): { root?: Element; unsupported: UnsupportedLayer[] } {
	const unsupported: UnsupportedLayer[] = [];
	const root = read(frame, undefined, context, unsupported);
	return { root, unsupported };
}

function read(
	node: SyncedNode,
	parentDirection: string | undefined,
	context: PullContext,
	unsupported: UnsupportedLayer[],
): Element | undefined {
	const isRoot = parentDirection === undefined;
	const key = context.keyFor(node);
	const reason = unsupportedReason(node, context);
	if (reason || (isRoot && node.type !== "FRAME")) {
		unsupported.push({
			nodeId: node.id,
			name: node.name,
			reason: reason ?? "isn't a frame",
		});
		// A pushed layer the designer took outside the subset keeps its element.
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
	} else if (fill?.type === "SOLID") {
		set("background-color", fill.color);
	}
	if (kind !== "text") set("border-radius", radius(node.cornerRadius));
	set("opacity", node.opacity !== 1 ? String(round(node.opacity)) : undefined);
	const isDefaultName = node.name === defaultName(element, context, isRoot);
	if (!isDefaultName) element.name = node.name;
	if (kind === "frame") {
		const direction = props["flex-direction"] ?? "row";
		for (const child of node.children ?? []) {
			const childElement = read(child, direction, context, unsupported);
			if (childElement) element.children.push(childElement);
		}
	}
	return element;
}

function kindOf(node: SyncedNode): Kind {
	if (node.type === "TEXT") return "text";
	if (node.type === "FRAME") return "frame";
	const [fill] = node.fills as Paint[];
	return fill?.type === "IMAGE" ? "image" : "rect";
}

/** Why a layer isn't expressible in the basic Screen Subset, if it isn't. */
function unsupportedReason(
	node: SyncedNode,
	context: PullContext,
): string | undefined {
	if (!["FRAME", "TEXT", "RECTANGLE"].includes(node.type))
		return `is a ${node.type}`;
	if (!node.visible) return "is hidden";
	if (node.rotation !== 0) return "is rotated";
	if (node.strokes > 0) return "has strokes";
	if (node.effects > 0) return "has effects";
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
		// Rectangles can't hug; text heights always do.
		else if (sizing === "FIXED" || kind === "rect" || kind === "image") {
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
