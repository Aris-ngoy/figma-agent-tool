// Push and Pull: applies Screens' node trees to their frames in place (and
// Defined Components' to their component sets) and reads them back. Layers
// are matched by node ID, which the server keeps; each layer's element key
// and each frame's Screen are stored in shared plugin data, so a frame that
// is renamed, moved or cut and pasted stays linked. Like create_nodes, a push does its async work first and edits the
// document in one synchronous pass, as one undo step.
import {
	type CommandParams,
	type CommandResult,
	FLOAT_BINDINGS,
	type LinkedComponentInfo,
	linkReaction,
	type Paint as PaintInfo,
	type ScreenFill,
	type ScreenNode,
	SYNC_KEYS,
	SYNC_NAMESPACE,
	type SyncedNode,
	withPrototypeLink,
} from "@figma-agent-tool/protocol";
import { fontKey, loadFonts } from "./edit";
import {
	CommandError,
	checkDeadline,
	type Deadline,
	NO_DEADLINE,
} from "./errors";
import { type ReactiveNode, readReactions } from "./reactions";
import { cornerRadius, paint, round, text } from "./serialize";
import {
	type AppliedDesignSystem,
	applyDesignSystem,
	loadDesignSystem,
} from "./tokens";

type Container = BaseNode & ChildrenMixin;
/** Frames, and Defined Components' component sets and components, which are laid out like them. */
type FrameLike = FrameNode | ComponentNode | ComponentSetNode;
type Layer = FrameLike | TextNode | RectangleNode | VectorNode;
/** What a Component's instances come from: a component set, or a lone component. */
type ComponentRoot = ComponentNode | ComponentSetNode;

const isFrameLike = (node: BaseNode): node is FrameLike =>
	node.type === "FRAME" ||
	node.type === "COMPONENT" ||
	node.type === "COMPONENT_SET";

const isComponentRoot = (node: BaseNode | null | undefined) =>
	(node?.type === "COMPONENT" || node?.type === "COMPONENT_SET") &&
	!node.removed;

/**
 * A component property's name as an instance's attribute: without the `#id`
 * Figma gives text and boolean ones, lower case, spaces as hyphens.
 */
const propertyName = (key: string) =>
	(key.split("#")[0] as string).trim().toLowerCase().replace(/\s+/g, "-");

const shared = (node: BaseNode, key: string) =>
	node.getSharedPluginData(SYNC_NAMESPACE, key);

/** The Link ID a Design Project stored in this file, if any. */
export function fileLinkId(): string | null {
	return shared(figma.root, SYNC_KEYS.link) || null;
}

export function linkFile({
	linkId,
}: CommandParams<"link_file">): CommandResult<"link_file"> {
	figma.root.setSharedPluginData(SYNC_NAMESPACE, SYNC_KEYS.link, linkId);
	return {
		file: { key: figma.fileKey ?? null, name: figma.root.name },
		linkId,
	};
}

export async function pushScreens(
	{
		page: pageRef,
		screens,
		images,
		designSystem: tokens,
		frames: linkedFrames,
		screenFrames,
		components,
		linked,
	}: CommandParams<"push_screens">,
	deadline: Deadline = NO_DEADLINE,
): Promise<CommandResult<"push_screens">> {
	const found = new Map<string, BaseNode>();
	const ids = [
		...[...components, ...screens].flatMap((item) => [
			...("frameId" in item && item.frameId ? [item.frameId] : []),
			...("nodeId" in item && item.nodeId ? [item.nodeId] : []),
			...treeIds(item.tree),
			...item.remove,
		]),
		...Object.values(linkedFrames),
	];
	const [page, loadedTokens, linkedComponents] = await Promise.all([
		findPage(pageRef),
		tokens && loadDesignSystem(tokens),
		Promise.all(linked.map(findLinkedComponent)),
		...ids.map(async (id) => {
			const node = await figma.getNodeByIdAsync(id);
			if (node) found.set(id, node);
		}),
	]);
	if (page) await page.loadAsync();
	const mains = await instanceMains(
		screens.map(({ tree }) => tree),
		found,
	);
	const fonts = [
		...(loadedTokens?.fonts ?? []),
		...[...components, ...screens].flatMap(({ tree }) =>
			treeFonts(tree, found),
		),
	];
	const failed = await loadFonts(fonts);
	const missing = fonts.find((font) => failed.has(fontKey(font)));
	if (missing) {
		throw new CommandError(
			"font_not_found",
			`Font "${fontKey(missing)}" isn't available in this file, so nothing was pushed. Install it, or use another font-family / font-weight in the Screen.`,
		);
	}
	checkLinks(screens, linkedFrames, found);
	checkInstances(
		screens.map(({ tree }) => tree),
		new Set(components.map(({ component }) => component)),
		linkedComponents,
	);
	checkDeadline(deadline);

	// Synchronous from here on: the document changes all at once.
	const designSystem = loadedTokens && applyDesignSystem(loadedTokens);
	const screensPage = page ?? createPage(pageRef.name);
	const hashes = Object.fromEntries(
		Object.entries(images).map(([name, bytes]) => [
			name,
			figma.createImage(figma.base64Decode(bytes)).hash,
		]),
	);
	const applier = new Applier(found, hashes, designSystem);
	for (const { component, root } of linkedComponents)
		applier.components.set(component, root);
	for (const [id, main] of mains) applier.mains.set(id, main);
	// Components first, so the Screens' instances find them.
	const pushedComponents = components.map((component) => ({
		component: component.component,
		root: applier.applyComponent(screensPage, component),
	}));
	for (const { remove } of components) {
		for (const id of remove) {
			const layer = found.get(id);
			if (layer && !layer.removed && layer.type !== "PAGE") layer.remove();
		}
	}
	const frames = screens.map(({ screen, frameId, tree, remove }) => {
		for (const id of remove) {
			const layer = found.get(id);
			if (layer && !layer.removed && layer.id !== frameId) layer.remove();
		}
		const existing = frameId ? found.get(frameId) : undefined;
		const frame =
			existing?.type === "FRAME" && !existing.removed
				? existing
				: placeNewFrame(screensPage);
		frame.setSharedPluginData(SYNC_NAMESPACE, SYNC_KEYS.screen, screen);
		applier.apply(frame, tree, true);
		return { screen, frame };
	});
	// Only styles and reactions are set asynchronously, once the layers are
	// in place and every linked frame exists.
	await applier.applyTextStyles();
	const pushedFrames = new Map(
		frames.map(({ screen, frame }) => [screen, frame.id]),
	);
	await applier.applyLinks(
		(screen) => pushedFrames.get(screen) ?? linkedFrames[screen],
		new Set([...screenFrames, ...pushedFrames.values()]),
	);
	figma.commitUndo();
	return {
		page: { id: screensPage.id, name: screensPage.name },
		images: hashes,
		...(designSystem && { designSystem: designSystem.result }),
		screens: await Promise.all(
			frames.map(async ({ screen, frame }) => ({
				screen,
				frame: await readNode(frame),
			})),
		),
		components: await Promise.all(
			pushedComponents.map(async ({ component, root }) => ({
				component,
				node: await readNode(root),
			})),
		),
		linked: linkedComponents.map(({ info }) => info),
	};
}

