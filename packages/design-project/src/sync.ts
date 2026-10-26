// The sync state a Design Project commits in sync/ (the Linked File, per
// Screen and Defined Component its Baseline and element ↔ node ID map, and
// what Push read of Linked Components), and the pure steps of Push and Pull
// around the Plugin's reads and writes.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type {
	FileInfo,
	ScreenFill,
	ScreenNode,
	SyncedNode,
} from "@figma-agent-tool/protocol";
import {
	type ComponentDefinition,
	componentDefinition,
	type LinkedComponentRecord,
} from "./components";
import { cssVariable, type Tokens } from "./design-md";
import type { DesignSystemBaseline, TokenBindings } from "./design-system";
import { type HtmlNode, parseHtml } from "./html";
import { assignElementKeys, elementKeys } from "./keys";
import { mergeScreen } from "./merge";
import {
	type FigmaOwnedLayer,
	fromComponentNode,
	fromSyncedNode,
	toScreenNode,
} from "./nodes";
import { printScreen } from "./print";
import {
	type DesignProject,
	type DirectionFile,
	defaultScreenSize,
	definitionOf,
	imagePath,
	isComponentFile,
	linkedComponentPath,
	type ScreenFile,
} from "./project";
import {
	type ResolveContext,
	resolveProp,
	sameElement,
	sameOwn,
} from "./resolve";
import { type Element, parseComponent, parseScreen } from "./screen";
import {
	isComponentTag,
	type Kind,
	PROP_NAMES,
	type Prop,
	variableName,
} from "./subset";

/** The Linked File, as the first Push (or a re-link) recorded it. */
export type Link = {
	/** Stored in the file too, so the tool knows it even without a file key. */
	linkId: string;
	file: FileInfo;
	screensPage: { id: string; name: string };
	/** The page Directions are copied to, once they have been. */
	explorationsPage?: { id: string; name: string };
};

export type ImageRecord = { imageHash: string; sha256: string };

/** A Screen as of its last Push or Pull, and where its elements went. */
export type Baseline = {
	frameId: string;
	source: string;
	/** The token values the Baseline's source was written against. */
	tokens: Record<string, string>;
	/** Element key → node ID. */
	nodes: Record<string, string>;
	/** Image `src` → the Figma image made from it. */
	images: Record<string, ImageRecord>;
	/** The properties of the Components a Screen uses, as of the Baseline. */
	components?: Record<string, ComponentDefinition>;
};

const linkPath = (project: { dir: string }) =>
	join(project.dir, "sync", "link.json");
const baselinePath = (project: { dir: string }, name: string) =>
	join(project.dir, "sync", "screens", `${name}.json`);
const componentBaselinePath = (project: { dir: string }, name: string) =>
	join(project.dir, "sync", "components", `${name}.json`);
const designSystemPath = (project: { dir: string }) =>
	join(project.dir, "sync", "design-system.json");

export async function readDesignSystemBaseline(project: {
	dir: string;
}): Promise<DesignSystemBaseline | undefined> {
	return readJson(designSystemPath(project));
}

export async function writeDesignSystemBaseline(
	project: { dir: string },
	baseline: DesignSystemBaseline,
) {
	await writeJson(designSystemPath(project), baseline);
}

export async function readLink(project: {
	dir: string;
}): Promise<Link | undefined> {
	return readJson(linkPath(project));
}

export async function writeLink(project: { dir: string }, link: Link) {
	await writeJson(linkPath(project), link);
}

export async function readBaseline(
	project: { dir: string },
	name: string,
): Promise<Baseline | undefined> {
	return readJson(baselinePath(project, name));
}

export async function writeBaseline(
	project: { dir: string },
	name: string,
	baseline: Baseline,
) {
	await writeJson(baselinePath(project, name), baseline);
}

/** Every Screen with a Baseline, by name. */
export async function readBaselines(project: {
	dir: string;
}): Promise<Map<string, Baseline>> {
	return readJsonFiles(join(project.dir, "sync", "screens"));
}

