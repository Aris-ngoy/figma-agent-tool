// Seam 2 harness: installs a mocked `figma` global built from the shared
// document fixture, so the real command handler runs as it would in Figma's
// sandbox. Fixture nodes are in serialized form; this turns them back into
// Plugin API shapes (0–1 RGB, `figma.mixed`, flattened auto-layout props).
import { afterEach } from "bun:test";
import type { Paint, SerializedNode } from "@figma-agent-tool/protocol";
import {
	availableFonts,
	createdNodeId,
	type DocumentFixture,
	findNode,
	framePng,
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

export function installMockFigma(document: DocumentFixture) {
	const storage = new Map<string, unknown>();
	const byId = new Map<string, MockNode>();
	const exports: { nodeId: string; settings: unknown }[] = [];
	const loadedPages = new Set<string>([document.currentPageId]);

	const loadedFonts = new Set<string>();
	let created = 0;

	function register(node: MockNode, parent?: MockNode): MockNode {
		node.parent = parent;
		byId.set(node.id, node);
		// Every canvas node exports the fixture PNG; tests check the settings.
		node.exportAsync = async (settings: unknown) => {
			exports.push({ nodeId: node.id, settings });
			return new Uint8Array(Buffer.from(framePng, "base64"));
		};
		node.remove = () => {
			const siblings = (node.parent as MockNode).children as MockNode[];
			siblings.splice(siblings.indexOf(node), 1);
			unregister(node);
		};
		if (node.children && node.type !== "INSTANCE") canAppend(node);
		if (node.type === "TEXT") guardText(node, loadedFonts);
		if (node.type === "COMPONENT") {
			node.createInstance = () => {
				const source = findNode(node.id, document) as SerializedNode;
				const id = createdNodeId(++created);
				return place(
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
				);
			};
		}
		for (const child of node.children ?? []) register(child, node);
		return node;
	}

	function canAppend(container: MockNode) {
		container.appendChild = (child: MockNode) => {
			const siblings = (child.parent as MockNode | undefined)?.children;
			siblings?.splice(siblings.indexOf(child), 1);
			container.children?.push(child);
			child.parent = container;
		};
	}

	function unregister(node: MockNode) {
		byId.delete(node.id);
		for (const child of node.children ?? []) unregister(child);
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

	const pages = document.pages.map((page) => {
		const children = page.children.map(toFigmaNode);
		const mockPage: MockNode = {
			id: page.id,
			name: page.name,
			type: "PAGE",
			selection: [],
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
		canAppend(mockPage);
		for (const child of children) register(child, mockPage);
		byId.set(page.id, mockPage);
		return mockPage;
	});

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
		root: { id: "0:0", name: document.name, type: "DOCUMENT", children: pages },
		currentPage,
		async getNodeByIdAsync(id: string) {
			return byId.get(id) ?? null;
		},
		base64Encode(data: Uint8Array) {
			return Buffer.from(data).toString("base64");
		},
		async loadFontAsync(font: Font) {
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

afterEach(() => {
	delete (globalThis as { figma?: unknown }).figma;
});

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
	};
	if (node.type !== "TEXT") cornerRadius(mock, node);
	if (node.text) {
		const { fontName, fontSize } = node.text;
		Object.assign(mock, {
			characters: node.text.characters,
			fontName: fontName === "mixed" ? mixed : fontName,
			fontSize: fontSize === "mixed" ? mixed : fontSize,
			textAlignHorizontal: node.text.textAlignHorizontal ?? "LEFT",
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
			layoutSizingHorizontal: layout?.sizing.horizontal ?? "FIXED",
			layoutSizingVertical: layout?.sizing.vertical ?? "FIXED",
		});
		mock.children = node.children.map(toFigmaNode);
	}
	if (node.component) {
		mock.key = node.component.key;
		mock.description = node.component.description ?? "";
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

function prefixIds(node: SerializedNode, prefix: string): SerializedNode {
	return {
		...node,
		id: `${prefix}${node.id}`,
		children: node.children?.map((child) => prefixIds(child, prefix)),
	};
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
			return { ...base, color: rgb(paint.color) };
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
