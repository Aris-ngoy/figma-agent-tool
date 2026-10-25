// Seam 2 harness: installs a mocked `figma` global built from the shared
// document fixture, so the real command handler runs as it would in Figma's
// sandbox. Fixture nodes are in serialized form; this turns them back into
// Plugin API shapes (0–1 RGB, `figma.mixed`, flattened auto-layout props,
// variable aliases).
import { afterEach } from "bun:test";
import {
	type AppliedAnimationStyle,
	BINDABLE_TEXT_FIELDS,
	type Effect,
	type KeyframeField,
	type KeyframeTrack,
	keyframeFieldKey,
	type Paint,
	type Reaction,
	type SerializedNode,
	type VariableValue,
} from "@figma-agent-tool/protocol";
import {
	appliedStyleId,
	availableFonts,
	createdNodeId,
	type DocumentFixture,
	findNode,
	framePng,
	keyframeId,
	keyframeTrackId,
	prefixIds,
	renumber,
	timelineId,
} from "@figma-agent-tool/protocol/fixtures";

const mixed = Symbol("figma.mixed");

type Font = { family: string; style: string };

/** The fonts mixed-font text nodes in the fixture are made of. */
const MIXED_FONTS: Font[] = [
	{ family: "Inter", style: "Regular" },
	{ family: "Inter", style: "Italic" },
];

const fontKey = (font: Font) => `${font.family} ${font.style}`;

type MockNode = Record<string, unknown> & {
	id: string;
	type: string;
	children?: MockNode[];
};

/** A page's children, readable whether or not the page is loaded. */
const RAW_CHILDREN = Symbol("children");

function childrenOf(parent: MockNode): MockNode[] {
	return (parent[RAW_CHILDREN as never] ?? parent.children) as MockNode[];
}

/** The serialized node each mock node was built from, for `clone`. */
const sources = new WeakMap<MockNode, SerializedNode>();