/** Every Defined Component with a Baseline, by name. */
export async function readComponentBaselines(project: {
	dir: string;
}): Promise<Map<string, Baseline>> {
	return readJsonFiles(join(project.dir, "sync", "components"));
}

export async function writeComponentBaseline(
	project: { dir: string },
	name: string,
	baseline: Baseline,
) {
	await writeJson(componentBaselinePath(project, name), baseline);
}

/** Records what Push read of a Linked Component in Figma. */
export async function writeLinkedComponentRecord(
	project: { dir: string },
	name: string,
	record: LinkedComponentRecord,
) {
	await writeJson(linkedComponentPath(project, name), record);
}

/** The JSON files in a folder, by name without `.json`. */
async function readJsonFiles<T>(dir: string): Promise<Map<string, T>> {
	if (!existsSync(dir)) return new Map();
	const names = (await readdir(dir))
		.filter((file) => file.endsWith(".json"))
		.sort();
	const entries = await Promise.all(
		names.map(async (file) => {
			const name = file.slice(0, -".json".length);
			return [name, (await readJson(join(dir, file))) as T] as const;
		}),
	);
	return new Map(entries);
}

/**
 * Forgets every Screen's frame (and its exports), every Component's node
 * and the Design System's variables, as a re-link to another file does.
 */
export async function clearBaselines(project: { dir: string }) {
	for (const dir of ["screens", "exports", "components", "linked"]) {
		await rm(join(project.dir, "sync", dir), { recursive: true, force: true });
	}
	await rm(designSystemPath(project), { force: true });
}

/** The Components as the Linked File has them: their properties, and which nodes they are. */
export type FigmaComponents = {
	definitions: Record<string, ComponentDefinition>;
	/** A component set's or component's node ID → its Component. */
	byId: Record<string, string>;
	/** A published component set's or component's key → its Component. */
	byKey: Record<string, string>;
};

/** The Components as their Baselines (Defined) and records (Linked) say Figma has them. */
export function figmaComponents(
	project: DesignProject,
	baselines: Map<string, Baseline>,
): FigmaComponents {
	const found: FigmaComponents = { definitions: {}, byId: {}, byKey: {} };
	for (const component of project.components) {
		const baseline = baselines.get(component.name);
		if (!baseline) continue;
		found.definitions[component.name] = componentDefinition(
			baselineRoot(component, baseline),
		);
		for (const id of [baseline.frameId, ...Object.values(baseline.nodes)])
			found.byId[id] = component.name;
	}
	for (const { name, record } of project.linkedComponents) {
		if (!record) continue;
		const { properties, variants } = record;
		found.definitions[name] = { properties, ...(variants && { variants }) };
		found.byId[record.componentId] = name;
		if (record.key) found.byKey[record.key] = name;
	}
	return found;
}

/** Which Component an instance is of, if it's one of the Design Project's. */
function componentOfInstance(components: FigmaComponents | undefined) {
	return (instance: NonNullable<SyncedNode["instance"]>) => {
		if (!components) return undefined;
		const { byId, byKey } = components;
		return (
			(instance.setId && byId[instance.setId]) ||
			byId[instance.mainId] ||
			(instance.setKey && byKey[instance.setKey]) ||
			(instance.mainKey && byKey[instance.mainKey]) ||
			undefined
		);
	};
}

/**
 * The Baseline as the Linked File shows it now: layers bound to the Design
 * System take its current values, which Figma's token edits change.
 */
export function withTokens(baseline: Baseline, tokens: Tokens): Baseline {
	return {
		...baseline,
		tokens: { ...baseline.tokens, ...tokenRecord(tokens) },
	};
}

