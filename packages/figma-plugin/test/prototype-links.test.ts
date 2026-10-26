// Prototype Links: Push sets each pushed layer's on-click NAVIGATE to its
// Screen's frame, leaving every other reaction as designers made it, and
// Pull reads them back, against the mocked figma global.
import { describe, expect, test } from "bun:test";
import {
	assignKeys,
	type Baseline,
	baselineAfterPush,
	checkScreen,
	type DesignProject,
	type Element,
	hasUnpulledChanges,
	loadProject,
	type ScreenFile,
	screenFramesOf,
	screenPush,
} from "@figma-agent-tool/design-project";
import {
	linkedScreens,
	writeFixtureProject,
} from "@figma-agent-tool/design-project/fixtures";
import type {
	CommandName,
	Reaction,
	SyncedNode,
} from "@figma-agent-tool/protocol";
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

type Pushed = Map<string, { screen: ScreenFile; baseline: Baseline }>;

async function linkedProject(): Promise<DesignProject> {
	return loadProject(
		await writeFixtureProject({
			"screens/login.html": null,
			"screens/home.html": linkedScreens.home as string,
			"screens/signup.html": linkedScreens.signup as string,
		}),
	);
}

/** Pushes these Screens in one push, over their last Push. */
async function push(
	project: DesignProject,
	names: string[],
	previous: Pushed = new Map(),
	edit: (source: string) => string = (source) => source,
): Promise<Pushed> {
	const pushes = [];
	for (const name of names) {
		const original = project.screens.find((s) => s.name === name) as ScreenFile;
		const before = previous.get(name);
		const source = edit(
			before?.screen.source ?? assignKeys(original.source).source,
		);
		const screen = { ...original, source };
		const { root } = checkScreen(project, screen);
		if (!root) throw new Error(`${name} doesn't check`);
		const { tree, remove } = await screenPush(
			project,
			screen,
			root,
			before?.baseline,
		);
		pushes.push({ screen, tree, remove, frameId: before?.baseline.frameId });
	}
	const others = [...previous].filter(([name]) => !names.includes(name));
	const result = await send<{ screens: { frame: SyncedNode }[] }>(
		"push_screens",
		{
			page: { name: "Screens" },
			screens: pushes.map(({ screen, tree, remove, frameId }) => ({
				screen: screen.name,
				frameId,
				tree,
				remove,
			})),
			frames: Object.fromEntries(
				others.map(([name, { baseline }]) => [name, baseline.frameId]),
			),
			screenFrames: [...previous.values()].map(
				({ baseline }) => baseline.frameId,
			),
		},
	);
	const pushed: Pushed = new Map(previous);
	pushes.forEach(({ screen }, index) => {
		const frame = result.screens[index]?.frame as SyncedNode;
		pushed.set(screen.name, {
			screen,
			baseline: baselineAfterPush(project, screen.source, frame, {}),
		});
	});
	return pushed;
}

async function readFrames(pushed: Pushed): Promise<Map<string, SyncedNode>> {
	const { screens } = await send<{
		screens: { screen: string; frame: SyncedNode }[];
	}>("read_screens", {
		screens: [...pushed].map(([screen, { baseline }]) => ({
			screen,
			frameId: baseline.frameId,
		})),
	});
	return new Map(screens.map(({ screen, frame }) => [screen, frame]));
}

type MockLayer = {
	reactions: Reaction[];
	setReactionsAsync: (reactions: Reaction[]) => Promise<void>;
};

async function layer(pushed: Pushed, screen: string, key: string) {
	const id = pushed.get(screen)?.baseline.nodes[key] as string;
	return (await figma.getNodeByIdAsync(id)) as unknown as MockLayer;
}

const frameId = (pushed: Pushed, screen: string) =>
	pushed.get(screen)?.baseline.frameId as string;

const hover: Reaction = {
	trigger: { type: "ON_HOVER" },
	actions: [
		{
			type: "NODE",
			destinationId: "1:2",
			navigation: "OVERLAY",
			transition: null,
		},
	],
};

const withoutAction = (reactions: Reaction[]) =>
	reactions.map(({ trigger, actions }) => ({ trigger, actions }));

