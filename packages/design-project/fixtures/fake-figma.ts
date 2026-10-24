// What the Plugin does with a pushed tree, in serialized form: updates the
// layers it names by ID in place, creates the others, removes pushed layers
// the tree no longer has and leaves the designers' own layers be. The fake
// plugin (MCP tests) and the design-project tests share it; the plugin's
// own tests check the real thing against the mocked `figma` global.
import type {
	Paint,
	ScreenFill,
	ScreenNode,
	SyncedNode,
} from "@figma-agent-tool/protocol";

export function applyScreenTree(
	tree: ScreenNode,
	previous: SyncedNode | undefined,
	{
		nextId,
		imageHash,
	}: { nextId: () => string; imageHash: (name: string) => string },
): SyncedNode {
	const old = new Map<string, SyncedNode>();
	const index = (node: SyncedNode) => {
		old.set(node.id, node);
		node.children?.forEach(index);
	};
	if (previous) index(previous);

	const apply = (spec: ScreenNode, isRoot: boolean): SyncedNode => {
		const existing = spec.id ? old.get(spec.id) : undefined;
		const reuse = existing?.type === spec.type ? existing : undefined;
		const node: SyncedNode = {
			id: reuse?.id ?? nextId(),
			key: spec.key,
			type: spec.type,
			name: spec.name ?? spec.text?.characters ?? spec.type,
			visible: true,
			x: reuse?.x ?? 0,
			y: reuse?.y ?? 0,
			width: spec.width,
			height: spec.height,
			rotation: 0,
			opacity: spec.opacity ?? 1,
			sizing: isRoot ? { horizontal: "FIXED", vertical: "FIXED" } : spec.sizing,
			fills: spec.fills.map((fill) => paint(fill, imageHash)),
			strokes: 0,
			effects: 0,
			cornerRadius: spec.cornerRadius ?? 0,
		};
		if (spec.layout) node.layout = structuredClone(spec.layout);
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
			const children = (spec.children ?? []).map((child) =>
				apply(child, false),
			);
			// The designers' own layers (no key) stay, after the pushed ones.
			const kept = (reuse?.children ?? []).filter(
				(child) => child.key === null,
			);
			node.children = [...children, ...kept];
		}
		return node;
	};
	return apply(tree, true);
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