async function readJson<T>(path: string): Promise<T | undefined> {
	if (!existsSync(path)) return undefined;
	return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, data: unknown) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(data, null, "\t")}\n`);
}

function tokenRecord(tokens: Tokens): Record<string, string> {
	return Object.fromEntries(tokens.variables);
}

function tokensFrom(record: Record<string, string>): Tokens {
	return { variables: new Map(Object.entries(record)) };
}

export function resolveContext(
	project: DesignProject,
	screen: { name: string; of?: string },
): ResolveContext {
	return {
		tokens: project.tokens,
		screenName: screen.name,
		screenSize: defaultScreenSize(project, screen),
		components: (name) => definitionOf(project, name),
	};
}

/** How the Baseline resolves: with the tokens and Components' properties it was written against. */
function baselineContext(
	project: DesignProject,
	screen: { name: string },
	baseline: Baseline,
): ResolveContext {
	return {
		...resolveContext(project, screen),
		tokens: tokensFrom(baseline.tokens),
		components: (name) =>
			baseline.components?.[name] ?? definitionOf(project, name),
	};
}

/** How Figma's version resolves: with the Components' properties as Figma has them. */
function figmaContext(
	project: DesignProject,
	screen: { name: string },
	baseline: Baseline,
	components: FigmaComponents | undefined,
): ResolveContext {
	return {
		...resolveContext(project, screen),
		components: (name) =>
			components?.definitions[name] ??
			baseline.components?.[name] ??
			definitionOf(project, name),
	};
}

/** The properties of the Components a Screen's source uses, as `definition` gives them. */
function usedComponents(
	source: string,
	definition: (name: string) => ComponentDefinition | undefined,
): Record<string, ComponentDefinition> | undefined {
	const used: Record<string, ComponentDefinition> = {};
	const walk = (nodes: HtmlNode[]) => {
		for (const node of nodes) {
			if (node.type !== "element") continue;
			const found = isComponentTag(node.tag) && definition(node.tag);
			if (found) used[node.tag] = found;
			walk(node.children);
		}
	};
	walk(parseHtml(source).nodes);
	return Object.keys(used).length > 0 ? used : undefined;
}

/** Parses a Baseline's source against the tokens it was written with. */
export function baselineRoot(screen: ScreenFile, baseline: Baseline): Element {
	const parse = isComponentFile(screen) ? parseComponent : parseScreen;
	const { root } = parse(screen.file, baseline.source, {
		tokens: tokensFrom(baseline.tokens),
		imageExists: () => true,
		screenExists: () => true,
		// Instances keep the properties they set, whatever their Components are now.
		component: () => ({ linked: true }),
	});
	if (!root) throw new Error(`The Baseline of ${screen.file} doesn't parse.`);
	return root;
}

const sha256 = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

/**
 * How a Screen's image goes to Figma: by the hash of the image Figma
 * already has for it, or as bytes sent under `image`.
 */
export type PushedImage = { sha256: string } & (
	| { imageHash: string }
	| { image: string }
);

/** The node tree a checked Screen (every element keyed) pushes as, with image bytes to send. */
export async function screenPush(
	project: DesignProject,
	screen: ScreenFile,
	root: Element,
	baseline: Baseline | undefined,
	bindings?: TokenBindings,
): Promise<{
	tree: ScreenNode;
	/** Image bytes (base64) to send, by name. */
	images: Record<string, string>;
	/** How each `src` is pushed. */
	sources: Record<string, PushedImage>;
	/** Layers of elements the Screen deleted since the Baseline. */
	remove: string[];
}> {
	const { images, sources } = await pushedImages(
		project,
		screen,
		root,
		baseline,
	);
	const setTree = toScreenNode(root, {
		...resolveContext(project, screen),
		nodeIds: baseline?.nodes ?? {},
		bindings,
		imageFill: imageFill(sources),
		placed: baseline ? placedSince(project, screen, baseline) : () => true,
	});
	// A Component without variants is a lone component, not a set.
	const [only, ...more] = root.children;
	const lone =
		isComponentFile(screen) && only && more.length === 0 && !only.name;
	const tree = lone ? (setTree.children?.[0] as ScreenNode) : setTree;
	const keys = new Set(elementKeys(root));
	const remove = Object.entries(baseline?.nodes ?? {}).flatMap(([key, id]) =>
		keys.has(key) ? [] : [id],
	);
	return { tree, images, sources, remove };
}

/**
 * The node tree a copy of a checked Direction (every element keyed) pushes
 * as: unbound, and its Figma-owned Elements copy the layers of its Screen's
 * frame.
 */
