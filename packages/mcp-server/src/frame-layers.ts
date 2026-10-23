// Where a frame's layers sit, so mismatched regions of a capture can be
// traced back to the Figma nodes drawn there.
import type { SerializedNode } from "@figma-agent-tool/protocol";

type Rect = { x: number; y: number; width: number; height: number };

export type LayerBox = Rect & { id: string; name: string; type: string };

/**
 * Groups and boolean operations have no coordinate space of their own: their
 * children's x/y are relative to the group's parent, as in the Plugin API.
 */
const TRANSPARENT_PARENTS = new Set(["GROUP", "BOOLEAN_OPERATION"]);

/**
 * The visible layers inside `frame`, in document order, with their boxes in
 * frame points. Rotation is ignored: a rotated layer gets its unrotated box.
 */
export function layerBoxes(frame: SerializedNode): LayerBox[] {
	const boxes: LayerBox[] = [];
	const visit = (parent: SerializedNode, originX: number, originY: number) => {
		for (const node of parent.children ?? []) {
			if (node.visible === false) continue;
			const x = originX + (node.x ?? 0);
			const y = originY + (node.y ?? 0);
			const { id, name, type, width, height } = node;
			if (width !== undefined && height !== undefined) {
				boxes.push({ id, name, type, x, y, width, height });
			}
			if (TRANSPARENT_PARENTS.has(type)) visit(node, originX, originY);
			else visit(node, x, y);
		}
	};
	visit(frame, 0, 0);
	return boxes;
}

/** The layers whose boxes share some area with `rect`. */
export function overlapping(boxes: readonly LayerBox[], rect: Rect) {
	return boxes
		.filter(
			(box) =>
				box.x < rect.x + rect.width &&
				rect.x < box.x + box.width &&
				box.y < rect.y + rect.height &&
				rect.y < box.y + box.height,
		)
		.map(({ id, name, type }) => ({ id, name, type }));
}