export function installMockFigma(
	document: DocumentFixture,
	{
		motion = true,
		fontLoadDelayMs = 0,
	}: {
		/** `motion: false` mocks a Figma version without the Motion API. */
		motion?: boolean;
		/** Delays every font load, as Figma does in a hidden window. */
		fontLoadDelayMs?: number;
	} = {},
) {
	const storage = new Map<string, unknown>();
	const byId = new Map<string, MockNode>();
	const exports: { nodeId: string; settings: unknown }[] = [];
	const loadedPages = new Set<string>([document.currentPageId]);

	const loadedFonts = new Set<string>();
	let created = 0;

	/** Like Figma's VariableCollection: modes added, renamed and removed. */
	function mockCollection(collection: {
		id: string;
		name: string;
		modes: { modeId: string; name: string }[];
		defaultModeId: string;
		variableIds: string[];
	}) {
		let added = 0;
		return {
			...collection,
			/** Copies the default mode's values into the new mode, as Figma does. */
			addMode(name: string): string {
				const id = `${this.id}/mode-${++added}`;
				this.modes.push({ modeId: id, name });
				for (const variableId of this.variableIds) {
					const variable = variables.get(variableId);
					if (variable)
						variable.valuesByMode[id] =
							variable.valuesByMode[this.defaultModeId];
				}
				return id;
			},
			renameMode(id: string, name: string) {
				const mode = this.modes.find((m) => m.modeId === id);
				if (!mode) throw new Error(`No mode ${id}`);
				mode.name = name;
			},
			removeMode(id: string) {
				if (id === this.defaultModeId)
					throw new Error("Can't remove the default mode");
				this.modes = this.modes.filter((m) => m.modeId !== id);
				for (const variableId of this.variableIds)
					delete variables.get(variableId)?.valuesByMode[id];
			},
		};
	}
	const collections = document.collections.map((collection) =>
		mockCollection({
			id: collection.id,
			name: collection.name,
			modes: collection.modes.map(({ id, name }) => ({ modeId: id, name })),
			defaultModeId: modeId(collection, collection.defaultMode),
			variableIds: collection.variables.map((variable) => variable.id),
		}),
	);
	type MockCollection = (typeof collections)[number];
	type MockVariable = {
		id: string;
		name: string;
		resolvedType: string;
		description: string;
		scopes: string[];
		variableCollectionId: string;
		valuesByMode: Record<string, unknown>;
		setValueForMode(modeId: string, value: unknown): void;
		remove(): void;
	};
	/** Like Figma's Variable: values set per mode, and removable. */
	function mockVariable(
		variable: Omit<MockVariable, "setValueForMode" | "remove">,
	): MockVariable {
		return {
			...variable,
			setValueForMode(modeId: string, value: unknown) {
				this.valuesByMode[modeId] = value;
			},
			remove() {
				variables.delete(this.id);
				const collection = collections.find(
					(c) => c.id === this.variableCollectionId,
				);
				if (collection) {
					collection.variableIds = collection.variableIds.filter(
						(id) => id !== this.id,
					);
				}
			},
		};
	}
	const variables = new Map<string, MockVariable>(
		document.collections.flatMap((collection) =>
			collection.variables.map((variable) => [
				variable.id,
				mockVariable({
					id: variable.id,
					name: variable.name,
					resolvedType: variable.type,
					description: variable.description ?? "",
					scopes: variable.scopes ?? ["ALL_SCOPES"],
					variableCollectionId: collection.id,
					valuesByMode: Object.fromEntries(
						Object.entries(variable.valuesByMode).map(([mode, value]) => [
							modeId(collection, mode),
							toVariableValue(value as VariableValue),
						]),
					),
				}),
			]),
		),
	);

	/** A variable's value in its collection's default mode, aliases followed. */
	function resolve(variable: MockVariable): unknown {
		const collection = collections.find(
			(c) => c.id === variable.variableCollectionId,
		);
		const value = variable.valuesByMode[collection?.defaultModeId as string];
		const alias = value as { type?: string; id: string };
		if (alias.type === "VARIABLE_ALIAS") {
			return resolve(variables.get(alias.id) as MockVariable);
		}
		return value;
	}

	const { styles: fixtureStyles } = document;
	const styles = {
		paint: fixtureStyles.paint.map((style) => ({
			...styleBase(style),
			type: "PAINT",
			paints: style.paints.map(toPaint),
		})),
		text: fixtureStyles.text.map((style) => ({
			...styleBase(style),
			type: "TEXT",
			fontName: style.fontName,
			fontSize: style.fontSize,
			lineHeight: style.lineHeight ?? { unit: "AUTO" },
			letterSpacing: style.letterSpacing ?? { value: 0, unit: "PERCENT" },
		})),
		effect: fixtureStyles.effect.map((style) => ({
			...styleBase(style),
			type: "EFFECT",
			effects: style.effects.map(toEffect),
		})),
	};
	const customAnimationStyles = document.motion.styles
		.filter((style) => style.type === "CUSTOM")
		.map((style) => ({
			id: style.styleId,
			name: style.name,
			description: style.description ?? "",
			type: "CUSTOM_ANIMATION",
			animationEntries: [],
		}));
	const presets = document.motion.styles
		.filter((style) => style.type === "FIGMA")
		.map(({ type: _, ...style }) => style);
	const timelineDurations = new Map(Object.entries(document.motion.timelines));
	const stylesById = new Map<string, Record<string, unknown>>(
		[
			...styles.paint,
			...styles.text,
			...styles.effect,
			...(motion ? customAnimationStyles : []),
		].map((style) => [style.id, style]),
	);
	/** Like Figma's TextStyle: its font must be loaded to change it. */
	function mockTextStyle(style: (typeof styles.text)[number]) {
		let { fontName } = style;
		const requireLoaded = (font: Font) => {
			if (!loadedFonts.has(fontKey(font))) {
				throw new Error(
					`Cannot write to style with unloaded font "${fontKey(font)}"`,
				);
			}
		};
		const mocked = Object.assign(style, {
			remove() {
				stylesById.delete(style.id);
				styles.text.splice(styles.text.indexOf(mocked), 1);
			},
		});
		for (const key of ["fontSize", "lineHeight", "letterSpacing"] as const) {
			let value = style[key];
			Object.defineProperty(mocked, key, {
				enumerable: true,
				get: () => value,
				set: (next) => {
					requireLoaded(fontName);
					value = next;
				},
			});
		}
		Object.defineProperty(mocked, "fontName", {
			enumerable: true,
			get: () => fontName,
			set: (next: Font) => {
				requireLoaded(fontName);
				requireLoaded(next);
				fontName = next;
			},
		});
		return mocked;
	}
	styles.text.forEach(mockTextStyle);

	/** Binding and style setters, which need the file's variables and styles. */
	function bindable(node: MockNode) {
		node.setBoundVariable = (field: string, variable: MockVariable | null) => {
			const bound = node.boundVariables as Record<string, unknown>;
			const textField = field in BINDABLE_TEXT_FIELDS;
			if (!textField && !(field in node)) {
				throw new Error(`node has no bindable field ${field}`);
			}
			if (!variable) {
				delete bound[field];
				return;
			}
			const value = resolve(variable);
			if (field === "fontFamily" || field === "fontStyle") {
				const key = field === "fontFamily" ? "family" : "style";
				node.fontName = { ...(node.fontName as Font), [key]: value };
			} else if (!textField || field === "fontSize") {
				node[field] = value;
			}
			const alias = { type: "VARIABLE_ALIAS", id: variable.id };
			bound[field] = textField ? [alias] : alias;
		};
		const styleSetter =
			(type: string, apply: (style: Record<string, unknown>) => void) =>
			async (id: string) => {
				const style = stylesById.get(id);
				if (id && style?.type !== type) {
					throw new Error(`"${id}" is not a ${type} style`);
				}
				if (style) apply(style);
			};
		node.setFillStyleIdAsync = styleSetter("PAINT", (style) => {
			node.fills = style.paints;
		});
		node.setStrokeStyleIdAsync = styleSetter("PAINT", (style) => {
			node.strokes = style.paints;
		});
		node.setEffectStyleIdAsync = styleSetter("EFFECT", (style) => {
			node.effects = style.effects;
		});
		node.setTextStyleIdAsync = styleSetter("TEXT", (style) => {
			node.fontName = style.fontName;
			node.fontSize = style.fontSize;
		});
		// Setting the property directly detaches its style; applying a style
		// records it after the paints are in.
		for (const [setter, styleKey] of [
			["setFillStyleIdAsync", "fillStyleId"],
			["setStrokeStyleIdAsync", "strokeStyleId"],
			["setEffectStyleIdAsync", "effectStyleId"],
			["setTextStyleIdAsync", "textStyleId"],
		] as const) {
			const apply = node[setter] as (id: string) => Promise<void>;
			node[setter] = async (id: string) => {
				await apply(id);
				node[styleKey] = id;
			};
		}
	}

	/**
	 * Like Figma's Motion API: applied styles, manual keyframe tracks read as
	 * a nested record, and the top-level frame's timeline.
	 */
	function mockMotion(node: MockNode) {
		const initial = document.motion.nodes[node.id];
		let styles: AppliedAnimationStyle[] = structuredClone(
			initial?.animationStyles ?? [],
		);
		let applied = styles.length;
		const tracks = new Map(
			(initial?.keyframeTracks ?? []).map((track) => [
				keyframeFieldKey(track.field),
				structuredClone(track),
			]),
		);
		const frame = () => {
			let up = node;
			while ((up.parent as MockNode | undefined)?.type !== "PAGE") {
				up = up.parent as MockNode;
			}
			return up;
		};
		Object.defineProperty(node, "animationStyles", {
			enumerable: true,
			get: () => structuredClone(styles),
		});
		Object.defineProperty(node, "manualKeyframeTracks", {
			enumerable: true,
			get: () => nestTracks([...tracks.values()]),
		});
		Object.defineProperty(node, "timelines", {
			enumerable: true,
			get: () => {
				const { id } = frame();
				const duration = timelineDurations.get(id);
				return duration ? [{ id: timelineId(id), duration }] : [];
			},
		});
		node.applyAnimationStyle = (
			styleId: string,
			config: Record<string, unknown> = {},
		) => {
			const id = appliedStyleId(node.id, ++applied);
			if (config.type === "CUSTOM") {
				const style = customAnimationStyles.find((s) => s.id === styleId);
				if (!style) throw new Error(`No custom animation style ${styleId}`);
				styles.push({
					...config,
					type: "CUSTOM",
					id,
					styleId,
					name: style.name,
				});
				return id;
			}
			const preset = presets.find((s) => s.styleId === styleId);
			if (!preset) throw new Error(`No animation style ${styleId}`);
			const { props: _, ...style } = preset;
			const defined = Object.fromEntries(
				Object.entries(config).filter(([, value]) => value !== undefined),
			);
			styles.push({ ...style, ...defined, type: "FIGMA", id });
			return id;
		};
		node.removeAnimationStyle = (id: string) => {
			if (!styles.some((style) => style.id === id)) {
				throw new Error(`No applied animation style ${id}`);
			}
			styles = styles.filter((style) => style.id !== id);
		};
		node.applyManualKeyframeTrack = (
			field: KeyframeField,
			{ id, baseValue, keyframes }: Omit<KeyframeTrack, "field">,
		) => {
			if (field.type === "INDEXED_ITEM") {
				const items = node[field.collection];
				if (!Array.isArray(items) || field.index >= items.length) {
					throw new Error(`No ${field.collection}[${field.index}] to animate`);
				}
			}
			const trackId = id ?? keyframeTrackId(node.id, field);
			tracks.set(keyframeFieldKey(field), {
				field,
				id: trackId,
				...(baseValue && { baseValue }),
				keyframes: keyframes.map((keyframe, index) => ({
					id: keyframeId(trackId, index),
					...keyframe,
				})),
			});
		};
		node.removeManualKeyframeTrack = (field: KeyframeField) => {
			tracks.delete(keyframeFieldKey(field));
		};
		node.setTimelineDuration = (id: string, duration: number) => {
			const frameId = frame().id;
			if (id !== timelineId(frameId) || !timelineDurations.has(frameId)) {
				throw new Error(`No timeline ${id}`);
			}
			timelineDurations.set(frameId, duration);
		};
	}

	function register(node: MockNode, parent?: MockNode): MockNode {
		node.parent = parent;
		byId.set(node.id, node);
		sharedPluginData(node);
		if (node.type === "TEXT") autoRename(node);
		if (node.type !== "PAGE") {
			guardSizing(node);
			guardPositioning(node);
		}
		// Every canvas node exports the fixture PNG; tests check the settings.
		node.exportAsync = async (settings: unknown) => {
			exports.push({ nodeId: node.id, settings });
			return new Uint8Array(Buffer.from(framePng, "base64"));
		};
		node.removed = false;
		node.remove = () => {
			detach(node);
			unregister(node);
		};
		// Copies the node as built (later edits aren't copied), with fresh IDs,
		// right after the original.
		node.clone = () => {
			const source = sources.get(node) as SerializedNode;
			const copy = toFigmaNode(
				renumber(source, () => createdNodeId(++created)),
			);
			const parent = node.parent as MockNode;
			register(copy, parent);
			const siblings = childrenOf(parent);
			siblings.splice(siblings.indexOf(node) + 1, 0, copy);
			return copy;
		};
		mockReactions(node, document.reactions[node.id] ?? []);
		if (motion) mockMotion(node);
		if (node.children) canAppend(node);
		if (node.type === "TEXT") guardText(node, loadedFonts);
		bindable(node);
		if (node.type === "COMPONENT") {
			node.createInstance = () => {
				const source = findNode(node.id, document) as SerializedNode;
				const id = createdNodeId(++created);
				return instanceProperties(
					place(
						toFigmaNode({
							...source,
							id,
							type: "INSTANCE",
							x: 0,
							y: 0,
							component: undefined,
							instance: {
								mainComponent: { id: node.id, name: String(node.name) },
								properties: {},
							},
							// Figma prefixes instance sublayer IDs with the instance's.
							children: source.children?.map((child) =>
								prefixIds(child, `I${id};`),
							),
						}),
					),
					node,
				);
			};
		}
		for (const child of node.children ?? []) register(child, node);
		return node;
	}

	function canAppend(container: MockNode) {
		const guard = () => {
			for (
				let up: MockNode | undefined = container;
				up;
				up = up.parent as never
			) {
				if (up.type === "INSTANCE") {
					throw new Error(
						"Cannot move node. New parent is an instance or is inside of an instance",
					);
				}
			}
		};
		// Counts the index once the child is taken out of its old place.
		container.insertChild = (index: number, child: MockNode) => {
			guard();
			detach(child);
			const children = childrenOf(container);
			if (index > children.length) {
				throw new Error(
					"Cannot insert node at index greater than the number of existing siblings",
				);
			}
			children.splice(index, 0, child);
			child.parent = container;
		};
		container.appendChild = (child: MockNode) => {
			guard();
			detach(child);
			childrenOf(container).push(child);
			child.parent = container;
		};
	}

	function detach(node: MockNode) {
		const parent = node.parent as MockNode | undefined;
		if (!parent) return;
		const siblings = childrenOf(parent);
		siblings.splice(siblings.indexOf(node), 1);
	}

	function unregister(node: MockNode) {
		byId.delete(node.id);
		node.removed = true;
		for (const child of node.children ?? []) unregister(child);
	}

	/**
	 * Like Figma, a group sits where the topmost grouped node was, spans its
	 * children, and keeps their layer order and coordinates.
	 */
	function group(nodes: MockNode[], parent: MockNode): MockNode {
		const siblings = childrenOf(parent);
		const ordered = nodes.every((node) => node.parent === parent)
			? [...nodes].sort((a, b) => siblings.indexOf(a) - siblings.indexOf(b))
			: nodes;
		const inParent = ordered.filter((node) => node.parent === parent);
		const top = Math.max(...inParent.map((node) => siblings.indexOf(node)));
		const at =
			inParent.length > 0 ? top - inParent.length + 1 : siblings.length;
		const box = bounds(ordered);
		const groupNode = toFigmaNode({
			id: createdNodeId(++created),
			name: "Group",
			type: "GROUP",
			...box,
			children: [],
		});
		for (const node of ordered) detach(node);
		register(groupNode, parent);
		siblings.splice(at, 0, groupNode);
		for (const node of ordered) {
			(groupNode.children as MockNode[]).push(node);
			node.parent = groupNode;
		}
		return groupNode;
	}

	function ungroup(node: MockNode): MockNode[] {
		const parent = node.parent as MockNode;
		const siblings = childrenOf(parent);
		const children = [...(node.children as MockNode[])];
		siblings.splice(siblings.indexOf(node), 1, ...children);
		for (const child of children) child.parent = parent;
		node.children = [];
		unregister(node);
		return children;
	}

	/** Like Figma, new nodes start out on the current page. */
	function place(node: MockNode): MockNode {
		register(node, currentPage);
		currentPage?.children?.push(node);
		return node;
	}

	function create(node: Omit<SerializedNode, "id">): MockNode {
		return place(toFigmaNode({ id: createdNodeId(++created), ...node }));
	}

	/** A published component (or set) by key, as importing finds it; throws like Figma when there's none. */
	function byKey(key: string, type: string): MockNode {
		const found = [...byId.values()].find(
			(node) => node.type === type && node.key === key && !node.removed,
		);
		if (!found) throw new Error(`Failed to import component with key ${key}`);
		return found;
	}

	/**
	 * Like Figma's components made by a plugin: a component set's variant
	 * properties come from its variants' names, text properties are added
	 * to the set (or a lone component), and instances set them.
	 */
	function mockComponent(node: MockNode): MockNode {
		const texts = new Map<string, { type: string; defaultValue: unknown }>();
		let added = 0;
		const inSet = () =>
			(node.parent as MockNode | undefined)?.type === "COMPONENT_SET";
		node.key = "";
		Object.defineProperty(node, "componentPropertyDefinitions", {
			get: () => {
				if (node.type === "COMPONENT" && inSet())
					throw new Error("read definitions from the component set");
				const definitions: Record<string, Record<string, unknown>> = {};
				for (const variant of node.type === "COMPONENT_SET"
					? childrenOf(node)
					: []) {
					for (const [name, value] of Object.entries(
						variant.variantProperties as Record<string, string>,
					)) {
						const definition = definitions[name] ?? {
							type: "VARIANT",
							defaultValue: value,
							variantOptions: [],
						};
						definitions[name] = definition;
						const options = definition.variantOptions as string[];
						if (!options.includes(value)) options.push(value);
					}
				}
				for (const [key, definition] of texts)
					definitions[key] = { ...definition };
				return definitions;
			},
		});
		node.addComponentProperty = (
			name: string,
			type: string,
			defaultValue: unknown,
		) => {
			if (inSet()) throw new Error("add properties to the component set");
			const key = `${name}#${node.id}-${++added}`;
			texts.set(key, { type, defaultValue });
			return key;
		};
		node.editComponentProperty = (
			key: string,
			{ defaultValue }: { defaultValue: unknown },
		) => {
			const definition = texts.get(key);
			if (!definition) throw new Error(`No property ${key}`);
			definition.defaultValue = defaultValue;
			return key;
		};
		node.deleteComponentProperty = (key: string) => {
			if (!texts.delete(key)) throw new Error(`No property ${key}`);
		};
		if (node.type !== "COMPONENT") return node;
		Object.defineProperty(node, "variantProperties", {
			get: () =>
				inSet()
					? Object.fromEntries(
							String(node.name)
								.split(", ")
								.map((pair) => pair.split("=")),
						)
					: null,
		});
		node.createInstance = () => mockInstance(node);
		return node;
	}

	/** An instance of a mocked component, which holds none of its layers. */
	function mockInstance(component: MockNode): MockNode {
		const parent = component.parent as MockNode;
		const instance = create({
			name: String((parent.type === "COMPONENT_SET" ? parent : component).name),
			type: "INSTANCE",
			x: 0,
			y: 0,
			width: component.width as number,
			height: component.height as number,
			fills: [],
		});
		instance.layoutMode = component.layoutMode;
		return instanceProperties(instance, component);
	}

	/** An instance's variant and text properties, read and set like Figma's. */
	function instanceProperties(instance: MockNode, component: MockNode) {
		let main = component;
		const overrides = new Map<string, unknown>();
		const holder = () =>
			((main.parent as MockNode).type === "COMPONENT_SET"
				? main.parent
				: main) as MockNode;
		instance.getMainComponentAsync = async () => main;
		Object.defineProperty(instance, "componentProperties", {
			get: () =>
				Object.fromEntries(
					Object.entries(
						holder().componentPropertyDefinitions as Record<
							string,
							{ type: string; defaultValue: unknown }
						>,
					).map(([key, { type, defaultValue }]) => [
						key,
						{
							type,
							value:
								type === "VARIANT"
									? (main.variantProperties as Record<string, string>)[key]
									: overrides.has(key)
										? overrides.get(key)
										: defaultValue,
						},
					]),
				),
		});
		instance.setProperties = (properties: Record<string, unknown>) => {
			const definitions = holder().componentPropertyDefinitions as Record<
				string,
				{ type: string }
			>;
			const variant = { ...(main.variantProperties as Record<string, string>) };
			for (const [key, value] of Object.entries(properties)) {
				const definition = definitions[key];
				if (!definition)
					throw new Error(
						`Could not find a component property with name: '${key}'`,
					);
				if (definition.type === "VARIANT") variant[key] = String(value);
				else overrides.set(key, value);
			}
			if (holder() === main) return;
			const swapped = childrenOf(holder()).find((sibling) =>
				Object.entries(variant).every(
					([name, value]) =>
						(sibling.variantProperties as Record<string, string>)[name] ===
						value,
				),
			);
			if (!swapped) throw new Error("No variant with these properties");
			main = swapped;
		};
		return instance;
	}

	function mockPage(page: {
		id: string;
		name: string;
		children: SerializedNode[];
		flows: { nodeId: string; name: string }[];
	}): MockNode {
		const children = page.children.map(toFigmaNode);
		const mockPage: MockNode = {
			id: page.id,
			name: page.name,
			type: "PAGE",
			selection: [],
			// Like Figma, a readonly array the plugin replaces to change flows.
			flowStartingPoints: Object.freeze(structuredClone(page.flows)),
			async loadAsync() {
				loadedPages.add(page.id);
			},
		};
		// Like Figma's dynamic-page access, an unloaded page has no children.
		Object.defineProperty(mockPage, "children", {
			enumerable: true,
			get: () => {
				if (!loadedPages.has(page.id)) {
					throw new Error(`page ${page.id} must be loaded first`);
				}
				return children;
			},
		});
		mockPage.findAllWithCriteria = ({ types }: { types: string[] }) => {
			const found: MockNode[] = [];
			const walk = (parent: { children?: MockNode[] }) => {
				for (const child of parent.children ?? []) {
					if (types.includes(child.type)) found.push(child);
					walk(child);
				}
			};
			walk(mockPage);
			return found;
		};
		Object.defineProperty(mockPage, RAW_CHILDREN, { value: children });
		canAppend(mockPage);
		sharedPluginData(mockPage);
		for (const child of children) register(child, mockPage);
		byId.set(page.id, mockPage);
		return mockPage;
	}

	const pages = document.pages.map(mockPage);
	const images = new Map<string, Uint8Array>();

	const currentPage = pages.find((page) => page.id === document.currentPageId);
	if (currentPage) {
		currentPage.selection = document.selection.map((id) => byId.get(id));
	}

	const mock = {
		mixed,
		fileKey: document.fileKey,
		clientStorage: {
			getAsync: async (key: string) => storage.get(key),
			setAsync: async (key: string, value: unknown) => {
				storage.set(key, value);
			},
		},
		root: sharedPluginData({
			id: "0:0",
			name: document.name,
			type: "DOCUMENT",
			children: pages,
		}),
		currentPage,
		createPage() {
			const page = mockPage({
				id: createdNodeId(++created),
				name: "Page",
				children: [],
				flows: [],
			});
			loadedPages.add(page.id);
			page.parent = mock.root;
			pages.push(page);
			return page;
		},
		createImage(bytes: Uint8Array) {
			const hash = `image-${images.size + 1}`;
			images.set(hash, bytes);
			return { hash };
		},
		getImageByHash(hash: string) {
			const bytes = images.get(hash);
			return bytes ? { hash, getBytesAsync: async () => bytes } : null;
		},
		base64Decode(data: string) {
			return new Uint8Array(Buffer.from(data, "base64"));
		},
		async getNodeByIdAsync(id: string) {
			return byId.get(id) ?? null;
		},
		async loadAllPagesAsync() {
			for (const page of pages) loadedPages.add(page.id);
		},
		async getStyleByIdAsync(id: string) {
			return stylesById.get(id) ?? null;
		},
		getLocalPaintStylesAsync: async () => styles.paint,
		getLocalTextStylesAsync: async () => styles.text,
		createTextStyle() {
			const style = mockTextStyle({
				id: `S:created-${++created}`,
				name: "Text style",
				description: "",
				type: "TEXT",
				fontName: { family: "Inter", style: "Regular" },
				fontSize: 12,
				lineHeight: { unit: "AUTO" },
				letterSpacing: { value: 0, unit: "PERCENT" },
			} as (typeof styles.text)[number]);
			styles.text.push(style);
			stylesById.set(style.id, style);
			return style;
		},
		getLocalEffectStylesAsync: async () => styles.effect,
		...(motion && {
			motion: {
				playheadPosition: undefined,
				figmaAnimationStyles: () => structuredClone(presets),
			},
			getLocalCustomAnimationStylesAsync: async () => customAnimationStyles,
		}),
		variables: {
			getLocalVariableCollectionsAsync: async () => collections,
			getLocalVariablesAsync: async () => [...variables.values()],
			async getVariableByIdAsync(id: string) {
				return variables.get(id) ?? null;
			},
			async getVariableCollectionByIdAsync(id: string) {
				return collections.find((collection) => collection.id === id) ?? null;
			},
			createVariableCollection(name: string): MockCollection {
				const id = `VariableCollectionId:created-${++created}`;
				const collection = mockCollection({
					id,
					name,
					modes: [{ modeId: `${id}/mode`, name: "Mode 1" }],
					defaultModeId: `${id}/mode`,
					variableIds: [] as string[],
				});
				collections.push(collection);
				return collection;
			},
			createVariable(
				name: string,
				collection: MockCollection,
				resolvedType: string,
			) {
				const variable = mockVariable({
					id: `VariableID:created-${++created}`,
					name,
					resolvedType,
					description: "",
					scopes: ["ALL_SCOPES"],
					variableCollectionId: collection.id,
					valuesByMode: {},
				});
				variables.set(variable.id, variable);
				collection.variableIds.push(variable.id);
				return variable;
			},
			createVariableAlias(variable: MockVariable) {
				return { type: "VARIABLE_ALIAS", id: variable.id };
			},
			setBoundVariableForPaint(
				paint: Record<string, unknown>,
				_field: "color",
				variable: MockVariable | null,
			) {
				const { boundVariables: _, ...rest } = paint;
				if (!variable) return rest;
				const { a: _a, ...color } = resolve(variable) as RGBA;
				return {
					...rest,
					color,
					boundVariables: {
						color: { type: "VARIABLE_ALIAS", id: variable.id },
					},
				};
			},
		},
		base64Encode(data: Uint8Array) {
			return Buffer.from(data).toString("base64");
		},
		/** Every font load, with how many nodes had been created by then. */
		fontLoads: [] as { font: string; createdBefore: number }[],
		async loadFontAsync(font: Font) {
			mock.fontLoads.push({ font: fontKey(font), createdBefore: created });
			if (fontLoadDelayMs) await Bun.sleep(fontLoadDelayMs);
			if (!availableFonts.some((f) => fontKey(f) === fontKey(font))) {
				throw new Error(`The font "${fontKey(font)}" could not be loaded`);
			}
			loadedFonts.add(fontKey(font));
		},
		createFrame: () =>
			create({
				name: "Frame",
				type: "FRAME",
				...newGeometry,
				fills: [{ type: "SOLID", color: "#ffffff" }],
				children: [],
			}),
		createRectangle: () =>
			create({
				name: "Rectangle",
				type: "RECTANGLE",
				...newGeometry,
				fills: [{ type: "SOLID", color: "#d9d9d9" }],
			}),
		createVector: () =>
			create({
				name: "Vector",
				type: "VECTOR",
				...newGeometry,
				fills: [],
			}),
		createStar: () =>
			create({
				name: "Star",
				type: "STAR",
				...newGeometry,
				fills: [{ type: "SOLID", color: "#ffcc00" }],
			}),
		createComponent: () =>
			mockComponent(
				create({
					name: "Component",
					type: "COMPONENT",
					...newGeometry,
					fills: [{ type: "SOLID", color: "#ffffff" }],
					children: [],
				}),
			),
		/** Like Figma, puts the components in a new set in `parent`, named after their variants. */
		combineAsVariants(components: MockNode[], parent: MockNode) {
			const set = mockComponent(
				create({
					name: "Component 1",
					type: "COMPONENT_SET",
					...newGeometry,
					fills: [],
					children: [],
				}),
			);
			(parent.appendChild as (node: MockNode) => void)(set);
			for (const component of components)
				(set.appendChild as (node: MockNode) => void)(component);
			return set;
		},
		importComponentByKeyAsync: async (key: string) => byKey(key, "COMPONENT"),
		importComponentSetByKeyAsync: async (key: string) =>
			byKey(key, "COMPONENT_SET"),
		createText: () =>
			create({
				name: "Text",
				type: "TEXT",
				...newGeometry,
				width: 0,
				height: 0,
				fills: [{ type: "SOLID", color: "#000000" }],
				text: {
					characters: "",
					fontName: { family: "Inter", style: "Regular" },
					fontSize: 12,
				},
			}),
		group,
		ungroup,
		undoCommits: 0,
		commitUndo() {
			mock.undoCommits++;
		},
		exports,
	};
	byId.set(mock.root.id, mock.root);
	(globalThis as { figma?: unknown }).figma = mock;
	return mock;
}