export async function directionPush(
	project: DesignProject,
	direction: DirectionFile,
	root: Element,
	screenBaseline: Baseline | undefined,
): Promise<{ tree: ScreenNode; images: Record<string, string> }> {
	const { images, sources } = await pushedImages(
		project,
		direction,
		root,
		undefined,
	);
	const owned = figmaOwnedElements(root, screenBaseline?.nodes ?? {});
	const tree = toScreenNode(root, {
		...resolveContext(project, direction),
		nodeIds: Object.fromEntries(owned.map(({ key, nodeId }) => [key, nodeId])),
		imageFill: imageFill(sources),
		placed: () => true,
	});
	return { tree, images };
}

/** How each image `src` in a Screen is pushed, and the bytes to send. */
async function pushedImages(
	project: DesignProject,
	screen: ScreenFile,
	root: Element,
	baseline: Baseline | undefined,
) {
	const images: Record<string, string> = {};
	const sources: Record<string, PushedImage> = {};
	const srcs = new Set<string>();
	const walk = (element: Element) => {
		if (element.src) srcs.add(element.src);
		element.children.forEach(walk);
	};
	walk(root);
	for (const src of srcs) {
		const path = imagePath(project, screen, src) as string;
		const bytes = await readFile(path);
		const sha = sha256(bytes);
		const known = baseline?.images[src];
		if (known?.sha256 === sha) {
			sources[src] = { sha256: sha, imageHash: known.imageHash };
		} else {
			// Named by project path, so Screens sharing an image send it once.
			const name = posixRelative(project.dir, path);
			images[name] = bytes.toString("base64");
			sources[src] = { sha256: sha, image: name };
		}
	}
	return { images, sources };
}

const imageFill =
	(sources: Record<string, PushedImage>) =>
	(src: string, scaleMode: "FILL" | "FIT"): ScreenFill => {
		const { sha256: _, ...fill } = sources[src] as PushedImage;
		return { type: "IMAGE", scaleMode, ...fill } as ScreenFill;
	};

/** Whether the Screen moved, resized or renamed an element since the Baseline. */
function placedSince(
	project: DesignProject,
	screen: ScreenFile,
	baseline: Baseline,
): (element: Element, parent: Element | undefined) => boolean {
	const base = baselineRoot(screen, baseline);
	const byKey = elementsByKey(base);
	const parents = new Map<string, string | undefined>();
	const walk = (element: Element) => {
		for (const child of element.children) {
			if (child.key) parents.set(child.key, element.key);
			walk(child);
		}
	};
	walk(base);
	const contexts = {
		a: baselineContext(project, screen, baseline),
		b: resolveContext(project, screen),
	};
	return (element, parent) => {
		const was = element.key ? byKey.get(element.key) : undefined;
		return (
			!was ||
			parents.get(element.key as string) !== parent?.key ||
			!sameOwn(was, element, contexts, false)
		);
	};
}

/** The Figma-owned Elements in a Screen, with the layers they stand for. */
export function figmaOwnedElements(
	root: Element,
	nodes: Record<string, string>,
): { key: string; nodeId: string; element: Element }[] {
	const owned: { key: string; nodeId: string; element: Element }[] = [];
	const walk = (element: Element) => {
		const nodeId = element.key && nodes[element.key];
		if (element.kind === "owned" && element.key && nodeId)
			owned.push({ key: element.key, nodeId, element });
		element.children.forEach(walk);
	};
	walk(root);
	return owned;
}

/** Keys of Figma-owned Elements whose layer the Baseline doesn't know: Pull didn't make them. */
export function unlinkedFigmaOwned(
	root: Element,
	baseline: Baseline | undefined,
): string[] {
	const linked = new Set(
		figmaOwnedElements(root, baseline?.nodes ?? {}).map(({ key }) => key),
	);
	const unlinked: string[] = [];
	const walk = (element: Element) => {
		if (element.kind === "owned" && !linked.has(element.key ?? ""))
			unlinked.push(element.key ?? "");
		element.children.forEach(walk);
	};
	walk(root);
	return unlinked;
}