/** A Linked Component's component set (or lone component), found by ID or imported by key. */
async function findLinkedComponent({
	component,
	key,
	id,
}: CommandParams<"push_screens">["linked"][number]): Promise<{
	component: string;
	root: ComponentRoot;
	info: LinkedComponentInfo;
}> {
	let node: BaseNode | null = null;
	if (id) node = await figma.getNodeByIdAsync(id);
	else if (key) {
		node = await figma.importComponentSetByKeyAsync(key).catch(() => null);
		node ??= await figma.importComponentByKeyAsync(key).catch(() => null);
	}
	if (!node || !isComponentRoot(node)) {
		throw new CommandError(
			"component_not_found",
			`Linked Component ${component}: no component with ${key ? `key "${key}" in this file or its enabled libraries` : `ID ${id} in this file`}, so nothing was pushed. Fix components/${component}.json (a published component's or component set's key, or the node ID of one in this file).`,
		);
	}
	const root = componentRootOf(node as ComponentRoot);
	return { component, root, info: { component, ...linkedInfo(root) } };
}

/** A variant stands for its component set. */
const componentRootOf = (node: ComponentRoot): ComponentRoot =>
	(node.parent?.type === "COMPONENT_SET" ? node.parent : node) as ComponentRoot;

/** What a Linked Component records of its component set (or lone component). */
function linkedInfo(
	root: ComponentRoot,
): Omit<LinkedComponentInfo, "component"> {
	return {
		componentId: root.id,
		...(root.key && { key: root.key }),
		...componentDefinitions(root),
	};
}

export async function readComponents({
	ids,
}: CommandParams<"read_components">): Promise<
	CommandResult<"read_components">
> {
	const found = await Promise.all(
		ids.map(async (id) => {
			const node = await figma.getNodeByIdAsync(id);
			if (!isComponentRoot(node)) return [];
			const root = componentRootOf(node as ComponentRoot);
			return [
				{ id, name: root.name, remote: root.remote, ...linkedInfo(root) },
			];
		}),
	);
	return { components: found.flat() };
}

/** A component set's (or lone component's) properties, as Screens set them. */
function componentDefinitions(
	root: ComponentRoot,
): Pick<LinkedComponentInfo, "properties" | "variants"> {
	const properties: LinkedComponentInfo["properties"] = {};
	for (const [key, definition] of Object.entries(
		root.componentPropertyDefinitions,
	)) {
		const name = propertyName(key);
		const value = String(definition.defaultValue);
		if (definition.type === "VARIANT")
			properties[name] = {
				type: "VARIANT",
				default: value,
				options: definition.variantOptions ?? [],
			};
		else if (definition.type === "TEXT" || definition.type === "BOOLEAN")
			properties[name] = { type: definition.type, default: value };
	}
	if (root.type !== "COMPONENT_SET") return { properties };
	const variants = root.children.map((child) =>
		Object.entries((child as ComponentNode).variantProperties ?? {})
			.map(([name, value]) => `${propertyName(name)}=${value}`)
			.join(", "),
	);
	return { properties, variants };
}

/** The main components of the instances the trees update, which decide whether each can stay. */
async function instanceMains(
	trees: ScreenNode[],
	found: Map<string, BaseNode>,
): Promise<Map<string, ComponentNode>> {
	const mains = new Map<string, ComponentNode>();
	const walk = async (spec: ScreenNode) => {
		const existing = spec.id ? found.get(spec.id) : undefined;
		if (spec.type === "INSTANCE" && existing?.type === "INSTANCE") {
			const main = await existing.getMainComponentAsync();
			if (main) mains.set(existing.id, main);
		}
		await Promise.all((spec.children ?? []).map(walk));
	};
	await Promise.all(trees.map(walk));
	return mains;
}

