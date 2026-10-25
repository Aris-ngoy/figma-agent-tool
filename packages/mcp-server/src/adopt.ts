// Adopt: starting a Design Project from the Bridged File. It lists the
// file's top-level frames to choose from, confirms the file and frames, then
// Pulls the Design System and the chosen frames into a new Design Project
// linked to the file. design-project decides what each frame and token
// becomes; this reads them through the Plugin and writes the files.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	adoptDesignSystem,
	adoptedComponentNames,
	adoptedScreenNames,
	adoptFrame,
	type DesignProject,
	designSystemToAdopt,
	type FigmaOwnedLayer,
	figmaComponents,
	type ImageRecord,
	initProject,
	type LinkedComponentRecord,
	loadProject,
	MODES_FILE,
	type ScreenFile,
	saveImage,
	screenFrameReason,
	screenPath,
	unknownImages,
	writeBaseline,
	writeDesignSystemBaseline,
	writeLink,
	writeLinkedComponentRecord,
} from "@figma-agent-tool/design-project";
import type { FileInfo, SyncedNode } from "@figma-agent-tool/protocol";
import type { Bridge } from "./bridge";
import { connected, DesignSyncError, fetchExports } from "./design-sync";

/** A top-level frame of the Bridged File, with the page it's on. */
type FileFrame = {
	id: string;
	name: string;
	page: string;
	width: number;
	height: number;
};

export type AdoptResult =
	| {
			status: "choose_frames";
			file: FileInfo;
			frames: FileFrame[];
			message: string;
	  }
	| {
			status: "confirm_adopt";
			file: FileInfo;
			screens: {
				screen: string;
				frameId: string;
				frame: string;
				page: string;
			}[];
			message: string;
	  }
	| {
			status: "adopted";
			linkedFile: FileInfo;
			dir: string;
			screensPage: { id: string; name: string };
			screens: {
				screen: string;
				frameId: string;
				/** Layers kept in Figma because the Screen Subset can't express them. */
				figmaOwned: FigmaOwnedLayer[];
			}[];
			/** Linked Components: a library's by key, the file's own by node ID. */
			components: {
				component: string;
				name: string;
				key?: string;
				id?: string;
			}[];
			designSystem: { tokens: string[]; notAdopted: string[] };
	  };

/**
 * Adopts the Bridged File into `dir`. Without `frames`, lists the frames to
 * choose from; without `confirm`, says what would be adopted. Nothing is
 * written until both are given, and never into an existing Design Project.
 */
export async function adoptFile(
	dir: string,
	bridge: Bridge,
	{ frames: chosen, confirm = false }: { frames?: string[]; confirm?: boolean },
): Promise<AdoptResult> {
	const root = resolve(dir);
	if (existsSync(join(root, "project.json"))) {
		throw new DesignSyncError(
			`Adopt refused: ${root} already has a Design Project. Adopt starts a new one: pick an empty folder, or link this one to the Bridged File with relink_file / \`figma-agent-tool relink\` and Push.`,
		);
	}
	const { file } = connected(bridge);
	const frames = await fileFrames(bridge);
	if (!chosen || chosen.length === 0) {
		return {
			status: "choose_frames",
			file,
			frames,
			message: `Ask the user which of these frames of “${file.name}” to adopt as Screens (by name or ID), then call adopt again with them. Pages and frames not chosen stay the designers'.`,
		};
	}
	const picked = chosen.map((wanted) => findFrame(frames, wanted, file));
	const read = await bridge.request("read_screens", {
		screens: picked.map(({ id, name }) => ({ screen: name, frameId: id })),
		components: [],
	});
	const nodes = read.screens.map(({ frame }, index) => {
		const { id, name } = picked[index] as FileFrame;
		if (!frame)
			throw new DesignSyncError(`The frame “${name}” (${id}) is gone.`);
		const reason = screenFrameReason(frame);
		if (reason) {
			throw new DesignSyncError(
				`Adopt refused: “${name}” (${id}) can't be a Screen: it ${reason}. Screens are auto-layout frames; leave it out, or give it auto layout in Figma first.`,
			);
		}
		return frame;
	});
	const names = adoptedScreenNames(picked);
	const screens = picked.map(({ id, name, page }) => ({
		screen: names.get(id) as string,
		frameId: id,
		frame: name,
		page,
	}));
	if (!confirm) {
		return {
			status: "confirm_adopt",
			file,
			screens,
			message: `Adopt starts a Design Project in ${root} from “${file.name}”, which becomes its Linked File: its variables and text styles become DESIGN.md, these frames Screens. Ask the user to confirm the file and frames, then call adopt again with confirm.`,
		};
	}

	const designSystem = await readDesignSystem(bridge, file);
	const components = await readComponents(bridge, nodes);
	// The Screens Page is where the first frame is; the others stay where they are.
	const [first] = picked as [FileFrame];
	const { id = "", name: pageName = first.page } =
		(await bridge.request("list_pages", {})).pages.find(
			(page) => page.name === first.page,
		) ?? {};
	const screensPage = { id, name: pageName };
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "DESIGN.md"), designSystem.designMd);
	await initProject(root, {
		screenSize: { width: first.width, height: first.height },
		screensPage: screensPage.name,
	});
	if (designSystem.modesSource)
		await writeFile(join(root, MODES_FILE), designSystem.modesSource);
	for (const { component, source, record } of components) {
		await mkdir(join(root, "components"), { recursive: true });
		await writeFile(join(root, "components", `${component}.json`), source);
		await writeLinkedComponentRecord({ dir: root }, component, record);
	}
	await writeDesignSystemBaseline({ dir: root }, designSystem.baseline);

	const project = await loadProject(root);
	const linked = figmaComponents(project, new Map());
	const screenFrames = Object.fromEntries(
		screens.map(({ screen, frameId }) => [frameId, screen]),
	);
	const adopted = [];
	for (const [index, { screen: name, frameId }] of screens.entries()) {
		const frame = nodes[index] as SyncedNode;
		const screen: ScreenFile = {
			name,
			file: `screens/${name}.html`,
			path: screenPath(project, name),
			source: "",
		};
		const images = await fetchImages(project, screen, frame, bridge);
		const result = adoptFrame(project, screen, frame, {
			images,
			screenFrames,
			components: linked,
			designSystem: designSystem.baseline,
		});
		if ("reason" in result) {
			throw new Error(
				`${frame.name} stopped being adoptable: ${result.reason}`,
			);
		}
		await writeFile(screen.path, result.source);
		await writeBaseline(project, name, result.baseline);
		await fetchExports(project, name, frame, result.figmaOwned, bridge);
		adopted.push({ screen: name, frameId, figmaOwned: result.figmaOwned });
	}
	const linkId = randomUUID();
	await bridge.request("link_file", { linkId });
	bridge.setLinkId(linkId);
	await writeLink(project, { linkId, file, screensPage });
	return {
		status: "adopted",
		linkedFile: file,
		dir: root,
		screensPage,
		screens: adopted,
		components: components.map(({ component, name, linkedBy }) => ({
			component,
			name,
			...linkedBy,
		})),
		designSystem: {
			tokens: [
				...Object.keys(designSystem.baseline.variables),
				...Object.keys(designSystem.baseline.textStyles),
			],
			notAdopted: designSystem.notAdopted,
		},
	};
}