/** The Figma image each `src` became, given the hashes the Plugin made from sent bytes. */
export function pushedImageRecords(
	sources: Record<string, PushedImage>,
	hashes: Record<string, string>,
): Record<string, ImageRecord> {
	return Object.fromEntries(
		Object.entries(sources).map(([src, pushed]) => [
			src,
			{
				imageHash:
					"imageHash" in pushed
						? pushed.imageHash
						: (hashes[pushed.image] as string),
				sha256: pushed.sha256,
			},
		]),
	);
}

/** The Baseline after a Push: the pushed source and where each element landed. */
export function baselineAfterPush(
	project: DesignProject,
	source: string,
	frame: SyncedNode,
	images: Record<string, ImageRecord>,
): Baseline {
	const components = usedComponents(source, (name) =>
		definitionOf(project, name),
	);
	return {
		frameId: frame.id,
		source,
		tokens: tokenRecord(project.tokens),
		nodes: nodeMap(frame),
		images,
		...(components && { components }),
	};
}

function nodeMap(frame: SyncedNode): Record<string, string> {
	const nodes: Record<string, string> = {};
	const walk = (node: SyncedNode) => {
		if (node.key) nodes[node.key] = node.id;
		node.children?.forEach(walk);
	};
	walk(frame);
	return nodes;
}

/** Image hashes in a frame that the Baseline has no `src` for. */
export function unknownImages(frame: SyncedNode, baseline: Baseline): string[] {
	const known = new Set(
		Object.values(baseline.images).map((image) => image.imageHash),
	);
	const unknown = new Set<string>();
	const walk = (node: SyncedNode) => {
		if (node.fills !== "mixed") {
			for (const fill of node.fills) {
				if (
					fill.type === "IMAGE" &&
					fill.imageHash &&
					!known.has(fill.imageHash)
				) {
					unknown.add(fill.imageHash);
				}
			}
		}
		node.children?.forEach(walk);
	};
	walk(frame);
	return [...unknown];
}

/** Saves an image Pull read from Figma into assets/ and returns its `src` for the Screen. */
export async function saveImage(
	project: DesignProject,
	screen: ScreenFile,
	imageHash: string,
	bytes: Uint8Array,
): Promise<{ src: string; record: ImageRecord }> {
	const path = join(
		project.dir,
		"assets",
		`${imageHash}.${imageExtension(bytes)}`,
	);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, bytes);
	const src = posixRelative(dirname(screen.path), path);
	return { src, record: { imageHash, sha256: sha256(bytes) } };
}

/** A relative path with forward slashes, as Screens and image names use. */
function posixRelative(from: string, to: string): string {
	return relative(from, to).split("\\").join("/");
}

function imageExtension(bytes: Uint8Array): string {
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
	if (bytes[0] === 0x47 && bytes[1] === 0x49) return "gif";
	return "png";
}

/**
 * Frame ID → the Screen it is the frame of, for every frame a Screen has or
 * had: Prototype Links are the on-click NAVIGATEs to these.
 */
export type ScreenFrames = Record<string, string>;

/** The Screens' frames: as their Baselines recorded them, and as Figma has them now. */
export function screenFramesOf(
	baselines: Map<string, Baseline>,
	frames: Map<string, SyncedNode>,
): ScreenFrames {
	return Object.fromEntries([
		...[...baselines].map(([name, baseline]) => [baseline.frameId, name]),
		...[...frames].map(([name, frame]) => [frame.id, name]),
	]);
}