/**
 * Every instance is of a Component of this push, and sets only properties
 * a Linked Component has, to values it takes.
 */
function checkInstances(
	trees: ScreenNode[],
	defined: Set<string>,
	linked: { component: string; info: LinkedComponentInfo }[],
) {
	const walk = (spec: ScreenNode) => {
		const name = spec.component;
		if (spec.type === "INSTANCE" && name !== undefined) {
			const link = linked.find(({ component }) => component === name);
			if (!link && !defined.has(name)) {
				throw new CommandError(
					"component_not_found",
					`Layer ${spec.key} is an instance of ${name}, which this push doesn't send or link, so nothing was pushed.`,
				);
			}
			// Defined Components' properties were checked against their files.
			if (!link) {
				spec.children?.forEach(walk);
				return;
			}
			for (const [property, value] of Object.entries(spec.properties ?? {})) {
				const definition = link.info.properties[property];
				if (!definition) {
					const names = Object.keys(link.info.properties).join(", ");
					throw new CommandError(
						"invalid_property",
						`Layer ${spec.key} sets ${property} on ${name}, which has no such property (${names ? `it has ${names}` : "it has none"}), so nothing was pushed.`,
					);
				}
				if (
					definition.type === "VARIANT" &&
					!definition.options.includes(value)
				) {
					throw new CommandError(
						"invalid_property",
						`Layer ${spec.key} sets ${property}="${value}" on ${name}, whose ${property} is one of ${definition.options.join(", ")}, so nothing was pushed.`,
					);
				}
			}
		}
		spec.children?.forEach(walk);
	};
	trees.forEach(walk);
}

/** Room between frames on the Explorations Page. */
const GAP = 100;

export async function pushExplorations(
	{
		page: pageRef,
		screens,
		images,
		components,
	}: CommandParams<"push_explorations">,
	deadline: Deadline = NO_DEADLINE,
): Promise<CommandResult<"push_explorations">> {
	const found = new Map<string, BaseNode>();
	const roots = new Map<string, ComponentRoot>();
	const trees = screens.flatMap(({ directions }) =>
		directions.map(({ tree }) => tree),
	);
	const [page] = await Promise.all([
		findPage(pageRef),
		...Object.entries(components).map(async ([component, id]) => {
			const node = await figma.getNodeByIdAsync(id);
			if (isComponentRoot(node)) roots.set(component, node as ComponentRoot);
		}),
		...trees.flatMap(treeIds).map(async (id) => {
			const node = await figma.getNodeByIdAsync(id);
			if (node) found.set(id, node);
		}),
	]);
	if (page) await page.loadAsync();
	const fonts = trees.flatMap((tree) => treeFonts(tree, found));
	const failed = await loadFonts(fonts);
	const missing = fonts.find((font) => failed.has(fontKey(font)));
	if (missing) {
		throw new CommandError(
			"font_not_found",
			`Font "${fontKey(missing)}" isn't available in this file, so nothing was pushed. Install it, or use another font-family / font-weight in the Direction.`,
		);
	}
	for (const tree of trees) {
		for (const id of treeIds(tree)) {
			if (!found.get(id) || found.get(id)?.removed) {
				throw new CommandError(
					"node_not_found",
					`The layer ${id} of a Figma-owned Element isn't in the file any more, so nothing was pushed. Pull first.`,
				);
			}
		}
	}
	checkInstances(trees, new Set(roots.keys()), []);
	checkDeadline(deadline);

	// Synchronous from here on: the document changes all at once.
	const explorations = page ?? createPage(pageRef.name);
	const hashes = Object.fromEntries(
		Object.entries(images).map(([name, bytes]) => [
			name,
			figma.createImage(figma.base64Decode(bytes)).hash,
		]),
	);
	const applier = new Applier(found, hashes, undefined, true);
	for (const [component, root] of roots)
		applier.components.set(component, root);
	const result = screens.map(({ screen, directions }) => {
		// A Screen's copies go in a row: where its last copies were, else below the rest.
		const old = explorations.children.filter(
			(node) => shared(node, SYNC_KEYS.exploration) === screen,
		);
		const bottom = Math.max(
			0,
			...explorations.children.map((node) => node.y + node.height + GAP),
		);
		let x = old.length > 0 ? Math.min(...old.map((node) => node.x)) : 0;
		const y = old.length > 0 ? Math.min(...old.map((node) => node.y)) : bottom;
		for (const node of old) node.remove();
		const frames = directions.map(({ direction, tree }) => {
			const frame = figma.createFrame();
			explorations.appendChild(frame);
			frame.setSharedPluginData(SYNC_NAMESPACE, SYNC_KEYS.exploration, screen);
			applier.apply(frame, tree, true);
			frame.x = x;
			frame.y = y;
			x += frame.width + GAP;
			return { direction, frameId: frame.id };
		});
		return { screen, frames };
	});
	await applier.applyTextStyles();
	figma.commitUndo();
	return {
		page: { id: explorations.id, name: explorations.name },
		screens: result,
	};
}

export async function readScreens({
	screens,
	components,
}: CommandParams<"read_screens">): Promise<CommandResult<"read_screens">> {
	const frames = await Promise.all(
		screens.map(async ({ screen, frameId }) => {
			const node = await figma.getNodeByIdAsync(frameId);
			const frame =
				node?.type === "FRAME" ? node : await findFrameOfScreen(screen);
			return { screen, frame: frame ? await readNode(frame) : null };
		}),
	);
	const roots = await Promise.all(
		components.map(async ({ component, nodeId }) => {
			const node = await figma.getNodeByIdAsync(nodeId);
			const root = isComponentRoot(node)
				? (node as ComponentRoot)
				: await findTopLevel(SYNC_KEYS.component, component);
			return { component, node: root ? await readNode(root) : null };
		}),
	);
	return { screens: frames, components: roots };
}

