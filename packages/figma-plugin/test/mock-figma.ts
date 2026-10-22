// Seam 2 harness: installs a mocked `figma` global built from the shared
// document fixture, so the real command handler runs as it would in Figma's
// sandbox. Fixture nodes are in serialized form; this turns them back into
// Plugin API shapes (0–1 RGB, `figma.mixed`, flattened auto-layout props).
import { afterEach } from "bun:test";
import type { Paint, SerializedNode } from "@figma-agent-tool/protocol";
import type { DocumentFixture } from "@figma-agent-tool/protocol/fixtures";

const mixed = Symbol("figma.mixed");

type MockNode = Record<string, unknown> & {
	id: string;
	type: string;
	children?: MockNode[];
};

export function installMockFigma(document: DocumentFixture) {
	const storage = new Map<string, unknown>();
	const byId = new Map<string, MockNode>();
	const loadedPages = new Set<string>([document.currentPageId]);

	function register(node: MockNode, parent?: MockNode): MockNode {
		node.parent = parent;
		byId.set(node.id, node);
		for (const child of node.children ?? []) register(child, node);
		return node;
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
	};
	byId.set(mock.root.id, mock.root);
	(globalThis as { figma?: unknown }).figma = mock;
	return mock;
}

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
	};
	if (node.type !== "TEXT") Object.assign(mock, cornerRadius(node));
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

function cornerRadius(node: SerializedNode) {
	const radius = node.cornerRadius ?? 0;
	if (typeof radius === "number") {
		return {
			cornerRadius: radius,
			topLeftRadius: radius,
			topRightRadius: radius,
			bottomRightRadius: radius,
			bottomLeftRadius: radius,
		};
	}
	return {
		cornerRadius: mixed,
		topLeftRadius: radius.topLeft,
		topRightRadius: radius.topRight,
		bottomRightRadius: radius.bottomRight,
		bottomLeftRadius: radius.bottomLeft,
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
