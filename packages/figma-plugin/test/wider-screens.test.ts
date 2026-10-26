// Push and Pull of the Screen Subset's wider mappings (absolute position,
// vectors, borders, clipping) and of Figma-owned Elements, against the
// mocked figma global.
import { describe, expect, test } from "bun:test";
import {
	assignKeys,
	type Baseline,
	baselineAfterPush,
	checkScreen,
	type DesignProject,
	hasUnpulledChanges,
	loadProject,
	pullScreen,
	pushedImageRecords,
	type ScreenFile,
	screenPush,
} from "@figma-agent-tool/design-project";
import {
	loginScreen,
	widerScreens,
	writeFixtureProject,
} from "@figma-agent-tool/design-project/fixtures";
import type { CommandName, SyncedNode } from "@figma-agent-tool/protocol";
import { document, handshake } from "@figma-agent-tool/protocol/fixtures";
import { createCommandHandler } from "../src/handler";
import { installMockFigma } from "./mock-figma";

async function send<T>(command: CommandName, params: unknown): Promise<T> {
	const response = await createCommandHandler({
		pluginVersion: handshake.pluginVersion,
	}).handle({ type: "request", id: "req-1", command, params });
	if (!response.ok) throw new Error(response.error.message);
	return response.result as T;
}

type Pushed = {
	project: DesignProject;
	screen: ScreenFile;
	frame: SyncedNode;
	baseline: Baseline;
};

/** Pushes a Screen's source, as Push does, over its last Push or Pull. */
async function push(
	project: DesignProject,
	source: string,
	previous?: Baseline,
): Promise<Pushed> {
	const original = project.screens[0] as ScreenFile;
	const screen = { ...original, source: assignKeys(source).source };
	const { root } = checkScreen(project, screen);
	if (!root) throw new Error("Screen doesn't check");
	const { tree, images, sources, remove } = await screenPush(
		project,
		screen,
		root,
		previous,
	);
	const result = await send<{
		images: Record<string, string>;
		screens: { frame: SyncedNode }[];
	}>("push_screens", {
		page: { name: "Screens" },
		screens: [
			{ screen: screen.name, frameId: previous?.frameId, tree, remove },
		],
		images,
	});
	const frame = result.screens[0]?.frame as SyncedNode;
	const records = pushedImageRecords(sources, result.images);
	return {
		project,
		screen,
		frame,
		baseline: baselineAfterPush(project, screen.source, frame, records),
	};
}

async function pushNew(source: string): Promise<Pushed> {
	const dir = await writeFixtureProject({
		"screens/login.html": null,
		"screens/wide.html": source,
	});
	return push(await loadProject(dir), source);
}

async function readFrame({ screen, baseline }: Pushed): Promise<SyncedNode> {
	const { screens } = await send<{ screens: { frame: SyncedNode }[] }>(
		"read_screens",
		{ screens: [{ screen: screen.name, frameId: baseline.frameId }] },
	);
	return screens[0]?.frame as SyncedNode;
}

async function pull(pushed: Pushed) {
	const { project, screen, baseline } = pushed;
	const { root } = checkScreen(project, screen);
	if (!root) throw new Error("Screen doesn't check");
	return pullScreen(project, screen, root, baseline, await readFrame(pushed));
}

type MockNode = Record<string, unknown> & {
	id: string;
	children?: MockNode[];
	appendChild: (node: unknown) => void;
};

async function node(id: string): Promise<MockNode> {
	return (await figma.getNodeByIdAsync(id)) as unknown as MockNode;
}

describe.each(Object.entries(widerScreens))("%s", (_, source) => {
	test("reads back as exactly the Screen it was pushed from", async () => {
		installMockFigma(document);
		const pushed = await pushNew(source);
		const frame = await readFrame(pushed);
		expect(
			hasUnpulledChanges(pushed.project, pushed.screen, pushed.baseline, frame),
		).toBe(false);
	});

	test("pushing again keeps every node ID", async () => {
		installMockFigma(document);
		const first = await pushNew(source);
		const again = await push(
			first.project,
			first.screen.source,
			first.baseline,
		);
		expect(again.baseline.nodes).toEqual(first.baseline.nodes);
	});
});