export async function getImage({
	imageHash,
}: CommandParams<"get_image">): Promise<CommandResult<"get_image">> {
	const image = figma.getImageByHash(imageHash);
	if (!image) {
		throw new CommandError(
			"image_not_found",
			`No image with hash "${imageHash}" exists in this file.`,
		);
	}
	return { bytes: figma.base64Encode(await image.getBytesAsync()) };
}

/** A frame that was cut and pasted has a new ID but keeps its plugin data. */
async function findFrameOfScreen(screen: string): Promise<FrameNode | null> {
	const node = await findTopLevel(SYNC_KEYS.screen, screen);
	return node?.type === "FRAME" ? node : null;
}

/** The top-level node of any page whose plugin data says it's this Screen's (or Component's). */
async function findTopLevel(
	key: string,
	value: string,
): Promise<SceneNode | null> {
	await figma.loadAllPagesAsync();
	for (const page of figma.root.children) {
		for (const node of page.children) {
			if (shared(node, key) === value) return node;
		}
	}
	return null;
}

async function findPage({
	id,
	name,
}: CommandParams<"push_screens">["page"]): Promise<PageNode | undefined> {
	if (id) {
		const page = await figma.getNodeByIdAsync(id);
		if (page?.type === "PAGE") return page;
	}
	return figma.root.children.find((page) => page.name === name);
}

function createPage(name: string): PageNode {
	const page = figma.createPage();
	page.name = name;
	return page;
}

/** A new frame to the right of everything on the page. */
function placeNewFrame(page: PageNode): FrameNode {
	const right = Math.max(
		0,
		...page.children.map((node) => node.x + node.width + 100),
	);
	const frame = figma.createFrame();
	page.appendChild(frame);
	frame.x = right;
	frame.y = 0;
	return frame;
}

/** Every Prototype Link goes to a Screen of this push or to a frame in the file. */
function checkLinks(
	screens: CommandParams<"push_screens">["screens"],
	linkedFrames: Record<string, string>,
	found: Map<string, BaseNode>,
) {
	const pushed = new Set(screens.map(({ screen }) => screen));
	const walk = (node: ScreenNode) => {
		const screen = node.link?.screen;
		if (screen !== undefined && !pushed.has(screen)) {
			const frame = found.get(linkedFrames[screen] ?? "");
			if (frame?.type !== "FRAME" || frame.removed) {
				throw new CommandError(
					"invalid_destination",
					`Layer ${node.key} links to the Screen ${screen}, whose frame ${linkedFrames[screen] ? `${linkedFrames[screen]} isn't in this file` : "wasn't given"}, so nothing was pushed. Push ${screen} too.`,
				);
			}
		}
		node.children?.forEach(walk);
	};
	for (const { tree } of screens) walk(tree);
}

function treeIds(tree: ScreenNode): string[] {
	return [
		...(tree.id ? [tree.id] : []),
		...(tree.children ?? []).flatMap(treeIds),
	];
}

/** Fonts the tree sets, plus those of text layers it edits. */
function treeFonts(tree: ScreenNode, found: Map<string, BaseNode>): FontName[] {
	const fonts: FontName[] = [];
	if (tree.text) fonts.push(tree.text.fontName);
	const existing = tree.id ? found.get(tree.id) : undefined;
	if (existing?.type === "TEXT") {
		fonts.push(
			...(existing.fontName === figma.mixed
				? existing.getRangeAllFontNames(0, existing.characters.length)
				: [existing.fontName]),
		);
	}
	return [
		...fonts,
		...(tree.children ?? []).flatMap((child) => treeFonts(child, found)),
	];
}

/** A layer field FLOAT_BINDINGS names, as the Plugin API binds it. */
const FLOAT_FIELDS = {
	itemSpacing: ["itemSpacing"],
	paddingTop: ["paddingTop"],
	paddingRight: ["paddingRight"],
	paddingBottom: ["paddingBottom"],
	paddingLeft: ["paddingLeft"],
	cornerRadius: [
		"topLeftRadius",
		"topRightRadius",
		"bottomRightRadius",
		"bottomLeftRadius",
	],
} as const satisfies Record<
	(typeof FLOAT_BINDINGS)[number],
	readonly VariableBindableNodeField[]
>;

class Applier {
	private readonly textStyles: [TextNode, TextStyle | undefined][] = [];
	/** Pushed layers below their frames, and the Prototype Link each should have. */
	private readonly links: [ReactiveNode, ScreenNode["link"]][] = [];
	/** The component set (or lone component) each Component's instances come from. */
	readonly components = new Map<string, ComponentRoot>();
	/** Existing instances' main components, by instance ID. */
	readonly mains = new Map<string, ComponentNode>();
	/** Layers made for keys before their tree is applied (a new set's variants). */
	private readonly made = new Map<string, SceneNode>();
	/** While applying a Component: its text layers, and the text property each shows. */
	private texts: [TextNode, string | undefined][] | undefined;