const newGeometry = { x: 0, y: 0, width: 100, height: 100 };

/** Shared plugin data, which Figma keeps per node and namespace. */
function sharedPluginData<T extends Record<string, unknown>>(node: T): T {
	const data = new Map<string, string>();
	Object.assign(node, {
		setSharedPluginData(namespace: string, key: string, value: string) {
			if (!/^[A-Za-z0-9_.]{3,}$/.test(namespace)) {
				throw new Error(`Invalid namespace "${namespace}"`);
			}
			data.set(`${namespace}/${key}`, value);
		},
		getSharedPluginData: (namespace: string, key: string) =>
			data.get(`${namespace}/${key}`) ?? "",
	});
	return node;
}

/** Like Figma, a text layer with `autoRename` is named after its characters. */
function autoRename(node: MockNode) {
	let name = node.name as string;
	node.autoRename = false;
	Object.defineProperty(node, "name", {
		enumerable: true,
		get: () => (node.autoRename ? node.characters : name),
		set: (value: string) => {
			name = value;
			node.autoRename = false;
		},
	});
}

/**
 * Like Figma: only children of auto-layout frames can FILL, and only text
 * and auto-layout frames can HUG.
 */
function guardSizing(node: MockNode) {
	for (const axis of ["layoutSizingHorizontal", "layoutSizingVertical"]) {
		let sizing = node[axis] ?? "FIXED";
		Object.defineProperty(node, axis, {
			enumerable: true,
			get: () => sizing,
			set: (value: string) => {
				const parent = node.parent as MockNode | undefined;
				if (value === "FILL" && (parent?.layoutMode ?? "NONE") === "NONE") {
					throw new Error(
						"FILL can only be set on children of auto-layout frames",
					);
				}
				const hugs =
					node.type === "TEXT" || (node.layoutMode ?? "NONE") !== "NONE";
				if (value === "HUG" && !hugs) {
					throw new Error("HUG can only be set on auto-layout frames and text");
				}
				sizing = value;
			},
		});
	}
}

