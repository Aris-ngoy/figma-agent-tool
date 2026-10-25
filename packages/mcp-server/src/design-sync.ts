// Push, Pull and re-link: the Design Project on one side, the Bridged File
// on the other. design-project decides what changes; this reads frames and
// applies trees through the Plugin. The MCP tools and the CLI both call
// these.
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	assignKeys,
	type Baseline,
	baselineAfterPush,
	type CheckError,
	checkProject,
	checkScreen,
	clearBaselines,
	type DesignProject,
	type DesignSystemBaseline,
	designSystemChanges,
	designSystemPush,
	type Element,
	exportsToFetch,
	type FigmaDesignSystem,
	type FigmaOwnedLayer,
	figmaDesignSystem,
	figmaOwnedElements,
	figmaTokens,
	followFrame,
	hasUnpulledChanges,
	type ImageRecord,
	type Link,
	loadProject,
	type PushedImage,
	parseDesignMd,
	pullDesignSystem,
	pullScreen,
	pushedImageRecords,
	readBaselines,
	readDesignSystemBaseline,
	readExports,
	readLink,
	type ScreenFile,
	saveExports,
	saveImage,
	screenPush,
	type Tokens,
	tokenBindings,
	unknownImages,
	unlinkedFigmaOwned,
	withTokens,
	writeBaseline,
	writeDesignSystemBaseline,
	writeLink,
} from "@figma-agent-tool/design-project";
import type {
	FileInfo,
	ScreenNode,
	SyncedNode,
} from "@figma-agent-tool/protocol";
import { type Bridge, BridgeNotConnectedError } from "./bridge";

/** Push or Pull refused, with what to do about it. */
export class DesignSyncError extends Error {}

const fileName = (file: FileInfo) => `“${file.name}”`;

function connected(bridge: Bridge) {
	const status = bridge.status();
	if (!status.connected) throw new BridgeNotConnectedError(status.port);
	return status;
}

/** Refuses when the Bridged File isn't the Linked File, naming both. */
function checkBridgedFile(bridge: Bridge, link: Link) {
	const status = connected(bridge);
	const sameKey =
		!status.file.key || !link.file.key || status.file.key === link.file.key;
	if (status.linkId !== link.linkId || !sameKey) {
		throw new DesignSyncError(
			`The Bridged File is ${fileName(status.file)}, but this Design Project is linked to ${fileName(link.file)}. Open the plugin in ${fileName(link.file)}, or relink the Design Project to ${fileName(status.file)} (relink_file / \`figma-agent-tool relink\`), which makes the next Push create its frames there.`,
		);
	}
}

/** `file:line element [rule] message`, as the CLI and refusals print a Check error. */
export function formatCheckError(error: CheckError): string {
	const element = error.element ? ` ${error.element}` : "";
	return `${error.file}:${error.line}${element} [${error.rule}] ${error.message}`;
}

function describeErrors(errors: CheckError[]): string {
	return errors.map((error) => `- ${formatCheckError(error)}`).join("\n");
}

/** The Screen with this name, or a DesignSyncError listing the Screens there are. */
export function findScreen(project: DesignProject, name: string): ScreenFile {
	const screen = project.screens.find((s) => s.name === name);
	if (!screen) {
		throw new DesignSyncError(
			`No Screen named "${name}": the Design Project has ${project.screens.map((s) => s.name).join(", ") || "no Screens"}.`,
		);
	}
	return screen;
}

export type PushResult =
	| {
			status: "confirm_link";
			file: FileInfo;
			message: string;
	  }
	| {
			status: "pushed";
			linkedFile: FileInfo;
			page: { id: string; name: string };
			screens: { screen: string; frameId: string; created: boolean }[];
	  };

