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
	type DirectionFile,
	designSystemChanges,
	designSystemPush,
	directionOf,
	directionPush,
	type Element,
	exportsToFetch,
	type FigmaComponents,
	type FigmaDesignSystem,
	type FigmaOwnedLayer,
	figmaComponents,
	figmaDesignSystem,
	figmaOwnedElements,
	figmaTokens,
	followFrame,
	hasUnpulledChanges,
	type ImageRecord,
	type Link,
	loadProject,
	MODES_FILE,
	type PushedImage,
	parseDesignMd,
	parseModes,
	pullDesignSystem,
	pullScreen,
	pushedImageRecords,
	readBaselines,
	readComponentBaselines,
	readDesignSystemBaseline,
	readExports,
	readLink,
	type ScreenFile,
	type ScreenFrames,
	saveExports,
	saveImage,
	screenFramesOf,
	screenLinks,
	screenPush,
	type Tokens,
	tokenBindings,
	unknownImages,
	unlinkedFigmaOwned,
	withTokens,
	writeBaseline,
	writeComponentBaseline,
	writeDesignSystemBaseline,
	writeLink,
	writeLinkedComponentRecord,
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

/** A Screen's Direction, or a DesignSyncError listing the Directions it has. */
export function findDirection(
	project: DesignProject,
	screen: string,
	direction: string,
): DirectionFile {
	const found = directionOf(project, screen, direction);
	if (!found) {
		const directions = project.directions.filter((d) => d.of === screen);
		throw new DesignSyncError(
			directions.length > 0
				? `No Direction named "${direction}": ${screen} has the Directions ${directions.map((d) => d.direction).join(", ")}.`
				: `No Direction named "${direction}": ${screen} has no Directions (in screens/${screen}.directions/).`,
		);
	}
	return found;
}

/** The first Push's question: link the Bridged File? */
type ConfirmLink = {
	status: "confirm_link";
	file: FileInfo;
	message: string;
};

