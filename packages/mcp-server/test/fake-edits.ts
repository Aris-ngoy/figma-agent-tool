// The fake plugin's write commands: applies create_nodes and update_nodes to
// its copy of the document fixture, in serialized form, the way the real
// plugin's edits read back through get_node. The plugin tests replay the
// same fixture exchanges against the real handler.
import {
	BINDABLE_FIELD_TYPES,
	type BindableField,
	type BridgeError,
	type CommandParams,
	type CommandResult,
	type CreatedNode,
	type DesignSystem,
	type NodeProps,
	type NodeSpec,
	type Paint,
	type PaintInput,
	parentError,
	type SerializedNode,
	STYLE_SLOTS,
	type StyleSlot,
	type UpdatedNode,
	type VariableInfo,
	type VariableValue,
} from "@figma-agent-tool/protocol";
import {
	availableFonts,
	type DocumentFixture,
	findNode,
	fontNotFoundError,
	nodeNotFoundResponse,
	notAComponentError,
	prefixIds,
	styleNotFoundError,
	styleTypeMismatchError,
	variableNotFoundError,
	variableTypeMismatchError,
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

type Style =
	| ({ type: "PAINT" } & DesignSystem["styles"]["paint"][number])
	| ({ type: "TEXT" } & DesignSystem["styles"]["text"][number])
	| ({ type: "EFFECT" } & DesignSystem["styles"]["effect"][number]);

type Bindings = {
	/** Hex colors of the variables bound to paints, by variable ID. */
	colors: Map<string, string>;
	/** Each bound field with its variable ID and resolved value. */
	fields: [BindableField, { id: string; value: VariableValue } | null][];
	styles: [StyleSlot, Style | null][];
};

/** `nextId` gives each new node its ID, shared with the other fakes. */
export function createFakeEditor(doc: DocumentFixture, nextId: () => string) {
	const variables = new Map(
		doc.collections.flatMap((collection) =>
			collection.variables.map((variable) => [
				variable.id,
				{ variable, defaultMode: collection.defaultMode },
			]),
		),
	);
	const styles = new Map<string, Style>([
		...doc.styles.paint.map((s) => [s.id, { ...s, type: "PAINT" }] as const),
		...doc.styles.text.map((s) => [s.id, { ...s, type: "TEXT" }] as const),
		...doc.styles.effect.map((s) => [s.id, { ...s, type: "EFFECT" }] as const),
	]);

	/** A variable's value in its collection's default mode, aliases followed. */
	function resolve(id: string): VariableValue {
		const { variable, defaultMode } = variables.get(id) as {
			variable: VariableInfo;
			defaultMode: string;
		};
		const value = variable.valuesByMode[defaultMode] as VariableValue;
		return typeof value === "object" && "alias" in value
			? resolve(value.alias)
			: value;
	}

	function findVariable(id: string, field: string, expected: string) {
		const variable = variables.get(id)?.variable;
		if (!variable) throw new FakeCommandError(variableNotFoundError(id));
		if (variable.type !== expected) {
			throw new FakeCommandError(
				variableTypeMismatchError(field, variable, expected),
			);
		}
		return { id, value: resolve(id) };
	}

	/** Looks up every variable and style the props name, checking types. */
	function resolveBindings(props: NodeProps): Bindings {
		const bindings: Bindings = { colors: new Map(), fields: [], styles: [] };
		for (const key of ["fills", "strokes"] as const) {
			for (const paint of props[key] ?? []) {
				if (paint.type !== "SOLID" || !paint.variable) continue;
				const { value } = findVariable(paint.variable, key, "COLOR");
				bindings.colors.set(paint.variable, (value as { color: string }).color);
			}
		}
		for (const [name, id] of Object.entries(props.variables ?? {})) {
			const field = name as BindableField;
			bindings.fields.push([
				field,
				id === null
					? null
					: findVariable(id, field, BINDABLE_FIELD_TYPES[field]),
			]);
		}
		for (const [name, id] of Object.entries(props.styles ?? {})) {
			const slot = name as StyleSlot;
			if (id === null) {
				bindings.styles.push([slot, null]);
				continue;
			}
			const style = styles.get(id);
			if (!style) throw new FakeCommandError(styleNotFoundError(id));
			const expected = STYLE_SLOTS[slot];
			if (style.type !== expected) {
				throw new FakeCommandError(
					styleTypeMismatchError(slot, style, expected),
				);
			}
			if (style.type === "TEXT") checkFont(style.fontName);
			bindings.styles.push([slot, style]);
		}
		return bindings;
	}

	/** Raw props first, then bound values, then styles, as Figma applies them. */
	function applyProps(node: SerializedNode, props: NodeProps) {
		const bindings = resolveBindings(props);
		applyRawProps(node, props, bindings.colors);
		applyRawProps(node, boundValues(node, bindings.fields), bindings.colors);
		const bound: Record<string, string> = { ...node.variables };
		for (const [field, binding] of bindings.fields) {
			if (binding) bound[field] = binding.id;
			else delete bound[field];
		}
		node.variables = bound;
		if (Object.keys(bound).length === 0) delete node.variables;
		applyStyles(node, bindings.styles);
	}

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
							id: nextId(),
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
		const id = nextId();
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
		/** Returns a failure for the whole command, or the command's result. */
		create_nodes({
			parentId,
			nodes,
		}: CommandParams<"create_nodes">):
			| CommandResult<"create_nodes">
			| BridgeError {
			try {
				const parent = find(parentId ?? doc.currentPageId);
				const siblings = parent.children;
				const invalid = parentError(
					{ id: parent.id, type: parent.type ?? "PAGE", parent: null },
					siblings !== undefined,
				);
				if (invalid || !siblings) return invalid as BridgeError;
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

/** The raw props that give each bound field its variable's value. */
function boundValues(
	node: SerializedNode,
	fields: Bindings["fields"],
): NodeProps {
	const props: NodeProps = {};
	const radius = node.cornerRadius ?? 0;
	const corners =
		typeof radius === "number"
			? {
					topLeft: radius,
					topRight: radius,
					bottomRight: radius,
					bottomLeft: radius,
				}
			: { ...radius };
	const padding: Record<string, number> = {};
	const layout: NonNullable<NodeProps["layout"]> = {};
	const text: NonNullable<NodeProps["text"]> = {};
	for (const [field, binding] of fields) {
		if (!binding) continue;
		const value = binding.value as never;
		switch (field) {
			case "width":
			case "height":
			case "opacity":
			case "visible":
			case "strokeWeight":
				props[field] = value;
				break;
			case "itemSpacing":
				layout.itemSpacing = value;
				break;
			case "paddingTop":
			case "paddingRight":
			case "paddingBottom":
			case "paddingLeft":
				padding[field.slice("padding".length).toLowerCase()] = value;
				break;
			case "topLeftRadius":
			case "topRightRadius":
			case "bottomRightRadius":
			case "bottomLeftRadius":
				corners[field.slice(0, -"Radius".length) as keyof typeof corners] =
					value;
				props.cornerRadius = corners;
				break;
			case "characters":
			case "fontSize":
				text[field] = value;
				break;
			case "fontFamily":
			case "fontStyle": {
				const font = node.text?.fontName;
				if (font && font !== "mixed") {
					const key = field === "fontFamily" ? "family" : "style";
					text.fontName = { ...font, ...text.fontName, [key]: value };
				}
				break;
			}
			// Other fields have no read-shape counterpart.
		}
	}
	if (Object.keys(padding).length > 0) layout.padding = padding;
	if (Object.keys(layout).length > 0) props.layout = layout;
	if (Object.keys(text).length > 0) props.text = text;
	return props;
}

function applyStyles(node: SerializedNode, slots: Bindings["styles"]) {
	const applied: Record<string, string> = { ...node.styles };
	for (const [slot, style] of slots) {
		if (!style) {
			delete applied[slot];
			continue;
		}
		applied[slot] = style.id;
		if (style.type === "PAINT" && slot === "fill") {
			node.fills = structuredClone(style.paints);
		}
		if (style.type === "PAINT" && slot === "stroke") {
			node.strokes = structuredClone(style.paints);
			node.strokeWeight ??= 1;
		}
		if (style.type === "TEXT" && node.text) {
			node.text.fontName = { ...style.fontName };
			node.text.fontSize = style.fontSize;
		}
	}
	node.styles = applied;
	if (Object.keys(applied).length === 0) delete node.styles;
}

/** Writes props the way they read back: defaults omitted, hex lowercase. */
function applyRawProps(
	node: SerializedNode,
	props: NodeProps,
	colors: Map<string, string>,
) {
	const {
		text,
		layout,
		cornerRadius,
		fills,
		strokes,
		variables: _variables,
		styles: _styles,
		...plain
	} = props;
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
	// Setting paints directly detaches their style.
	if (fills) {
		node.fills = fills.map((input) => paint(input, colors));
		if (node.styles) delete node.styles.fill;
	}
	if (strokes) {
		node.strokes = strokes.map((input) => paint(input, colors));
		node.strokeWeight ??= 1;
		if (node.styles) delete node.styles.stroke;
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

function paint(input: PaintInput, colors: Map<string, string>): Paint {
	const out = { ...input } as Paint;
	if (out.opacity === 1) delete out.opacity;
	if (out.type === "SOLID" && out.variable) {
		out.color = colors.get(out.variable) as string;
	}
	return out;
}