export async function pushDesignProject(
	dir: string,
	bridge: Bridge,
	{
		screens: only,
		confirmLink = false,
	}: { screens?: string[]; confirmLink?: boolean } = {},
): Promise<PushResult> {
	const project = await loadProject(dir);
	const status = connected(bridge);
	const screens = selectScreens(project, only);
	if (screens.length === 0) {
		throw new DesignSyncError(
			"Nothing to push: the Design Project has no Screens yet. Add HTML files to screens/.",
		);
	}
	const checked = await checkProject(project);
	const failing = checked.errors.filter(
		(error) =>
			error.file === "DESIGN.md" ||
			screens.some((screen) => screen.file === error.file),
	);
	if (failing.length > 0) {
		const conflicted = [
			...new Set(
				failing.filter((e) => e.rule === "sync-conflict").map((e) => e.file),
			),
		];
		throw new DesignSyncError(
			[
				conflicted.length > 0
					? `Push refused: ${conflicted.join(", ")} still ${conflicted.length === 1 ? "has" : "have"} Sync Conflicts to resolve.`
					: "Push refused: these files fail Check.",
				describeErrors(failing),
			].join("\n"),
		);
	}

	let link = await readLink(project);
	if (!link) {
		if (!confirmLink) {
			const linkedElsewhere = status.linkId
				? " It is already linked to another Design Project, which would lose its link."
				: "";
			return {
				status: "confirm_link",
				file: status.file,
				message: `This first Push links the Design Project to the Bridged File, ${fileName(status.file)}: from then on Push and Pull only work with that file.${linkedElsewhere} Ask the user to confirm it's the right file, then push again with confirmLink.`,
			};
		}
		link = await linkBridgedFile(project, bridge, status.file);
	} else {
		checkBridgedFile(bridge, link);
	}

	const linked = await readLinkedDesignSystem(project, bridge);
	if (linked && linked.changes.length > 0) {
		throw new DesignSyncError(
			`Push refused: the Design System has Unpulled Changes: a designer edited ${linked.changes.join(", ")} in Figma. Pull first; it merges them into DESIGN.md.`,
		);
	}
	const baselines = linkedBaselines(await readBaselines(project), linked);
	const frames = await readFrames(bridge, screens, baselines);
	const unpulled = screensWithUnpulledChanges(
		project,
		screens,
		baselines,
		frames,
	);
	if (unpulled.length > 0) {
		throw new DesignSyncError(
			`Push refused: ${unpulled.map((screen) => `${screen.name} (frame “${frames.get(screen.name)?.name}”)`).join(", ")} ${unpulled.length === 1 ? "has" : "have"} Unpulled Changes: a designer edited ${unpulled.length === 1 ? "its frame" : "their frames"} in Figma. Pull first; it merges their edits into the Screens.`,
		);
	}

	const { push: designSystem } = designSystemPush(
		project.fields,
		linked?.baseline,
	);
	const bindings = tokenBindings(designSystem);
	const pushes: {
		screen: ScreenFile;
		tree: ScreenNode;
		sources: Record<string, PushedImage>;
		frameId?: string;
		remove: string[];
		/** Keys of its Figma-owned Elements. */
		figmaOwned: string[];
	}[] = [];
	const images: Record<string, string> = {};
	for (const original of screens) {
		const { source, added } = assignKeys(original.source);
		if (added > 0) await writeFile(original.path, source);
		const screen = { ...original, source };
		const { root } = checkScreen(project, screen);
		if (!root)
			throw new Error(`${screen.file} stopped checking while keys were added.`);
		// A frame deleted in Figma is pushed anew; a cut and pasted one is followed.
		const frame = frames.get(screen.name);
		const previous = baselines.get(screen.name);
		const baseline =
			frame && previous
				? followFrame(project, screen, previous, frame)
				: undefined;
		const unlinked = unlinkedFigmaOwned(root, baseline);
		if (unlinked.length > 0) {
			throw new DesignSyncError(
				`Push refused: ${screen.file} has Figma-owned Elements (${unlinked.join(", ")}) whose layers aren't in its frame in Figma${frame ? "" : ", which was deleted"}. Only Pull makes Figma-owned Elements, and Push can't recreate a designer's layer: delete them from the Screen (or undo the edit that changed their data-key).`,
			);
		}
		const push = await screenPush(project, screen, root, baseline, bindings);
		Object.assign(images, push.images);
		pushes.push({
			screen,
			tree: push.tree,
			sources: push.sources,
			frameId: baseline?.frameId,
			remove: push.remove,
			figmaOwned: figmaOwnedElements(root, baseline?.nodes ?? {}).map(
				({ key }) => key,
			),
		});
	}
	const result = await bridge.request("push_screens", {
		page: { id: link.screensPage.id || undefined, name: link.screensPage.name },
		screens: pushes.map(({ screen, frameId, tree, remove }) => ({
			screen: screen.name,
			frameId,
			tree,
			remove,
		})),
		images,
		designSystem,
	});
	await writeLink(project, { ...link, screensPage: result.page });
	if (result.designSystem) {
		await writeDesignSystemBaseline(project, {
			source: project.designMd,
			...result.designSystem,
		});
	}
	const pushed = [];
	for (const [index, push] of pushes.entries()) {
		const frame = result.screens[index]?.frame as SyncedNode;
		const records = pushedImageRecords(push.sources, result.images);
		await writeBaseline(
			project,
			push.screen.name,
			baselineAfterPush(project, push.screen.source, frame, records),
		);
		// Exports of Figma-owned Elements the Screen deleted go with their layers.
		await saveExports(project, push.screen.name, [], push.figmaOwned);
		pushed.push({
			screen: push.screen.name,
			frameId: frame.id,
			created: frame.id !== push.frameId,
		});
	}
	return {
		status: "pushed",
		linkedFile: link.file,
		page: result.page,
		screens: pushed,
	};
}

