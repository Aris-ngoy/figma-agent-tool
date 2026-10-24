// Push, Pull and re-link: the Design Project on one side, the Bridged File
// on the other. design-project decides what changes; this reads frames and
// applies trees through the Plugin. The MCP tools and the CLI both call
// these.
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
	assignKeys,
	type Baseline,
	baselineAfterPush,
	type CheckError,
	checkProject,
	checkScreen,
	clearBaselines,
	type DesignProject,
	type Element,
	followFrame,
	hasUnpulledChanges,
	type ImageRecord,
	type Link,
	loadProject,
	type PushedImage,
	pullScreen,
	pushedImageRecords,
	readBaselines,
	readLink,
	type ScreenFile,
	saveImage,
	screenPush,
	type UnsupportedLayer,
	unknownImages,
	writeBaseline,
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

function describeErrors(errors: CheckError[]): string {
	return errors
		.map(
			(error) =>
				`- ${error.file}:${error.line}${error.element ? ` ${error.element}` : ""} [${error.rule}] ${error.message}`,
		)
		.join("\n");
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
					: "Push refused: these Screens fail Check.",
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

	const baselines = await readBaselines(project);
	const frames = await readFrames(bridge, screens, baselines);
	const unpulled = screens.filter((screen) => {
		const baseline = baselines.get(screen.name);
		const frame = frames.get(screen.name);
		return (
			baseline && frame && hasUnpulledChanges(project, screen, baseline, frame)
		);
	});
	if (unpulled.length > 0) {
		throw new DesignSyncError(
			`Push refused: ${unpulled.map((screen) => `${screen.name} (frame “${frames.get(screen.name)?.name}”)`).join(", ")} ${unpulled.length === 1 ? "has" : "have"} Unpulled Changes: a designer edited ${unpulled.length === 1 ? "its frame" : "their frames"} in Figma. Pull first; it merges their edits into the Screens.`,
		);
	}

	const pushes: {
		screen: ScreenFile;
		tree: ScreenNode;
		sources: Record<string, PushedImage>;
		frameId?: string;
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
		const push = await screenPush(project, screen, root, baseline);
		Object.assign(images, push.images);
		pushes.push({
			screen,
			tree: push.tree,
			sources: push.sources,
			frameId: baseline?.frameId,
		});
	}
	const result = await bridge.request("push_screens", {
		page: { id: link.screensPage.id || undefined, name: link.screensPage.name },
		screens: pushes.map(({ screen, frameId, tree }) => ({
			screen: screen.name,
			frameId,
			tree,
		})),
		images,
	});
	await writeLink(project, { ...link, screensPage: result.page });
	const pushed = [];
	for (const [index, push] of pushes.entries()) {
		const frame = result.screens[index]?.frame as SyncedNode;
		const records = pushedImageRecords(push.sources, result.images);
		await writeBaseline(
			project,
			push.screen.name,
			baselineAfterPush(project, push.screen.source, frame, records),
		);
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
	return only.map((name) => {
		const screen = project.screens.find((s) => s.name === name);
		if (!screen) {
			throw new DesignSyncError(
				`No Screen named "${name}": the Design Project has ${project.screens.map((s) => s.name).join(", ") || "no Screens"}.`,
			);
		}
		return screen;
	});
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
	screens: {
		screen: string;
		/** merged: Figma's edits are in the file; unchanged: nothing to pull; missing: the frame is gone. */
		status: "merged" | "unchanged" | "missing";
		conflicts: number;
		/** Layers kept in Figma because the Screen Subset can't express them. */
		unsupported: UnsupportedLayer[];
	}[];
	conflicts: number;
};

export async function pullDesignProject(
	dir: string,
	bridge: Bridge,
): Promise<PullResult> {
	const project = await loadProject(dir);
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
	const checked = screens.map((screen) => checkScreen(project, screen));
	const failing = checked.flatMap((screen) => screen.errors);
	if (failing.length > 0) {
		throw new DesignSyncError(
			`Pull refused: these Screens fail Check, so Figma's edits can't be merged into them. Fix them (or resolve their Sync Conflicts) first.\n${describeErrors(failing)}`,
		);
	}
	const frames = await readFrames(bridge, screens, baselines);
	const results: PullResult["screens"] = [];
	for (const screen of checked) {
		const baseline = baselines.get(screen.name) as Baseline;
		const frame = frames.get(screen.name);
		if (!frame) {
			results.push({
				screen: screen.name,
				status: "missing",
				conflicts: 0,
				unsupported: [],
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
		if (pulled.baseline !== baseline)
			await writeBaseline(project, screen.name, pulled.baseline);
		results.push({
			screen: screen.name,
			status: pulled.changed ? "merged" : "unchanged",
			conflicts: pulled.conflicts,
			unsupported: pulled.unsupported,
		});
	}
	return {
		linkedFile: link.file,
		screens: results,
		conflicts: results.reduce((sum, screen) => sum + screen.conflicts, 0),
	};
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
	if (bridgedFileIsLinked) {
		const baselines = await readBaselines(project);
		try {
			const frames = await readFrames(bridge, project.screens, baselines);
			unpulledChanges = project.screens
				.filter((screen) => {
					const baseline = baselines.get(screen.name);
					const frame = frames.get(screen.name);
					return (
						baseline &&
						frame &&
						hasUnpulledChanges(project, screen, baseline, frame)
					);
				})
				.map((screen) => screen.name);
		} catch {
			unpulledChanges = null;
		}
	}
	return {
		dir: project.dir,
		screens: project.screens.map((screen) => screen.name),
		linkedFile: link?.file ?? null,
		bridgedFileIsLinked,
		unpulledChanges,
		syncConflicts,
	};
}
