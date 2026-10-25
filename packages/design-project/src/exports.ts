// Figma-owned Elements' exports: Pull caches a PNG of each one's layer in
// sync/exports/<Screen>/<key>.png, so the Preview and Render can show what
// the Screen Subset can't express. Each export records the layer's content
// as it was exported, so Pull fetches it again only when a designer changed
// the layer, and its size, so a Screen that resized the element knows its
// export is stale until the next Pull.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SyncedNode } from "@figma-agent-tool/protocol";
import type { DesignProject, ScreenFile } from "./project";
import { resolveProp } from "./resolve";
import type { Element } from "./screen";
import type { Baseline } from "./sync";

export type FigmaOwnedExport = {
	nodeId: string;
	/** The layer's content when it was exported; see layerFingerprint. */
	fingerprint: string;
	width: number;
	height: number;
};

/** Element key → its export. */
export type FigmaOwnedExports = Record<string, FigmaOwnedExport>;

/**
 * current: the export shows the layer as of the last Pull; stale: the
 * Screen resized the element since; missing: there is no export of its
 * layer (Pull couldn't make one, or it was deleted).
 */
export type ExportStatus = "current" | "stale" | "missing";

export type FigmaOwnedPreview = {
	key: string;
	name?: string;
	export: ExportStatus;
	/** Relative to the Screen's folder, when there's an export. */
	src?: string;
};

const exportsDir = (project: { dir: string }, screen: string) =>
	join(project.dir, "sync", "exports", screen);
const manifestPath = (project: { dir: string }, screen: string) =>
	join(exportsDir(project, screen), "exports.json");

/** Where a Figma-owned Element's export is, relative to its Screen's folder. */
export function exportSrc(screen: string, key: string): string {
	return `../sync/exports/${screen}/${key}.png`;
}

export async function readExports(
	project: { dir: string },
	screen: string,
): Promise<FigmaOwnedExports> {
	const path = manifestPath(project, screen);
	if (!existsSync(path)) return {};
	return JSON.parse(await readFile(path, "utf8"));
}

/** A layer's content, ignoring where it sits: what its export shows. */
export function layerFingerprint(node: SyncedNode): string {
	const { x: _x, y: _y, absolute: _a, sizing: _s, name: _n, ...own } = node;
	const content = JSON.stringify(own, (field, value) =>
		field === "id" || field === "key" ? undefined : value,
	);
	return createHash("sha256").update(content).digest("hex");
}

/** The layers among a frame's Figma-owned Elements whose exports are missing or out of date. */
export function exportsToFetch(
	frame: SyncedNode,
	owned: { key?: string; nodeId: string }[],
	exports: FigmaOwnedExports,
): { key: string; node: SyncedNode }[] {
	const nodes = new Map<string, SyncedNode>();
	const index = (node: SyncedNode) => {
		nodes.set(node.id, node);
		node.children?.forEach(index);
	};
	index(frame);
	return owned.flatMap(({ key, nodeId }) => {
		const node = nodes.get(nodeId);
		if (!key || !node || nodeId === frame.id) return [];
		const known = exports[key];
		const current =
			known?.nodeId === nodeId &&
			known.fingerprint === layerFingerprint(node) &&
			known.width === node.width &&
			known.height === node.height;
		return current ? [] : [{ key, node }];
	});
}

/**
 * Saves a Screen's fetched exports and forgets those of elements that
 * aren't Figma-owned any more.
 */
export async function saveExports(
	project: { dir: string },
	screen: string,
	fetched: { key: string; node: SyncedNode; png: Uint8Array }[],
	keep: string[],
) {
	const before = await readExports(project, screen);
	const exports: FigmaOwnedExports = {};
	for (const key of keep) {
		if (before[key]) exports[key] = before[key];
	}
	const dir = exportsDir(project, screen);
	await mkdir(dir, { recursive: true });
	for (const { key, node, png } of fetched) {
		await writeFile(join(dir, `${key}.png`), png);
		exports[key] = {
			nodeId: node.id,
			fingerprint: layerFingerprint(node),
			width: node.width,
			height: node.height,
		};
	}
	for (const key of Object.keys(before)) {
		if (!exports[key]) await rm(join(dir, `${key}.png`), { force: true });
	}
	if (Object.keys(exports).length === 0) {
		await rm(dir, { recursive: true, force: true });
		return;
	}
	await writeFile(
		manifestPath(project, screen),
		`${JSON.stringify(exports, null, "\t")}\n`,
	);
}

/** How the Preview shows each of a Screen's Figma-owned Elements. */
export async function figmaOwnedPreviews(
	project: DesignProject,
	screen: ScreenFile,
	root: Element | undefined,
	baseline: Baseline | undefined,
): Promise<FigmaOwnedPreview[]> {
	if (!root) return [];
	const exports = await readExports(project, screen.name);
	const previews: FigmaOwnedPreview[] = [];
	const walk = (element: Element) => {
		if (element.kind === "owned" && element.key) {
			previews.push(preview(element, element.key));
		}
		element.children.forEach(walk);
	};
	const preview = (element: Element, key: string): FigmaOwnedPreview => {
		const known = exports[key];
		const src = exportSrc(screen.name, key);
		const file = join(exportsDir(project, screen.name), `${key}.png`);
		const base = { key, ...(element.name && { name: element.name }) };
		// An export of another layer is no export of this one.
		const ofLayer = known?.nodeId === baseline?.nodes[key];
		if (!known || !ofLayer || !existsSync(file))
			return { ...base, export: "missing" };
		// Elements filling their parent have no size to compare.
		const resized = (["width", "height"] as const).some(
			(axis) =>
				element.props[axis] !== undefined &&
				Number(resolveProp(element, axis, project.tokens)) !== known[axis],
		);
		return { ...base, export: resized ? "stale" : "current", src };
	};
	walk(root);
	return previews;
}