	constructor(
		private readonly found: Map<string, BaseNode>,
		private readonly hashes: Record<string, string>,
		private readonly designSystem?: AppliedDesignSystem,
		/** Figma-owned Elements get copies of their layers, not the layers. */
		private readonly copyOwned = false,
	) {}

	/** Applies each text layer's text style, or detaches the one it had. */
	async applyTextStyles() {
		for (const [node, style] of this.textStyles) {
			if (style) await node.setTextStyleIdAsync(style.id);
			else if (node.textStyleId) await node.setTextStyleIdAsync("");
		}
	}

	/**
	 * Gives each pushed layer its Prototype Link to `frameOf` its Screen, or
	 * none; the frames' own reactions and every other reaction stay.
	 */
	async applyLinks(
		frameOf: (screen: string) => string | undefined,
		screenFrames: ReadonlySet<string>,
	) {
		for (const [node, link] of this.links) {
			const destination = link && frameOf(link.screen);
			const current = readReactions(node);
			const next = withPrototypeLink(
				current,
				link && destination
					? linkReaction(destination, link.transition)
					: undefined,
				screenFrames,
			);
			if (JSON.stringify(next) === JSON.stringify(current)) continue;
			// Our schema mirrors the Plugin API's; it only types `readonly` looser.
			await node.setReactionsAsync(next as unknown as Reaction[]);
		}
	}

	/**
	 * Applies a Defined Component's tree to its component set (or lone
	 * component), made on the page below everything else when it has none.
	 */
	applyComponent(
		page: PageNode,
		{
			component,
			nodeId,
			tree,
		}: CommandParams<"push_screens">["components"][number],
	): ComponentRoot {
		const existing = nodeId ? this.found.get(nodeId) : undefined;
		let root: ComponentRoot;
		if (tree.type === "COMPONENT_SET") {
			if (existing?.type === "COMPONENT_SET" && !existing.removed) {
				root = existing;
			} else {
				const variants = (tree.children ?? []).map((spec) => {
					const variant = this.layerFor(spec) as ComponentNode;
					this.made.set(spec.key, variant);
					return variant;
				});
				root = figma.combineAsVariants(variants, page);
			}
		} else {
			root = this.layerFor(tree) as ComponentNode;
			if (root.parent !== page) page.appendChild(root);
		}
		const isNew = !isComponentRoot(existing);
		root.setSharedPluginData(SYNC_NAMESPACE, SYNC_KEYS.component, component);
		this.texts = [];
		this.apply(root, tree, true);
		this.applyTextProperties(root, this.texts);
		this.texts = undefined;
		this.made.clear();
		if (isNew) {
			const others = page.children.filter((node) => node !== root);
			root.x = 0;
			root.y = Math.max(0, ...others.map((node) => node.y + node.height + GAP));
		}
		this.components.set(component, root);
		return root;
	}

	/**
	 * Gives the Component (its set, for variants) a text property per name
	 * its text layers show, defaulting to the first one's characters, and
	 * points the layers at them; it drops the text properties it no longer has.
	 */
	private applyTextProperties(
		root: ComponentRoot,
		texts: [TextNode, string | undefined][],
	) {
		const definitions = root.componentPropertyDefinitions;
		const wanted = new Map<string, string>();
		for (const [node, property] of texts) {
			if (property && !wanted.has(property))
				wanted.set(property, node.characters);
		}
		const existing = new Map(
			Object.entries(definitions)
				.filter(([, definition]) => definition.type === "TEXT")
				.map(([key]) => [propertyName(key), key]),
		);
		for (const [name, key] of existing) {
			if (!wanted.has(name)) root.deleteComponentProperty(key);
		}
		const keys = new Map<string, string>();
		for (const [name, defaultValue] of wanted) {
			const key = existing.get(name);
			if (!key) {
				keys.set(name, root.addComponentProperty(name, "TEXT", defaultValue));
				continue;
			}
			if (definitions[key]?.defaultValue !== defaultValue)
				root.editComponentProperty(key, { defaultValue });
			keys.set(name, key);
		}
		for (const [node, property] of texts) {
			const key = property && keys.get(property);
			node.componentPropertyReferences = key ? { characters: key } : {};
		}
	}

	/** An instance: only its properties, name, place and size are the Screen's. */
	private instance(node: InstanceNode, spec: ScreenNode) {
		node.setSharedPluginData(SYNC_NAMESPACE, SYNC_KEYS.element, spec.key);
		this.links.push([node, spec.link]);
		if (spec.name !== undefined) node.name = spec.name;
		const main = this.mainFor(spec);
		const root = (
			main.parent?.type === "COMPONENT_SET" ? main.parent : main
		) as ComponentRoot;
		const properties: Record<string, string | boolean> = {};
		for (const [key, definition] of Object.entries(
			root.componentPropertyDefinitions,
		)) {
			const value = spec.properties?.[propertyName(key)];
			if (value === undefined) continue;
			properties[key] =
				definition.type === "BOOLEAN" ? value === "true" : value;
		}
		if (Object.keys(properties).length > 0) node.setProperties(properties);
		place(node, hugsAsMain(main, node, spec), false);
	}

