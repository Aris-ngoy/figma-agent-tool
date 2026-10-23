// Write commands: create and update nodes in batches. Each item succeeds or
// fails on its own, and every batch lands as one undoable step in Figma.
//
// While its window is hidden, Figma can stall a plugin for about a minute at
// any `await`. So each batch first does all its async work (lookups, then
// every font at once), checks the server is still waiting, and only then
// edits the document synchronously: a stall can delay a batch but never
// leave it half done. Applying styles is the one async step after that.
import {
	BINDABLE_FIELD_TYPES,
	BINDABLE_TEXT_FIELDS,
	type BindableField,
	type BridgeError,
	type CommandParams,
	type CommandResult,
	type CreatedNode,
	type NodeProps,
	type NodeSpec,
	type PaintInput,
	parentError,
	STYLE_SLOTS,
	type StyleSlot,
	type UpdatedNode,
} from "@figma-agent-tool/protocol";
import {
	CommandError,
	checkDeadline,
	type Deadline,
	NO_DEADLINE,
	nodeNotFound,
	toBridgeError,
} from "./errors";

/** The font Figma gives new text nodes. */
const DEFAULT_FONT: FontName = { family: "Inter", style: "Regular" };

type Container = BaseNode & ChildrenMixin;

/** A node spec with its lookups done, ready to create synchronously. */
type PreparedNode = {
	spec: NodeSpec;
	error?: BridgeError;
	component?: ComponentNode;
	bindings: Bindings;
	fonts: FontName[];
	children?: PreparedNode[];
};

/** A style to apply once the batch's synchronous edits are done. */
type StyleJob = {
	node: BaseNode;
	slot: StyleSlot;
	style: BaseStyle | null;
	/** Marks the node's item failed if the style can't be applied. */
	fail(error: BridgeError): void;
};

export async function createNodes(
	{ parentId, nodes }: CommandParams<"create_nodes">,
	deadline: Deadline = NO_DEADLINE,
): Promise<CommandResult<"create_nodes">> {
	const parent = parentId
		? await figma.getNodeByIdAsync(parentId)
		: figma.currentPage;
	if (!parent) throw nodeNotFound(parentId as string);
	const invalid = parentError(parent, "appendChild" in parent);
	if (invalid) throw new CommandError(invalid.code, invalid.message);
	const container = parent as Container;
	if (container.type === "PAGE") await container.loadAsync();
	const prepared = await Promise.all(nodes.map(prepareNode));
	const failedFonts = await loadFonts(prepared.flatMap(allFonts));
	checkDeadline(deadline);

	const styleJobs: StyleJob[] = [];
	const created: SceneNode[] = [];
	const results = prepared.map((item) =>
		buildNode(item, container, failedFonts, styleJobs, created),
	);
	await applyStyles(styleJobs);
	if (deadline.passed()) {
		// Styles stalled past the deadline: undo the batch rather than leave
		// nodes the agent was told weren't made.
		for (const node of created) if (!node.removed) node.remove();
		checkDeadline(deadline);
	}
	figma.commitUndo();
	return { nodes: results };
}

/** Validates a spec and does its lookups, collecting the fonts it needs. */
async function prepareNode(spec: NodeSpec): Promise<PreparedNode> {
	const { type, componentId, children, ...props } = spec;
	try {
		if (children && type !== "FRAME") {
			throw new CommandError(
				"cannot_have_children",
				`A ${type} can't hold children; nest them in a FRAME instead.`,
			);
		}
		const [component, bindings, preparedChildren] = await Promise.all([
			type === "INSTANCE" ? findComponent(componentId) : undefined,
			resolveBindings(props),
			children ? Promise.all(children.map(prepareNode)) : undefined,
		]);
		const fonts =
			type === "TEXT"
				? [props.text?.fontName ?? DEFAULT_FONT, ...styleFonts(bindings)]
				: [];
		return {
			spec,
			component,
			bindings,
			fonts,
			children: preparedChildren,
		};
	} catch (error) {
		return {
			spec,
			error: toBridgeError(error),
			bindings: NO_BINDINGS,
			fonts: [],
		};
	}
}