/** Every page's top-level frames. */
async function fileFrames(bridge: Bridge): Promise<FileFrame[]> {
	const { pages } = await bridge.request("list_pages", {});
	const found: FileFrame[] = [];
	for (const page of pages) {
		const listed = await bridge.request("list_frames", { pageId: page.id });
		for (const { id, name, type, width, height } of listed.frames) {
			if (type === "FRAME")
				found.push({ id, name, page: page.name, width, height });
		}
	}
	return found;
}

/** The frame with this ID, or else this name, or a DesignSyncError saying which there are. */
function findFrame(
	frames: FileFrame[],
	wanted: string,
	file: FileInfo,
): FileFrame {
	const byId = frames.find((frame) => frame.id === wanted);
	if (byId) return byId;
	const named = frames.filter((frame) => frame.name === wanted);
	if (named.length === 1) return named[0] as FileFrame;
	const list = (some: FileFrame[]) =>
		some
			.map((frame) => `“${frame.name}” (${frame.id}, ${frame.page})`)
			.join(", ");
	if (named.length > 1) {
		throw new DesignSyncError(
			`Several top-level frames are named “${wanted}”: ${list(named)}. Choose one by its ID.`,
		);
	}
	throw new DesignSyncError(
		`No top-level frame “${wanted}” in “${file.name}”: it has ${list(frames) || "none"}.`,
	);
}

async function readDesignSystem(bridge: Bridge, file: FileInfo) {
	const { collections, styles } = await bridge.request("get_design_system", {});
	const toAdopt = designSystemToAdopt({ collections, textStyles: styles.text });
	const read = await bridge.request("read_design_system", {
		variables: Object.values(toAdopt.variables),
		textStyles: Object.values(toAdopt.textStyles),
	});
	return adoptDesignSystem(file.name, toAdopt, read);
}

/** The components the frames' instances are of, as Linked Components. */
async function readComponents(bridge: Bridge, frames: SyncedNode[]) {
	const ids = new Set<string>();
	const walk = (node: SyncedNode) => {
		if (node.instance) ids.add(node.instance.setId ?? node.instance.mainId);
		node.children?.forEach(walk);
	};
	frames.forEach(walk);
	if (ids.size === 0) return [];
	const { components } = await bridge.request("read_components", {
		ids: [...ids],
	});
	const found = [
		...new Map(components.map((c) => [c.componentId, c])).values(),
	];
	const names = adoptedComponentNames(found);
	return found.map(({ id: _, name, remote, ...record }) => {
		const component = names.get(record.componentId) as string;
		// A library's component is found by key; the file's own by node ID.
		const linkedBy =
			remote && record.key ? { key: record.key } : { id: record.componentId };
		return {
			component,
			name,
			linkedBy,
			source: `${JSON.stringify(linkedBy, null, "\t")}\n`,
			record: record as LinkedComponentRecord,
		};
	});
}

/** Saves the images a frame uses into assets/, by `src`. */
async function fetchImages(
	project: DesignProject,
	screen: ScreenFile,
	frame: SyncedNode,
	bridge: Bridge,
): Promise<Record<string, ImageRecord>> {
	const images: Record<string, ImageRecord> = {};
	// A frame being adopted has no Baseline, so every image is unknown.
	const none = { frameId: "", source: "", tokens: {}, nodes: {}, images: {} };
	for (const imageHash of unknownImages(frame, none)) {
		const { bytes } = await bridge.request("get_image", { imageHash });
		const { src, record } = await saveImage(
			project,
			screen,
			imageHash,
			Buffer.from(bytes, "base64"),
		);
		images[src] = record;
	}
	return images;
}