/** Like Figma: only children of auto-layout frames can be positioned absolutely. */
function guardPositioning(node: MockNode) {
	let positioning = "AUTO";
	Object.defineProperty(node, "layoutPositioning", {
		enumerable: true,
		get: () => positioning,
		set: (value: string) => {
			const parent = node.parent as MockNode | undefined;
			if (value === "ABSOLUTE" && (parent?.layoutMode ?? "NONE") === "NONE") {
				throw new Error(
					"ABSOLUTE can only be set on children of auto-layout frames",
				);
			}
			positioning = value;
		},
	});
}

/**
 * Like Figma with dynamic-page access: `reactions` is read-only and
 * `setReactionsAsync` writes. Reads also carry the deprecated `action`.
 */
function mockReactions(node: MockNode, initial: Reaction[]) {
	let stored = structuredClone(initial);
	Object.defineProperty(node, "reactions", {
		enumerable: true,
		get: () =>
			stored.map((reaction) => ({ ...reaction, action: reaction.actions[0] })),
		set: () => {
			throw new Error("Cannot write to reactions; use setReactionsAsync");
		},
	});
	node.setReactionsAsync = async (reactions: Reaction[]) => {
		stored = structuredClone(reactions);
	};
}

afterEach(() => {
	delete (globalThis as { figma?: unknown }).figma;
});

