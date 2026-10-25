// Push and Pull: applies Screens' node trees to their frames in place and
// reads frames back. Layers are matched by node ID, which the server keeps;
// each layer's element key and each frame's Screen are stored in shared
// plugin data, so a frame that is renamed, moved or cut and pasted stays
// linked. Like create_nodes, a push does its async work first and edits the
// document in one synchronous pass, as one undo step.
import {
	type CommandParams,
	type CommandResult,
	FLOAT_BINDINGS,
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
type Layer = FrameNode | TextNode | RectangleNode | VectorNode;

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
	}: CommandParams<"push_screens">,
	deadline: Deadline = NO_DEADLINE,
): Promise<CommandResult<"push_screens">> {
	const found = new Map<string, BaseNode>();
	const ids = [
		...screens.flatMap(({ frameId, tree, remove }) => [
			...(frameId ? [frameId] : []),
			...treeIds(tree),
			...remove,
		]),
		...Object.values(linkedFrames),
	];
	const [page, loadedTokens] = await Promise.all([
		findPage(pageRef),
		tokens && loadDesignSystem(tokens),
		...ids.map(async (id) => {
			const node = await figma.getNodeByIdAsync(id);
			if (node) found.set(id, node);
		}),
	]);
	if (page) await page.loadAsync();
	const fonts = [
		...(loadedTokens?.fonts ?? []),
		...screens.flatMap(({ tree }) => treeFonts(tree, found)),
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
		screens: frames.map(({ screen, frame }) => ({
			screen,
			frame: readNode(frame),
		})),
	};
}

/** Room between frames on the Explorations Page. */
const GAP = 100;

export async function pushExplorations(
	{ page: pageRef, screens, images }: CommandParams<"push_explorations">,
	deadline: Deadline = NO_DEADLINE,
): Promise<CommandResult<"push_explorations">> {
	const found = new Map<string, BaseNode>();
	const trees = screens.flatMap(({ directions }) =>
		directions.map(({ tree }) => tree),
	);
	const [page] = await Promise.all([
		findPage(pageRef),
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
}: CommandParams<"read_screens">): Promise<CommandResult<"read_screens">> {
	const frames = await Promise.all(
		screens.map(async ({ screen, frameId }) => {
			const node = await figma.getNodeByIdAsync(frameId);
			const frame =
				node?.type === "FRAME" ? node : await findFrameOfScreen(screen);
			return { screen, frame: frame ? readNode(frame) : null };
		}),
	);
	return { screens: frames };
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
	await figma.loadAllPagesAsync();
	for (const page of figma.root.children) {
		for (const node of page.children) {
			if (node.type === "FRAME" && shared(node, SYNC_KEYS.screen) === screen) {
				return node;
			}
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

	apply(node: Layer, spec: ScreenNode, isRoot: boolean) {
		node.setSharedPluginData(SYNC_NAMESPACE, SYNC_KEYS.element, spec.key);
		if (!isRoot) this.links.push([node, spec.link]);
		this.unbind(node, spec);
		if (spec.name !== undefined) node.name = spec.name;
		else if (node.type === "TEXT") node.autoRename = true;
		if (node.type === "TEXT" && spec.text) {
			node.fontName = spec.text.fontName;
			node.fontSize = spec.text.fontSize;
			node.characters = spec.text.characters;
			node.textAlignHorizontal = spec.text.textAlignHorizontal;
		}
		if (node.type === "FRAME" && spec.layout) {
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
		if (node.type === "FRAME") node.clipsContent = spec.clips ?? false;
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
		if (node.type === "FRAME") this.children(node, spec.children ?? []);
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
			if (binding !== "cornerRadius" && node.type !== "FRAME") continue;
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
	private children(parent: FrameNode, specs: ScreenNode[]) {
		const kept = new Set<BaseNode>();
		specs.forEach((spec, index) => {
			const child = this.layerFor(spec);
			if (parent.children[index] !== child) parent.insertChild(index, child);
			kept.add(child);
			if (spec.type === "OWNED") this.keep(child, spec);
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
		const existing = spec.id ? this.found.get(spec.id) : undefined;
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

/** Sizes a layer, and places it in or out of its parent's auto layout. */
function place(node: Placeable, spec: ScreenNode, isRoot: boolean) {
	const { horizontal, vertical } = isRoot
		? { horizontal: "FIXED", vertical: "FIXED" }
		: spec.sizing;
	node.resize(
		horizontal === "FIXED" ? spec.width : node.width,
		vertical === "FIXED" ? spec.height : node.height,
	);
	if (isRoot) return;
	position(node, spec);
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
	if (node.type === "FRAME") node.strokesIncludedInLayout = true;
}

/** A layer and everything in it, as Pull reads it. */
export function readNode(node: SceneNode): SyncedNode {
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
	if (node.type === "FRAME") out.clips = node.clipsContent;
	if (node.type === "VECTOR") {
		out.vector = {
			paths: node.vectorPaths.map(({ data, windingRule }) => ({
				data,
				windingRule,
			})),
		};
	}
	if (node.type === "FRAME") {
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
	}
	const bindings = readBindings(node);
	if (bindings) out.bindings = bindings;
	if ("reactions" in node && node.reactions.length > 0)
		out.reactions = readReactions(node);
	if ("children" in node) {
		out.children = (node as Container).children.map((child) =>
			readNode(child as SceneNode),
		);
	}
	return out;
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
		...(node.type === "FRAME" && {
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
