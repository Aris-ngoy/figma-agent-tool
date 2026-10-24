// Push and Pull: applies Screens' node trees to their frames in place and
// reads frames back. Layers are matched by node ID, which the server keeps;
// each layer's element key and each frame's Screen are stored in shared
// plugin data, so a frame that is renamed, moved or cut and pasted stays
// linked. Like create_nodes, a push does its async work first and edits the
// document in one synchronous pass, as one undo step.
import {
	type CommandParams,
	type CommandResult,
	type Paint as PaintInfo,
	type ScreenFill,
	type ScreenNode,
	SYNC_KEYS,
	SYNC_NAMESPACE,
	type SyncedNode,
} from "@figma-agent-tool/protocol";
import { fontKey, loadFonts } from "./edit";
import {
	CommandError,
	checkDeadline,
	type Deadline,
	NO_DEADLINE,
} from "./errors";
import { cornerRadius, paint, round, text } from "./serialize";

type Container = BaseNode & ChildrenMixin;
type Layer = FrameNode | TextNode | RectangleNode;

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
	{ page: pageRef, screens, images }: CommandParams<"push_screens">,
	deadline: Deadline = NO_DEADLINE,
): Promise<CommandResult<"push_screens">> {
	const found = new Map<string, BaseNode>();
	const ids = screens.flatMap(({ frameId, tree }) => [
		...(frameId ? [frameId] : []),
		...treeIds(tree),
	]);
	const [page] = await Promise.all([
		findPage(pageRef),
		...ids.map(async (id) => {
			const node = await figma.getNodeByIdAsync(id);
			if (node) found.set(id, node);
		}),
	]);
	if (page) await page.loadAsync();
	const fonts = screens.flatMap(({ tree }) => treeFonts(tree, found));
	const failed = await loadFonts(fonts);
	const missing = fonts.find((font) => failed.has(fontKey(font)));
	if (missing) {
		throw new CommandError(
			"font_not_found",
			`Font "${fontKey(missing)}" isn't available in this file, so nothing was pushed. Install it, or use another font-family / font-weight in the Screen.`,
		);
	}
	checkDeadline(deadline);

	// Synchronous from here on: the document changes all at once.
	const screensPage = page ?? createPage(pageRef.name);
	const hashes = Object.fromEntries(
		Object.entries(images).map(([name, bytes]) => [
			name,
			figma.createImage(figma.base64Decode(bytes)).hash,
		]),
	);
	const frames = screens.map(({ screen, frameId, tree }) => {
		const existing = frameId ? found.get(frameId) : undefined;
		const frame =
			existing?.type === "FRAME" && !existing.removed
				? existing
				: placeNewFrame(screensPage);
		frame.setSharedPluginData(SYNC_NAMESPACE, SYNC_KEYS.screen, screen);
		new Applier(found, hashes).apply(frame, tree, true);
		return { screen, frame };
	});
	figma.commitUndo();
	return {
		page: { id: screensPage.id, name: screensPage.name },
		images: hashes,
		screens: frames.map(({ screen, frame }) => ({
			screen,
			frame: readNode(frame),
		})),
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

class Applier {
	constructor(
		private readonly found: Map<string, BaseNode>,
		private readonly hashes: Record<string, string>,
	) {}

	apply(node: Layer, spec: ScreenNode, isRoot: boolean) {
		node.setSharedPluginData(SYNC_NAMESPACE, SYNC_KEYS.element, spec.key);
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
		node.fills = spec.fills.map((fill) => this.paint(fill));
		if (node.type !== "TEXT") {
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
		const { horizontal, vertical } = isRoot
			? { horizontal: "FIXED", vertical: "FIXED" }
			: spec.sizing;
		node.resize(
			horizontal === "FIXED" ? spec.width : node.width,
			vertical === "FIXED" ? spec.height : node.height,
		);
		if (!isRoot) {
			node.layoutSizingHorizontal = spec.sizing.horizontal;
			node.layoutSizingVertical = spec.sizing.vertical;
		}
		if (node.type === "FRAME") this.children(node, spec.children ?? []);
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
			this.apply(child, spec, false);
		});
		for (const child of [...parent.children]) {
			if (!kept.has(child) && shared(child, SYNC_KEYS.element)) child.remove();
		}
	}

	private layerFor(spec: ScreenNode): Layer {
		const existing = spec.id ? this.found.get(spec.id) : undefined;
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
		}
	}

	private paint(fill: ScreenFill): Paint {
		if (fill.type === "SOLID") {
			const { r, g, b } = rgb(fill.color);
			return {
				type: "SOLID",
				color: { r, g, b },
				opacity: fill.opacity ?? 1,
			};
		}
		const imageHash =
			"imageHash" in fill
				? fill.imageHash
				: (this.hashes[fill.image] as string);
		return { type: "IMAGE", imageHash, scaleMode: fill.scaleMode };
	}
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
	if ("children" in node) {
		out.children = (node as Container).children.map((child) =>
			readNode(child as SceneNode),
		);
	}
	return out;
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