	/** The component an instance's Component and variant properties name. */
	private mainFor(spec: ScreenNode): ComponentNode {
		const root = this.components.get(spec.component ?? "");
		if (!root) {
			throw new CommandError(
				"component_not_found",
				`Layer ${spec.key} is an instance of ${spec.component}, which isn't in this file.`,
			);
		}
		if (root.type === "COMPONENT") return root;
		const definitions = root.componentPropertyDefinitions;
		const wanted = Object.entries(definitions)
			.filter(([, definition]) => definition.type === "VARIANT")
			.map(([name, definition]) => [
				name,
				spec.properties?.[propertyName(name)] ??
					String(definition.defaultValue),
			]);
		const main = root.children.find((variant) =>
			wanted.every(
				([name, value]) =>
					(variant as ComponentNode).variantProperties?.[name as string] ===
					value,
			),
		);
		if (!main) {
			throw new CommandError(
				"invalid_property",
				`Layer ${spec.key}: ${spec.component} has no variant ${wanted.map(([n, v]) => `${n}=${v}`).join(", ")}.`,
			);
		}
		return main as ComponentNode;
	}

	apply(node: Layer, spec: ScreenNode, isRoot: boolean) {
		node.setSharedPluginData(SYNC_NAMESPACE, SYNC_KEYS.element, spec.key);
		// Only a top-level node can be a component set.
		if (!isRoot) this.links.push([node as ReactiveNode, spec.link]);
		if (node.type === "TEXT") this.texts?.push([node, spec.property]);
		this.unbind(node, spec);
		if (spec.name !== undefined) node.name = spec.name;
		else if (node.type === "TEXT") node.autoRename = true;
		if (node.type === "TEXT" && spec.text) {
			node.fontName = spec.text.fontName;
			node.fontSize = spec.text.fontSize;
			node.characters = spec.text.characters;
			node.textAlignHorizontal = spec.text.textAlignHorizontal;
		}
		if (isFrameLike(node) && spec.layout) {
			const { layout } = spec;
			node.layoutMode = layout.mode;
			node.itemSpacing = layout.itemSpacing;
			node.paddingTop = layout.padding.top;
			node.paddingRight = layout.padding.right;
			node.paddingBottom = layout.padding.bottom;
			node.paddingLeft = layout.padding.left;
			node.primaryAxisAlignItems = layout.primaryAxisAlignItems;
			node.counterAxisAlignItems = layout.counterAxisAlignItems;
			node.layoutWrap = layout.wrap ? "WRAP" : "NO_WRAP";
		}
		node.fills = spec.fills.map((fill, index) =>
			this.paint(fill, index === 0 ? spec.bindings?.fill : undefined),
		);
		applyStroke(node, spec);
		if (isFrameLike(node)) node.clipsContent = spec.clips ?? false;
		if (node.type === "VECTOR" && spec.vector) {
			// Sized first: resizing a vector scales its paths.
			place(node, spec, isRoot);
			node.vectorPaths = spec.vector.paths;
		}
		if (node.type !== "TEXT" && node.type !== "VECTOR") {
			const radius = spec.cornerRadius ?? 0;
			if (typeof radius === "number") node.cornerRadius = radius;
			else {
				node.topLeftRadius = radius.topLeft;
				node.topRightRadius = radius.topRight;
				node.bottomRightRadius = radius.bottomRight;
				node.bottomLeftRadius = radius.bottomLeft;
			}
		}
		node.opacity = spec.opacity ?? 1;
		if (node.type !== "VECTOR") place(node, spec, isRoot);
		this.bind(node, spec);
		if (isFrameLike(node)) this.children(node, spec.children ?? []);
	}

	private variable(token: string | undefined): Variable | undefined {
		return token ? this.designSystem?.variables.get(token) : undefined;
	}

	/** Frees fields the tree no longer binds, so their values can be set. */
	private unbind(node: Layer, spec: ScreenNode) {
		if (node.type === "TEXT") return;
		for (const binding of FLOAT_BINDINGS) {
			if (this.variable(spec.bindings?.[binding])) continue;
			for (const field of FLOAT_FIELDS[binding]) {
				if (node.boundVariables?.[field]) node.setBoundVariable(field, null);
			}
		}
	}

	/** Binds spacing and radii to their variables; text styles come last. */
	private bind(node: Layer, spec: ScreenNode) {
		if (node.type === "TEXT") {
			const token = spec.bindings?.textStyle;
			this.textStyles.push([
				node,
				token ? this.designSystem?.textStyles.get(token) : undefined,
			]);
			return;
		}
		for (const binding of FLOAT_BINDINGS) {
			const variable = this.variable(spec.bindings?.[binding]);
			if (!variable) continue;
			if (binding !== "cornerRadius" && !isFrameLike(node)) continue;
			for (const field of FLOAT_FIELDS[binding]) {
				node.setBoundVariable(field, variable);
			}
		}
	}

	/**
	 * Puts the children in the tree's order, updating or creating each, and
	 * removes pushed layers the tree no longer has. Layers without a key are
	 * the designers' and stay, after the pushed ones.
	 */
	private children(parent: FrameLike, specs: ScreenNode[]) {
		const kept = new Set<BaseNode>();
		specs.forEach((spec, index) => {
			const child = this.layerFor(spec);
			if (parent.children[index] !== child)
				(parent as FrameNode).insertChild(index, child);
			kept.add(child);
			if (spec.type === "OWNED") this.keep(child, spec);
			else if (spec.type === "INSTANCE")
				this.instance(child as InstanceNode, spec);
			else this.apply(child as Layer, spec, false);
		});
		for (const child of [...parent.children]) {
			if (!kept.has(child) && shared(child, SYNC_KEYS.element)) child.remove();
		}
	}