/** Tracks in the Plugin API's nested `manualKeyframeTracks` shape. */
function nestTracks(tracks: KeyframeTrack[]) {
	const nested: Record<string, unknown> = {};
	// Newest first, so the plugin can't rely on the order Figma reports.
	for (const { field, ...binding } of [...tracks].reverse()) {
		const path = nestedTrackPath(field);
		const key = path.pop() as string;
		let at = nested;
		for (const step of path) {
			at[step] ??= {};
			at = at[step] as Record<string, unknown>;
		}
		at[key] = binding;
	}
	return nested;
}

/** Where a field's track sits in the nested `manualKeyframeTracks` record. */
function nestedTrackPath(field: KeyframeField): string[] {
	if (field.type === "PROPERTY") return [field.name];
	const item = [field.collection, String(field.index)];
	if (field.propertyId) return [...item, "properties", field.propertyId];
	if (field.field) return [...item, field.field];
	return item;
}

/** The box around the nodes, in their parent's coordinates. */
function bounds(nodes: MockNode[]) {
	const edges = (start: "x" | "y", size: "width" | "height") => {
		const from = Math.min(...nodes.map((node) => node[start] as number));
		const to = Math.max(
			...nodes.map((node) => (node[start] as number) + (node[size] as number)),
		);
		return [from, to - from];
	};
	const [x, width] = edges("x", "width");
	const [y, height] = edges("y", "height");
	return { x, y, width, height };
}

