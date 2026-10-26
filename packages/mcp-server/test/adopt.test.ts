import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	designerFile,
	writeFixtureProject,
} from "@figma-agent-tool/design-project/fixtures";
import type { SyncedNode } from "@figma-agent-tool/protocol";
import { startHarness } from "./harness";

type Result = Awaited<
	ReturnType<Awaited<ReturnType<typeof startHarness>>["callTool"]>
>;

function text(result: Result): string {
	const [content] = result.content as { type: string; text: string }[];
	return content?.text ?? "";
}

function structured<T = Record<string, unknown>>(result: Result): T {
	return result.structuredContent as T;
}

/** A harness with no Design Project yet, its plugin in the designers' file. */
async function withDesignerFile(designDir?: string) {
	const harness = await startHarness({ designDir });
	const plugin = await harness.connectFakePlugin();
	plugin.screens.addDesignerFile(designerFile);
	const file = (name: string) =>
		readFile(join(harness.designDir, name), "utf8");
	return { harness, plugin, file };
}

/** Adopted Home and Task Details, confirmed. */
async function adopted() {
	const setup = await withDesignerFile();
	const result = await setup.harness.callTool("adopt_file", {
		frames: ["Home", "76:1"],
		confirm: true,
	});
	expect(result.isError).toBeFalsy();
	return { ...setup, result };
}

/** A frame without plugin data keys, which Push adds. */
function withoutKeys(node: SyncedNode): SyncedNode {
	const { key: _, children, ...rest } = node;
	return {
		...rest,
		key: null,
		...(children && { children: children.map(withoutKeys) }),
	};
}