	/**
	 * A Figma-owned Element's layer: only its key, and with `place` its name,
	 * size and position, are the Screen's; its content stays the designers'.
	 */
	private keep(node: SceneNode, spec: ScreenNode) {
		node.setSharedPluginData(SYNC_NAMESPACE, SYNC_KEYS.element, spec.key);
		if (!spec.place) return;
		if (spec.name !== undefined) node.name = spec.name;
		if ("resize" in node && "layoutSizingHorizontal" in node) {
			place(node, spec, false);
		}
	}

	private layerFor(spec: ScreenNode): SceneNode {
		const made = this.made.get(spec.key);
		if (made) return made;
		const existing = spec.id ? this.found.get(spec.id) : undefined;
		if (spec.type === "INSTANCE") {
			const main = this.mainFor(spec);
			const current = existing && this.mains.get(existing.id);
			const sameComponent =
				current === main ||
				(current?.parent?.type === "COMPONENT_SET" &&
					current.parent === main.parent);
			if (existing?.type === "INSTANCE" && !existing.removed && sameComponent)
				return existing;
			return main.createInstance();
		}
		if (spec.type === "OWNED") {
			if (existing && !existing.removed) {
				return this.copyOwned
					? (existing as SceneNode).clone()
					: (existing as SceneNode);
			}
			throw new CommandError(
				"node_not_found",
				`The layer ${spec.id} of Figma-owned Element ${spec.key} isn't in the file any more, so nothing was pushed. Pull first.`,
			);
		}
		if (existing && !existing.removed && existing.type === spec.type) {
			return existing as Layer;
		}
		switch (spec.type) {
			case "FRAME":
				return figma.createFrame();
			case "TEXT":
				return figma.createText();
			case "RECTANGLE":
				return figma.createRectangle();
			case "VECTOR":
				return figma.createVector();
			case "COMPONENT":
				return figma.createComponent();
			default:
				throw new Error(`A ${spec.type} isn't made on its own.`);
		}
	}

	private paint(fill: ScreenFill, token?: string): Paint {
		if (fill.type === "SOLID") {
			const { r, g, b } = rgb(fill.color);
			const solid: SolidPaint = {
				type: "SOLID",
				color: { r, g, b },
				opacity: fill.opacity ?? 1,
			};
			const variable = this.variable(token);
			return variable
				? figma.variables.setBoundVariableForPaint(solid, "color", variable)
				: solid;
		}
		const imageHash =
			"imageHash" in fill
				? fill.imageHash
				: (this.hashes[fill.image] as string);
		return { type: "IMAGE", imageHash, scaleMode: fill.scaleMode };
	}
}

type Placeable = SceneNode &
	LayoutMixin & {
		resize(width: number, height: number): void;
	};

/**
 * Sizes a layer, and places it in or out of its parent's auto layout. A
 * Screen's frame is fixed at its size; a Component's set or lone component
 * hugs its content unless it has a size.
 */
function place(node: Placeable, spec: ScreenNode, isRoot: boolean) {
	const screenFrame = isRoot && spec.type === "FRAME";
	const { horizontal, vertical } = screenFrame
		? { horizontal: "FIXED", vertical: "FIXED" }
		: spec.sizing;
	node.resize(
		horizontal === "FIXED" ? spec.width : node.width,
		vertical === "FIXED" ? spec.height : node.height,
	);
	if (screenFrame) return;
	if (!isRoot) position(node, spec);
	node.layoutSizingHorizontal = spec.sizing.horizontal;
	node.layoutSizingVertical = spec.sizing.vertical;
}

/** `position: absolute` is absolute position, pinned to the top left. */
function position(node: Placeable, spec: ScreenNode) {
	if (!spec.position) {
		node.layoutPositioning = "AUTO";
		return;
	}
	node.layoutPositioning = "ABSOLUTE";
	node.x = spec.position.x;
	node.y = spec.position.y;
	if ("constraints" in node) {
		node.constraints = { horizontal: "MIN", vertical: "MIN" };
	}
}

/** A border (inside, taking up room in auto layout) or an SVG stroke. */
function applyStroke(node: Layer, spec: ScreenNode) {
	const { stroke } = spec;
	if (!stroke) {
		if (node.strokes.length > 0) node.strokes = [];
		return;
	}
	node.strokes = [{ type: "SOLID", color: rgb(stroke.color), opacity: 1 }];
	node.strokeWeight = stroke.weight;
	node.strokeAlign = stroke.align;
	node.dashPattern = [];
	if (node.type === "VECTOR") {
		node.strokeCap = stroke.cap ?? "NONE";
		node.strokeJoin = stroke.join ?? "MITER";
	}
	if (isFrameLike(node)) node.strokesIncludedInLayout = true;
}