/** A frame read as a Screen against its Baseline; layers outside the subset are listed. */
export function readFrame(
	project: DesignProject,
	screen: ScreenFile,
	baseline: Baseline,
	frame: SyncedNode,
	{
		local,
		screenFrames = {},
		components,
	}: {
		local?: Element;
		screenFrames?: ScreenFrames;
		components?: FigmaComponents;
	} = {},
): { root?: Element; figmaOwned: FigmaOwnedLayer[] } {
	const base = baselineRoot(screen, baseline);
	const ids = new Set<string>();
	const collect = (node: SyncedNode) => {
		ids.add(node.id);
		node.children?.forEach(collect);
	};
	collect(frame);
	const keysById = new Map(
		Object.entries(baseline.nodes).map(([key, id]) => [id, key]),
	);
	const baseByKey = elementsByKey(base);
	// Tags as the Design Project writes them now, else as the Baseline did.
	const tags = new Map([...baseByKey, ...(local ? elementsByKey(local) : [])]);
	const srcs = new Map(
		Object.entries(baseline.images).map(([src, image]) => [
			image.imageHash,
			src,
		]),
	);
	const claimed = new Set<string>();
	const read = isComponentFile(screen) ? fromComponentNode : fromSyncedNode;
	return read(frame, {
		...figmaContext(project, screen, baseline, components),
		componentOf: componentOfInstance(components),
		keyFor: (node) => {
			const key = layerKey(node, baseline, ids, keysById);
			// A designer's copy of a layer carries its key too: first one wins.
			if (!key || claimed.has(key)) return undefined;
			claimed.add(key);
			return key;
		},
		tagFor: (key: string | undefined, kind: Kind) => {
			const element = key ? tags.get(key) : undefined;
			return element?.kind === kind ? element.tag : undefined;
		},
		srcFor: (imageHash) => srcs.get(imageHash),
		baseElement: (key) => baseByKey.get(key),
		screenOf: (frameId) =>
			frameId === frame.id ? screen.name : screenFrames[frameId],
	});
}

function elementsByKey(root: Element): Map<string, Element> {
	const byKey = new Map<string, Element>();
	const walk = (element: Element) => {
		if (element.key) byKey.set(element.key, element);
		element.children.forEach(walk);
	};
	walk(root);
	return byKey;
}

/** A layer's element key: its plugin data, checked against the node ID map. */
function layerKey(
	node: SyncedNode,
	baseline: Baseline,
	ids: Set<string>,
	keysById: Map<string, string>,
): string | undefined {
	const mapped = keysById.get(node.id);
	if (mapped) return mapped;
	if (!node.key) return undefined;
	const pushedTo = baseline.nodes[node.key];
	// The layer it was pushed to is gone (cut and pasted): this is it.
	if (pushedTo === undefined || !ids.has(pushedTo)) return node.key;
	return undefined;
}

/**
 * The Baseline pointing at the frame as it is now: a frame that was cut and
 * pasted has a new ID, and so does every layer in it.
 */
export function followFrame(
	project: DesignProject,
	screen: ScreenFile,
	baseline: Baseline,
	frame: SyncedNode,
): Baseline {
	if (frame.id === baseline.frameId) return baseline;
	const { root } = readFrame(project, screen, baseline, frame);
	if (!root) return { ...baseline, frameId: frame.id };
	return { ...baseline, frameId: frame.id, nodes: elementNodeMap(root, {}) };
}

/** Whether a frame (or a Component's node) was edited in Figma since the Baseline. */
export function hasUnpulledChanges(
	project: DesignProject,
	screen: ScreenFile,
	baseline: Baseline,
	frame: SyncedNode,
	screenFrames: ScreenFrames = {},
	components?: FigmaComponents,
): boolean {
	const { root } = readFrame(project, screen, baseline, frame, {
		screenFrames,
		components,
	});
	if (!root) return true;
	const base = baselineRoot(screen, baseline);
	return !sameElement(
		base,
		root,
		{
			a: baselineContext(project, screen, baseline),
			b: figmaContext(project, screen, baseline, components),
		},
		true,
	);
}

export type ScreenPull = {
	/** Whether Figma changed the frame since the Baseline. */
	changed: boolean;
	/** The merged Screen file, when changed. */
	source?: string;
	baseline: Baseline;
	conflicts: number;
	figmaOwned: FigmaOwnedLayer[];
};

/**
 * Merges a frame's changes into a checked Screen. A file Figma didn't change
 * stays exactly as it is.
 */