async function linkBridgedFile(
	project: DesignProject,
	bridge: Bridge,
	file: FileInfo,
): Promise<Link> {
	const linkId = randomUUID();
	await bridge.request("link_file", { linkId });
	bridge.setLinkId(linkId);
	const link: Link = {
		linkId,
		file,
		screensPage: { id: "", name: project.config.screensPage },
	};
	await writeLink(project, link);
	return link;
}

function selectScreens(
	project: DesignProject,
	only: string[] | undefined,
): ScreenFile[] {
	if (!only || only.length === 0) return project.screens;
	return only.map((name) => findScreen(project, name));
}

/** The Screens whose frames a designer edited since their Baseline. */
function screensWithUnpulledChanges(
	project: DesignProject,
	screens: ScreenFile[],
	baselines: Map<string, Baseline>,
	frames: Map<string, SyncedNode>,
): ScreenFile[] {
	return screens.filter((screen) => {
		const baseline = baselines.get(screen.name);
		const frame = frames.get(screen.name);
		return (
			baseline && frame && hasUnpulledChanges(project, screen, baseline, frame)
		);
	});
}

/** The Design System as the Linked File has it, against its Baseline; undefined before its first Push. */
type LinkedDesignSystem = {
	baseline: DesignSystemBaseline;
	figma: FigmaDesignSystem;
	/** Token fields a designer changed since the Baseline. */
	changes: string[];
	/** The tokens layers bound to the Design System show. */
	tokens: Tokens;
};

async function readLinkedDesignSystem(
	project: DesignProject,
	bridge: Bridge,
): Promise<LinkedDesignSystem | undefined> {
	const baseline = await readDesignSystemBaseline(project);
	if (!baseline) return undefined;
	const read = await bridge.request("read_design_system", {
		variables: Object.values(baseline.variables),
		textStyles: Object.values(baseline.textStyles),
	});
	const figma = figmaDesignSystem(read, baseline);
	const base = parseDesignMd(baseline.source).fields;
	return {
		baseline,
		figma,
		changes: designSystemChanges(base, figma),
		tokens: figmaTokens(base, figma),
	};
}

/** A Screen's Baseline resolving tokens as the Linked File shows them. */
function linkedBaseline(
	baseline: Baseline,
	linked: LinkedDesignSystem | undefined,
): Baseline {
	return linked ? withTokens(baseline, linked.tokens) : baseline;
}

function linkedBaselines(
	baselines: Map<string, Baseline>,
	linked: LinkedDesignSystem | undefined,
): Map<string, Baseline> {
	return new Map(
		[...baselines].map(([name, baseline]) => [
			name,
			linkedBaseline(baseline, linked),
		]),
	);
}

