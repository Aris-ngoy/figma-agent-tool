import { describe, expect, test } from "bun:test";
import {
	assignKeys,
	type Baseline,
	baselineAfterPush,
	checkScreen,
	hasUnpulledChanges,
	loadProject,
	type ScreenFile,
	screenPush,
} from "@figma-agent-tool/design-project";
import {
	logoPng,
	writeFixtureProject,
} from "@figma-agent-tool/design-project/fixtures";
import type { CommandName, SyncedNode } from "@figma-agent-tool/protocol";
import { document, handshake } from "@figma-agent-tool/protocol/fixtures";
import { createCommandHandler } from "../src/handler";
import { installMockFigma } from "./mock-figma";

const handler = () =>
	createCommandHandler({ pluginVersion: handshake.pluginVersion });

async function send<T = unknown>(
	command: CommandName,
	params: unknown,
	timeoutMs?: number,
): Promise<T> {
	const response = await handler().handle({
		type: "request",
		id: "req-1",
		command,
		params,
		...(timeoutMs !== undefined && { timeoutMs }),
	});
	return (response.ok ? response.result : { error: response.error }) as T;
}

/** The fixture Design Project's login Screen, keyed and ready to push. */
async function loginScreen(
	edit: (source: string) => string = (source) => source,
) {
	const project = await loadProject(await writeFixtureProject());
	const original = project.screens[0] as ScreenFile;
	const screen = {
		...original,
		source: edit(assignKeys(original.source).source),
	};
	const { root } = checkScreen(project, screen);
	if (!root) throw new Error("fixture Screen doesn't check");
	return { project, screen, root };
}

type PushResult = {
	page: { id: string; name: string };
	images: Record<string, string>;
	screens: { screen: string; frame: SyncedNode }[];
};

async function push(
	login: Awaited<ReturnType<typeof loginScreen>>,
	baseline?: Baseline,
	page = { name: "Screens" },
) {
	const { tree, images, imageShas } = await screenPush(
		login.project,
		login.screen,
		login.root,
		baseline,
	);
	const result = await send<PushResult>("push_screens", {
		page,
		screens: [{ screen: "login", frameId: baseline?.frameId, tree }],
		images,
	});
	const frame = result.screens[0]?.frame as SyncedNode;
	const imageRecords = Object.fromEntries(
		Object.entries(imageShas).map(([src, sha256]) => [
			src,
			{
				imageHash:
					baseline?.images[src]?.imageHash ??
					(Object.values(result.images)[0] as string),
				sha256,
			},
		]),
	);
	return {
		result,
		frame,
		baseline: baselineAfterPush(
			login.project,
			login.screen.source,
			frame,
			imageRecords,
		),
	};
}

function child(frame: SyncedNode, index: number): SyncedNode {
	return frame.children?.[index] as SyncedNode;
}