function toFigmaNode(node: SerializedNode): MockNode {
	const mock: MockNode = {
		id: node.id,
		name: node.name,
		type: node.type,
		visible: node.visible ?? true,
		x: node.x,
		y: node.y,
		width: node.width,
		height: node.height,
		rotation: node.rotation ?? 0,
		opacity: node.opacity ?? 1,
		fills: node.fills === "mixed" ? mixed : (node.fills ?? []).map(toPaint),
		strokes: (node.strokes ?? []).map(toPaint),
		strokeWeight:
			node.strokeWeight === "mixed" ? mixed : (node.strokeWeight ?? 1),
		layoutSizingHorizontal: "FIXED",
		layoutSizingVertical: "FIXED",
		resize(width: number, height: number) {
			mock.width = width;
			mock.height = height;
		},
		strokeAlign: "INSIDE",
		strokeCap: "NONE",
		strokeJoin: "MITER",
		dashPattern: [],
		constraints: { horizontal: "MIN", vertical: "MIN" },
		effects: [],
		effectStyleId: node.styles?.effect ?? "",
		boundVariables: Object.fromEntries(
			Object.entries(node.variables ?? {}).map(([field, id]) => {
				const alias = { type: "VARIABLE_ALIAS", id };
				return [field, field in BINDABLE_TEXT_FIELDS ? [alias] : alias];
			}),
		),
	};
	detachableStyle(mock, "fills", "fillStyleId", node.styles?.fill);
	detachableStyle(mock, "strokes", "strokeStyleId", node.styles?.stroke);
	if (node.type !== "TEXT") cornerRadius(mock, node);
	if (node.text) {
		const { fontName, fontSize } = node.text;
		mock.componentPropertyReferences = null;
		Object.assign(mock, {
			characters: node.text.characters,
			fontName: fontName === "mixed" ? mixed : fontName,
			fontSize: fontSize === "mixed" ? mixed : fontSize,
			textAlignHorizontal: node.text.textAlignHorizontal ?? "LEFT",
			textStyleId: node.styles?.text ?? "",
		});
	}
	if (node.children) {
		const { layout } = node;
		Object.assign(mock, {
			layoutMode: layout?.mode ?? "NONE",
			itemSpacing: layout?.itemSpacing ?? 0,
			paddingTop: layout?.padding.top ?? 0,
			paddingRight: layout?.padding.right ?? 0,
			paddingBottom: layout?.padding.bottom ?? 0,
			paddingLeft: layout?.padding.left ?? 0,
			primaryAxisAlignItems: layout?.primaryAxisAlignItems ?? "MIN",
			counterAxisAlignItems: layout?.counterAxisAlignItems ?? "MIN",
			layoutWrap: layout?.wrap ? "WRAP" : "NO_WRAP",
			// Figma's default for new frames.
			clipsContent: true,
			strokesIncludedInLayout: false,
			layoutSizingHorizontal: layout?.sizing.horizontal ?? "FIXED",
			layoutSizingVertical: layout?.sizing.vertical ?? "FIXED",
		});
		mock.children = node.children.map(toFigmaNode);
	}
	if (node.type === "VECTOR") mock.vectorPaths = [];
	if (node.type === "STAR") mock.pointCount = 5;
	sources.set(mock, node);
	if (node.component) {
		const { key, description, properties, variantProperties } = node.component;
		mock.key = key;
		mock.description = description ?? "";
		if (node.type === "COMPONENT") {
			mock.variantProperties = variantProperties ?? null;
		}
		// Like Figma, a variant's definitions live on its component set.
		Object.defineProperty(mock, "componentPropertyDefinitions", {
			get: () => {
				if (variantProperties) {
					throw new Error("read definitions from the component set");
				}
				return properties ?? {};
			},
		});
	}
	if (node.instance) {
		const { mainComponent, properties } = node.instance;
		mock.componentProperties = Object.fromEntries(
			Object.entries(properties).map(([name, value]) => [
				name,
				{ type: typeof value === "boolean" ? "BOOLEAN" : "TEXT", value },
			]),
		);
		mock.getMainComponentAsync = async () =>
			mainComponent && (await figma.getNodeByIdAsync(mainComponent.id));
		// In dynamic-page mode the sync getter throws.
		Object.defineProperty(mock, "mainComponent", {
			get: () => {
				throw new Error("use getMainComponentAsync");
			},
		});
	}
	return mock;
}