/** The current frame of each Screen that has a Baseline; missing when deleted. */
async function readFrames(
	bridge: Bridge,
	screens: { name: string }[],
	baselines: Map<string, Baseline>,
): Promise<Map<string, SyncedNode>> {
	const requested = screens.flatMap((screen) => {
		const baseline = baselines.get(screen.name);
		return baseline ? [{ screen: screen.name, frameId: baseline.frameId }] : [];
	});
	if (requested.length === 0) return new Map();
	const { screens: frames } = await bridge.request("read_screens", {
		screens: requested,
	});
	return new Map(
		frames.flatMap(({ screen, frame }) => (frame ? [[screen, frame]] : [])),
	);
}

export type PullResult = {
	linkedFile: FileInfo;
	designSystem: {
		/** merged: Figma's token edits are in DESIGN.md; unchanged: nothing to pull; not_pushed: no Push sent it yet. */
		status: "merged" | "unchanged" | "not_pushed";
		/** Token fields Figma changed. */
		changed: string[];
		conflicts: number;
	};
	screens: {
		screen: string;
		/** merged: Figma's edits are in the file; unchanged: nothing to pull; missing: the frame is gone. */
		status: "merged" | "unchanged" | "missing";
		conflicts: number;
		/** Layers kept in Figma because the Screen Subset can't express them. */
		figmaOwned: FigmaOwnedLayer[];
	}[];
	conflicts: number;
};

export async function pullDesignProject(
	dir: string,
	bridge: Bridge,
): Promise<PullResult> {
	let project = await loadProject(dir);
	const link = await readLink(project);
	if (!link) {
		throw new DesignSyncError(
			"Nothing to pull: the Design Project isn't linked to a Figma file yet. Push first.",
		);
	}
	checkBridgedFile(bridge, link);
	const baselines = await readBaselines(project);
	const screens = project.screens.filter((screen) =>
		baselines.has(screen.name),
	);
	const failing = [
		...project.designMdErrors,
		...screens.flatMap((screen) => checkScreen(project, screen).errors),
	];
	if (failing.length > 0) {
		throw new DesignSyncError(
			`Pull refused: these files fail Check, so Figma's edits can't be merged into them. Fix them (or resolve their Sync Conflicts) first.\n${describeErrors(failing)}`,
		);
	}
	const linked = await readLinkedDesignSystem(project, bridge);
	const designSystem: PullResult["designSystem"] = {
		status: linked ? "unchanged" : "not_pushed",
		changed: [],
		conflicts: 0,
	};
	if (linked && linked.changes.length > 0) {
		const pulled = pullDesignSystem(
			project.designMd,
			linked.baseline,
			linked.figma,
		);
		if (pulled.source !== undefined) {
			await writeFile(join(project.dir, "DESIGN.md"), pulled.source);
		}
		await writeDesignSystemBaseline(project, {
			...linked.baseline,
			source: pulled.baselineSource,
		});
		Object.assign(designSystem, {
			status: "merged",
			changed: pulled.changed,
			conflicts: pulled.conflicts,
		});
		// Screens merge against the merged tokens, unless they're in conflict.
		if (pulled.conflicts === 0) project = await loadProject(dir);
	}
	const checked = screens.map((original) => {
		const screen = project.screens.find((s) => s.name === original.name);
		return checkScreen(project, screen ?? original);
	});
	const frames = await readFrames(
		bridge,
		screens,
		linkedBaselines(baselines, linked),
	);
	const results: PullResult["screens"] = [];
	for (const screen of checked) {
		const stored = baselines.get(screen.name) as Baseline;
		const baseline = linkedBaseline(stored, linked);
		const frame = frames.get(screen.name);
		if (!frame) {
			results.push({
				screen: screen.name,
				status: "missing",
				conflicts: 0,
				figmaOwned: [],
			});
			continue;
		}
		const fetched: Record<string, { src: string; record: ImageRecord }> = {};
		for (const imageHash of unknownImages(frame, baseline)) {
			const { bytes } = await bridge.request("get_image", { imageHash });
			fetched[imageHash] = await saveImage(
				project,
				screen,
				imageHash,
				Buffer.from(bytes, "base64"),
			);
		}
		const pulled = pullScreen(
			project,
			screen,
			screen.root as Element,
			baseline,
			frame,
			fetched,
		);
		if (pulled.source !== undefined)
			await writeFile(screen.path, pulled.source);
		await fetchExports(project, screen.name, frame, pulled.figmaOwned, bridge);
		if (JSON.stringify(pulled.baseline) !== JSON.stringify(stored))
			await writeBaseline(project, screen.name, pulled.baseline);
		results.push({
			screen: screen.name,
			status: pulled.changed ? "merged" : "unchanged",
			conflicts: pulled.conflicts,
			figmaOwned: pulled.figmaOwned,
		});
	}
	return {
		linkedFile: link.file,
		designSystem,
		screens: results,
		conflicts: results.reduce(
			(sum, screen) => sum + screen.conflicts,
			designSystem.conflicts,
		),
	};
}