function allFonts(item: PreparedNode): FontName[] {
	return [...item.fonts, ...(item.children ?? []).flatMap(allFonts)];
}

/** Creates a prepared node and its children; synchronous up to styles. */
function buildNode(
	item: PreparedNode,
	parent: Container,
	failedFonts: Set<string>,
	styleJobs: StyleJob[],
	created: SceneNode[],
): CreatedNode {
	if (item.error) return { ok: false, error: item.error };
	const { type, componentId, children, ...props } = item.spec;
	let node: SceneNode | undefined;
	// Filled in below; a failed style replaces it with the error.
	const result = { ok: true } as CreatedNode;
	try {
		throwIfFontFailed(item.fonts, failedFonts);
		const made = instantiate(type, item.component);
		node = made;
		parent.appendChild(made);
		applyProps(made, props, item.bindings, styleJobs, (error) => {
			made.remove();
			replaceWithError(result, error);
		});
		Object.assign(result, { id: made.id, name: made.name, type: made.type });
		if (item.children) {
			const container = made as FrameNode;
			Object.assign(result, {
				children: item.children.map((child) =>
					buildNode(child, container, failedFonts, styleJobs, []),
				),
			});
		}
		created.push(made);
		return result;
	} catch (error) {
		node?.remove();
		return { ok: false, error: toBridgeError(error) };
	}
}

/** Turns an item's result into a failure in place, keeping its position. */
function replaceWithError(result: CreatedNode, error: BridgeError) {
	for (const key of Object.keys(result)) {
		delete (result as Record<string, unknown>)[key];
	}
	Object.assign(result, { ok: false, error });
}

/** Makes the bare node. */
function instantiate(
	type: NodeSpec["type"],
	component: ComponentNode | undefined,
): SceneNode {
	switch (type) {
		case "FRAME":
			return figma.createFrame();
		case "RECTANGLE":
			return figma.createRectangle();
		case "TEXT":
			return figma.createText();
		case "INSTANCE":
			return (component as ComponentNode).createInstance();
	}
}

async function findComponent(
	componentId: string | undefined,
): Promise<ComponentNode> {
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
	return component;
}

/** A node to update with its lookups done. */
type PreparedUpdate = {
	id: string;
	props: NodeProps;
	error?: BridgeError;
	node?: BaseNode;
	bindings: Bindings;
	fonts: FontName[];
};

export async function updateNodes(
	{ updates }: CommandParams<"update_nodes">,
	deadline: Deadline = NO_DEADLINE,
): Promise<CommandResult<"update_nodes">> {
	const prepared = await Promise.all(updates.map(prepareUpdate));
	const failedFonts = await loadFonts(prepared.flatMap((item) => item.fonts));
	checkDeadline(deadline);

	const styleJobs: StyleJob[] = [];
	const results = prepared.map((item): UpdatedNode => {
		const { id, node, props, bindings } = item;
		if (item.error) return { id, ok: false, error: item.error };
		const result: UpdatedNode = { id, ok: true };
		try {
			throwIfFontFailed(item.fonts, failedFonts);
			applyProps(node as BaseNode, props, bindings, styleJobs, (error) =>
				Object.assign(result, { ok: false, error }),
			);
		} catch (error) {
			return { id, ok: false, error: toBridgeError(error) };
		}
		return result;
	});
	await applyStyles(styleJobs);
	figma.commitUndo();
	return { nodes: results };
}

async function prepareUpdate({
	id,
	...props
}: CommandParams<"update_nodes">["updates"][number]): Promise<PreparedUpdate> {
	try {
		const [node, bindings] = await Promise.all([
			figma.getNodeByIdAsync(id),
			resolveBindings(props),
		]);
		if (!node) throw nodeNotFound(id);
		const fonts =
			node.type === "TEXT" ? fontsNeeded(node, props, bindings) : [];
		return { id, props, node, bindings, fonts };
	} catch (error) {
		return {
			id,
			props,
			error: toBridgeError(error),
			bindings: NO_BINDINGS,
			fonts: [],
		};
	}
}

/**
 * Sets the given properties synchronously; the fonts they need must be
 * loaded and their variables and styles resolved. Unsupported properties are
 * caught before anything changes. Order matters: auto-layout before sizing,
 * explicit sizes after text, which can resize the node, and styles last (as
 * jobs run after the batch's edits), so they win over raw values.
 */
