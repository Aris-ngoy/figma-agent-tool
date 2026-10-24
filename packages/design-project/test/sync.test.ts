import { describe, expect, test } from "bun:test";
import type { SyncedNode } from "@figma-agent-tool/protocol";
import { applyScreenTree, layerByKey, loginScreen } from "../fixtures";
import {
	assignKeys,
	type Baseline,
	baselineAfterPush,
	checkScreen,
	type DesignProject,
	hasUnpulledChanges,
	pullScreen,
	type ScreenFile,
	screenPush,
} from "../src";
import { fixtureProject } from "./fixture-project";

/** Pushes a Screen into a fake frame, as Push does through the Plugin. */
async function push(
	project: DesignProject,
	screen: ScreenFile,
	previous?: { frame: SyncedNode; baseline: Baseline },
) {
	const { source } = assignKeys(screen.source);
	const keyed = { ...screen, source };
	const { root } = checkScreen(project, keyed);
	if (!root) throw new Error("Screen doesn't check");
	const { tree, images, imageShas } = await screenPush(
		project,
		keyed,
		root,
		previous?.baseline,
	);
	let id = previous ? 100 : 0;
	const frame = applyScreenTree(tree, previous?.frame, {
		nextId: () => `9:${++id}`,
		imageHash: (name) => `hash-of-${name}`,
	});
	const imageRecords = Object.fromEntries(
		Object.entries(imageShas).map(([src, sha256]) => [
			src,
			{
				imageHash:
					previous?.baseline.images[src]?.imageHash ??
					`hash-of-${Object.keys(images)[0]}`,
				sha256,
			},
		]),
	);
	const baseline = baselineAfterPush(project, source, frame, imageRecords);
	return { tree, images, frame, baseline, screen: keyed };
}

async function pushedLogin() {
	const project = await fixtureProject();
	const screen = project.screens[0] as ScreenFile;
	return { project, ...(await push(project, screen)) };
}

function pull(
	project: DesignProject,
	screen: ScreenFile,
	baseline: Baseline,
	frame: SyncedNode,
) {
	const { root } = checkScreen(project, screen);
	if (!root) throw new Error("Screen doesn't check");
	return pullScreen(project, screen, root, baseline, frame);
}

describe("Push", () => {
	test("writes a key into every element and leaves the rest of the file as it is", async () => {
		const { screen } = await pushedLogin();
		expect(screen.source.replace(/ data-key="e\d+"/g, "")).toBe(loginScreen);
		expect(screen.source.match(/data-key/g)).toHaveLength(7);
	});

	test("turns a Screen into an auto-layout frame at the Screen Size, tokens resolved", async () => {
		const { tree, images } = await pushedLogin();
		const [logo, title, subtitle, button, divider] = tree.children ?? [];
		expect(tree).toMatchObject({
			key: "e1",
			type: "FRAME",
			name: "login",
			width: 393,
			height: 852,
			fills: [{ type: "SOLID", color: "#ffffff" }],
			layout: {
				mode: "VERTICAL",
				itemSpacing: 16,
				padding: { top: 64, right: 24, bottom: 34, left: 24 },
				primaryAxisAlignItems: "MIN",
				counterAxisAlignItems: "CENTER",
				wrap: false,
			},
		});
		expect(logo).toMatchObject({
			type: "RECTANGLE",
			name: "Image",
			width: 64,
			height: 64,
			cornerRadius: 8,
			sizing: { horizontal: "FIXED", vertical: "FIXED" },
			fills: [{ type: "IMAGE", image: "assets/logo.png", scaleMode: "FILL" }],
		});
		expect(Object.keys(images)).toEqual(["assets/logo.png"]);
		expect(title).toMatchObject({
			type: "TEXT",
			fills: [{ type: "SOLID", color: "#111111" }],
			sizing: { horizontal: "HUG", vertical: "HUG" },
			text: {
				characters: "Welcome back",
				fontName: { family: "Inter", style: "Bold" },
				fontSize: 28,
				textAlignHorizontal: "CENTER",
			},
		});
		expect(title?.name).toBeUndefined();
		expect(subtitle).toMatchObject({
			width: 280,
			sizing: { horizontal: "FIXED", vertical: "HUG" },
			text: { characters: "Sign in to pick up where you left off." },
		});
		expect(button).toMatchObject({
			type: "FRAME",
			name: "Button",
			cornerRadius: 12,
			sizing: { horizontal: "FILL", vertical: "HUG" },
			fills: [{ type: "SOLID", color: "#3366ff" }],
			layout: { mode: "HORIZONTAL", primaryAxisAlignItems: "CENTER" },
			children: [
				expect.objectContaining({
					text: expect.objectContaining({
						fontName: { family: "Inter", style: "Semi Bold" },
					}),
					fills: [{ type: "SOLID", color: "#ffffff" }],
				}),
			],
		});
		expect(divider).toMatchObject({
			type: "RECTANGLE",
			name: "Rectangle",
			height: 1,
			sizing: { horizontal: "FILL", vertical: "FIXED" },
		});
	});

	test("sizes a Screen that overrides the Screen Size", async () => {
		const project = await fixtureProject({
			"screens/login.html": null,
			"screens/welcome.html":
				'<body style="display:flex; width:1024px; height:768px"></body>\n',
		});
		const { tree } = await push(project, project.screens[0] as ScreenFile);
		expect(tree).toMatchObject({ width: 1024, height: 768 });
	});

	test("pushing again updates every layer in place, keeping its node ID", async () => {
		const first = await pushedLogin();
		const edited = first.screen.source.replace("Welcome back", "Hello again");
		const second = await push(
			first.project,
			{ ...first.screen, source: edited },
			{ frame: first.frame, baseline: first.baseline },
		);
		expect(second.baseline.nodes).toEqual(first.baseline.nodes);
		expect(second.tree.children?.[1]).toMatchObject({
			id: first.baseline.nodes.e3,
		});
		// The image didn't change, so it isn't sent again.
		expect(second.images).toEqual({});
	});
});

