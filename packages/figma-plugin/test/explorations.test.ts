// Pushing Directions: copies on the Explorations Page, against the mocked
// figma global. Pull must never find them.
import { describe, expect, test } from "bun:test";
import {
	assignKeys,
	baselineAfterPush,
	checkScreen,
	type DesignProject,
	type DirectionFile,
	directionPush,
	loadProject,
	pullScreen,
	type ScreenFile,
	screenPush,
} from "@figma-agent-tool/design-project";
import {
	loginScreen,
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

type MockNode = Record<string, unknown> & {
	id: string;
	name: string;
	x: number;
	y: number;
	parent: MockNode;
	children: MockNode[];
	appendChild: (node: unknown) => void;
	remove: () => void;
};

const node = async (id: string) =>
	(await figma.getNodeByIdAsync(id)) as unknown as MockNode;

const bold = loginScreen
	.replace("Welcome back", "Welcome back!")
	.replace("../assets/logo.png", "../../assets/logo.png");

/** The fixture project with Directions of login, the login Screen pushed. */
async function pushedLogin(directions: Record<string, string>) {
	const files = Object.fromEntries(
		Object.entries(directions).map(([name, source]) => [
			`screens/login.directions/${name}.html`,
			source,
		]),
	);
	const project = await loadProject(await writeFixtureProject(files));
	const original = project.screens[0] as ScreenFile;
	const screen = { ...original, source: assignKeys(original.source).source };
	const { root } = checkScreen(project, screen);
	if (!root) throw new Error("login doesn't check");
	const { tree, images } = await screenPush(project, screen, root, undefined);
	const result = await send<{ screens: { frame: SyncedNode }[] }>(
		"push_screens",
		{ page: { name: "Screens" }, screens: [{ screen: "login", tree }], images },
	);
	const frame = result.screens[0]?.frame as SyncedNode;
	return {
		project,
		screen,
		frame,
		baseline: baselineAfterPush(project, screen.source, frame, {}),
	};
}

type Explored = {
	page: { id: string; name: string };
	screens: {
		screen: string;
		frames: { direction: string; frameId: string }[];
	}[];
};

async function pushDirections(
	project: DesignProject,
	baseline?: Parameters<typeof directionPush>[3],
	directions: DirectionFile[] = project.directions,
): Promise<Explored> {
	const images: Record<string, string> = {};
	const pushes = [];
	for (const original of directions) {
		const direction = {
			...original,
			source: assignKeys(original.source).source,
		};
		const { root } = checkScreen(project, direction);
		if (!root) throw new Error(`${direction.file} doesn't check`);
		const push = await directionPush(project, direction, root, baseline);
		Object.assign(images, push.images);
		pushes.push({ direction: direction.direction, tree: push.tree });
	}
	return send<Explored>("push_explorations", {
		page: { name: "Explorations" },
		screens: [{ screen: "login", directions: pushes }],
		images,
	});
}

describe("push_explorations", () => {
	test("copies each Direction, labelled, side by side on the Explorations Page, as one undo step", async () => {
		const figma = installMockFigma(document);
		const { project } = await pushedLogin({ bold, calm: bold });
		const undos = figma.undoCommits;
		const result = await pushDirections(project);
		expect(result.page.name).toBe("Explorations");
		const [first, second] = await Promise.all(
			(result.screens[0]?.frames ?? []).map(({ frameId }) => node(frameId)),
		);
		expect(first).toMatchObject({ name: "login / bold", x: 0, y: 0 });
		expect(first?.parent.id).toBe(result.page.id);
		expect(second).toMatchObject({ name: "login / calm", y: 0 });
		expect(second?.x).toBe(393 + 100);
		expect(first?.children[1]).toMatchObject({ characters: "Welcome back!" });
		expect(figma.undoCommits).toBe(undos + 1);
	});

	test("pushing again replaces a Screen's copies where they were", async () => {
		installMockFigma(document);
		const { project } = await pushedLogin({ bold, calm: bold });
		const first = await pushDirections(project);
		// A designer moves the row of copies.
		const [old, other] = first.screens[0]?.frames ?? [];
		Object.assign(await node(old?.frameId as string), { x: 50, y: 900 });
		Object.assign(await node(other?.frameId as string), { x: 543, y: 900 });
		const [direction] = project.directions;
		const again = await pushDirections(project, undefined, [
			direction as DirectionFile,
		]);
		const page = await node(again.page.id);
		expect(page.children.map((frame) => frame.name)).toEqual(["login / bold"]);
		expect(page.children[0]).toMatchObject({ x: 50, y: 900 });
		expect(page.children[0]?.id).not.toBe(old?.frameId);
	});

	test("Pull never finds a copy: it isn't linked to its Screen", async () => {
		installMockFigma(document);
		const pushed = await pushedLogin({ bold });
		await pushDirections(pushed.project);
		(await node(pushed.frame.id)).remove();
		const { screens } = await send<{ screens: { frame: SyncedNode | null }[] }>(
			"read_screens",
			{ screens: [{ screen: "login", frameId: pushed.frame.id }] },
		);
		expect(screens[0]?.frame).toBeNull();
	});

	test("copies the layers of Figma-owned Elements, leaving the Screen's own", async () => {
		installMockFigma(document);
		const pushed = await pushedLogin({});
		const star = figma.createStar() as unknown as MockNode;
		Object.assign(star, { name: "Star", width: 40, height: 38 });
		(await node(pushed.frame.id)).appendChild(star);
		const { screens } = await send<{ screens: { frame: SyncedNode }[] }>(
			"read_screens",
			{ screens: [{ screen: "login", frameId: pushed.frame.id }] },
		);
		const { root } = checkScreen(pushed.project, pushed.screen);
		const pulled = pullScreen(
			pushed.project,
			pushed.screen,
			root as NonNullable<typeof root>,
			pushed.baseline,
			screens[0]?.frame as SyncedNode,
		);
		const direction: DirectionFile = {
			...pushed.screen,
			name: "login / starry",
			of: "login",
			direction: "starry",
			source: (pulled.source as string).replace("Welcome back", "Stars!"),
		};
		const result = await pushDirections(pushed.project, pulled.baseline, [
			direction,
		]);
		const copy = await node(result.screens[0]?.frames[0]?.frameId as string);
		const copied = copy.children.find((layer) => layer.type === "STAR");
		expect(copied).toMatchObject({ name: "Star", width: 40, height: 38 });
		expect(copied?.id).not.toBe(star.id);
		expect(star.parent.id).toBe(pushed.frame.id);
	});
});