function applyProps(
	target: BaseNode,
	props: NodeProps,
	bindings: Bindings,
	styleJobs: StyleJob[],
	fail: StyleJob["fail"],
) {
	const missing = unsupportedProp(target, props);
	if (missing) {
		throw new CommandError(
			"unsupported_property",
			`Node ${target.id} is a ${target.type}, which has no ${missing}.`,
		);
	}
	if (props.text) applyText(target as TextNode, props.text);

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
	const toPaint = (paint: PaintInput) => figmaPaint(paint, bindings.variables);
	if (props.fills) node.fills = props.fills.map(toPaint);
	if (props.strokes) node.strokes = props.strokes.map(toPaint);
	if (props.strokeWeight !== undefined) node.strokeWeight = props.strokeWeight;
	if (sizing?.horizontal) node.layoutSizingHorizontal = sizing.horizontal;
	if (sizing?.vertical) node.layoutSizingVertical = sizing.vertical;
	for (const [field, variable] of bindings.fields) {
		(node as unknown as TextNode).setBoundVariable(
			field as VariableBindableTextField,
			variable,
		);
	}
	for (const [slot, style] of bindings.styles) {
		styleJobs.push({ node, slot, style, fail });
	}
}

/**
 * Applies the batch's styles all at once (Figma only has async setters).
 * Each node's styles run in order, after its raw values.
 */
async function applyStyles(jobs: StyleJob[]) {
	const byNode = new Map<BaseNode, StyleJob[]>();
	for (const job of jobs) {
		byNode.set(job.node, [...(byNode.get(job.node) ?? []), job]);
	}
	await Promise.all(
		[...byNode.values()].map(async (nodeJobs) => {
			for (const { node, slot, style, fail } of nodeJobs) {
				try {
					await STYLE_SETTERS[slot](node as TextNode, style?.id ?? "");
				} catch (error) {
					fail(toBridgeError(error));
					return;
				}
			}
		}),
	);
}

type Bindings = {
	/** Variables bound to paints, by ID. */
	variables: Map<string, Variable>;
	/** null unbinds the field. */
	fields: [BindableField, Variable | null][];
	/** null detaches the style. */
	styles: [StyleSlot, BaseStyle | null][];
};

const NO_BINDINGS: Bindings = { variables: new Map(), fields: [], styles: [] };

/** Looks up every variable and style the props name, checking their types. */
async function resolveBindings(props: NodeProps): Promise<Bindings> {
	const bindings: Bindings = { variables: new Map(), fields: [], styles: [] };
	for (const key of ["fills", "strokes"] as const) {
		for (const paint of props[key] ?? []) {
			if (paint.type !== "SOLID" || !paint.variable) continue;
			const variable = await findVariable(paint.variable, key, "COLOR");
			bindings.variables.set(variable.id, variable);
		}
	}
	for (const [name, id] of Object.entries(props.variables ?? {})) {
		const field = name as BindableField;
		bindings.fields.push([
			field,
			id === null
				? null
				: await findVariable(id, field, BINDABLE_FIELD_TYPES[field]),
		]);
	}
	for (const [name, id] of Object.entries(props.styles ?? {})) {
		const slot = name as StyleSlot;
		bindings.styles.push([
			slot,
			id === null ? null : await findStyle(id, slot),
		]);
	}
	return bindings;
}

async function findVariable(
	id: string,
	field: string,
	expected: VariableResolvedDataType,
): Promise<Variable> {
	const variable = await figma.variables.getVariableByIdAsync(id);
	if (!variable) {
		throw new CommandError(
			"variable_not_found",
			`No variable with ID "${id}" exists in this file. Get variable IDs from get_design_system.`,
		);
	}
	if (variable.resolvedType !== expected) {
		throw new CommandError(
			"variable_type_mismatch",
			`Variable "${variable.name}" (${id}) is a ${variable.resolvedType} variable; ${field} needs a ${expected} one.`,
		);
	}
	return variable;
}