export type PushResult =
	| ConfirmLink
	| {
			status: "pushed";
			linkedFile: FileInfo;
			page: { id: string; name: string };
			screens: { screen: string; frameId: string; created: boolean }[];
			/** Defined Components: their component set's (or lone component's) node. */
			components: { component: string; nodeId: string; created: boolean }[];
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
	connected(bridge);
	const screens = selectScreens(project, only);
	if (screens.length === 0) {
		throw new DesignSyncError(
			"Nothing to push: the Design Project has no Screens yet. Add HTML files to screens/.",
		);
	}
	// Every Component goes with every Push, so instances always find theirs.
	await refuseFailingCheck(project, [
		...screens,
		...project.components,
		...project.linkedComponents,
	]);
	const link = await linkOrConfirm(project, bridge, confirmLink);
	if ("status" in link) return link;

	const linked = await readLinkedDesignSystem(project, bridge);
	if (linked && linked.changes.length > 0) {
		throw new DesignSyncError(
			`Push refused: the Design System has Unpulled Changes: a designer edited ${linked.changes.join(", ")} in Figma. Pull first; it merges them into DESIGN.md.`,
		);
	}
	const baselines = linkedBaselines(await readBaselines(project), linked);
	const componentBaselines = linkedBaselines(
		await readComponentBaselines(project),
		linked,
	);
	// Every Screen's frame, since the pushed ones may link to any of them.
	const { frames, components: componentNodes } = await readFigma(
		bridge,
		project.screens,
		baselines,
		componentBaselines,
	);
	const editedComponents = screensWithUnpulledChanges(
		project,
		project.components,
		componentBaselines,
		componentNodes,
		{},
	);
	if (editedComponents.length > 0) {
		throw new DesignSyncError(
			`Push refused: the Component${editedComponents.length === 1 ? "" : "s"} ${editedComponents.map((c) => c.name).join(", ")} ${editedComponents.length === 1 ? "has" : "have"} Unpulled Changes: a designer edited ${editedComponents.length === 1 ? "its main component" : "their main components"} in Figma. Pull first; it merges their edits into components/.`,
		);
	}
	const screenFrames = screenFramesOf(baselines, frames);
	const unpulled = screensWithUnpulledChanges(
		project,
		screens,
		baselines,
		frames,
		screenFrames,
		figmaComponents(project, componentBaselines),
	);
	if (unpulled.length > 0) {
		throw new DesignSyncError(
			`Push refused: ${unpulled.map((screen) => `${screen.name} (frame “${frames.get(screen.name)?.name}”)`).join(", ")} ${unpulled.length === 1 ? "has" : "have"} Unpulled Changes: a designer edited ${unpulled.length === 1 ? "its frame" : "their frames"} in Figma. Pull first; it merges their edits into the Screens.`,
		);
	}

	const { push: designSystem } = designSystemPush(
		project.fields,
		linked?.baseline,
		project.modes,
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
	const componentPushes: {
		component: ScreenFile;
		tree: ScreenNode;
		sources: Record<string, PushedImage>;
		nodeId?: string;
		remove: string[];
	}[] = [];
	for (const original of project.components) {
		const component = await withKeys(original);
		const { root } = checkScreen(project, component);
		if (!root)
			throw new Error(
				`${component.file} stopped checking while keys were added.`,
			);
		const node = componentNodes.get(component.name);
		const previous = componentBaselines.get(component.name);
		const baseline =
			node && previous
				? followFrame(project, component, previous, node)
				: undefined;
		const push = await screenPush(project, component, root, baseline, bindings);
		Object.assign(images, push.images);
		componentPushes.push({
			component,
			tree: push.tree,
			sources: push.sources,
			nodeId: baseline?.frameId,
			remove: push.remove,
		});
	}
	const pushedNames = new Set(screens.map((screen) => screen.name));
	for (const original of screens) {
		const screen = await withKeys(original);
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
		const unpushed = screenLinks(root).filter(
			(target) => !pushedNames.has(target) && !frames.has(target),
		);
		if (unpushed.length > 0) {
			throw new DesignSyncError(
				`Push refused: ${screen.file} links to ${unpushed.join(", ")}, which ${unpushed.length === 1 ? "has" : "have"} no frame in Figma yet. Push ${unpushed.length === 1 ? "it" : "them"} too.`,
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
		frames: Object.fromEntries(
			[...frames]
				.filter(([name]) => !pushedNames.has(name))
				.map(([name, frame]) => [name, frame.id]),
		),
		screenFrames: Object.keys(screenFrames),
		components: componentPushes.map(({ component, nodeId, tree, remove }) => ({
			component: component.name,
			nodeId,
			tree,
			remove,
		})),
		linked: project.linkedComponents.map(({ name, key, id }) => ({
			component: name,
			key,
			id,
		})),
	});
	await writeLink(project, { ...link, screensPage: result.page });
	const pushedComponents = [];
	for (const [index, push] of componentPushes.entries()) {
		const node = result.components[index]?.node as SyncedNode;
		const records = pushedImageRecords(push.sources, result.images);
		await writeComponentBaseline(
			project,
			push.component.name,
			baselineAfterPush(project, push.component.source, node, records),
		);
		pushedComponents.push({
			component: push.component.name,
			nodeId: node.id,
			created: node.id !== push.nodeId,
		});
	}
	for (const { component, ...record } of result.linked)
		await writeLinkedComponentRecord(project, component, record);
	// Screens' Baselines record their Linked Components' properties as Figma has them.
	const pushedProject =
		result.linked.length > 0 ? await loadProject(dir) : project;
	if (result.designSystem) {
		await writeDesignSystemBaseline(project, {
			source: project.designMd,
			modesSource: project.modes.source,
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
			baselineAfterPush(pushedProject, push.screen.source, frame, records),
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
		components: pushedComponents,
	};
}

/** A Screen's or Component's file with a key on every element, written back when Push added any. */
async function withKeys(file: ScreenFile): Promise<ScreenFile> {
	const { source, added } = assignKeys(file.source);
	if (added > 0) await writeFile(file.path, source);
	return { ...file, source };
}

/** Refuses while DESIGN.md, its Modes file or one of `files` fails Check. */
async function refuseFailingCheck(
	project: DesignProject,
	files: { file: string }[],
) {
	const checked = await checkProject(project);
	const failing = checked.errors.filter(
		(error) =>
			isDesignSystemFile(error.file) ||
			files.some((file) => file.file === error.file),
	);
	if (failing.length === 0) return;
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

/**
 * The Linked File, once the Bridged File is checked to be it. The first Push
 * asks to confirm linking the Bridged File, and links it with `confirmLink`.
 */
async function linkOrConfirm(
	project: DesignProject,
	bridge: Bridge,
	confirmLink: boolean,
): Promise<Link | ConfirmLink> {
	const status = connected(bridge);
	const link = await readLink(project);
	if (link) {
		checkBridgedFile(bridge, link);
		return link;
	}
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
	return linkBridgedFile(project, bridge, status.file);
}

export type PushDirectionsResult =
	| ConfirmLink
	| {
			status: "pushed_directions";
			linkedFile: FileInfo;
			page: { id: string; name: string };
			screens: {
				screen: string;
				directions: { direction: string; frameId: string }[];
			}[];
	  };

/**
 * Copies the Directions of the Screens named (all Screens' by default) to
 * the Explorations Page, replacing their earlier copies, for designers to
 * compare. Screens and their frames are left as they are.
 */
export async function pushDirections(
	dir: string,
	bridge: Bridge,
	{
		screens: only,
		confirmLink = false,
	}: { screens?: string[]; confirmLink?: boolean } = {},
): Promise<PushDirectionsResult> {
	const project = await loadProject(dir);
	connected(bridge);
	const directions = project.directions.filter(
		(direction) => !only || only.length === 0 || only.includes(direction.of),
	);
	if (directions.length === 0) {
		throw new DesignSyncError(
			`No Directions to push: ${only && only.length > 0 ? only.join(", ") : "no Screen"} has none. Write them in screens/<screen>.directions/.`,
		);
	}
	await refuseFailingCheck(project, directions);
	const link = await linkOrConfirm(project, bridge, confirmLink);
	if ("status" in link) return link;

	const baselines = await readBaselines(project);
	const components = await componentNodeIds(project);
	const images: Record<string, string> = {};
	const screens = new Map<string, { direction: string; tree: ScreenNode }[]>();
	for (const direction of directions) {
		// Keyed for the push only: a Direction's file stays as the Agent wrote it.
		const keyed = { ...direction, source: assignKeys(direction.source).source };
		const { root } = checkScreen(project, keyed);
		if (!root)
			throw new Error(
				`${direction.file} stopped checking while keys were added.`,
			);
		const baseline = baselines.get(direction.of);
		const unlinked = unlinkedFigmaOwned(root, baseline);
		if (unlinked.length > 0) {
			throw new DesignSyncError(
				`Push refused: ${direction.file} has Figma-owned Elements (${unlinked.join(", ")}) whose layers aren't in ${direction.of}'s frame, so they can't be copied. Only Pull makes Figma-owned Elements: copy them from the Screen as Pull wrote them, or delete them.`,
			);
		}
		const unpushed = instanceComponents(root).filter(
			(component) => !components[component],
		);
		if (unpushed.length > 0) {
			throw new DesignSyncError(
				`Push refused: ${direction.file} uses ${unpushed.join(", ")}, which ${unpushed.length === 1 ? "isn't" : "aren't"} in Figma yet. Push the Screens first: every Push sends the Components.`,
			);
		}
		const push = await directionPush(project, keyed, root, baseline);
		Object.assign(images, push.images);
		const pushes = screens.get(direction.of) ?? [];
		pushes.push({ direction: direction.direction, tree: push.tree });
		screens.set(direction.of, pushes);
	}
	const page = link.explorationsPage ?? {
		id: "",
		name: project.config.explorationsPage,
	};
	const result = await bridge.request("push_explorations", {
		page: { id: page.id || undefined, name: page.name },
		screens: [...screens].map(([screen, pushes]) => ({
			screen,
			directions: pushes,
		})),
		images,
		components,
	});
	await writeLink(project, { ...link, explorationsPage: result.page });
	return {
		status: "pushed_directions",
		linkedFile: link.file,
		page: result.page,
		screens: result.screens.map(({ screen, frames }) => ({
			screen,
			directions: frames,
		})),
	};
}

/** The node each Component's instances come from, once a Push has sent (or found) it. */
async function componentNodeIds(
	project: DesignProject,
): Promise<Record<string, string>> {
	const baselines = await readComponentBaselines(project);
	return Object.fromEntries([
		...project.components.flatMap((component) => {
			const baseline = baselines.get(component.name);
			return baseline ? [[component.name, baseline.frameId]] : [];
		}),
		...project.linkedComponents.flatMap(({ name, record }) =>
			record ? [[name, record.componentId]] : [],
		),
	]);
}

/** The Components an element's instances are of. */
function instanceComponents(root: Element): string[] {
	const found = new Set<string>();
	const walk = (element: Element) => {
		if (element.kind === "instance") found.add(element.tag);
		element.children.forEach(walk);
	};
	walk(root);
	return [...found];
}

/** DESIGN.md and its Modes file. */
const isDesignSystemFile = (file: string) =>
	file === "DESIGN.md" || file === MODES_FILE;

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

/** The Screens (or Components) whose frames (or nodes) a designer edited since their Baseline. */
function screensWithUnpulledChanges(
	project: DesignProject,
	screens: ScreenFile[],
	baselines: Map<string, Baseline>,
	frames: Map<string, SyncedNode>,
	screenFrames: ScreenFrames,
	components?: FigmaComponents,
): ScreenFile[] {
	return screens.filter((screen) => {
		const baseline = baselines.get(screen.name);
		const frame = frames.get(screen.name);
		return (
			baseline &&
			frame &&
			hasUnpulledChanges(
				project,
				screen,
				baseline,
				frame,
				screenFrames,
				components,
			)
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
		changes: designSystemChanges(
			base,
			figma,
			parseModes(baseline.modesSource ?? ""),
		),
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

/**
 * The current frame of each Screen, and node of each Defined Component,
 * that has a Baseline; missing when deleted.
 */
async function readFigma(
	bridge: Bridge,
	screens: { name: string }[],
	baselines: Map<string, Baseline>,
	componentBaselines: Map<string, Baseline> = new Map(),
): Promise<{
	frames: Map<string, SyncedNode>;
	components: Map<string, SyncedNode>;
}> {
	const requested = screens.flatMap((screen) => {
		const baseline = baselines.get(screen.name);
		return baseline ? [{ screen: screen.name, frameId: baseline.frameId }] : [];
	});
	const wanted = [...componentBaselines].map(([component, baseline]) => ({
		component,
		nodeId: baseline.frameId,
	}));
	if (requested.length === 0 && wanted.length === 0)
		return { frames: new Map(), components: new Map() };
	const result = await bridge.request("read_screens", {
		screens: requested,
		components: wanted,
	});
	return {
		frames: new Map(
			result.screens.flatMap(({ screen, frame }) =>
				frame ? [[screen, frame]] : [],
			),
		),
		components: new Map(
			result.components.flatMap(({ component, node }) =>
				node ? [[component, node]] : [],
			),
		),
	};
}

export type PullResult = {
	linkedFile: FileInfo;
	designSystem: {
		/** merged: Figma's token edits are in DESIGN.md and the Modes file; unchanged: nothing to pull; not_pushed: no Push sent it yet. */
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
	/** Defined Components: designers' edits to their main components. */
	components: {
		component: string;
		status: "merged" | "unchanged" | "missing";
		conflicts: number;
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
	const componentBaselines = await readComponentBaselines(project);
	const screens = project.screens.filter((screen) =>
		baselines.has(screen.name),
	);
	const components = project.components.filter((component) =>
		componentBaselines.has(component.name),
	);
	const failing = [
		...project.designMdErrors,
		...project.modes.errors,
		...[...components, ...screens].flatMap(
			(screen) => checkScreen(project, screen).errors,
		),
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
			project.modes.source,
		);
		if (pulled.source !== undefined) {
			await writeFile(join(project.dir, "DESIGN.md"), pulled.source);
		}
		if (pulled.modesSource !== undefined) {
			await writeFile(join(project.dir, MODES_FILE), pulled.modesSource);
		}
		await writeDesignSystemBaseline(project, {
			...linked.baseline,
			source: pulled.baselineSource,
			modesSource: pulled.baselineModesSource,
		});
		Object.assign(designSystem, {
			status: "merged",
			changed: pulled.changed,
			conflicts: pulled.conflicts,
		});
		// Screens merge against the merged tokens, unless they're in conflict.
		if (pulled.conflicts === 0) project = await loadProject(dir);
	}
	const { frames, components: componentNodes } = await readFigma(
		bridge,
		screens,
		linkedBaselines(baselines, linked),
		linkedBaselines(componentBaselines, linked),
	);
	// Components first: the Screens' instances read against their properties.
	const componentResults: PullResult["components"] = [];
	for (const original of components) {
		const component = checkScreen(
			project,
			project.components.find((c) => c.name === original.name) ?? original,
		);
		const stored = componentBaselines.get(component.name) as Baseline;
		const node = componentNodes.get(component.name);
		if (!node) {
			componentResults.push({
				component: component.name,
				status: "missing",
				conflicts: 0,
				figmaOwned: [],
			});
			continue;
		}
		const baseline = linkedBaseline(stored, linked);
		const pulled = pullScreen(
			project,
			component,
			component.root as Element,
			baseline,
			node,
			await fetchImages(project, component, node, baseline, bridge),
		);
		if (pulled.source !== undefined)
			await writeFile(component.path, pulled.source);
		if (JSON.stringify(pulled.baseline) !== JSON.stringify(stored)) {
			await writeComponentBaseline(project, component.name, pulled.baseline);
			componentBaselines.set(component.name, pulled.baseline);
		}
		componentResults.push({
			component: component.name,
			status: pulled.changed ? "merged" : "unchanged",
			conflicts: pulled.conflicts,
			figmaOwned: pulled.figmaOwned,
		});
	}
	if (componentResults.some(({ status }) => status === "merged"))
		project = await loadProject(dir);
	const figma = figmaComponents(
		project,
		linkedBaselines(componentBaselines, linked),
	);
	const checked = screens.map((original) => {
		const screen = project.screens.find((s) => s.name === original.name);
		return checkScreen(project, screen ?? original);
	});
	const screenFrames = screenFramesOf(baselines, frames);
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
		const pulled = pullScreen(
			project,
			screen,
			screen.root as Element,
			baseline,
			frame,
			await fetchImages(project, screen, frame, baseline, bridge),
			screenFrames,
			figma,
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
		components: componentResults,
		conflicts: [...results, ...componentResults].reduce(
			(sum, screen) => sum + screen.conflicts,
			designSystem.conflicts,
		),
	};
}

/** Saves the images a designer put in a frame (or Component) that its Baseline doesn't know. */
async function fetchImages(
	project: DesignProject,
	screen: ScreenFile,
	frame: SyncedNode,
	baseline: Baseline,
	bridge: Bridge,
): Promise<Record<string, { src: string; record: ImageRecord }>> {
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
	return fetched;
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
		/** Whether DESIGN.md or the Modes file has Sync Conflicts to resolve. */
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
	const syncConflicts = [...project.screens, ...project.components]
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
			const componentBaselines = linkedBaselines(
				await readComponentBaselines(project),
				linked,
			);
			const { frames, components } = await readFigma(
				bridge,
				project.screens,
				baselines,
				componentBaselines,
			);
			unpulledChanges = [
				...screensWithUnpulledChanges(
					project,
					project.components,
					componentBaselines,
					components,
					{},
				),
				...screensWithUnpulledChanges(
					project,
					project.screens,
					baselines,
					frames,
					screenFramesOf(baselines, frames),
					figmaComponents(project, componentBaselines),
				),
			].map((screen) => screen.name);
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
				(error) =>
					isDesignSystemFile(error.file) && error.rule === "sync-conflict",
			),
		},
	};
}