describe("push_screens", () => {
	test("creates the Screen's frame on the Screens Page with auto layout, named layers and editable text", async () => {
		const figma = installMockFigma(document);
		const { result, frame } = await push(await loginScreen());
		expect(result.page).toEqual({ id: "0:1", name: "Screens" });
		expect(frame).toMatchObject({
			key: "e1",
			type: "FRAME",
			name: "login",
			width: 393,
			height: 852,
			fills: [{ type: "SOLID", color: "#ffffff" }],
			layout: {
				mode: "VERTICAL",
				itemSpacing: 16,
				counterAxisAlignItems: "CENTER",
			},
		});
		// To the right of the page's other frames.
		expect(frame.x).toBeGreaterThan(886);
		const node = (await figma.getNodeByIdAsync(frame.id)) as unknown as {
			parent: { id: string };
		};
		expect(node.parent.id).toBe("0:1");
		expect(child(frame, 0)).toMatchObject({
			type: "RECTANGLE",
			name: "Image",
			fills: [
				{
					type: "IMAGE",
					imageHash: result.images["assets/logo.png"],
					scaleMode: "FILL",
				},
			],
		});
		expect(child(frame, 1)).toMatchObject({
			key: "e3",
			type: "TEXT",
			name: "Welcome back",
			sizing: { horizontal: "HUG", vertical: "HUG" },
			text: {
				characters: "Welcome back",
				fontName: { family: "Inter", style: "Bold" },
				fontSize: 28,
				textAlignHorizontal: "CENTER",
			},
		});
		expect(child(frame, 3)).toMatchObject({
			name: "Button",
			sizing: { horizontal: "FILL", vertical: "HUG" },
			children: [
				expect.objectContaining({
					text: expect.objectContaining({ characters: "Sign in" }),
				}),
			],
		});
		expect(figma.undoCommits).toBe(1);
	});

	test("reads back as exactly the Screen it was pushed from", async () => {
		installMockFigma(document);
		const login = await loginScreen();
		const { baseline } = await push(login);
		const { screens } = (await send("read_screens", {
			screens: [{ screen: "login", frameId: baseline.frameId }],
		})) as { screens: { frame: SyncedNode }[] };
		const frame = screens[0]?.frame as SyncedNode;
		expect(
			hasUnpulledChanges(login.project, login.screen, baseline, frame),
		).toBe(false);
	});

	test("creates the Screens Page when the file has none", async () => {
		installMockFigma(document);
		const { result } = await push(await loginScreen(), undefined, {
			name: "Agent screens",
		});
		expect(result.page.name).toBe("Agent screens");
		expect(["0:1", "0:2", "0:3"]).not.toContain(result.page.id);
	});

	test("pushing again updates layers in place and keeps every node ID", async () => {
		const figma = installMockFigma(document);
		const first = await push(await loginScreen());
		const edited = await loginScreen((source) =>
			source
				.replace("Welcome back", "Hello again")
				.replace(/\n {2}<div data-key="e7"[^\n]*/, ""),
		);
		const second = await push(edited, first.baseline);
		const { e7, ...kept } = first.baseline.nodes;
		expect(second.baseline.nodes).toEqual(kept);
		expect(child(second.frame, 1).text?.characters).toBe("Hello again");
		expect(await figma.getNodeByIdAsync(e7 as string)).toBeNull();
		expect(figma.undoCommits).toBe(2);
	});

	test("leaves layers the designers added", async () => {
		const figma = installMockFigma(document);
		const login = await loginScreen();
		const first = await push(login);
		const frame = (await figma.getNodeByIdAsync(first.frame.id)) as unknown as {
			appendChild: (node: unknown) => void;
		};
		const sticker = figma.createRectangle();
		frame.appendChild(sticker);
		const second = await push(login, first.baseline);
		expect(second.frame.children?.map((layer) => layer.id)).toContain(
			sticker.id,
		);
	});

	test("changes nothing once the server has stopped waiting", async () => {
		const figma = installMockFigma(document, { fontLoadDelayMs: 5 });
		const login = await loginScreen();
		const { tree, images } = await screenPush(
			login.project,
			login.screen,
			login.root,
			undefined,
		);
		const before = (figma.currentPage as { children: unknown[] }).children
			.length;
		const response = await send(
			"push_screens",
			{
				page: { name: "Screens" },
				screens: [{ screen: "login", tree }],
				images,
			},
			1,
		);
		expect(response).toMatchObject({ error: { code: "timed_out" } });
		expect((figma.currentPage as { children: unknown[] }).children.length).toBe(
			before,
		);
	});

	test("refuses a font the file doesn't have, changing nothing", async () => {
		const figma = installMockFigma(document);
		const login = await loginScreen((source) =>
			source.replace("font-weight:600", "font-weight:900"),
		);
		const { tree, images } = await screenPush(
			login.project,
			login.screen,
			login.root,
			undefined,
		);
		const before = (figma.currentPage as { children: unknown[] }).children
			.length;
		const response = await send("push_screens", {
			page: { name: "Screens" },
			screens: [{ screen: "login", tree }],
			images,
		});
		expect(response).toMatchObject({
			error: {
				code: "font_not_found",
				message: expect.stringContaining("Inter Black"),
			},
		});
		expect((figma.currentPage as { children: unknown[] }).children.length).toBe(
			before,
		);
	});
});

describe("read_screens", () => {
	test("keeps a frame linked when it's renamed or moved to another page", async () => {
		const figma = installMockFigma(document);
		const { frame } = await push(await loginScreen());
		const node = (await figma.getNodeByIdAsync(frame.id)) as unknown as {
			name: string;
		};
		node.name = "Login (final)";
		const onboarding = (await figma.getNodeByIdAsync("0:3")) as unknown as {
			loadAsync: () => Promise<void>;
			appendChild: (node: unknown) => void;
		};
		await onboarding.loadAsync();
		onboarding.appendChild(node);
		const { screens } = (await send("read_screens", {
			screens: [{ screen: "login", frameId: frame.id }],
		})) as { screens: { frame: SyncedNode }[] };
		expect(screens[0]?.frame).toMatchObject({
			id: frame.id,
			name: "Login (final)",
			key: "e1",
		});
	});

	test("finds a frame that was cut and pasted, with a new ID, by its Screen", async () => {
		installMockFigma(document);
		const { frame } = await push(await loginScreen());
		const { screens } = (await send("read_screens", {
			screens: [{ screen: "login", frameId: "77:77" }],
		})) as { screens: { frame: SyncedNode | null }[] };
		expect(screens[0]?.frame?.id).toBe(frame.id);
	});

	test("reports a deleted frame as null", async () => {
		installMockFigma(document);
		const { screens } = await send<{ screens: unknown[] }>("read_screens", {
			screens: [{ screen: "gone", frameId: "77:77" }],
		});
		expect(screens).toEqual([{ screen: "gone", frame: null }]);
	});
});

describe("link_file", () => {
	test("stores the Link ID in the file, which the handshake then reports", async () => {
		installMockFigma(document);
		expect(handler().handshake().linkId).toBeNull();
		expect(await send("link_file", { linkId: "link-1" })).toEqual({
			file: { key: document.fileKey, name: document.name },
			linkId: "link-1",
		});
		expect(handler().handshake().linkId).toBe("link-1");
	});
});

describe("get_image", () => {
	test("returns the bytes of an image in the file", async () => {
		installMockFigma(document);
		const { result } = await push(await loginScreen());
		const hash = result.images["assets/logo.png"];
		expect(await send("get_image", { imageHash: hash })).toEqual({
			bytes: logoPng,
		});
	});

	test("reports an unknown image", async () => {
		installMockFigma(document);
		expect(await send("get_image", { imageHash: "nope" })).toMatchObject({
			error: { code: "image_not_found" },
		});
	});
});