/** A layer and everything in it (but an instance's own layers), as Pull reads it. */
export async function readNode(node: SceneNode): Promise<SyncedNode> {
	const out: SyncedNode = {
		id: node.id,
		key: shared(node, SYNC_KEYS.element) || null,
		type: node.type,
		name: node.name,
		visible: node.visible,
		x: round(node.x),
		y: round(node.y),
		width: round(node.width),
		height: round(node.height),
		rotation: "rotation" in node ? round(node.rotation) : 0,
		opacity: "opacity" in node ? round(node.opacity) : 1,
		fills: fills(node),
		strokes: "strokes" in node ? node.strokes.length : 0,
		effects: "effects" in node ? node.effects.length : 0,
		cornerRadius: "cornerRadius" in node ? cornerRadius(node) : 0,
	};
	if ("layoutSizingHorizontal" in node) {
		out.sizing = {
			horizontal: node.layoutSizingHorizontal,
			vertical: node.layoutSizingVertical,
		};
	}
	if ("layoutPositioning" in node && node.layoutPositioning === "ABSOLUTE") {
		out.absolute =
			"constraints" in node
				? node.constraints
				: { horizontal: "MIN", vertical: "MIN" };
	}
	const stroke = readStroke(node);
	if (stroke) out.stroke = stroke;
	if (node.type === "INSTANCE") {
		const main = await node.getMainComponentAsync();
		out.instance = readInstance(node, main);
		if (node.layoutMode === "NONE" && main && out.sizing) {
			type Sizing = NonNullable<SyncedNode["sizing"]>["horizontal"];
			const hugs = (axis: "width" | "height", sizing: Sizing): Sizing =>
				sizing === "FIXED" && round(node[axis]) === round(main[axis])
					? "HUG"
					: sizing;
			out.sizing = {
				horizontal: hugs("width", out.sizing.horizontal),
				vertical: hugs("height", out.sizing.vertical),
			};
		}
		if (node.reactions.length > 0) out.reactions = readReactions(node);
		return out;
	}
	if (isFrameLike(node)) out.clips = node.clipsContent;
	if (node.type === "VECTOR") {
		out.vector = {
			paths: node.vectorPaths.map(({ data, windingRule }) => ({
				data,
				windingRule,
			})),
		};
	}
	if (isFrameLike(node)) {
		out.layout = {
			mode: node.layoutMode,
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
		};
	}
	if (node.type === "TEXT") {
		out.text = {
			...text(node),
			textAlignHorizontal: node.textAlignHorizontal,
		};
		const property = node.componentPropertyReferences?.characters;
		if (property) out.property = propertyName(property);
	}
	const bindings = readBindings(node);
	if (bindings) out.bindings = bindings;
	if ("reactions" in node && node.reactions.length > 0)
		out.reactions = readReactions(node);
	if ("children" in node) {
		out.children = await Promise.all(
			(node as Container).children.map((child) => readNode(child as SceneNode)),
		);
	}
	return out;
}

/**
 * An instance of a component without auto layout can't hug, so where the
 * Screen has it hug it keeps its main component's size; readNode reads
 * that size back as hugging.
 */
function hugsAsMain(
	main: ComponentNode,
	node: InstanceNode,
	spec: ScreenNode,
): ScreenNode {
	if (node.layoutMode !== "NONE") return spec;
	const { horizontal, vertical } = spec.sizing;
	return {
		...spec,
		width: horizontal === "HUG" ? main.width : spec.width,
		height: vertical === "HUG" ? main.height : spec.height,
		sizing: {
			horizontal: horizontal === "HUG" ? "FIXED" : horizontal,
			vertical: vertical === "HUG" ? "FIXED" : vertical,
		},
	};
}

/** An instance's main component (and set) and property values, as Screens write them. */
function readInstance(
	node: InstanceNode,
	main: ComponentNode | null,
): SyncedNode["instance"] {
	const set = main?.parent?.type === "COMPONENT_SET" ? main.parent : undefined;
	const properties: Record<string, string> = {};
	for (const [key, { type, value }] of Object.entries(
		node.componentProperties,
	)) {
		if (type === "VARIANT" || type === "TEXT" || type === "BOOLEAN")
			properties[propertyName(key)] = String(value);
	}
	return {
		mainId: main?.id ?? "",
		mainKey: main?.key || null,
		...(set && { setId: set.id, setKey: set.key || null }),
		properties,
	};
}

/** How a layer's first stroke is drawn. */
function readStroke(node: SceneNode): SyncedNode["stroke"] {
	if (!("strokes" in node) || node.strokes.length === 0) return undefined;
	const mixed = (value: unknown) =>
		value === figma.mixed ? ("mixed" as const) : value;
	const first = node.strokes[0] as Paint;
	return {
		paint: paint(first),
		weight: mixed(node.strokeWeight) as number | "mixed",
		align: node.strokeAlign,
		cap: ("strokeCap" in node ? mixed(node.strokeCap) : "NONE") as string,
		join: ("strokeJoin" in node ? mixed(node.strokeJoin) : "MITER") as string,
		dashed: "dashPattern" in node && node.dashPattern.length > 0,
		...(isFrameLike(node) && {
			inLayout: node.strokesIncludedInLayout,
		}),
	};
}

/** The variables and text style a layer is bound to, by ID. */
function readBindings(node: SceneNode): SyncedNode["bindings"] {
	const bindings: NonNullable<SyncedNode["bindings"]> = {};
	const bound = ("boundVariables" in node && node.boundVariables) || {};
	for (const binding of FLOAT_BINDINGS) {
		const ids = FLOAT_FIELDS[binding].map(
			(field) =>
				(bound as Record<string, VariableAlias | undefined>)[field]?.id,
		);
		// Corners count only when all four share one variable.
		if (ids[0] && ids.every((id) => id === ids[0])) bindings[binding] = ids[0];
	}
	if (node.type === "TEXT" && typeof node.textStyleId === "string") {
		if (node.textStyleId) bindings.textStyle = node.textStyleId;
	}
	return Object.keys(bindings).length > 0 ? bindings : undefined;
}

function fills(node: SceneNode): PaintInfo[] | "mixed" {
	if (!("fills" in node)) return [];
	if (node.fills === figma.mixed) return "mixed";
	return node.fills.map(paint);
}

function rgb(hex: string): RGB {
	const channel = (offset: number) =>
		Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
	return { r: channel(1), g: channel(3), b: channel(5) };
}