describe("Pull", () => {
	test("Push then Pull round-trips a Screen byte for byte", async () => {
		const { project, screen, baseline, frame } = await pushedLogin();
		expect(hasUnpulledChanges(project, screen, baseline, frame)).toBe(false);
		const result = pull(project, screen, baseline, frame);
		expect(result.changed).toBe(false);
		expect(result.source).toBeUndefined();
		expect(result.unsupported).toEqual([]);
	});

	test("a Screen overriding the Screen Size round-trips too", async () => {
		const project = await fixtureProject({
			"screens/welcome.html":
				'<body style="display:flex; justify-content:space-between; width:1024px; height:768px">\n  <p>Welcome</p>\n  <div style="height:200px; flex:1; background:#eeeeee"></div>\n</body>\n',
		});
		const screen = project.screens.find(
			(s) => s.name === "welcome",
		) as ScreenFile;
		const pushed = await push(project, screen);
		expect(
			hasUnpulledChanges(project, pushed.screen, pushed.baseline, pushed.frame),
		).toBe(false);
	});

	test("merges a designer's edit into the file, keeping the Design Project's tokens", async () => {
		const { project, screen, baseline, frame } = await pushedLogin();
		const title = layerByKey(frame, "e3");
		(title.text as { characters: string }).characters = "Good to see you";
		title.name = "Good to see you";
		(layerByKey(frame, "e5").layout as { itemSpacing: number }).itemSpacing = 4;

		expect(hasUnpulledChanges(project, screen, baseline, frame)).toBe(true);
		const result = pull(project, screen, baseline, frame);
		expect(result.changed).toBe(true);
		expect(result.conflicts).toBe(0);
		expect(result.source).toBe(
			[
				'<body data-key="e1" style="display:flex; flex-direction:column; align-items:center; gap:var(--spacing-md); padding:64px var(--spacing-lg) 34px; background-color:var(--colors-surface)">',
				'  <img data-key="e2" src="../assets/logo.png" style="width:64px; height:64px; border-radius:var(--rounded-md)">',
				'  <h1 data-key="e3" style="color:var(--colors-heading); font-size:var(--typography-title-font-size); font-weight:700; text-align:center">Good to see you</h1>',
				'  <p data-key="e4" style="width:280px; color:#666666; text-align:center">Sign in to pick up where you left off.</p>',
				'  <div data-key="e5" data-name="Button" style="display:flex; justify-content:center; gap:4px; padding:12px 16px; align-self:stretch; background-color:var(--colors-primary); border-radius:12px">',
				'    <p data-key="e6" style="color:#fff; font-weight:600">Sign in</p>',
				"  </div>",
				'  <div data-key="e7" style="height:1px; align-self:stretch; background-color:#dddddd"></div>',
				"</body>",
				"",
			].join("\n"),
		);
		// The new Baseline is Figma's version: nothing left to pull.
		const pulled = { ...screen, source: result.source as string };
		expect(hasUnpulledChanges(project, pulled, result.baseline, frame)).toBe(
			false,
		);
		expect(pull(project, pulled, result.baseline, frame).changed).toBe(false);
	});

	test("merges edits from both sides to different elements", async () => {
		const { project, screen, baseline, frame } = await pushedLogin();
		layerByKey(frame, "e7").fills = [{ type: "SOLID", color: "#000000" }];
		const local = {
			...screen,
			source: screen.source.replace("Sign in</p>", "Log in</p>"),
		};
		const result = pull(project, local, baseline, frame);
		expect(result.conflicts).toBe(0);
		expect(result.source).toContain(">Log in</p>");
		expect(result.source).toContain("background-color:#000000");
	});

	test("marks a Sync Conflict where both sides changed the same element", async () => {
		const { project, screen, baseline, frame } = await pushedLogin();
		const label = layerByKey(frame, "e6");
		(label.text as { characters: string }).characters = "Continue";
		label.name = "Continue";
		const local = {
			...screen,
			source: screen.source.replace("Sign in</p>", "Log in</p>"),
		};
		const result = pull(project, local, baseline, frame);
		expect(result.conflicts).toBe(1);
		expect(result.source).toContain(
			[
				"<<<<<<< Design Project",
				'    <p data-key="e6" style="color:#fff; font-weight:600">Log in</p>',
				"=======",
				'    <p data-key="e6" style="color:#ffffff; font-weight:600">Continue</p>',
				">>>>>>> Figma",
			].join("\n"),
		);
		const marked = checkScreen(project, {
			...screen,
			source: result.source as string,
		});
		expect(marked.errors.map((error) => error.rule)).toEqual(["sync-conflict"]);
	});

	test("marks a frame whose own styles both sides changed, keeping its children", async () => {
		const { project, screen, baseline, frame } = await pushedLogin();
		const button = layerByKey(frame, "e5");
		button.cornerRadius = 4;
		const local = {
			...screen,
			source: screen.source.replace("border-radius:12px", "border-radius:20px"),
		};
		const result = pull(project, local, baseline, frame);
		expect(result.conflicts).toBe(1);
		expect(result.source).toContain(
			[
				"<<<<<<< Design Project",
				'  <div data-key="e5" data-name="Button" style="display:flex; justify-content:center; padding:12px 16px; align-self:stretch; background-color:var(--colors-primary); border-radius:20px">',
				"=======",
				'  <div data-key="e5" data-name="Button" style="display:flex; justify-content:center; padding:12px 16px; align-self:stretch; background-color:#3366ff; border-radius:4px">',
				">>>>>>> Figma",
				'    <p data-key="e6" style="color:#fff; font-weight:600">Sign in</p>',
				"  </div>",
			].join("\n"),
		);
	});

	test("adds layers a designer created, with new keys mapped to their nodes", async () => {
		const { project, screen, baseline, frame } = await pushedLogin();
		const added = structuredClone(layerByKey(frame, "e4"));
		Object.assign(added, { id: "9:50", key: null, name: "Forgot password?" });
		(added.text as { characters: string }).characters = "Forgot password?";
		frame.children?.splice(3, 0, added);
		const result = pull(project, screen, baseline, frame);
		expect(result.source).toContain(
			'  <p data-key="e8" style="width:280px; color:#666666; text-align:center">Forgot password?</p>\n  <div data-key="e5"',
		);
		expect(result.baseline.nodes.e8).toBe("9:50");
	});

	test("drops an element a designer deleted, unless the Design Project changed it", async () => {
		const { project, screen, baseline, frame } = await pushedLogin();
		frame.children = frame.children?.filter(
			(child) => child.key !== "e7" && child.key !== "e4",
		);
		const local = {
			...screen,
			source: screen.source.replace("#666666", "#555555"),
		};
		const result = pull(project, local, baseline, frame);
		expect(result.source).not.toContain('data-key="e7"');
		expect(result.conflicts).toBe(1);
		expect(result.source).toContain(
			[
				"<<<<<<< Design Project",
				'  <p data-key="e4" style="width:280px; color:#555555; text-align:center">Sign in to pick up where you left off.</p>',
				"=======",
				">>>>>>> Figma",
			].join("\n"),
		);
	});

	test("keeps a layer outside the Screen Subset in Figma and lists it", async () => {
		const { project, screen, baseline, frame } = await pushedLogin();
		const star = {
			...structuredClone(layerByKey(frame, "e7")),
			id: "9:60",
			key: null,
			type: "STAR",
			name: "Star",
		};
		frame.children?.push(star);
		const shadowed = layerByKey(frame, "e5");
		shadowed.effects = 1;
		const result = pull(project, screen, baseline, frame);
		expect(result.unsupported).toEqual([
			{ nodeId: shadowed.id, name: "Button", reason: "has effects" },
			{ nodeId: "9:60", name: "Star", reason: "is a STAR" },
		]);
		expect(result.changed).toBe(false);
		expect(hasUnpulledChanges(project, screen, baseline, frame)).toBe(false);
	});

	test("follows a frame that was cut and pasted, which gives every layer a new ID", async () => {
		const { project, screen, baseline, frame } = await pushedLogin();
		const renumber = (node: SyncedNode) => {
			node.id = `7:${node.id}`;
			node.children?.forEach(renumber);
		};
		renumber(frame);
		frame.name = "Login (final)";
		const result = pull(project, screen, baseline, frame);
		expect(result.conflicts).toBe(0);
		expect(result.source).toContain(
			'<body data-key="e1" data-name="Login (final)"',
		);
		expect(result.baseline.frameId).toBe(`7:${baseline.frameId}`);
		expect(result.baseline.nodes.e3).toBe(`7:${baseline.nodes.e3}`);
	});
});
