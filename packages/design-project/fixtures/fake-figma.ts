// What the Plugin does with a pushed tree, in serialized form: updates the
// layers it names by ID in place, creates the others, removes pushed layers
// the tree no longer has and leaves the designers' own layers be. The fake
// plugin (MCP tests) and the design-project tests share it; the plugin's
// own tests check the real thing against the mocked `figma` global.
import {
	type DesignSystemPush,
	FLOAT_BINDINGS,
	type Paint,
	type PushedDesignSystem,
	type ScreenFill,
	type ScreenNode,
	type SyncedDesignSystem,
	type SyncedNode,
	type TextStyleInfo,
	type VariableValue,
} from "@figma-agent-tool/protocol";

export function applyScreenTree(
	tree: ScreenNode,
	previous: SyncedNode | undefined,
	{
		nextId,
		imageHash,
		designSystem,
		remove = [],
	}: {
		nextId: () => string;
		imageHash: (name: string) => string;
		/** Where the trees' bindings point; bindings are dropped without it. */
		designSystem?: FakeDesignSystem;
		/** Layers to delete. */
		remove?: string[];
	},
): SyncedNode {
	const old = new Map<string, SyncedNode>();
	const index = (node: SyncedNode) => {
		old.set(node.id, node);
		node.children?.forEach(index);
	};
	if (previous) index(previous);
	const gone = new Set(remove);
	const placed = new Set<string>();

	/** A layer Push keeps as it is, placed only when the Screen moved it. */
	const keep = (spec: ScreenNode): SyncedNode | undefined => {
		const existing = spec.id ? old.get(spec.id) : undefined;
		if (!existing || gone.has(existing.id)) return undefined;
		placed.add(existing.id);
		const node = { ...structuredClone(existing), key: spec.key };
		if (!spec.place) return node;
		const { horizontal, vertical } = spec.sizing;
		Object.assign(node, {
			name: spec.name ?? node.name,
			width: horizontal === "FIXED" ? spec.width : node.width,
			height: vertical === "FIXED" ? spec.height : node.height,
			sizing: spec.sizing,
			x: spec.position?.x ?? node.x,
			y: spec.position?.y ?? node.y,
		});
		if (spec.position) node.absolute = { horizontal: "MIN", vertical: "MIN" };
		else delete node.absolute;
		return node;
	};

	const apply = (spec: ScreenNode, isRoot: boolean): SyncedNode => {
		const existing = spec.id ? old.get(spec.id) : undefined;
		const reuse = existing?.type === spec.type ? existing : undefined;
		const node: SyncedNode = {
			id: reuse?.id ?? nextId(),
			key: spec.key,
			type: spec.type,
			name: spec.name ?? spec.text?.characters ?? spec.type,
			visible: true,
			x: spec.position?.x ?? reuse?.x ?? 0,
			y: spec.position?.y ?? reuse?.y ?? 0,
			width: spec.width,
			height: spec.height,
			rotation: 0,
			opacity: spec.opacity ?? 1,
			sizing: isRoot ? { horizontal: "FIXED", vertical: "FIXED" } : spec.sizing,
			fills: spec.fills.map((fill) => paint(fill, imageHash)),
			strokes: spec.stroke ? 1 : 0,
			effects: 0,
			cornerRadius: spec.cornerRadius ?? 0,
		};
		if (spec.stroke) {
			const { color, weight, align, cap, join } = spec.stroke;
			node.stroke = {
				paint: { type: "SOLID", color },
				weight,
				align,
				cap: cap ?? "NONE",
				join: join ?? "MITER",
				dashed: false,
				...(spec.type === "FRAME" && { inLayout: true }),
			};
		}
		if (spec.clips !== undefined) node.clips = spec.clips;
		if (spec.vector) node.vector = structuredClone(spec.vector);
		if (spec.position) node.absolute = { horizontal: "MIN", vertical: "MIN" };
		if (spec.layout) node.layout = structuredClone(spec.layout);
		if (designSystem && spec.bindings) bind(node, spec.bindings, designSystem);
		if (spec.text) {
			const { characters, fontName, fontSize, textAlignHorizontal } = spec.text;
			node.text = {
				characters,
				fontName: { ...fontName },
				fontSize,
				textAlignHorizontal,
			};
		}
		if (spec.type === "FRAME") {
			const children = (spec.children ?? []).flatMap(
				(child) =>
					(child.type === "OWNED" ? keep(child) : apply(child, false)) ?? [],
			);
			// The designers' own layers (no key) stay, after the pushed ones.
			const kept = (reuse?.children ?? []).filter(
				(child) =>
					child.key === null && !placed.has(child.id) && !gone.has(child.id),
			);
			node.children = [...children, ...kept];
		}
		return node;
	};
	const frame = apply(tree, true);
	return designSystem ? designSystem.resolve(frame) : frame;
}

/** Records a pushed layer's bindings by variable and style ID, as Figma reads them. */
function bind(
	node: SyncedNode,
	bindings: NonNullable<ScreenNode["bindings"]>,
	designSystem: FakeDesignSystem,
) {
	const [fill] = node.fills as Paint[];
	const fillVariable = bindings.fill && designSystem.idOf(bindings.fill);
	if (fill?.type === "SOLID" && fillVariable) fill.variable = fillVariable;
	const bound: NonNullable<SyncedNode["bindings"]> = {};
	for (const field of [...FLOAT_BINDINGS, "textStyle"] as const) {
		const token = bindings[field];
		const id = token && designSystem.idOf(token);
		if (id) bound[field] = id;
	}
	if (Object.keys(bound).length > 0) node.bindings = bound;
}