describe("push_screens with the wider Screen Subset", () => {
	test("positions layers absolutely in their auto layout", async () => {
		installMockFigma(document);
		const { baseline } = await pushNew(widerScreens.absolute as string);
		const dot = await node(baseline.nodes.e3 as string);
		expect(dot).toMatchObject({
			layoutPositioning: "ABSOLUTE",
			x: 40,
			y: -4,
			constraints: { horizontal: "MIN", vertical: "MIN" },
		});
		const title = await node(baseline.nodes.e2 as string);
		expect(title.layoutPositioning).toBe("AUTO");
	});

	test("draws <svg>s as vector layers, and borders as inside strokes", async () => {
		installMockFigma(document);
		const vectors = await pushNew(widerScreens.vector as string);
		const check = await node(vectors.baseline.nodes.e2 as string);
		expect(check).toMatchObject({
			type: "VECTOR",
			width: 48,
			height: 48,
			vectorPaths: [{ data: "M 8 24 L 18 34 L 40 12", windingRule: "NONZERO" }],
			strokeWeight: 4,
			strokeAlign: "CENTER",
			strokeCap: "ROUND",
			strokeJoin: "ROUND",
		});
		const borders = await pushNew(widerScreens.border as string);
		const card = await node(borders.baseline.nodes.e2 as string);
		expect(card).toMatchObject({
			strokeWeight: 1,
			strokeAlign: "INSIDE",
			strokesIncludedInLayout: true,
			clipsContent: false,
		});
	});
});

/** The login Screen pushed, with a star a designer drew in its frame and Pulled. */
async function pulledStar() {
	installMockFigma(document);
	const dir = await writeFixtureProject();
	const pushed = await push(await loadProject(dir), loginScreen);
	const star = figma.createStar() as unknown as MockNode;
	Object.assign(star, { name: "Star", width: 40, height: 38 });
	(await node(pushed.frame.id)).appendChild(star);
	const pulled = await pull(pushed);
	if (!pulled.source) throw new Error("Pull didn't write the star");
	return {
		...pushed,
		star,
		screen: { ...pushed.screen, source: pulled.source },
		baseline: pulled.baseline,
	};
}

describe("Figma-owned Elements", () => {
	test("Push leaves a Figma-owned Element's layer as the designers made it", async () => {
		const pulled = await pulledStar();
		expect(pulled.screen.source).toContain(
			'<figma-owned data-key="e8" data-name="Star" style="width:40px; height:38px"></figma-owned>',
		);
		Object.assign(pulled.star, { fills: [], pointCount: 7 });
		const again = await push(
			pulled.project,
			pulled.screen.source.replace("Welcome back", "Hello"),
			pulled.baseline,
		);
		expect(pulled.star).toMatchObject({ pointCount: 7, fills: [] });
		expect(again.baseline.nodes.e8).toBe(pulled.star.id);
		expect(
			again.frame.children?.find((layer) => layer.id === pulled.star.id)?.key,
		).toBe("e8");
	});

	test("Push moves and resizes a Figma-owned Element's layer when the Screen did", async () => {
		const pulled = await pulledStar();
		await push(
			pulled.project,
			pulled.screen.source
				.replace(
					'style="width:40px; height:38px"',
					'style="position:absolute; left:4px; top:8px; width:60px; height:38px"',
				)
				.replace('data-name="Star"', 'data-name="Big star"'),
			pulled.baseline,
		);
		expect(pulled.star).toMatchObject({
			type: "STAR",
			name: "Big star",
			width: 60,
			layoutPositioning: "ABSOLUTE",
			x: 4,
			y: 8,
		});
	});

	test("Push deletes the layer of a Figma-owned Element the Screen deleted", async () => {
		const pulled = await pulledStar();
		await push(
			pulled.project,
			pulled.screen.source.replace(/\n {2}<figma-owned[^\n]*/, ""),
			pulled.baseline,
		);
		expect(await figma.getNodeByIdAsync(pulled.star.id)).toBeNull();
	});
});