export function pullScreen(
	project: DesignProject,
	screen: ScreenFile,
	local: Element,
	baseline: Baseline,
	frame: SyncedNode,
	fetchedImages: Record<string, { src: string; record: ImageRecord }> = {},
	screenFrames: ScreenFrames = {},
	components?: FigmaComponents,
): ScreenPull {
	const images = { ...baseline.images };
	for (const { src, record } of Object.values(fetchedImages))
		images[src] = record;
	const withImages = { ...baseline, images };
	const { root: figma, figmaOwned } = readFrame(
		project,
		screen,
		withImages,
		frame,
		{ local, screenFrames, components },
	);
	if (!figma) {
		return { changed: false, baseline, conflicts: 0, figmaOwned };
	}
	const withKeys = () => ownedWithKeys(figma, figmaOwned);
	const base = baselineRoot(screen, baseline);
	const contexts = {
		base: baselineContext(project, screen, baseline),
		local: resolveContext(project, screen),
		figma: figmaContext(project, screen, baseline, components),
	};
	if (sameElement(base, figma, { a: contexts.base, b: contexts.figma }, true)) {
		return {
			changed: false,
			baseline: followFrame(project, screen, baseline, frame),
			conflicts: 0,
			figmaOwned: withKeys(),
		};
	}
	const merged = mergeScreen(base, local, figma, contexts);
	assignElementKeys(figma, [
		...elementKeys(local),
		...elementKeys(merged.root),
	]);
	const source = printScreen(keepTokens(figma, local, contexts.local));
	const used = usedComponents(
		source,
		contexts.figma.components ?? (() => undefined),
	);
	return {
		changed: true,
		source: printScreen(merged.root),
		baseline: {
			frameId: frame.id,
			source,
			tokens: tokenRecord(project.tokens),
			nodes: elementNodeMap(figma, baseline.nodes),
			images,
			...(used && { components: used }),
		},
		conflicts: merged.conflicts,
		figmaOwned: withKeys(),
	};
}

/** The layers kept in Figma, with the keys of their Figma-owned Elements. */
function ownedWithKeys(
	root: Element,
	figmaOwned: FigmaOwnedLayer[],
): FigmaOwnedLayer[] {
	const keys = new Map<string, string>();
	const walk = (element: Element) => {
		if (element.nodeId && element.key) keys.set(element.nodeId, element.key);
		element.children.forEach(walk);
	};
	walk(root);
	return figmaOwned.map((layer) => {
		const key = keys.get(layer.nodeId);
		return key ? { key, ...layer } : layer;
	});
}

/**
 * A frame designers made, read as a new Screen with its first Baseline, as
 * Adopt makes it; or why the frame can't be a Screen. Its layers are all
 * new to the Design Project, whatever keys they carry.
 */
export function adoptFrame(
	project: DesignProject,
	screen: ScreenFile,
	frame: SyncedNode,
	{
		images = {},
		screenFrames = {},
		components,
		designSystem,
	}: {
		/** Image `src` → the Figma image it's saved from. */
		images?: Record<string, ImageRecord>;
		screenFrames?: ScreenFrames;
		components?: FigmaComponents;
		/** The adopted variables and text styles, whose layers' bindings become tokens. */
		designSystem?: DesignSystemBaseline;
	} = {},
):
	| { source: string; baseline: Baseline; figmaOwned: FigmaOwnedLayer[] }
	| { reason: string } {
	const srcs = new Map(
		Object.entries(images).map(([src, image]) => [image.imageHash, src]),
	);
	const { root, figmaOwned } = fromSyncedNode(frame, {
		...resolveContext(project, screen),
		componentOf: componentOfInstance(components),
		keyFor: () => undefined,
		tagFor: () => undefined,
		srcFor: (imageHash) => srcs.get(imageHash),
		baseElement: () => undefined,
		screenOf: (frameId) => screenFrames[frameId],
	});
	if (!root) return { reason: figmaOwned[0]?.reason ?? "isn't a frame" };
	if (designSystem) bindTokens(root, frame, designSystem, project.tokens);
	assignElementKeys(root);
	const source = printScreen(root);
	const used = usedComponents(source, (name) => definitionOf(project, name));
	return {
		source,
		baseline: {
			frameId: frame.id,
			source,
			tokens: tokenRecord(project.tokens),
			nodes: elementNodeMap(root, {}),
			images,
			...(used && { components: used }),
		},
		figmaOwned: ownedWithKeys(root, figmaOwned),
	};
}