export type FakeDesignSystem = ReturnType<typeof createFakeDesignSystem>;

type FakeVariable = {
	id: string;
	name: string;
	type: "COLOR" | "FLOAT";
	value: VariableValue;
};

/**
 * A file's variables and text styles, as Push makes them and designers edit
 * them. Frames read through `resolve` show bound layers with the current
 * values, as Figma does.
 */
export function createFakeDesignSystem(nextId: () => string) {
	const variables = new Map<string, FakeVariable>();
	const textStyles = new Map<string, TextStyleInfo>();
	/** Token path → ID, from the last Push. */
	const ids = new Map<string, string>();
	let collectionId: string | undefined;

	const resolved = (value: VariableValue): VariableValue | null => {
		if (typeof value === "object" && "alias" in value) {
			const target = variables.get(value.alias);
			return target ? resolved(target.value) : null;
		}
		return value;
	};

	return {
		variables,
		textStyles,
		idOf: (token: string) => ids.get(token),
		/** The variable with this name, as a designer finds it. */
		variable(name: string): FakeVariable {
			const found = [...variables.values()].find((v) => v.name === name);
			if (!found) throw new Error(`No variable ${name}`);
			return found;
		},
		textStyle(name: string): TextStyleInfo {
			const found = [...textStyles.values()].find((s) => s.name === name);
			if (!found) throw new Error(`No text style ${name}`);
			return found;
		},

		push(spec: DesignSystemPush): PushedDesignSystem {
			if (!collectionId || spec.collection.id !== collectionId)
				collectionId = spec.collection.id ?? nextId();
			for (const id of spec.remove.variables) variables.delete(id);
			for (const id of spec.remove.textStyles) textStyles.delete(id);
			const pushed: PushedDesignSystem = {
				collectionId,
				variables: {},
				textStyles: {},
			};
			for (const variable of spec.variables) {
				const id =
					variable.id && variables.has(variable.id) ? variable.id : nextId();
				pushed.variables[variable.token] = id;
				ids.set(variable.token, id);
			}
			for (const variable of spec.variables) {
				const { value } = variable;
				const id = pushed.variables[variable.token] as string;
				variables.set(id, {
					id,
					name: variable.name,
					type: variable.type,
					value:
						typeof value === "object" && "token" in value
							? { alias: pushed.variables[value.token] as string }
							: value,
				});
			}
			for (const { token, id: given, ...style } of spec.textStyles) {
				const id = given && textStyles.has(given) ? given : nextId();
				pushed.textStyles[token] = id;
				ids.set(token, id);
				textStyles.set(id, { id, ...structuredClone(style) });
			}
			return pushed;
		},

		read(params: {
			variables: string[];
			textStyles: string[];
		}): SyncedDesignSystem {
			return {
				variables: params.variables.flatMap((id) => {
					const variable = variables.get(id);
					if (!variable) return [];
					const { value, ...rest } = structuredClone(variable);
					return [{ ...rest, value, resolved: resolved(value) }];
				}),
				textStyles: params.textStyles.flatMap((id) => {
					const style = textStyles.get(id);
					return style ? [structuredClone(style)] : [];
				}),
			};
		},

		/** A frame with bound layers showing the variables' and styles' current values. */
		resolve(frame: SyncedNode): SyncedNode {
			const value = (id: string | undefined) => {
				const variable = id ? variables.get(id) : undefined;
				return variable ? resolved(variable.value) : null;
			};
			const walk = (node: SyncedNode) => {
				if (node.fills !== "mixed") {
					for (const fill of node.fills) {
						if (fill.type !== "SOLID") continue;
						const color = value(fill.variable);
						if (color && typeof color === "object" && "color" in color)
							fill.color = color.color;
					}
				}
				const bound = node.bindings ?? {};
				const number = (id: string | undefined) => {
					const v = value(id);
					return typeof v === "number" ? v : undefined;
				};
				if (node.layout) {
					const { layout } = node;
					layout.itemSpacing = number(bound.itemSpacing) ?? layout.itemSpacing;
					const { padding } = layout;
					padding.top = number(bound.paddingTop) ?? padding.top;
					padding.right = number(bound.paddingRight) ?? padding.right;
					padding.bottom = number(bound.paddingBottom) ?? padding.bottom;
					padding.left = number(bound.paddingLeft) ?? padding.left;
				}
				const radius = number(bound.cornerRadius);
				if (radius !== undefined) node.cornerRadius = radius;
				const style = bound.textStyle
					? textStyles.get(bound.textStyle)
					: undefined;
				if (style && node.text) {
					node.text.fontName = { ...style.fontName };
					node.text.fontSize = style.fontSize;
				}
				node.children?.forEach(walk);
			};
			walk(frame);
			return frame;
		},
	};
}

function paint(fill: ScreenFill, imageHash: (name: string) => string): Paint {
	if (fill.type === "SOLID") {
		return {
			type: "SOLID",
			color: fill.color,
			...(fill.opacity !== undefined &&
				fill.opacity !== 1 && { opacity: fill.opacity }),
		};
	}
	return {
		type: "IMAGE",
		imageHash: "imageHash" in fill ? fill.imageHash : imageHash(fill.image),
		scaleMode: fill.scaleMode,
	};
}

/** Finds a layer in a frame by key, for tests that edit it as a designer would. */
export function layerByKey(frame: SyncedNode, key: string): SyncedNode {
	const stack = [frame];
	while (stack.length > 0) {
		const node = stack.pop() as SyncedNode;
		if (node.key === key) return node;
		stack.push(...(node.children ?? []));
	}
	throw new Error(`No layer with key ${key}`);
}
