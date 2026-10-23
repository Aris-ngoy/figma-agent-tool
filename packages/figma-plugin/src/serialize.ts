// Turns Plugin API nodes into the compact agent-facing `SerializedNode`.
// Defaults are left out, colors become hex and `figma.mixed` becomes "mixed".
import {
	type AutoLayout,
	BindableField,
	type ComponentInfo,
	type Effect as EffectInfo,
	type Paint as PaintInfo,
	type SerializedNode,
	type TextInfo,
} from "@figma-agent-tool/protocol";

export async function serializeNode(
	node: BaseNode,
	depth: number,
): Promise<SerializedNode> {
	const out: SerializedNode = { id: node.id, name: node.name, type: node.type };
	if ("visible" in node && !node.visible) out.visible = false;
	if ("x" in node) {
		out.x = round(node.x);
		out.y = round(node.y);
		out.width = round(node.width);
		out.height = round(node.height);
	}
	if ("rotation" in node && node.rotation !== 0) {
		out.rotation = round(node.rotation);
	}
	if ("opacity" in node && node.opacity !== 1) {
		out.opacity = round(node.opacity);
	}
	if ("cornerRadius" in node) {
		const radius = cornerRadius(node);
		if (radius !== 0) out.cornerRadius = radius;
	}
	if ("fills" in node) {
		if (node.fills === figma.mixed) out.fills = "mixed";
		else if (node.fills.length > 0) out.fills = node.fills.map(paint);
	}
	if ("strokes" in node && node.strokes.length > 0) {
		out.strokes = node.strokes.map(paint);
		out.strokeWeight =
			node.strokeWeight === figma.mixed ? "mixed" : node.strokeWeight;
	}
	if (node.type === "TEXT") out.text = text(node);
	if ("layoutMode" in node && node.layoutMode !== "NONE") {
		out.layout = autoLayout(node);
	}
	if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
		out.component = componentInfo(node);
	}
	if (node.type === "INSTANCE") {
		const main = await node.getMainComponentAsync();
		out.instance = {
			mainComponent: main && { id: main.id, name: main.name },
			properties: Object.fromEntries(
				Object.entries(node.componentProperties).map(([name, { value }]) => [
					name,
					value,
				]),
			),
		};
	}
	const variables = boundVariables(node);
	if (variables) out.variables = variables;
	const styles = styleIds(node);
	if (styles) out.styles = styles;
	if ("children" in node) {
		// With dynamic page access, a page's children exist once it's loaded.
		if (node.type === "PAGE") await node.loadAsync();
		const { children } = node;
		if (depth > 0) {
			out.children = await Promise.all(
				children.map((child) => serializeNode(child, depth - 1)),
			);
		} else if (children.length > 0) {
			out.childCount = children.length;
		}
	}
	return out;
}

export function componentInfo(
	node: ComponentNode | ComponentSetNode,
): ComponentInfo {
	const info: ComponentInfo = { key: node.key };
	if (node.description) info.description = node.description;
	// A variant's property definitions live on its component set.
	if (node.type === "COMPONENT" && node.variantProperties) {
		info.variantProperties = { ...node.variantProperties };
		return info;
	}
	const definitions = Object.entries(node.componentPropertyDefinitions);
	if (definitions.length > 0) {
		info.properties = Object.fromEntries(
			definitions.map(([name, { type, defaultValue, variantOptions }]) => [
				name,
				variantOptions
					? { type, defaultValue, variantOptions: [...variantOptions] }
					: { type, defaultValue },
			]),
		);
	}
	return info;
}

const bindableFields = new Set<string>(BindableField.options);