/** Like Figma, setting paints directly detaches the paint style. */
function detachableStyle(
	mock: MockNode,
	key: "fills" | "strokes",
	styleKey: string,
	styleId = "",
) {
	let paints = mock[key];
	mock[styleKey] = styleId;
	Object.defineProperty(mock, key, {
		enumerable: true,
		get: () => paints,
		set: (value) => {
			paints = value;
			mock[styleKey] = "";
		},
	});
}

const CORNERS = [
	"topLeftRadius",
	"topRightRadius",
	"bottomRightRadius",
	"bottomLeftRadius",
] as const;

/** Per-corner radii; `cornerRadius` reads `figma.mixed` when they differ. */
function cornerRadius(mock: MockNode, node: SerializedNode) {
	const radius = node.cornerRadius ?? 0;
	Object.assign(
		mock,
		typeof radius === "number"
			? Object.fromEntries(CORNERS.map((corner) => [corner, radius]))
			: {
					topLeftRadius: radius.topLeft,
					topRightRadius: radius.topRight,
					bottomRightRadius: radius.bottomRight,
					bottomLeftRadius: radius.bottomLeft,
				},
	);
	Object.defineProperty(mock, "cornerRadius", {
		enumerable: true,
		get: () => {
			const radii = new Set(CORNERS.map((corner) => mock[corner]));
			return radii.size === 1 ? mock.topLeftRadius : mixed;
		},
		set: (value: number) => {
			for (const corner of CORNERS) mock[corner] = value;
		},
	});
}