describe("adopt_file", () => {
	test("without frames, lists the Bridged File's top-level frames by page to choose from", async () => {
		const { harness } = await withDesignerFile();
		const result = await harness.callTool("adopt_file");
		expect(result.isError).toBeFalsy();
		expect(structured(result)).toMatchObject({
			status: "choose_frames",
			file: { name: "Sample App" },
		});
		const { frames } = structured<{
			frames: {
				id: string;
				name: string;
				page: string;
				width: number;
				height: number;
			}[];
		}>(result);
		expect(frames).toContainEqual({
			id: "75:1",
			name: "Home",
			page: "Designs",
			width: 393,
			height: 852,
		});
		expect(frames.map((frame) => frame.name)).toContain("Task Details");
		expect(existsSync(harness.designDir)).toBe(false);
	});

	test("asks to confirm the file and frames before writing anything", async () => {
		const { harness, plugin } = await withDesignerFile();
		const result = await harness.callTool("adopt_file", {
			frames: ["Home", "Task Details"],
		});
		expect(result.isError).toBeFalsy();
		expect(structured(result)).toEqual({
			status: "confirm_adopt",
			file: { key: "FILEKEY123", name: "Sample App" },
			screens: [
				{ screen: "home", frameId: "75:1", frame: "Home", page: "Designs" },
				{
					screen: "task-details",
					frameId: "76:1",
					frame: "Task Details",
					page: "Designs",
				},
			],
			message: expect.stringContaining("Ask the user to confirm"),
		});
		expect(existsSync(harness.designDir)).toBe(false);
		expect(plugin.screens.linkId).toBeNull();
	});

	test("refuses a frame that can't be a Screen, or one the file doesn't have, saying why", async () => {
		const { harness } = await withDesignerFile();
		const sketch = await harness.callTool("adopt_file", {
			frames: ["Home", "Sketch"],
			confirm: true,
		});
		expect(sketch.isError).toBe(true);
		expect(text(sketch)).toContain(
			"“Sketch” (77:1) can't be a Screen: it doesn't use auto layout",
		);
		const missing = await harness.callTool("adopt_file", {
			frames: ["Settings"],
		});
		expect(missing.isError).toBe(true);
		expect(text(missing)).toContain("No top-level frame “Settings”");
		expect(existsSync(harness.designDir)).toBe(false);
	});

	test("refuses a folder that already has a Design Project", async () => {
		const designDir = await writeFixtureProject();
		const { harness } = await withDesignerFile(designDir);
		const result = await harness.callTool("adopt_file", {
			frames: ["Home"],
			confirm: true,
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("already has a Design Project");
	});
});

describe("adopt_file, confirmed", () => {
	test("writes DESIGN.md and modes.yaml from the file's variables and text styles", async () => {
		const { file, result } = await adopted();
		expect(structured(result)).toMatchObject({
			status: "adopted",
			linkedFile: { key: "FILEKEY123", name: "Sample App" },
			designSystem: { notAdopted: [] },
		});
		const designMd = await file("DESIGN.md");
		expect(designMd).toContain('primary: "#3366ff"');
		expect(designMd).toContain('heading: "{colors.primary}"');
		expect(designMd).toContain("spacing:\n  md: 16px");
		expect(designMd).toContain("rounded:\n  md: 8px");
		expect(designMd).toContain(
			"heading-large:\n    fontFamily: Inter\n    fontSize: 28px\n    fontWeight: 700",
		);
		expect(designMd).toContain("lineHeight: 1.5");
		expect(await file("modes.yaml")).toBe(
			'default: Light\nmodes:\n  Dark:\n    colors:\n      primary: "#6699ff"\n      surface: "#111111"\n      text: "#eeeeee"\n',
		);
	});

	test("writes the frames as Screens bound to the tokens, with Linked Components, Prototype Links and Figma-owned Elements", async () => {
		const { harness, file } = await adopted();
		const home = await file("screens/home.html");
		expect(home).toContain(
			'<body data-key="e1" data-name="Home" style="display:flex; flex-direction:column; gap:var(--spacing-md); padding:24px var(--spacing-md); background-color:var(--colors-surface)">',
		);
		expect(home).toContain('src="../assets/designer-logo.png"');
		expect(home).toContain(
			'<p data-key="e3" style="color:var(--colors-heading); font-size:var(--typography-heading-large-font-size); font-weight:700">Good morning</p>',
		);
		expect(home).toContain(
			'<figma-owned data-key="e5" data-name="Card" style="height:120px; align-self:stretch"></figma-owned>',
		);
		expect(home).toContain(
			'<app-button data-key="e7" data-name="Button" label="See all" href="task-details.html"></app-button>',
		);
		expect(home).toContain(
			'<app-avatar data-key="e8" data-name="Avatar" initials="JD"></app-avatar>',
		);
		const details = await file("screens/task-details.html");
		expect(details).toContain(
			'href="home.html" data-transition="dissolve 200ms ease-in-out"',
		);
		expect(details).toContain(
			'<app-button data-key="e3" data-name="Button" kind="secondary">',
		);
		// The file's own component by node ID, a library's by key.
		expect(JSON.parse(await file("components/app-button.json"))).toEqual({
			id: "73:1",
		});
		expect(JSON.parse(await file("components/app-avatar.json"))).toEqual({
			key: "avatar-library-key",
		});
		expect(
			existsSync(join(harness.designDir, "assets/designer-logo.png")),
		).toBe(true);
		const check = await harness.callTool("check_design_project");
		expect(structured(check)).toEqual({ ok: true, errors: [], warnings: [] });
	});

	test("makes the file the Linked File, its frames' page the Screens Page", async () => {
		const { harness, plugin, result } = await adopted();
		expect(structured(result)).toMatchObject({
			screensPage: { id: "70:9", name: "Designs" },
			screens: [
				{
					screen: "home",
					frameId: "75:1",
					figmaOwned: [{ key: "e5", nodeId: "75:5", reason: "has effects" }],
				},
				{ screen: "task-details", frameId: "76:1", figmaOwned: [] },
			],
		});
		expect(plugin.screens.linkId).not.toBeNull();
		const status = await harness.callTool("get_status");
		expect(structured(status)).toMatchObject({
			designProject: {
				screens: ["home", "task-details"],
				linkedFile: { name: "Sample App" },
				bridgedFileIsLinked: true,
				unpulledChanges: [],
			},
		});
	});

	test("a Push straight after changes nothing in Figma but the keys", async () => {
		const { harness, plugin } = await adopted();
		const before = [...plugin.screens.frames.values()].map(({ frame }) =>
			structuredClone(frame),
		);
		const designSystem = plugin.screens.get_design_system();
		const pushed = await harness.callTool("push");
		expect(pushed.isError).toBeFalsy();
		expect(structured(pushed)).toMatchObject({
			status: "pushed",
			screens: [
				{ screen: "home", frameId: "75:1", created: false },
				{ screen: "task-details", frameId: "76:1", created: false },
			],
		});
		const after = new Map(
			[...plugin.screens.frames.values()].map(({ frame }) => [frame.id, frame]),
		);
		for (const frame of before)
			expect(withoutKeys(after.get(frame.id) as SyncedNode)).toEqual(frame);
		expect(plugin.screens.get_design_system()).toEqual(designSystem);
		// And a Pull finds nothing to merge.
		const pulled = await harness.callTool("pull");
		expect(structured(pulled)).toMatchObject({
			designSystem: { status: "unchanged" },
			screens: [
				{ screen: "home", status: "unchanged" },
				{ screen: "task-details", status: "unchanged" },
			],
		});
	});
});
