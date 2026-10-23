// Prototype graph → handoff Markdown. Pure: everything it renders is passed
// in, and the same input always renders the same bytes.
import {
	type DanglingEdge,
	type DesignSystem,
	type Easing,
	type FileInfo,
	type FlowEdge,
	type FlowScreen,
	type PrototypeGraph,
	type SerializedNode,
	STYLE_SLOTS,
	type StyleSlot,
	type Transition,
	type Trigger,
	type VariableValue,
} from "@figma-agent-tool/protocol";

/** What both exports render from. */
export type Handoff = {
	/** The bridged file; links to Figma need its key. */
	file: FileInfo | null;
	/** The traced graph; a screen export renders only `graph.start`. */
	graph: PrototypeGraph;
	/** Each screen's layer tree (full depth), in `graph.screens` order. */
	trees: SerializedNode[];
	designSystem: DesignSystem;
};

/**
 * A whole flow: a header, then one section per screen in walk order. `name`
 * is the flow's, or the start screen's when no flow starts there.
 */
export function renderFlowMarkdown(
	handoff: Handoff & { name: string },
): string {
	const { file, graph, name } = handoff;
	const context = contextOf(handoff);
	const start = graph.screens[0];
	const header = [
		`# Flow: ${name}`,
		"",
		...whereFacts(file, graph),
		`- Start: ${start ? ref(start) : graph.start}`,
		`- Screens: ${graph.screens.length}`,
		...(graph.truncated
			? [
					`- Truncated: screens at depth ${Math.max(...graph.screens.map((s) => s.depth))} are listed without their interactions`,
				]
			: []),
	];
	const sections = graph.screens.map((screen) =>
		[
			`## Screen: ${ref(screen)}`,
			"",
			...screenFacts(screen, context),
			`- Depth: ${screen.depth}`,
			"",
			...screenBody(screen, context, "###"),
		].join("\n"),
	);
	return `${[header.join("\n"), ...sections].join("\n\n")}\n`;
}

/** One screen: its facts, interactions, tokens and components. */
export function renderScreenMarkdown(handoff: Handoff): string {
	const { file, graph } = handoff;
	const context = contextOf(handoff);
	const screen = graph.screens.find(({ id }) => id === graph.start);
	if (!screen) throw new Error(`Screen ${graph.start} isn't in the graph.`);
	return `${[
		`# Screen: ${ref(screen)}`,
		"",
		...whereFacts(file, graph),
		...screenFacts(screen, context),
		"",
		...screenBody(screen, context, "##"),
	].join("\n")}\n`;
}

type Context = {
	file: FileInfo | null;
	graph: PrototypeGraph;
	trees: Map<string, SerializedNode>;
	designSystem: DesignSystem;
	/** Node names by ID: screens, their layers, components and variants. */
	names: Map<string, string>;
};

function contextOf({ file, graph, trees, designSystem }: Handoff): Context {
	const names = new Map<string, string>();
	for (const component of designSystem.components) {
		names.set(component.id, component.name);
		for (const variant of component.variants ?? []) {
			names.set(variant.id, `${component.name} / ${variant.name}`);
		}
	}
	const addNames = (node: SerializedNode) => {
		names.set(node.id, node.name);
		for (const child of node.children ?? []) addNames(child);
	};
	for (const tree of trees) addNames(tree);
	for (const screen of graph.screens) names.set(screen.id, screen.name);
	return {
		file,
		graph,
		trees: new Map(trees.map((tree) => [tree.id, tree])),
		designSystem,
		names,
	};
}

function whereFacts(file: FileInfo | null, { page }: PrototypeGraph): string[] {
	return [...(file ? [`- File: ${file.name}`] : []), `- Page: ${ref(page)}`];
}

function screenFacts(screen: FlowScreen, { file }: Context): string[] {
	const size =
		screen.width === undefined
			? "—"
			: `${screen.width}×${screen.height ?? "—"}`;
	return [
		...(file?.key
			? [`- Link: ${figmaLink(file.key, file.name, screen.id)}`]
			: []),
		`- Size: ${size}`,
	];
}

function screenBody(
	screen: FlowScreen,
	context: Context,
	level: string,
): string[] {
	const { graph } = context;
	const tree = context.trees.get(screen.id);
	const edges = graph.edges.filter((edge) => edge.from === screen.id);
	const dangling = graph.dangling.filter((edge) => edge.from === screen.id);
	return [
		`${level} Interactions`,
		"",
		table(
			[
				"Layer",
				"Trigger",
				"Action",
				"Destination",
				"Transition",
				"Direction",
				"Easing",
				"Duration",
			],
			edges.map((edge) => interactionRow(edge, context)),
		),
		"",
		`${level} Broken interactions`,
		"",
		table(
			["Layer", "Trigger", "Action", "Destination", "Reason"],
			dangling.map((edge) => brokenRow(edge, context)),
		),
		"",
		`${level} Tokens`,
		"",
		table(
			["Token", "Kind", "Value", "Used for"],
			tree ? tokenRows(tree, context.designSystem) : [],
		),
		"",
		`${level} Components`,
		"",
		table(
			["Layer", "Component", "Properties"],
			tree ? componentRows(tree, context) : [],
		),
	];
}

/** `https://www.figma.com/design/<key>/<File-name>?node-id=1-2` */
function figmaLink(key: string, fileName: string, nodeId: string): string {
	const slug = fileName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
	return `https://www.figma.com/design/${key}/${slug}?node-id=${nodeId.replace(":", "-")}`;
}