describe("push_screens with Prototype Links", () => {
	test("sets on-click NAVIGATEs to the linked Screens' frames, made in the same push", async () => {
		installMockFigma(document);
		const pushed = await push(await linkedProject(), ["home", "signup"]);
		const signup = frameId(pushed, "signup");
		expect(
			withoutAction((await layer(pushed, "home", "e3")).reactions),
		).toEqual([
			{
				trigger: { type: "ON_CLICK" },
				actions: [
					{
						type: "NODE",
						destinationId: signup,
						navigation: "NAVIGATE",
						transition: {
							type: "PUSH",
							direction: "LEFT",
							matchLayers: false,
							easing: { type: "EASE_OUT" },
							duration: 0.3,
						},
					},
				],
			},
		]);
		expect(
			withoutAction((await layer(pushed, "signup", "e2")).reactions),
		).toMatchObject([
			{ actions: [{ destinationId: frameId(pushed, "home") }] },
		]);
	});

	test("reads back as exactly the Screens it pushed", async () => {
		installMockFigma(document);
		const project = await linkedProject();
		const pushed = await push(project, ["home", "signup"]);
		const frames = await readFrames(pushed);
		const screenFrames = screenFramesOf(
			new Map([...pushed].map(([name, { baseline }]) => [name, baseline])),
			frames,
		);
		for (const [name, { screen, baseline }] of pushed) {
			expect(
				hasUnpulledChanges(
					project,
					screen,
					baseline,
					frames.get(name) as SyncedNode,
					screenFrames,
				),
			).toBe(false);
		}
	});

	test("links to a Screen outside the push by its frame", async () => {
		installMockFigma(document);
		const project = await linkedProject();
		const first = await push(project, ["home", "signup"]);
		const again = await push(project, ["home"], first, (source) =>
			source.replace('data-transition="push left"', ""),
		);
		expect(
			withoutAction((await layer(again, "home", "e3")).reactions),
		).toMatchObject([
			{
				actions: [
					{ destinationId: frameId(first, "signup"), transition: null },
				],
			},
		]);
	});

	test("keeps designers' other reactions, and their link where the Screen didn't change it", async () => {
		installMockFigma(document);
		const project = await linkedProject();
		const first = await push(project, ["home", "signup"]);
		const button = await layer(first, "home", "e3");
		// A designer adds a hover overlay and resets scrolling on the link.
		const [link] = withoutAction(button.reactions) as [Reaction];
		const tweaked = structuredClone(link);
		Object.assign(tweaked.actions[0] as object, { resetScrollPosition: true });
		await button.setReactionsAsync([hover, tweaked]);
		await push(project, ["home", "signup"], first);
		expect(withoutAction(button.reactions)).toEqual([hover, tweaked]);
		await push(project, ["home", "signup"], first, (source) =>
			source
				.replace(
					'<a data-key="e3" href="signup.html" data-transition="push left"',
					'<div data-key="e3"',
				)
				.replace('  </a>\n  <a data-key="e5"', '  </div>\n  <a data-key="e5"'),
		);
		expect(withoutAction(button.reactions)).toEqual([hover]);
	});

	test("refuses a link to a Screen whose frame isn't in the file, changing nothing", async () => {
		const figma = installMockFigma(document);
		const project = await linkedProject();
		const screen = {
			...(project.screens[0] as ScreenFile),
			source: assignKeys(linkedScreens.home as string).source,
		};
		const { root } = checkScreen(project, screen);
		const { tree } = await screenPush(
			project,
			screen,
			root as Element,
			undefined,
		);
		const response = await createCommandHandler({
			pluginVersion: handshake.pluginVersion,
		}).handle({
			type: "request",
			id: "req-1",
			command: "push_screens",
			params: {
				page: { name: "Screens" },
				screens: [{ screen: "home", tree }],
				frames: { signup: "77:77" },
			},
		});
		expect(response.ok).toBe(false);
		expect(!response.ok && response.error.code).toBe("invalid_destination");
		expect(figma.undoCommits).toBe(0);
	});

	test("Motion on a pushed layer survives a later Push", async () => {
		installMockFigma(document);
		const project = await linkedProject();
		const first = await push(project, ["home", "signup"]);
		const [animated] = Object.keys(document.motion.nodes) as [string];
		const { keyframeTracks } = await send<{ keyframeTracks: unknown[] }>(
			"get_motion",
			{ nodeId: animated },
		);
		const nodeId = first.get("home")?.baseline.nodes.e3;
		await send("set_motion", { nodeId, keyframeTracks });
		const before = await send("get_motion", { nodeId });
		expect(before).toMatchObject({ keyframeTracks });
		await push(project, ["home", "signup"], first, (source) =>
			source.replace("Home</h1>", "Welcome</h1>"),
		);
		expect(await send("get_motion", { nodeId })).toEqual(before);
	});
});