/** Caches an export of each Figma-owned Element's layer a designer made or changed. */
async function fetchExports(
	project: DesignProject,
	screen: string,
	frame: SyncedNode,
	figmaOwned: FigmaOwnedLayer[],
	bridge: Bridge,
) {
	const exports = await readExports(project, screen);
	const fetched = [];
	for (const { key, node } of exportsToFetch(frame, figmaOwned, exports)) {
		try {
			// Twice the Screen's pixels, so the Preview stays sharp.
			const { png } = await bridge.request("export_node_image", {
				nodeId: node.id,
				scale: 2,
			});
			fetched.push({ key, node, png: Buffer.from(png, "base64") });
		} catch {
			// The Preview says the export is missing; the next Pull tries again.
		}
	}
	const keys = figmaOwned.flatMap(({ key }) => (key ? [key] : []));
	await saveExports(project, screen, fetched, keys);
}

/** Links the Design Project to the Bridged File instead, forgetting the old file's frames. */
export async function relinkDesignProject(
	dir: string,
	bridge: Bridge,
): Promise<{ linkedFile: FileInfo; previous?: FileInfo }> {
	const project = await loadProject(dir);
	const status = connected(bridge);
	const previous = await readLink(project);
	await clearBaselines(project);
	const link = await linkBridgedFile(project, bridge, status.file);
	return { linkedFile: link.file, previous: previous?.file };
}

export type DesignStatus = {
	dir: string;
	screens: string[];
	linkedFile: FileInfo | null;
	/** Whether the Bridged File is the Linked File; null without a plugin or a link. */
	bridgedFileIsLinked: boolean | null;
	/** Screens whose frames have Unpulled Changes; null when Figma can't be read. */
	unpulledChanges: string[] | null;
	syncConflicts: string[];
	designSystem: {
		/** Token fields with Unpulled Changes; null when Figma can't be read. */
		unpulledChanges: string[] | null;
		/** Whether DESIGN.md has Sync Conflicts to resolve. */
		syncConflicts: boolean;
	};
};

export async function designProjectStatus(
	dir: string,
	bridge: Bridge,
): Promise<DesignStatus | null> {
	let project: DesignProject;
	try {
		project = await loadProject(dir);
	} catch {
		return null;
	}
	const link = await readLink(project);
	const { errors } = await checkProject(project);
	const syncConflicts = project.screens
		.filter((screen) =>
			errors.some(
				(error) => error.file === screen.file && error.rule === "sync-conflict",
			),
		)
		.map((screen) => screen.name);
	const status = bridge.status();
	const bridgedFileIsLinked =
		link && status.connected ? status.linkId === link.linkId : null;
	let unpulledChanges: string[] | null = null;
	let unpulledTokens: string[] | null = null;
	if (bridgedFileIsLinked) {
		try {
			const linked = await readLinkedDesignSystem(project, bridge);
			unpulledTokens = linked?.changes ?? [];
			const baselines = linkedBaselines(await readBaselines(project), linked);
			const frames = await readFrames(bridge, project.screens, baselines);
			unpulledChanges = screensWithUnpulledChanges(
				project,
				project.screens,
				baselines,
				frames,
			).map((screen) => screen.name);
		} catch {
			unpulledChanges = null;
			unpulledTokens = null;
		}
	}
	return {
		dir: project.dir,
		screens: project.screens.map((screen) => screen.name),
		linkedFile: link?.file ?? null,
		bridgedFileIsLinked,
		unpulledChanges,
		syncConflicts,
		designSystem: {
			unpulledChanges: unpulledTokens,
			syncConflicts: errors.some(
				(error) => error.file === "DESIGN.md" && error.rule === "sync-conflict",
			),
		},
	};
}