/** A GitHub table, or `None.` without rows so every heading has a body. */
function table(header: string[], rows: string[][]): string {
	if (rows.length === 0) return "None.";
	const line = (cells: string[]) =>
		`| ${cells.map((cell) => cell.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ")).join(" | ")} |`;
	return [line(header), line(header.map(() => "---")), ...rows.map(line)].join(
		"\n",
	);
}

const NONE = "—";

function ref({ id, name }: { id: string; name: string }): string {
	return `${name} (${id})`;
}

function nodeRef(id: string, { names }: Context, fallback?: string): string {
	const name = names.get(id) ?? fallback;
	return name === undefined ? id : `${name} (${id})`;
}

function interactionRow(edge: FlowEdge, context: Context): string[] {
	return [
		ref({ id: edge.nodeId, name: edge.nodeName }),
		describeTrigger(edge.trigger),
		describeAction(edge),
		destination(edge, context),
		...describeTransition(edge.transition),
	];
}

function brokenRow(edge: DanglingEdge, context: Context): string[] {
	return [
		ref({ id: edge.nodeId, name: edge.nodeName }),
		describeTrigger(edge.trigger),
		describeAction(edge),
		destination(edge, context),
		edge.reason,
	];
}

function destination(edge: FlowEdge, context: Context): string {
	if (edge.action === "URL") return edge.url ?? NONE;
	return edge.to === null ? NONE : nodeRef(edge.to, context);
}

/** Figma's trigger type, with its timing or keys when it has them. */
function describeTrigger(trigger: Trigger | null): string {
	if (!trigger) return NONE;
	switch (trigger.type) {
		case "AFTER_TIMEOUT":
			return `${trigger.type} ${seconds(trigger.timeout)}`;
		case "MOUSE_UP":
		case "MOUSE_DOWN":
		case "MOUSE_ENTER":
		case "MOUSE_LEAVE":
			return trigger.delay > 0
				? `${trigger.type} ${seconds(trigger.delay)}`
				: trigger.type;
		case "ON_KEY_DOWN":
			return `${trigger.type} ${trigger.device} ${trigger.keyCodes.join("+")}`;
		case "ON_MEDIA_HIT":
			return `${trigger.type} ${seconds(trigger.mediaHitTime)}`;
		default:
			return trigger.type;
	}
}

function describeAction(edge: FlowEdge): string {
	const position = edge.overlayRelativePosition;
	return [
		edge.action,
		...(position ? [`at ${position.x},${position.y}`] : []),
		...(edge.openInNewTab ? ["(new tab)"] : []),
		...(edge.conditional ? ["(conditional)"] : []),
	].join(" ");
}

/** Transition, direction, easing and duration cells. */
function describeTransition(transition: Transition | null): string[] {
	if (!transition) return ["INSTANT", NONE, NONE, NONE];
	const directional = "direction" in transition;
	return [
		directional && transition.matchLayers
			? `${transition.type} (match layers)`
			: transition.type,
		directional ? transition.direction : NONE,
		describeEasing(transition.easing),
		`${round(transition.duration * 1000)}ms`,
	];
}

function describeEasing(easing: Easing): string {
	switch (easing.type) {
		case "CUSTOM_CUBIC_BEZIER": {
			const { x1, y1, x2, y2 } = easing.easingFunctionCubicBezier;
			return `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`;
		}
		case "CUSTOM_SPRING": {
			const { mass, stiffness, damping, initialVelocity } =
				easing.easingFunctionSpring;
			return `spring(mass ${mass}, stiffness ${stiffness}, damping ${damping}, velocity ${initialVelocity})`;
		}
		default:
			return easing.type;
	}
}

function seconds(value: number): string {
	return `${round(value)}s`;
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}

/**
 * The visible layers of a screen that the developer implements: instances
 * are their component's business, so their insides aren't walked (their own
 * bindings and overrides still count).
 */
function visibleLayers(root: SerializedNode): SerializedNode[] {
	if (root.visible === false) return [];
	if (root.type === "INSTANCE") return [root];
	return [root, ...(root.children ?? []).flatMap(visibleLayers)];
}

type TokenUse = {
	kind: "variable" | StyleSlot;
	id: string;
	fields: Set<string>;
};