/**
 * Like Figma, text can only change once the fonts it uses (or switches to)
 * are loaded.
 */
function guardText(node: MockNode, loadedFonts: Set<string>) {
	const state = {
		characters: node.characters,
		fontName: node.fontName,
		fontSize: node.fontSize,
		textAlignHorizontal: node.textAlignHorizontal,
	};
	const fonts = () =>
		state.fontName === mixed ? MIXED_FONTS : [state.fontName as Font];
	const requireLoaded = (required: Font[]) => {
		for (const font of required) {
			if (!loadedFonts.has(fontKey(font))) {
				throw new Error(
					`Cannot write to node with unloaded font "${fontKey(font)}"`,
				);
			}
		}
	};
	node.getRangeAllFontNames = () => fonts();
	for (const key of Object.keys(state) as (keyof typeof state)[]) {
		Object.defineProperty(node, key, {
			enumerable: true,
			get: () => state[key],
			set: (value) => {
				requireLoaded(key === "fontName" ? [value] : fonts());
				state[key] = value;
			},
		});
	}
}

function toPaint(paint: Paint) {
	const base = {
		type: paint.type,
		opacity: paint.opacity ?? 1,
		visible: paint.visible ?? true,
		blendMode: "NORMAL",
	};
	switch (paint.type) {
		case "SOLID":
			return {
				...base,
				color: rgb(paint.color),
				...(paint.variable && {
					boundVariables: {
						color: { type: "VARIABLE_ALIAS", id: paint.variable },
					},
				}),
			};
		case "IMAGE":
			return {
				...base,
				imageHash: paint.imageHash,
				scaleMode: paint.scaleMode,
			};
		case "VIDEO":
		case "PATTERN":
		case "SHADER":
			return base;
		default:
			return {
				...base,
				gradientTransform: [
					[1, 0, 0],
					[0, 1, 0],
				],
				gradientStops: paint.stops.map((stop) => ({
					position: stop.position,
					color: { ...rgb(stop.color), a: stop.opacity },
				})),
			};
	}
}

function rgb(hex: string) {
	const channel = (offset: number) =>
		Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
	return { r: channel(1), g: channel(3), b: channel(5) };
}

function toEffect(effect: Effect) {
	const base = { type: effect.type, visible: effect.visible ?? true };
	if ("offset" in effect) {
		return {
			...base,
			color: { ...rgb(effect.color), a: effect.opacity ?? 1 },
			offset: effect.offset,
			radius: effect.radius,
			spread: effect.spread ?? 0,
			blendMode: "NORMAL",
		};
	}
	if ("radius" in effect) {
		return { ...base, radius: effect.radius, blurType: "NORMAL" };
	}
	return base;
}

function toVariableValue(value: VariableValue) {
	if (typeof value !== "object") return value;
	if ("alias" in value) return { type: "VARIABLE_ALIAS", id: value.alias };
	return { ...rgb(value.color), a: value.opacity ?? 1 };
}

function modeId(
	collection: { modes: { id: string; name: string }[] },
	name: string,
) {
	return collection.modes.find((mode) => mode.name === name)?.id as string;
}

function styleBase(style: { id: string; name: string; description?: string }) {
	return {
		id: style.id,
		name: style.name,
		description: style.description ?? "",
	};
}