/** The prop a layer's first fill is, by kind of element. */
const FILL_PROPS: Partial<Record<Kind, Prop>> = {
	frame: "background-color",
	rect: "background-color",
	text: "color",
	vector: "fill",
};

/**
 * Writes a token's CSS variable wherever a layer is bound to its variable
 * (or a text to its text style) and shows its value, so Push binds the
 * layer to it again.
 */
function bindTokens(
	root: Element,
	frame: SyncedNode,
	designSystem: DesignSystemBaseline,
	tokens: Tokens,
) {
	const nodes = new Map<string, SyncedNode>();
	const index = (node: SyncedNode) => {
		nodes.set(node.id, node);
		node.children?.forEach(index);
	};
	index(frame);
	const tokenOf = new Map(
		[
			...Object.entries(designSystem.variables),
			...Object.entries(designSystem.textStyles),
		].map(([token, id]) => [id, token]),
	);
	const walk = (element: Element) => {
		const node = element.nodeId ? nodes.get(element.nodeId) : undefined;
		if (node && element.kind !== "instance" && element.kind !== "owned") {
			const bind = (
				prop: Prop | undefined,
				id: string | undefined,
				field = "",
			) => {
				const token = id && tokenOf.get(id);
				if (!prop || !token) return;
				const raw = `var(${cssVariable(token + field)})`;
				const bound = { ...element, props: { ...element.props, [prop]: raw } };
				if (
					resolveProp(bound, prop, tokens) ===
					resolveProp(element, prop, tokens)
				)
					element.props[prop] = raw;
			};
			const [fill] = node.fills === "mixed" ? [] : node.fills;
			bind(
				FILL_PROPS[element.kind],
				fill?.type === "SOLID" ? fill.variable : undefined,
			);
			const bound = node.bindings ?? {};
			if (element.kind === "frame") {
				bind("gap", bound.itemSpacing);
				bind("padding-top", bound.paddingTop);
				bind("padding-right", bound.paddingRight);
				bind("padding-bottom", bound.paddingBottom);
				bind("padding-left", bound.paddingLeft);
			}
			if (element.kind !== "text" && element.kind !== "vector")
				bind("border-radius", bound.cornerRadius);
			if (element.kind === "text")
				bind("font-size", bound.textStyle, ".fontSize");
		}
		element.children.forEach(walk);
	};
	walk(root);
}

/**
 * Figma's version with the Design Project's tokens wherever they mean the
 * same value, so the Baseline follows later changes to them in Figma
 * (whose layers are bound to them) instead of holding the values.
 */
function keepTokens(
	figma: Element,
	local: Element,
	context: ResolveContext,
): Element {
	const copy = structuredClone(figma);
	const localByKey = elementsByKey(local);
	const walk = (element: Element) => {
		const mine = element.key ? localByKey.get(element.key) : undefined;
		if (mine?.kind === element.kind) {
			for (const prop of PROP_NAMES) {
				const raw = mine.props[prop];
				if (
					variableName(raw) &&
					element.props[prop] !== undefined &&
					resolveProp(mine, prop, context.tokens) ===
						resolveProp(element, prop, context.tokens)
				) {
					element.props[prop] = raw;
				}
			}
		}
		element.children.forEach(walk);
	};
	walk(copy);
	return copy;
}

/** Element key → node ID; elements kept from the Baseline keep their old IDs. */
function elementNodeMap(
	root: Element,
	previous: Record<string, string>,
): Record<string, string> {
	const nodes: Record<string, string> = {};
	const walk = (element: Element) => {
		const id = element.nodeId ?? (element.key && previous[element.key]);
		if (element.key && id) nodes[element.key] = id;
		element.children.forEach(walk);
	};
	walk(root);
	return nodes;
}