/** Variables then styles, each by name, with the fields that use them. */
function tokenRows(tree: SerializedNode, designSystem: DesignSystem) {
	const uses = new Map<string, TokenUse>();
	const use = (kind: TokenUse["kind"], id: string, field: string) => {
		if (id === "mixed") return;
		const key = `${kind === "variable" ? kind : "style"}:${id}`;
		const entry = uses.get(key) ?? { kind, id, fields: new Set() };
		entry.fields.add(field);
		uses.set(key, entry);
	};
	for (const node of visibleLayers(tree)) {
		for (const [field, id] of Object.entries(node.variables ?? {})) {
			use("variable", id, field);
		}
		for (const [field, paints] of [
			["fill", node.fills],
			["stroke", node.strokes],
		] as const) {
			if (!Array.isArray(paints)) continue;
			for (const paint of paints) {
				if (paint.type === "SOLID" && paint.variable) {
					use("variable", paint.variable, field);
				}
			}
		}
		for (const [slot, id] of Object.entries(node.styles ?? {})) {
			use(slot as StyleSlot, id, slot);
		}
	}
	const variables = new Map(
		designSystem.collections.flatMap((collection) =>
			collection.variables.map(
				(variable) => [variable.id, { collection, variable }] as const,
			),
		),
	);
	const variableName = (id: string) => variables.get(id)?.variable.name ?? id;
	type Row = [token: string, kind: string, value: string, usedFor: string];
	const rows = [...uses.values()].map(
		({ kind, id, fields }): { order: number; row: Row } => {
			const usedFor = [...fields].sort().join(", ");
			if (kind === "variable") {
				const found = variables.get(id);
				if (!found) {
					return { order: 0, row: [id, "variable", NONE, usedFor] };
				}
				const { collection, variable } = found;
				const values = collection.modes.map(({ name }) => {
					const value = describeValue(
						variable.valuesByMode[name] ?? null,
						variableName,
					);
					return collection.modes.length > 1 ? `${name}: ${value}` : value;
				});
				return {
					order: 0,
					row: [
						variable.name,
						`${variable.type} variable`,
						values.join("; "),
						usedFor,
					],
				};
			}
			const type = STYLE_SLOTS[kind];
			const style = describeStyle(type, id, designSystem);
			return {
				order: 1,
				row: [
					style?.name ?? id,
					`${type} style`,
					style?.value ?? NONE,
					usedFor,
				],
			};
		},
	);
	return rows
		.sort((a, b) => a.order - b.order || compare(a.row[0], b.row[0]))
		.map(({ row }) => row);
}

function describeValue(
	value: VariableValue | null,
	variableName: (id: string) => string,
): string {
	if (value === null) return NONE;
	if (typeof value !== "object") return String(value);
	if ("alias" in value) return `→ ${variableName(value.alias)}`;
	return hex(value.color, value.opacity);
}

function hex(color: string, opacity?: number): string {
	return opacity === undefined || opacity === 1
		? color
		: `${color} ${round(opacity * 100)}%`;
}

function describeStyle(
	type: (typeof STYLE_SLOTS)[StyleSlot],
	id: string,
	{ styles }: DesignSystem,
): { name: string; value: string } | undefined {
	switch (type) {
		case "PAINT": {
			const style = styles.paint.find((s) => s.id === id);
			return (
				style && {
					name: style.name,
					value: style.paints
						.map((paint) =>
							paint.type === "SOLID"
								? hex(paint.color, paint.opacity)
								: paint.type,
						)
						.join(", "),
				}
			);
		}
		case "TEXT": {
			const style = styles.text.find((s) => s.id === id);
			if (!style) return undefined;
			const { fontName, fontSize, lineHeight, letterSpacing } = style;
			const unit = (u: "PIXELS" | "PERCENT") => (u === "PIXELS" ? "px" : "%");
			return {
				name: style.name,
				value: [
					`${fontName.family} ${fontName.style} ${fontSize}${lineHeight ? `/${lineHeight.value}${unit(lineHeight.unit)}` : ""}`,
					...(letterSpacing
						? [
								`letter-spacing ${letterSpacing.value}${unit(letterSpacing.unit)}`,
							]
						: []),
				].join(", "),
			};
		}
		case "EFFECT": {
			const style = styles.effect.find((s) => s.id === id);
			return (
				style && {
					name: style.name,
					value: style.effects.map((effect) => effect.type).join(", "),
				}
			);
		}
	}
}

/** Instances in layer order, with their component and property values. */
function componentRows(tree: SerializedNode, context: Context): string[][] {
	return visibleLayers(tree).flatMap((node) => {
		if (!node.instance || node === tree) return [];
		const { mainComponent, properties } = node.instance;
		const values = Object.entries(properties)
			// Figma suffixes non-variant property names with `#<id>`.
			.map(([name, value]): [string, string] => [
				name.replace(/#[^#]*$/, ""),
				String(value),
			])
			.sort(([a], [b]) => compare(a, b))
			.map(([name, value]) => `${name}=${value}`);
		return [
			[
				ref(node),
				mainComponent
					? nodeRef(mainComponent.id, context, mainComponent.name)
					: NONE,
				values.length > 0 ? values.join(", ") : NONE,
			],
		];
	});
}

/** Locale-independent, so output doesn't depend on where it runs. */
function compare(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}
