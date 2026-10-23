// Groups mismatched pixels into bounding boxes an agent can act on.
import type { Rect } from "./compare";

export type MismatchRegion = Rect & { mismatchedPixels: number };

type Cell = {
	count: number;
	left: number;
	top: number;
	right: number;
	bottom: number;
};

/** At most this many regions are reported, largest first. */
export const MAX_REGIONS = 20;

/**
 * Buckets mismatches into square cells and joins touching cells (including
 * diagonals), so mismatches a cell or so apart form one region rather than
 * hundreds of specks.
 */
export function clusterRegions(
	mismatchMap: Uint8Array,
	width: number,
	height: number,
): MismatchRegion[] {
	const cell = Math.max(8, Math.ceil(Math.max(width, height) / 128));
	const columns = Math.ceil(width / cell);
	const rows = Math.ceil(height / cell);
	const cells: Cell[] = Array.from({ length: columns * rows }, () => ({
		count: 0,
		left: Number.POSITIVE_INFINITY,
		top: Number.POSITIVE_INFINITY,
		right: -1,
		bottom: -1,
	}));
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (!mismatchMap[y * width + x]) continue;
			const bucket = cells[
				Math.floor(y / cell) * columns + Math.floor(x / cell)
			] as Cell;
			bucket.count++;
			bucket.left = Math.min(bucket.left, x);
			bucket.top = Math.min(bucket.top, y);
			bucket.right = Math.max(bucket.right, x);
			bucket.bottom = Math.max(bucket.bottom, y);
		}
	}

	const visited = new Uint8Array(cells.length);
	const regions: MismatchRegion[] = [];
	for (let start = 0; start < cells.length; start++) {
		if (visited[start] || !cells[start]?.count) continue;
		visited[start] = 1;
		const region = {
			left: width,
			top: height,
			right: -1,
			bottom: -1,
			count: 0,
		};
		const queue = [start];
		for (let index = queue.pop(); index !== undefined; index = queue.pop()) {
			const bucket = cells[index] as Cell;
			region.count += bucket.count;
			region.left = Math.min(region.left, bucket.left);
			region.top = Math.min(region.top, bucket.top);
			region.right = Math.max(region.right, bucket.right);
			region.bottom = Math.max(region.bottom, bucket.bottom);
			const column = index % columns;
			const row = Math.floor(index / columns);
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const c = column + dx;
					const r = row + dy;
					if (c < 0 || r < 0 || c >= columns || r >= rows) continue;
					const neighbour = r * columns + c;
					if (visited[neighbour] || !cells[neighbour]?.count) continue;
					visited[neighbour] = 1;
					queue.push(neighbour);
				}
			}
		}
		regions.push({
			x: region.left,
			y: region.top,
			width: region.right - region.left + 1,
			height: region.bottom - region.top + 1,
			mismatchedPixels: region.count,
		});
	}
	return regions
		.sort((a, b) => b.mismatchedPixels - a.mismatchedPixels)
		.slice(0, MAX_REGIONS);
}