async function findStyle(id: string, slot: StyleSlot): Promise<BaseStyle> {
	const style = await figma.getStyleByIdAsync(id);
	if (!style) {
		throw new CommandError(
			"style_not_found",
			`No style with ID "${id}" exists in this file. Get style IDs from get_design_system.`,
		);
	}
	const expected = STYLE_SLOTS[slot];
	if (style.type !== expected) {
		throw new CommandError(
			"style_type_mismatch",
			`Style "${style.name}" (${id}) is a ${style.type} style; styles.${slot} needs a ${expected} one.`,
		);
	}
	return style;
}

const STYLE_SETTERS: Record<
	StyleSlot,
	(node: TextNode, id: string) => Promise<void>
> = {
	fill: (node, id) => node.setFillStyleIdAsync(id),
	stroke: (node, id) => node.setStrokeStyleIdAsync(id),
	text: (node, id) => node.setTextStyleIdAsync(id),
	effect: (node, id) => node.setEffectStyleIdAsync(id),
};

/** The node property each style slot needs. */
const STYLE_MEMBERS: Record<Exclude<StyleSlot, "text">, string> = {
	fill: "fills",
	stroke: "strokes",
	effect: "effects",
};

/**
 * Text edits need the node's fonts loaded; switching font needs only the new
 * one, and a text style needs its own font too.
 */
function fontsNeeded(
	node: TextNode,
	props: NodeProps,
	bindings: Bindings,
): FontName[] {
	const fonts: FontName[] = [];
	const bindsText = bindings.fields.some(
		([field]) => field in BINDABLE_TEXT_FIELDS || field === "characters",
	);
	const stylesText = bindings.styles.some(([slot]) => slot === "text");
	if (props.text?.fontName) fonts.push(props.text.fontName);
	else if (props.text || bindsText || stylesText) {
		fonts.push(...currentFonts(node));
	}
	return [...fonts, ...styleFonts(bindings)];
}

/** Fonts the text styles being applied use. */
function styleFonts(bindings: Bindings): FontName[] {
	return bindings.styles.flatMap(([, style]) =>
		style?.type === "TEXT" ? [(style as TextStyle).fontName] : [],
	);
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
	for (const field of Object.keys(props.variables ?? {})) {
		const has =
			field in BINDABLE_TEXT_FIELDS ? node.type === "TEXT" : field in node;
		if (!has) return `variables.${field}`;
	}
	for (const slot of Object.keys(props.styles ?? {}) as StyleSlot[]) {
		const has =
			slot === "text" ? node.type === "TEXT" : STYLE_MEMBERS[slot] in node;
		if (!has) return `styles.${slot}`;
	}
	return undefined;
}

function applyText(node: TextNode, text: NonNullable<NodeProps["text"]>) {
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

const fontKey = (font: FontName) => `${font.family} ${font.style}`;

/** Loads each distinct font once, all at the same time; returns those that failed. */
async function loadFonts(fonts: FontName[]): Promise<Set<string>> {
	const unique = new Map(fonts.map((font) => [fontKey(font), font]));
	const failed = new Set<string>();
	await Promise.all(
		[...unique].map(async ([key, font]) => {
			try {
				await figma.loadFontAsync(font);
			} catch {
				failed.add(key);
			}
		}),
	);
	return failed;
}

function throwIfFontFailed(fonts: FontName[], failed: Set<string>) {
	const font = fonts.find((candidate) => failed.has(fontKey(candidate)));
	if (font) {
		throw new CommandError(
			"font_not_found",
			`Font "${font.family} ${font.style}" isn't available in this file. Use an installed font, such as one an existing text node's fontName shows.`,
		);
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

function figmaPaint(
	paint: PaintInput,
	variables: Map<string, Variable>,
): Paint {
	const extras = {
		opacity: paint.opacity ?? 1,
		visible: paint.visible ?? true,
	};
	switch (paint.type) {
		case "SOLID": {
			const solid: SolidPaint = {
				type: paint.type,
				// A bound variable supplies the color.
				color: rgb(paint.color ?? "#000000"),
				...extras,
			};
			const variable = paint.variable && variables.get(paint.variable);
			return variable
				? figma.variables.setBoundVariableForPaint(solid, "color", variable)
				: solid;
		}
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