/** Field → bound variable ID. Paint bindings are reported on the paints. */
function boundVariables(node: BaseNode): SerializedNode["variables"] {
	if (!("boundVariables" in node) || !node.boundVariables) return undefined;
	const out: Record<string, string> = {};
	for (const [field, binding] of Object.entries(node.boundVariables)) {
		if (!bindableFields.has(field) || !binding) continue;
		// Text fields carry one alias per styled range.
		const aliases = (Array.isArray(binding) ? binding : [binding]) as {
			id: string;
		}[];
		const [id, ...others] = new Set(aliases.map((alias) => alias.id));
		if (id) out[field] = others.length > 0 ? "mixed" : id;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

const STYLE_ID_PROPS = {
	fill: "fillStyleId",
	stroke: "strokeStyleId",
	text: "textStyleId",
	effect: "effectStyleId",
} as const;

function styleIds(node: BaseNode): SerializedNode["styles"] {
	const out: NonNullable<SerializedNode["styles"]> = {};
	for (const [slot, prop] of Object.entries(STYLE_ID_PROPS)) {
		if (!(prop in node)) continue;
		const id = (node as unknown as Record<string, string | symbol>)[prop];
		if (id === figma.mixed) out[slot as keyof typeof out] = "mixed";
		else if (id) out[slot as keyof typeof out] = id as string;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function cornerRadius(
	node: {
		cornerRadius?: number | PluginAPI["mixed"];
	} & Partial<RectangleCornerMixin>,
) {
	if (node.cornerRadius !== figma.mixed) return round(node.cornerRadius ?? 0);
	return {
		topLeft: round(node.topLeftRadius ?? 0),
		topRight: round(node.topRightRadius ?? 0),
		bottomRight: round(node.bottomRightRadius ?? 0),
		bottomLeft: round(node.bottomLeftRadius ?? 0),
	};
}

export function paint(p: Paint): PaintInfo {
	const extras: { opacity?: number; visible?: false } = {};
	if (p.opacity !== undefined && p.opacity !== 1) {
		extras.opacity = round(p.opacity);
	}
	if (p.visible === false) extras.visible = false;
	switch (p.type) {
		case "SOLID": {
			const variable = p.boundVariables?.color?.id;
			return {
				type: p.type,
				color: hex(p.color),
				...(variable && { variable }),
				...extras,
			};
		}
		case "IMAGE":
			return {
				type: p.type,
				imageHash: p.imageHash,
				scaleMode: p.scaleMode,
				...extras,
			};
		case "VIDEO":
		case "PATTERN":
		case "SHADER":
			return { type: p.type, ...extras };
		default:
			return {
				type: p.type,
				stops: p.gradientStops.map((stop) => ({
					position: round(stop.position),
					color: hex(stop.color),
					opacity: round(stop.color.a),
				})),
				...extras,
			};
	}
}

export function effect(e: Effect): EffectInfo {
	const extras: { visible?: false } = e.visible ? {} : { visible: false };
	switch (e.type) {
		case "DROP_SHADOW":
		case "INNER_SHADOW": {
			const shadow: EffectInfo = {
				type: e.type,
				color: hex(e.color),
				offset: { x: round(e.offset.x), y: round(e.offset.y) },
				radius: round(e.radius),
				...extras,
			};
			if (e.color.a !== 1) shadow.opacity = round(e.color.a);
			if (e.spread) shadow.spread = round(e.spread);
			return shadow;
		}
		case "LAYER_BLUR":
		case "BACKGROUND_BLUR":
			return { type: e.type, radius: round(e.radius), ...extras };
		default:
			return { type: e.type, ...extras };
	}
}

function text(node: TextNode): TextInfo {
	const info: TextInfo = {
		characters: node.characters,
		fontName: node.fontName === figma.mixed ? "mixed" : node.fontName,
		fontSize: node.fontSize === figma.mixed ? "mixed" : node.fontSize,
	};
	if (node.textAlignHorizontal !== "LEFT") {
		info.textAlignHorizontal = node.textAlignHorizontal;
	}
	return info;
}

function autoLayout(
	node: AutoLayoutMixin & AutoLayoutChildrenMixin & LayoutMixin,
): AutoLayout {
	return {
		mode: node.layoutMode as AutoLayout["mode"],
		itemSpacing: round(node.itemSpacing),
		padding: {
			top: round(node.paddingTop),
			right: round(node.paddingRight),
			bottom: round(node.paddingBottom),
			left: round(node.paddingLeft),
		},
		primaryAxisAlignItems: node.primaryAxisAlignItems,
		counterAxisAlignItems: node.counterAxisAlignItems,
		wrap: node.layoutWrap === "WRAP",
		sizing: {
			horizontal: node.layoutSizingHorizontal,
			vertical: node.layoutSizingVertical,
		},
	};
}

export function hex({ r, g, b }: RGB): string {
	const channel = (value: number) =>
		Math.round(value * 255)
			.toString(16)
			.padStart(2, "0");
	return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Figma geometry carries float noise like 12.000000001. */
export function round(value: number): number {
	return Math.round(value * 100) / 100;
}
