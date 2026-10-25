import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	avatarComponent,
	componentFiles,
	detachInstance,
	layerByKey,
	linkedScreens,
	loginScreen,
	logoPng,
	welcomeScreen,
	widerScreens,
	writeFixtureProject,
} from "@figma-agent-tool/design-project/fixtures";
import type {
	PrototypeGraph,
	Reaction,
	SyncedNode,
} from "@figma-agent-tool/protocol";
import { handshake } from "@figma-agent-tool/protocol/fixtures";
import { lint } from "@google/design.md/linter";
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

/** A harness on the fixture Design Project, with a plugin connected. */
async function withProject(
	overrides: Record<string, string | null> = {},
	pluginOptions: Parameters<
		Awaited<ReturnType<typeof startHarness>>["connectFakePlugin"]
	>[0] = {},
) {
	const designDir = await writeFixtureProject(overrides);
	const harness = await startHarness({ designDir });
	const plugin = await harness.connectFakePlugin(pluginOptions);
	const login = join(designDir, "screens/login.html");
	return {
		harness,
		plugin,
		designDir,
		login,
		read: () => readFile(login, "utf8"),
	};
}

/** Pushed once, link confirmed. */
async function pushed(
	overrides: Record<string, string | null> = {},
	pluginOptions: Parameters<typeof withProject>[1] = {},
) {
	const setup = await withProject(overrides, pluginOptions);
	const result = await setup.harness.callTool("push", { confirmLink: true });
	expect(result.isError).toBeFalsy();
	return { ...setup, frame: () => setup.plugin.screens.frame("login") };
}

const modesFile = `default: Light
modes:
  Dark:
    colors:
      surface: "#111111"
      text: "#eeeeee"
`;

function ids(frame: SyncedNode): string[] {
	return [frame.id, ...(frame.children ?? []).flatMap(ids)];
}

describe("init_design_project", () => {
	test("creates a Design Project with the default Screen Size, DESIGN.md, screens/ and assets/", async () => {
		const harness = await startHarness();
		const result = await harness.callTool("init_design_project");
		expect(result.isError).toBeFalsy();
		const config = JSON.parse(
			await readFile(join(harness.designDir, "project.json"), "utf8"),
		);
		expect(config).toEqual({
			screenSize: { width: 393, height: 852 },
			screensPage: "Screens",
			explorationsPage: "Explorations",
		});
		expect(
			await readFile(join(harness.designDir, "DESIGN.md"), "utf8"),
		).toStartWith("---\nversion: alpha");
		expect(existsSync(join(harness.designDir, "screens"))).toBe(true);
		const check = await harness.callTool("check_design_project");
		expect(structured(check)).toEqual({ ok: true, errors: [], warnings: [] });
	});

	test("refuses a folder that already holds a Design Project", async () => {
		const harness = await startHarness({
			designDir: await writeFixtureProject(),
		});
		const result = await harness.callTool("init_design_project");
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("already holds a Design Project");
	});
});

describe("check_design_project", () => {
	test("reports out-of-subset elements with file, line, element and rule", async () => {
		const designDir = await writeFixtureProject({
			"screens/bad.html":
				'<body style="display:flex">\n  <section></section>\n</body>\n',
		});
		const harness = await startHarness({ designDir });
		const result = await harness.callTool("check_design_project");
		expect(structured(result)).toEqual({
			ok: false,
			errors: [
				{
					file: "screens/bad.html",
					line: 2,
					element: "body > section",
					rule: "unknown-element",
					message: expect.stringContaining("<section>"),
				},
			],
			warnings: [],
		});
	});

	test("explains where the Design Project is missing", async () => {
		const harness = await startHarness();
		const result = await harness.callTool("check_design_project");
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("Create one with init");
	});
});

describe("render_screen", () => {
	test("writes the Preview's rendering of a Screen into the artifacts folder", async () => {
		const designDir = await writeFixtureProject();
		const shots: { html: string; size: unknown }[] = [];
		const harness = await startHarness({
			designDir,
			screenshot: async (htmlPath, pngPath, size) => {
				shots.push({ html: await readFile(htmlPath, "utf8"), size });
				await writeFile(pngPath, Buffer.from(logoPng, "base64"));
			},
		});
		const result = await harness.callTool("render_screen", { screen: "login" });
		expect(result.isError).toBeFalsy();
		const { path } = structured<{ path: string }>(result);
		expect(path.startsWith(harness.artifactsDir)).toBe(true);
		expect((await readFile(path)).toString("base64")).toBe(logoPng);
		expect(shots[0]?.size).toEqual({ width: 393, height: 852 });
		expect(shots[0]?.html).toContain("Welcome back");
	});

	test("renders a Screen in a Mode", async () => {
		const designDir = await writeFixtureProject({ "modes.yaml": modesFile });
		const shots: string[] = [];
		const harness = await startHarness({
			designDir,
			screenshot: async (htmlPath, pngPath) => {
				shots.push(await readFile(htmlPath, "utf8"));
				await writeFile(pngPath, Buffer.from(logoPng, "base64"));
			},
		});
		const result = await harness.callTool("render_screen", {
			screen: "login",
			mode: "Dark",
		});
		expect(result.isError).toBeFalsy();
		expect(structured<{ path: string }>(result).path).toContain(
			"screen-login-Dark",
		);
		expect(shots[0]).toContain("--colors-surface: #111111;");
		const unknown = await harness.callTool("render_screen", {
			screen: "login",
			mode: "Sepia",
		});
		expect(unknown.isError).toBe(true);
		expect(text(unknown)).toContain("the Design System has Light, Dark");
	});

	test("names the Screens there are when one doesn't exist", async () => {
		const harness = await startHarness({
			designDir: await writeFixtureProject(),
		});
		const result = await harness.callTool("render_screen", { screen: "nope" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("has login");
	});
});

describe("open_preview", () => {
	test("starts the Preview once and returns its URL", async () => {
		const harness = await startHarness({
			designDir: await writeFixtureProject(),
		});
		const first = structured<{ url: string }>(
			await harness.callTool("open_preview"),
		);
		const second = structured<{ url: string }>(
			await harness.callTool("open_preview"),
		);
		expect(second.url).toBe(first.url);
		const html = await (await fetch(`${first.url}screens/login`)).text();
		expect(html).toContain("Welcome back");
		await harness.client.close();
	});
});

describe("push", () => {
	test("asks to confirm the Bridged File before the first Push links it", async () => {
		const { harness, plugin, read } = await withProject();
		const before = await read();
		const result = await harness.callTool("push");
		expect(result.isError).toBeFalsy();
		expect(structured(result)).toMatchObject({
			status: "confirm_link",
			file: handshake.file,
			message: expect.stringContaining("“Sample App”"),
		});
		expect(plugin.requests.map((request) => request.command)).not.toContain(
			"push_screens",
		);
		expect(await read()).toBe(before);
	});

	test("links the file, then creates the Screen's frame and records its Baseline", async () => {
		const { harness, plugin, designDir, read } = await withProject();
		const result = await harness.callTool("push", { confirmLink: true });
		expect(structured(result)).toMatchObject({
			status: "pushed",
			linkedFile: handshake.file,
			page: { id: "0:1", name: "Screens" },
			screens: [{ screen: "login", created: true }],
		});
		expect(plugin.requests.map((request) => request.command)).toEqual([
			"link_file",
			"push_screens",
		]);
		const link = JSON.parse(
			await readFile(join(designDir, "sync/link.json"), "utf8"),
		);
		expect(link).toEqual({
			linkId: plugin.screens.linkId,
			file: handshake.file,
			screensPage: { id: "0:1", name: "Screens" },
		});
		const source = await read();
		expect(source).toContain('<body data-key="e1" style=');
		const baseline = JSON.parse(
			await readFile(join(designDir, "sync/screens/login.json"), "utf8"),
		);
		expect(baseline.source).toBe(source);
		expect(Object.keys(baseline.nodes)).toHaveLength(7);
		expect(plugin.screens.frame("login")).toMatchObject({
			name: "login",
			width: 393,
			height: 852,
		});
	});

	test("refuses a different Bridged File, naming both files", async () => {
		const { harness } = await pushed();
		await harness.connectFakePlugin({
			handshake: {
				...handshake,
				file: { key: "OTHER", name: "Other File" },
				linkId: null,
			},
		});
		for (const tool of ["push", "pull"]) {
			const result = await harness.callTool(tool);
			expect(result.isError).toBe(true);
			expect(text(result)).toContain(
				"The Bridged File is “Other File”, but this Design Project is linked to “Sample App”",
			);
		}
	});

	test("refuses Screens that fail Check", async () => {
		const { harness, plugin } = await withProject({
			"screens/bad.html":
				'<body style="display:flex; box-shadow:none"></body>\n',
		});
		const result = await harness.callTool("push", { confirmLink: true });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain(
			"screens/bad.html:1 body [unknown-property]",
		);
		expect(plugin.requests).toEqual([]);
	});

	test("refuses while a frame has Unpulled Changes, naming it", async () => {
		const { harness, frame } = await pushed();
		const title = layerByKey(frame(), "e3");
		(title.text as { characters: string }).characters = "Hi";
		const result = await harness.callTool("push");
		expect(result.isError).toBe(true);
		expect(text(result)).toContain(
			"login (frame “login”) has Unpulled Changes",
		);
	});

	test("pushing twice keeps every node ID", async () => {
		const { harness, frame, login, read } = await pushed();
		const before = ids(frame());
		await writeFile(login, (await read()).replace("Welcome back", "Welcome"));
		const result = await harness.callTool("push");
		expect(structured(result)).toMatchObject({
			screens: [{ screen: "login", created: false }],
		});
		expect(ids(frame())).toEqual(before);
		expect(layerByKey(frame(), "e3").text?.characters).toBe("Welcome");
	});

	test("updates a frame that was cut and pasted, which gave every layer a new ID", async () => {
		const { harness, plugin, frame } = await pushed();
		const pasted = structuredClone(frame());
		const renumber = (node: SyncedNode) => {
			node.id = `7:${node.id}`;
			node.children?.forEach(renumber);
		};
		renumber(pasted);
		plugin.screens.frames.clear();
		plugin.screens.frames.set(pasted.id, {
			screen: "login",
			pageId: "0:1",
			frame: pasted,
		});

		const result = await harness.callTool("push");
		expect(structured(result)).toMatchObject({
			screens: [{ frameId: pasted.id, created: false }],
		});
		expect(ids(frame())).toEqual(ids(pasted));
	});

	test("pushes a Screen at its own Screen Size", async () => {
		const { plugin } = await pushed({
			"screens/tablet.html":
				'<body style="display:flex; width:1024px; height:768px"><p>Hi</p></body>\n',
		});
		expect(plugin.screens.frame("tablet")).toMatchObject({
			width: 1024,
			height: 768,
		});
	});
});

describe("pull", () => {
	test("Push then Pull round-trips a Screen byte for byte", async () => {
		const { harness, read } = await pushed();
		const before = await read();
		const result = await harness.callTool("pull");
		expect(structured(result)).toMatchObject({
			screens: [
				{ screen: "login", status: "unchanged", conflicts: 0, figmaOwned: [] },
			],
		});
		expect(await read()).toBe(before);
	});

	test("merges a designer's edit, after which Push works again and keeps every node ID", async () => {
		const { harness, frame, read } = await pushed();
		const title = layerByKey(frame(), "e3");
		(title.text as { characters: string }).characters = "Good to see you";
		title.name = "Good to see you";
		const before = ids(frame());

		const result = await harness.callTool("pull");
		expect(structured(result)).toMatchObject({
			screens: [{ status: "merged", conflicts: 0 }],
			conflicts: 0,
		});
		const source = await read();
		expect(source).toContain(">Good to see you</h1>");
		expect(source).toContain("var(--colors-primary)");

		const again = await harness.callTool("push");
		expect(again.isError).toBeFalsy();
		expect(ids(frame())).toEqual(before);
	});

	test("marks Sync Conflicts, and Push refuses until they're resolved", async () => {
		const { harness, frame, login, read } = await pushed();
		const label = layerByKey(frame(), "e6");
		(label.text as { characters: string }).characters = "Continue";
		await writeFile(login, (await read()).replace("Sign in</p>", "Log in</p>"));

		const result = await harness.callTool("pull");
		expect(structured(result)).toMatchObject({
			screens: [{ status: "merged", conflicts: 1 }],
			conflicts: 1,
		});
		const marked = await read();
		expect(marked).toContain("<<<<<<< Design Project");
		expect(marked).toContain(">>>>>>> Figma");

		const status = await harness.callTool("get_status");
		expect(structured(status)).toMatchObject({
			designProject: { syncConflicts: ["login"] },
		});

		const refused = await harness.callTool("push");
		expect(refused.isError).toBe(true);
		expect(text(refused)).toContain(
			"screens/login.html still has Sync Conflicts",
		);

		// The Agent keeps Figma's side.
		const resolved = marked.replace(
			/<<<<<<< Design Project\n.*\n=======\n(.*)\n>>>>>>> Figma\n/,
			"$1\n",
		);
		await writeFile(login, resolved);
		const pushedAgain = await harness.callTool("push");
		expect(pushedAgain.isError).toBeFalsy();
		expect(layerByKey(frame(), "e6").text?.characters).toBe("Continue");
	});

	test("saves an image a designer swapped in", async () => {
		const { harness, plugin, frame, designDir, read } = await pushed();
		plugin.screens.addImage("designer-image", logoPng);
		const logo = layerByKey(frame(), "e2");
		logo.fills = [
			{ type: "IMAGE", imageHash: "designer-image", scaleMode: "FIT" },
		];
		await harness.callTool("pull");
		const source = await read();
		expect(source).toContain(
			'src="../assets/designer-image.png" style="width:64px; height:64px; border-radius:var(--rounded-md); object-fit:contain"',
		);
		expect(
			(await readFile(join(designDir, "assets/designer-image.png"))).toString(
				"base64",
			),
		).toBe(logoPng);
	});

	test("refuses before the first Push", async () => {
		const { harness } = await withProject();
		const result = await harness.callTool("pull");
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("Push first");
	});
});

describe("relink_file", () => {
	test("links the Bridged File instead, so the next Push creates frames there", async () => {
		const { harness, designDir } = await pushed();
		const other = await harness.connectFakePlugin({
			handshake: {
				...handshake,
				file: { key: "OTHER", name: "Other File" },
				linkId: null,
			},
		});
		const relinked = await harness.callTool("relink_file", { confirm: true });
		expect(structured(relinked)).toMatchObject({
			linkedFile: { key: "OTHER", name: "Other File" },
			previous: handshake.file,
		});
		const result = await harness.callTool("push");
		expect(structured(result)).toMatchObject({
			status: "pushed",
			screens: [{ created: true }],
		});
		expect(other.screens.frame("login")).toBeDefined();
		const link = JSON.parse(
			await readFile(join(designDir, "sync/link.json"), "utf8"),
		);
		expect(link.file.name).toBe("Other File");
	});
});

describe("get_status", () => {
	test("reports the Design Project, its Linked File and Screens with Unpulled Changes", async () => {
		const { harness, frame, designDir } = await pushed();
		const clean = await harness.callTool("get_status");
		expect(structured(clean)).toMatchObject({
			bridge: { linkId: expect.any(String) },
			designProject: {
				dir: designDir,
				screens: ["login"],
				linkedFile: handshake.file,
				bridgedFileIsLinked: true,
				unpulledChanges: [],
				syncConflicts: [],
			},
		});
		layerByKey(frame(), "e7").height = 2;
		const edited = await harness.callTool("get_status");
		expect(structured(edited)).toMatchObject({
			designProject: { unpulledChanges: ["login"] },
		});
	});

	test("reports no Design Project when there is none", async () => {
		const harness = await startHarness();
		const result = await harness.callTool("get_status");
		expect(structured(result)).toMatchObject({ designProject: null });
	});
});

describe("Design System", () => {
	const designMdPath = (designDir: string) => join(designDir, "DESIGN.md");

	test("Push creates variables and text styles from DESIGN.md, keeping their IDs across Pushes", async () => {
		const { harness, plugin, designDir } = await pushed();
		const tokens = plugin.screens.designSystem;
		const text = tokens.variable("colors/text");
		expect(tokens.variable("colors/primary")).toMatchObject({
			type: "COLOR",
			value: { color: "#3366ff" },
		});
		expect(tokens.variable("colors/heading").value).toEqual({
			alias: text.id,
		});
		expect(tokens.variable("spacing/md")).toMatchObject({
			type: "FLOAT",
			value: 16,
		});
		expect(tokens.textStyle("title")).toMatchObject({
			fontName: { family: "Inter", style: "Bold" },
			fontSize: 28,
		});
		const before = [...tokens.variables.keys(), ...tokens.textStyles.keys()];

		const path = designMdPath(designDir);
		await writeFile(
			path,
			(await readFile(path, "utf8"))
				.replace("#3366FF", "#0055ff")
				.replace("fontSize: 28px", "fontSize: 30px"),
		);
		const again = await harness.callTool("push");
		expect(again.isError).toBeFalsy();
		expect([...tokens.variables.keys(), ...tokens.textStyles.keys()]).toEqual(
			before,
		);
		expect(tokens.variable("colors/primary").value).toEqual({
			color: "#0055ff",
		});
		expect(tokens.textStyle("title").fontSize).toBe(30);
	});

	test("Screen elements using token variables are pushed bound to them", async () => {
		const { plugin, frame } = await pushed();
		const tokens = plugin.screens.designSystem;
		const id = (name: string) => tokens.variable(name).id;
		const root = frame();
		expect(root.fills).toEqual([
			{ type: "SOLID", color: "#ffffff", variable: id("colors/surface") },
		]);
		expect(root.bindings).toEqual({
			itemSpacing: id("spacing/md"),
			paddingRight: id("spacing/lg"),
			paddingLeft: id("spacing/lg"),
		});
		expect(layerByKey(root, "e2").bindings).toEqual({
			cornerRadius: id("rounded/md"),
		});
		const title = layerByKey(root, "e3");
		expect(title.bindings).toEqual({
			textStyle: tokens.textStyle("title").id,
		});
		expect(title.fills).toEqual([
			{ type: "SOLID", color: "#111111", variable: id("colors/heading") },
		]);
		// Literal values stay literal.
		expect(layerByKey(root, "e4").fills).toEqual([
			{ type: "SOLID", color: "#666666" },
		]);
	});

	test("Pull writes a designer's token edits into DESIGN.md, which stays spec-pure, and leaves bound Screens alone", async () => {
		const { harness, plugin, designDir, read } = await pushed();
		const screen = await read();
		const tokens = plugin.screens.designSystem;
		tokens.variable("colors/primary").value = { color: "#ff0000" };
		tokens.textStyle("title").fontSize = 32;
		const path = designMdPath(designDir);
		const before = await readFile(path, "utf8");

		const status = await harness.callTool("get_status");
		expect(structured(status)).toMatchObject({
			designProject: {
				unpulledChanges: [],
				designSystem: {
					unpulledChanges: ["colors.primary", "typography.title.fontSize"],
					syncConflicts: false,
				},
			},
		});

		const result = await harness.callTool("pull");
		expect(structured(result)).toMatchObject({
			designSystem: {
				status: "merged",
				changed: ["colors.primary", "typography.title.fontSize"],
				conflicts: 0,
			},
			screens: [{ screen: "login", status: "unchanged" }],
			conflicts: 0,
		});
		const after = await readFile(path, "utf8");
		expect(after).toBe(
			before
				.replace('primary: "#3366FF"', 'primary: "#ff0000"')
				.replace("fontSize: 28px", "fontSize: 32px"),
		);
		expect(lint(after).summary.errors).toBe(0);
		expect(await read()).toBe(screen);

		const again = await harness.callTool("push");
		expect(again.isError).toBeFalsy();
		const check = await harness.callTool("pull");
		expect(structured(check)).toMatchObject({
			designSystem: { status: "unchanged" },
			screens: [{ status: "unchanged" }],
		});
	});

	test("Pull marks a token both sides changed, and Push refuses until it's resolved", async () => {
		const { harness, plugin, designDir } = await pushed();
		plugin.screens.designSystem.variable("spacing/md").value = 20;
		const path = designMdPath(designDir);
		await writeFile(
			path,
			(await readFile(path, "utf8")).replace("md: 16px", "md: 12px"),
		);

		const result = await harness.callTool("pull");
		expect(structured(result)).toMatchObject({
			designSystem: { status: "merged", conflicts: 1 },
			conflicts: 1,
		});
		const marked = await readFile(path, "utf8");
		expect(marked).toContain(
			"<<<<<<< Design Project\n  md: 12px\n=======\n  md: 20px\n>>>>>>> Figma\n",
		);
		const status = await harness.callTool("get_status");
		expect(structured(status)).toMatchObject({
			designProject: { designSystem: { syncConflicts: true } },
		});
		const refused = await harness.callTool("push");
		expect(refused.isError).toBe(true);
		expect(text(refused)).toContain("DESIGN.md still has Sync Conflicts");

		// The Agent keeps Figma's side.
		await writeFile(
			path,
			marked.replace(
				/<<<<<<< Design Project\n.*\n=======\n(.*)\n>>>>>>> Figma\n/,
				"$1\n",
			),
		);
		const pushedAgain = await harness.callTool("push");
		expect(pushedAgain.isError).toBeFalsy();
		expect(plugin.screens.designSystem.variable("spacing/md").value).toBe(20);
	});

	test("Unpulled Design System changes refuse Push, naming the tokens", async () => {
		const { harness, plugin } = await pushed();
		plugin.screens.designSystem.variable("rounded/md").value = 4;
		const result = await harness.callTool("push");
		expect(result.isError).toBe(true);
		expect(text(result)).toContain(
			"the Design System has Unpulled Changes: a designer edited rounded.md in Figma",
		);
	});

	test("check reports DESIGN.md spec errors and contrast warnings", async () => {
		const designDir = await writeFixtureProject({
			"DESIGN.md": `---
version: alpha
name: Sample App
colors:
  primary: "#3366FF"
  muted: "#eeeeee"
components:
  button:
    backgroundColor: "#ffffff"
    textColor: "{colors.muted}"
  link:
    textColor: "{colors.missing}"
---

# Sample App
`,
			"screens/login.html": null,
		});
		const harness = await startHarness({ designDir });
		const result = await harness.callTool("check_design_project");
		const { ok, errors, warnings } = structured<{
			ok: boolean;
			errors: { rule: string; line: number }[];
			warnings: { rule: string; line: number; element: string }[];
		}>(result);
		expect(ok).toBe(false);
		expect(errors).toEqual([
			expect.objectContaining({
				file: "DESIGN.md",
				rule: "broken-ref",
				element: "components.link",
				line: 11,
			}),
		]);
		expect(warnings).toContainEqual(
			expect.objectContaining({
				file: "DESIGN.md",
				rule: "contrast-ratio",
				element: "components.button",
				line: 8,
			}),
		);
	});
});

describe("wider Screen Subset", () => {
	test.each(Object.keys(widerScreens))(
		"%s: Push then Pull round-trips byte for byte",
		async (name) => {
			const { harness, designDir } = await pushed({
				"screens/login.html": widerScreens[name] as string,
			});
			const before = await readFile(join(designDir, "screens/login.html"));
			const result = await harness.callTool("pull");
			expect(structured(result)).toMatchObject({
				screens: [{ status: "unchanged", figmaOwned: [] }],
			});
			expect(await readFile(join(designDir, "screens/login.html"))).toEqual(
				before,
			);
		},
	);
});

describe("Figma-owned Elements", () => {
	/** Login pushed, a star drawn in its frame, and Pulled; exports counted. */
	async function pulledStar() {
		const exported: string[] = [];
		const setup = await pushed(
			{},
			{
				exportPng: (nodeId) => {
					exported.push(nodeId);
					return logoPng;
				},
			},
		);
		const star: SyncedNode = {
			...structuredClone(layerByKey(setup.frame(), "e7")),
			id: "9:60",
			key: null,
			type: "STAR",
			name: "Star",
			width: 40,
			height: 38,
			sizing: { horizontal: "FIXED", vertical: "FIXED" },
			fills: [{ type: "SOLID", color: "#ffcc00" }],
		};
		setup.frame().children?.push(star);
		const result = await setup.harness.callTool("pull");
		return { ...setup, exported, result, star };
	}

	const starIn = (frame: SyncedNode) =>
		frame.children?.find((layer) => layer.id === "9:60");

	test("Pull writes a layer outside the Screen Subset as a Figma-owned Element and caches its export", async () => {
		const pulled = await pulledStar();
		expect(structured(pulled.result)).toMatchObject({
			screens: [
				{
					status: "merged",
					figmaOwned: [
						{ key: "e8", nodeId: "9:60", name: "Star", reason: "is a STAR" },
					],
				},
			],
		});
		expect(await pulled.read()).toContain(
			'<figma-owned data-key="e8" data-name="Star" style="width:40px; height:38px"></figma-owned>',
		);
		expect(pulled.exported).toEqual(["9:60"]);
		const png = join(pulled.designDir, "sync/exports/login/e8.png");
		expect((await readFile(png)).toString("base64")).toBe(logoPng);
		const check = await pulled.harness.callTool("check_design_project");
		expect(structured(check)).toMatchObject({ ok: true });
	});

	test("Push leaves its layer as the designers made it, and Pull then finds nothing new", async () => {
		const pulled = await pulledStar();
		const before = structuredClone(starIn(pulled.frame()));
		const source = await pulled.read();
		await writeFile(
			pulled.login,
			source.replace("Welcome back", "Hello again"),
		);
		const result = await pulled.harness.callTool("push");
		expect(result.isError).toBeFalsy();
		expect({ ...starIn(pulled.frame()), key: null }).toEqual({
			...(before as SyncedNode),
			key: null,
		});
		const again = await pulled.harness.callTool("pull");
		expect(structured(again)).toMatchObject({
			screens: [{ status: "unchanged" }],
		});
		// The export is current: no need to fetch it again.
		expect(pulled.exported).toEqual(["9:60"]);
	});

	test("Push moves and resizes its layer when the Screen did", async () => {
		const pulled = await pulledStar();
		await writeFile(
			pulled.login,
			(await pulled.read()).replace(
				'style="width:40px; height:38px"',
				'style="position:absolute; left:4px; top:8px; width:60px; height:38px"',
			),
		);
		const result = await pulled.harness.callTool("push");
		expect(result.isError).toBeFalsy();
		expect(starIn(pulled.frame())).toMatchObject({
			type: "STAR",
			width: 60,
			x: 4,
			y: 8,
			fills: [{ type: "SOLID", color: "#ffcc00" }],
		});
	});

	test("Pull fetches its export again once a designer changed the layer", async () => {
		const pulled = await pulledStar();
		(starIn(pulled.frame()) as SyncedNode).fills = [
			{ type: "SOLID", color: "#00ff00" },
		];
		const result = await pulled.harness.callTool("pull");
		expect(structured(result)).toMatchObject({
			screens: [{ status: "unchanged" }],
		});
		expect(pulled.exported).toEqual(["9:60", "9:60"]);
	});

	test("deleting it in the Screen deletes its layer on Push, and its export", async () => {
		const pulled = await pulledStar();
		await writeFile(
			pulled.login,
			(await pulled.read()).replace(/\n {2}<figma-owned[^\n]*/, ""),
		);
		const result = await pulled.harness.callTool("push");
		expect(result.isError).toBeFalsy();
		expect(starIn(pulled.frame())).toBeUndefined();
		expect(
			existsSync(join(pulled.designDir, "sync/exports/login/e8.png")),
		).toBe(false);
	});

	test("Push refuses a Figma-owned Element Pull didn't make", async () => {
		const pulled = await pulledStar();
		await writeFile(
			pulled.login,
			(await pulled.read()).replace('data-key="e8"', 'data-key="e99"'),
		);
		const result = await pulled.harness.callTool("push");
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("Figma-owned Elements (e99)");
	});

	test("render_screen shows it from its cached export, and says when that's stale or missing", async () => {
		const pulled = await pulledStar();
		const shots: string[] = [];
		const harness = await startHarness({
			designDir: pulled.designDir,
			screenshot: async (htmlPath, pngPath) => {
				shots.push(await readFile(htmlPath, "utf8"));
				await writeFile(pngPath, Buffer.from(logoPng, "base64"));
			},
		});
		const render = () => harness.callTool("render_screen", { screen: "login" });
		expect(structured(await render())).toMatchObject({
			figmaOwned: [{ key: "e8", name: "Star", export: "current" }],
		});
		expect(shots[0]).toContain("../sync/exports/login/e8.png");

		await writeFile(
			pulled.login,
			(await pulled.read()).replace("width:40px", "width:80px"),
		);
		const stale = await render();
		expect(structured(stale)).toMatchObject({
			figmaOwned: [{ key: "e8", export: "stale" }],
		});
		expect(text(stale)).toContain("stale");

		await rm(join(pulled.designDir, "sync/exports"), { recursive: true });
		expect(structured(await render())).toMatchObject({
			figmaOwned: [{ key: "e8", export: "missing" }],
		});
	});
});

describe("Modes", () => {
	const modesPath = (designDir: string) => join(designDir, "modes.yaml");

	test("Push makes a variable mode per Mode; Pull brings a designer's Mode edits into the Modes file", async () => {
		const { harness, plugin, designDir, read } = await pushed({
			"modes.yaml": modesFile,
		});
		const tokens = plugin.screens.designSystem;
		expect(tokens.modeNames).toEqual(["Light", "Dark"]);
		const dark = tokens.modeId("Dark");
		expect(tokens.variable("colors/surface").modes[dark]).toEqual({
			color: "#111111",
		});
		expect(tokens.variable("colors/primary").modes[dark]).toEqual({
			color: "#3366ff",
		});
		const screen = await read();
		const designMd = await readFile(join(designDir, "DESIGN.md"), "utf8");

		tokens.variable("colors/surface").modes[dark] = { color: "#000000" };
		tokens.variable("colors/primary").modes[dark] = { color: "#99bbff" };
		const status = await harness.callTool("get_status");
		expect(structured(status)).toMatchObject({
			designProject: {
				unpulledChanges: [],
				designSystem: {
					unpulledChanges: [
						"modes.Dark.colors.primary",
						"modes.Dark.colors.surface",
					],
				},
			},
		});
		const refused = await harness.callTool("push");
		expect(refused.isError).toBe(true);
		expect(text(refused)).toContain("modes.Dark.colors.surface");

		const pulled = await harness.callTool("pull");
		expect(structured(pulled)).toMatchObject({
			designSystem: { status: "merged", conflicts: 0 },
			screens: [{ screen: "login", status: "unchanged" }],
		});
		expect(await readFile(modesPath(designDir), "utf8")).toBe(
			modesFile
				.replace('surface: "#111111"', 'surface: "#000000"')
				.replace(
					'text: "#eeeeee"\n',
					'text: "#eeeeee"\n      primary: "#99bbff"\n',
				),
		);
		const designMdAfter = await readFile(join(designDir, "DESIGN.md"), "utf8");
		expect(designMdAfter).toBe(designMd);
		expect(lint(designMdAfter).summary.errors).toBe(0);
		expect(await read()).toBe(screen);

		const again = await harness.callTool("push");
		expect(again.isError).toBeFalsy();
		const check = await harness.callTool("pull");
		expect(structured(check)).toMatchObject({
			designSystem: { status: "unchanged" },
		});
	});

	test("Push removes the Modes the file dropped, and a Mode deleted in Figma is made again", async () => {
		const { harness, plugin, designDir } = await pushed({
			"modes.yaml": modesFile.replace(
				"modes:\n",
				"modes:\n  Dim:\n    spacing:\n      lg: 20px\n",
			),
		});
		const tokens = plugin.screens.designSystem;
		expect(tokens.modeNames).toEqual(["Light", "Dim", "Dark"]);
		tokens.removeMode("Dark");
		await writeFile(modesPath(designDir), modesFile);
		const again = await harness.callTool("push");
		expect(again.isError).toBeFalsy();
		expect(tokens.modeNames).toEqual(["Light", "Dark"]);
	});

	test("Pull marks a Mode's token both sides changed, and Push refuses until it's resolved", async () => {
		const { harness, plugin, designDir } = await pushed({
			"modes.yaml": modesFile,
		});
		const tokens = plugin.screens.designSystem;
		tokens.variable("colors/text").modes[tokens.modeId("Dark")] = {
			color: "#ffffff",
		};
		await writeFile(
			modesPath(designDir),
			modesFile.replace("#eeeeee", "#dddddd"),
		);
		const result = await harness.callTool("pull");
		expect(structured(result)).toMatchObject({
			designSystem: { conflicts: 1 },
			conflicts: 1,
		});
		const status = await harness.callTool("get_status");
		expect(structured(status)).toMatchObject({
			designProject: { designSystem: { syncConflicts: true } },
		});
		const refused = await harness.callTool("push");
		expect(refused.isError).toBe(true);
		expect(text(refused)).toContain("modes.yaml still has Sync Conflicts");
	});

	test("check validates the Modes file against DESIGN.md's tokens", async () => {
		const designDir = await writeFixtureProject({
			"modes.yaml": modesFile.replace("text:", "txt:"),
		});
		const harness = await startHarness({ designDir });
		const result = await harness.callTool("check_design_project");
		expect(structured(result)).toMatchObject({
			ok: false,
			errors: [
				{
					file: "modes.yaml",
					line: 6,
					element: "modes.Dark.colors.txt",
					rule: "unknown-token",
				},
			],
		});
	});
});

describe("Prototype Links", () => {
	const linkedFiles = {
		"screens/login.html": null,
		"screens/home.html": linkedScreens.home as string,
		"screens/signup.html": linkedScreens.signup as string,
	};

	/** Home and Sign up pushed once, link confirmed. */
	async function pushedLinked() {
		const setup = await pushed(linkedFiles);
		const home = join(setup.designDir, "screens/home.html");
		return {
			...setup,
			home,
			readHome: () => readFile(home, "utf8"),
			homeFrame: () => setup.plugin.screens.frame("home"),
			signupFrame: () => setup.plugin.screens.frame("signup"),
		};
	}

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

	test("Push makes links on-click NAVIGATEs to the linked Screens' frames, instant by default", async () => {
		const { homeFrame, signupFrame } = await pushedLinked();
		const [link] = layerByKey(homeFrame(), "e3").reactions ?? [];
		expect(link).toEqual({
			trigger: { type: "ON_CLICK" },
			actions: [
				{
					type: "NODE",
					destinationId: signupFrame().id,
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
		});
		expect(layerByKey(homeFrame(), "e5").reactions).toMatchObject([
			{ actions: [{ destinationId: signupFrame().id, transition: null }] },
		]);
		expect(layerByKey(signupFrame(), "e2").reactions).toMatchObject([
			{ actions: [{ destinationId: homeFrame().id }] },
		]);
	});

	test("trace_flow over the Pushed Screens returns the linked graph", async () => {
		const { harness, homeFrame, signupFrame } = await pushedLinked();
		const result = await harness.callTool("trace_flow", {
			nodeId: homeFrame().id,
		});
		expect(result.isError).toBeFalsy();
		const graph = structured<PrototypeGraph>(result);
		expect(graph.screens).toEqual([
			expect.objectContaining({ id: homeFrame().id, name: "home", depth: 0 }),
			expect.objectContaining({
				id: signupFrame().id,
				name: "signup",
				depth: 1,
			}),
		]);
		expect(
			graph.edges.map(({ from, nodeName, action, to, transition }) => ({
				from,
				nodeName,
				action,
				to,
				transition: transition?.type ?? null,
			})),
		).toEqual([
			{
				from: homeFrame().id,
				nodeName: "Sign up",
				action: "NAVIGATE",
				to: signupFrame().id,
				transition: "PUSH",
			},
			{
				from: homeFrame().id,
				nodeName: "I have an account",
				action: "NAVIGATE",
				to: signupFrame().id,
				transition: null,
			},
			{
				from: homeFrame().id,
				nodeName: "Rectangle",
				action: "NAVIGATE",
				to: homeFrame().id,
				transition: "DISSOLVE",
			},
			{
				from: signupFrame().id,
				nodeName: "Back",
				action: "NAVIGATE",
				to: homeFrame().id,
				transition: "SLIDE_OUT",
			},
		]);
		expect(graph.dangling).toEqual([]);
	});

	test("check rejects links to Screens that don't exist and invalid transitions", async () => {
		const designDir = await writeFixtureProject({
			...linkedFiles,
			"screens/signup.html": `<body style="display:flex">\n  <a href="welcome.html">Welcome</a>\n  <a href="home.html" data-transition="slide-in sideways">Home</a>\n</body>\n`,
		});
		const harness = await startHarness({ designDir });
		const result = await harness.callTool("check_design_project");
		expect(structured(result)).toMatchObject({
			ok: false,
			errors: [
				{ file: "screens/signup.html", line: 2, rule: "unknown-screen" },
				{ file: "screens/signup.html", line: 3, rule: "invalid-transition" },
			],
		});
	});

	test("Push refuses a link to a Screen that has no frame yet, unless it's pushed too", async () => {
		const { harness } = await withProject(linkedFiles);
		const result = await harness.callTool("push", {
			confirmLink: true,
			screens: ["home"],
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain(
			"screens/home.html links to signup, which has no frame in Figma yet",
		);
	});

	test("Pull writes a designer's changed transition and new link; Push again keeps the node IDs", async () => {
		const { harness, designDir, homeFrame, signupFrame, readHome } =
			await pushedLinked();
		const button = layerByKey(homeFrame(), "e3");
		const [link] = button.reactions as [Reaction];
		Object.assign(link.actions[0] as object, {
			transition: {
				type: "SMART_ANIMATE",
				easing: { type: "EASE_IN_AND_OUT" },
				duration: 0.4,
			},
		});
		layerByKey(signupFrame(), "e3").reactions = [
			{
				trigger: { type: "ON_CLICK" },
				actions: [
					{
						type: "NODE",
						destinationId: homeFrame().id,
						navigation: "NAVIGATE",
						transition: null,
					},
				],
			},
		];
		const status = await harness.callTool("get_status");
		expect(structured(status)).toMatchObject({
			designProject: { unpulledChanges: ["home", "signup"] },
		});
		const result = await harness.callTool("pull");
		expect(structured(result)).toMatchObject({
			screens: [
				{ screen: "home", status: "merged", conflicts: 0 },
				{ screen: "signup", status: "merged", conflicts: 0 },
			],
		});
		expect(await readHome()).toContain(
			'href="signup.html" data-transition="smart-animate 400ms ease-in-out"',
		);
		const signup = await readFile(
			join(designDir, "screens/signup.html"),
			"utf8",
		);
		expect(signup).toContain('<p data-key="e3" href="home.html">');
		const before = [ids(homeFrame()), ids(signupFrame())];
		const again = await harness.callTool("push");
		expect(again.isError).toBeFalsy();
		expect([ids(homeFrame()), ids(signupFrame())]).toEqual(before);
		expect(structured(await harness.callTool("pull"))).toMatchObject({
			screens: [{ status: "unchanged" }, { status: "unchanged" }],
		});
	});

	test("Figma-only reactions on Pushed layers survive later Pushes, and Pull finds nothing new", async () => {
		const { harness, home, homeFrame, readHome } = await pushedLinked();
		const title = layerByKey(homeFrame(), "e2");
		title.reactions = [hover];
		const button = layerByKey(homeFrame(), "e3");
		button.reactions = [hover, ...(button.reactions ?? [])];
		const frameReaction: Reaction = { ...hover, trigger: { type: "ON_DRAG" } };
		homeFrame().reactions = [frameReaction];
		expect(structured(await harness.callTool("pull"))).toMatchObject({
			screens: [{ status: "unchanged" }, { status: "unchanged" }],
		});
		await writeFile(
			home,
			(await readHome())
				.replace("Home</h1>", "Welcome</h1>")
				.replace(' data-transition="push left"', ""),
		);
		const result = await harness.callTool("push");
		expect(result.isError).toBeFalsy();
		expect(layerByKey(homeFrame(), "e2").reactions).toEqual([hover]);
		expect(layerByKey(homeFrame(), "e3").reactions).toMatchObject([
			hover,
			{ actions: [{ navigation: "NAVIGATE", transition: null }] },
		]);
		expect(homeFrame().reactions).toEqual([frameReaction]);
	});
});

/** A Direction of the login Screen: the same Screen, bolder. */
const boldLogin = loginScreen
	.replace("Welcome back", "Welcome back!")
	.replace("../assets/logo.png", "../../assets/logo.png");

async function writeDirection(designDir: string, name: string, source: string) {
	const dir = join(designDir, "screens/login.directions");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${name}.html`), source);
}

describe("Directions", () => {
	test("check reports a Direction's errors under its file", async () => {
		const designDir = await writeFixtureProject({
			"screens/login.directions/bold.html":
				'<body style="display:flex">\n  <table></table>\n</body>\n',
			"screens/login.directions/calm.html": boldLogin,
		});
		const harness = await startHarness({ designDir });
		const result = await harness.callTool("check_design_project");
		expect(structured(result)).toMatchObject({
			ok: false,
			errors: [
				{
					file: "screens/login.directions/bold.html",
					line: 2,
					element: "body > table",
					rule: "unknown-element",
				},
			],
		});
	});

	test("render_screen renders a Direction at its Screen's Screen Size", async () => {
		const designDir = await writeFixtureProject({
			"screens/welcome.html": welcomeScreen,
			"screens/welcome.directions/stacked.html":
				'<body style="display:flex; flex-direction:column">\n  <p>Stacked welcome</p>\n</body>\n',
		});
		const shots: { html: string; size: unknown }[] = [];
		const harness = await startHarness({
			designDir,
			screenshot: async (htmlPath, pngPath, size) => {
				shots.push({ html: await readFile(htmlPath, "utf8"), size });
				await writeFile(pngPath, Buffer.from(logoPng, "base64"));
			},
		});
		const result = await harness.callTool("render_screen", {
			screen: "welcome",
			direction: "stacked",
		});
		expect(result.isError).toBeFalsy();
		expect(structured<{ path: string }>(result).path).toContain(
			"screen-welcome-stacked",
		);
		expect(shots[0]?.size).toEqual({ width: 1024, height: 768 });
		expect(shots[0]?.html).toContain("Stacked welcome");
		expect(shots[0]?.html).toContain("body { width: 1024px; height: 768px; }");
		const unknown = await harness.callTool("render_screen", {
			screen: "welcome",
			direction: "nope",
		});
		expect(unknown.isError).toBe(true);
		expect(text(unknown)).toContain("welcome has the Directions stacked");
	});

	test("choose_direction makes a Direction the Screen and removes the other Directions", async () => {
		const designDir = await writeFixtureProject({
			"screens/login.directions/bold.html": boldLogin,
			"screens/login.directions/calm.html": loginScreen,
		});
		const harness = await startHarness({ designDir });
		const result = await harness.callTool("choose_direction", {
			screen: "login",
			direction: "bold",
		});
		expect(result.isError).toBeFalsy();
		expect(structured(result)).toEqual({
			screen: "login",
			file: "screens/login.html",
			chose: "bold",
			discarded: ["calm"],
		});
		// Its images' paths follow it to the Screen's folder.
		expect(await readFile(join(designDir, "screens/login.html"), "utf8")).toBe(
			loginScreen.replace("Welcome back", "Welcome back!"),
		);
		expect(existsSync(join(designDir, "screens/login.directions"))).toBe(false);
		const check = await harness.callTool("check_design_project");
		expect(structured(check)).toMatchObject({ ok: true });
		const again = await harness.callTool("choose_direction", {
			screen: "login",
			direction: "bold",
		});
		expect(again.isError).toBe(true);
		expect(text(again)).toContain("login has no Directions");
	});

	test("choose_direction makes a new Screen from a Direction of a Screen that doesn't exist yet", async () => {
		const designDir = await writeFixtureProject({
			"screens/signup.directions/a.html": boldLogin,
		});
		const harness = await startHarness({ designDir });
		const result = await harness.callTool("choose_direction", {
			screen: "signup",
			direction: "a",
		});
		expect(result.isError).toBeFalsy();
		expect(await readFile(join(designDir, "screens/signup.html"), "utf8")).toBe(
			loginScreen.replace("Welcome back", "Welcome back!"),
		);
	});

	test("a regular Push never Pushes Directions to the Screens Page", async () => {
		const { harness, plugin } = await withProject({
			"screens/login.directions/bold.html": boldLogin,
		});
		const result = await harness.callTool("push", { confirmLink: true });
		expect(structured(result)).toMatchObject({
			status: "pushed",
			screens: [{ screen: "login", created: true }],
		});
		expect([...plugin.screens.frames.values()].map((f) => f.screen)).toEqual([
			"login",
		]);
		expect(plugin.screens.frame("login").children?.[1]?.text?.characters).toBe(
			"Welcome back",
		);
	});

	test("Pushing Directions copies them, labelled, to the Explorations Page; again replaces the copies", async () => {
		const { harness, plugin, designDir, frame } = await pushed();
		await writeDirection(designDir, "bold", boldLogin);
		await writeDirection(
			designDir,
			"calm",
			boldLogin.replace("Welcome back!", "Hello"),
		);
		const screenFrame = structuredClone(frame());
		const result = await harness.callTool("push", {
			screens: ["login"],
			directions: true,
		});
		expect(result.isError).toBeFalsy();
		expect(structured(result)).toMatchObject({
			status: "pushed_directions",
			page: { name: "Explorations" },
			screens: [
				{
					screen: "login",
					directions: [
						{ direction: "bold", frameId: expect.any(String) },
						{ direction: "calm", frameId: expect.any(String) },
					],
				},
			],
		});
		const copies = () => [...plugin.screens.explorations.values()];
		expect(copies().map(({ frame }) => frame.name)).toEqual([
			"login / bold",
			"login / calm",
		]);
		expect(copies()[0]?.frame.children?.[1]?.text?.characters).toBe(
			"Welcome back!",
		);
		const page = plugin.document.pages.find((p) => p.name === "Explorations");
		expect(copies().every(({ pageId }) => pageId === page?.id)).toBe(true);
		// The Screen, its frame and its file are untouched; Directions get no keys.
		expect(frame()).toEqual(screenFrame);
		expect(
			await readFile(
				join(designDir, "screens/login.directions/bold.html"),
				"utf8",
			),
		).toBe(boldLogin);
		const link = JSON.parse(
			await readFile(join(designDir, "sync/link.json"), "utf8"),
		);
		expect(link.explorationsPage).toEqual({
			id: page?.id,
			name: "Explorations",
		});

		await rm(join(designDir, "screens/login.directions/calm.html"));
		await harness.callTool("push", { directions: true });
		expect(copies().map(({ frame }) => frame.name)).toEqual(["login / bold"]);
	});

	test("Pull never reads the Explorations Page", async () => {
		const { harness, plugin, designDir, read } = await pushed();
		await writeDirection(designDir, "bold", boldLogin);
		await harness.callTool("push", { directions: true });
		const before = await read();
		// A designer edits a copy, then deletes the Screen's own frame.
		const [copy] = [...plugin.screens.explorations.values()];
		(copy?.frame.children?.[1]?.text as { characters: string }).characters =
			"Edited copy";
		plugin.screens.frames.clear();
		const result = await harness.callTool("pull");
		expect(structured(result)).toMatchObject({
			screens: [{ screen: "login", status: "missing" }],
		});
		expect(await read()).toBe(before);
	});

	test("Pushing Directions is refused without Directions, or when one fails Check", async () => {
		const { harness, designDir } = await pushed();
		const none = await harness.callTool("push", { directions: true });
		expect(none.isError).toBe(true);
		expect(text(none)).toContain("No Directions to push");
		await writeDirection(designDir, "bad", "<body><table></table></body>\n");
		const failing = await harness.callTool("push", { directions: true });
		expect(failing.isError).toBe(true);
		expect(text(failing)).toContain("screens/login.directions/bad.html:1");
	});

	test("choosing a Direction, then Pushing, updates the Screen's frame in place", async () => {
		const { harness, plugin, designDir, read, frame } = await pushed();
		const { id } = frame();
		// An Agent copies the keyed Screen into a Direction and edits it.
		const keyed = (await read())
			.replace("Welcome back", "Welcome back!")
			.replace("../assets/logo.png", "../../assets/logo.png");
		await writeDirection(designDir, "bold", keyed);
		await harness.callTool("choose_direction", {
			screen: "login",
			direction: "bold",
		});
		const result = await harness.callTool("push");
		expect(structured(result)).toMatchObject({
			status: "pushed",
			screens: [{ screen: "login", frameId: id, created: false }],
		});
		expect(plugin.screens.frame("login").children?.[1]?.text?.characters).toBe(
			"Welcome back!",
		);
	});
});

describe("Components", () => {
	const files = { "screens/login.html": null, ...componentFiles };

	/** The fixture's Components and start Screen, with the avatar in the plugin's library. */
	async function withComponents(overrides: Record<string, string | null> = {}) {
		const setup = await withProject({ ...files, ...overrides });
		setup.plugin.screens.components.addLibraryComponent(avatarComponent);
		const start = join(setup.designDir, "screens/start.html");
		const button = join(setup.designDir, "components/app-button.html");
		return {
			...setup,
			readStart: () => readFile(start, "utf8"),
			readButton: () => readFile(button, "utf8"),
			startFrame: () => setup.plugin.screens.frame("start"),
			buttonNode: () =>
				setup.plugin.screens.components.defined.get("app-button") as SyncedNode,
		};
	}

	async function pushedComponents(
		overrides: Record<string, string | null> = {},
	) {
		const setup = await withComponents(overrides);
		const result = await setup.harness.callTool("push", { confirmLink: true });
		expect(result.isError).toBeFalsy();
		return { ...setup, result };
	}

	test("Push creates a component set per Defined Component, and the Screens use instances of it", async () => {
		const { result, buttonNode, startFrame, designDir } =
			await pushedComponents();
		expect(structured(result)).toMatchObject({
			status: "pushed",
			components: [
				{ component: "app-button", nodeId: buttonNode().id, created: true },
			],
		});
		expect(buttonNode()).toMatchObject({
			type: "COMPONENT_SET",
			name: "app-button",
			children: [
				{ type: "COMPONENT", name: "kind=primary" },
				{ type: "COMPONENT", name: "kind=secondary" },
			],
		});
		const [, primary, secondary, avatar] = startFrame().children ?? [];
		expect(primary).toMatchObject({
			type: "INSTANCE",
			instance: {
				mainId: buttonNode().children?.[0]?.id,
				setId: buttonNode().id,
				properties: { kind: "primary", label: "Get started" },
			},
		});
		expect(secondary?.instance?.mainId).toBe(
			buttonNode().children?.[1]?.id as string,
		);
		expect(avatar).toMatchObject({
			type: "INSTANCE",
			instance: { setId: "5:1", properties: { size: "large", initials: "AB" } },
		});
		// Keys were written into the Component's file, as into Screens.
		expect(
			await readFile(join(designDir, "components/app-button.html"), "utf8"),
		).toContain('<component data-key="e1" data-variant="kind=primary"');
		// What Push found of the Linked Component is recorded.
		const record = JSON.parse(
			await readFile(join(designDir, "sync/linked/app-avatar.json"), "utf8"),
		);
		expect(record).toEqual({
			componentId: "5:1",
			key: "avatar-key",
			properties: avatarComponent.properties,
			variants: avatarComponent.variants,
		});
	});

	test("Pushing again keeps the Components' and instances' node IDs, and Pull finds nothing new", async () => {
		const { harness, buttonNode, startFrame, readStart, readButton } =
			await pushedComponents();
		const before = [ids(buttonNode()), ids(startFrame())];
		const [start, button] = [await readStart(), await readButton()];
		const again = await harness.callTool("push");
		expect(again.isError).toBeFalsy();
		expect([ids(buttonNode()), ids(startFrame())]).toEqual(before);
		expect(structured(await harness.callTool("pull"))).toMatchObject({
			components: [{ component: "app-button", status: "unchanged" }],
			screens: [{ screen: "start", status: "unchanged" }],
		});
		expect([await readStart(), await readButton()]).toEqual([start, button]);
	});

	test("check and Push reject an instance of a Component the Design Project doesn't have", async () => {
		const { harness } = await withComponents({
			"screens/start.html": `<body style="display:flex">\n  <app-card></app-card>\n</body>\n`,
		});
		const check = await harness.callTool("check_design_project");
		expect(text(check)).toContain("unknown-component");
		const push = await harness.callTool("push", { confirmLink: true });
		expect(push.isError).toBe(true);
		expect(text(push)).toContain(
			"screens/start.html:2 body > app-card [unknown-component]",
		);
	});

	test("Push fails, naming it, when a Linked Component isn't in the file or its libraries", async () => {
		const { harness, plugin } = await withComponents({
			"components/app-avatar.json": `{ "key": "gone" }\n`,
		});
		const push = await harness.callTool("push", { confirmLink: true });
		expect(push.isError).toBe(true);
		expect(text(push)).toContain(
			'Linked Component app-avatar: no component with key "gone"',
		);
		expect(plugin.screens.frames.size).toBe(0);
	});

	test("Pull writes a designer's instance overrides as attributes, and a detached instance as plain elements", async () => {
		const { harness, startFrame, buttonNode, readStart } =
			await pushedComponents();
		const secondary = layerByKey(startFrame(), "e4");
		Object.assign(secondary.instance ?? {}, {
			properties: { kind: "primary", label: "Create account" },
		});
		detachInstance(
			startFrame(),
			"e3",
			buttonNode().children?.[0] as SyncedNode,
			(() => {
				let id = 0;
				return () => `8:${++id}`;
			})(),
		);
		expect(structured(await harness.callTool("get_status"))).toMatchObject({
			designProject: { unpulledChanges: ["start"] },
		});
		const result = await harness.callTool("pull");
		expect(structured(result)).toMatchObject({
			screens: [{ screen: "start", status: "merged", conflicts: 0 }],
		});
		const start = await readStart();
		expect(start).toContain(
			'<app-button data-key="e4" label="Create account"></app-button>',
		);
		expect(start).toContain(
			'<div data-key="e3" data-name="app-button" style="display:flex; justify-content:center; padding:12px 16px; align-self:stretch; background-color:#3366ff; border-radius:12px">\n    <p data-key="e6" style="color:#ffffff; font-weight:600">Sign in</p>\n  </div>',
		);
		const again = await harness.callTool("push");
		expect(again.isError).toBeFalsy();
	});

	test("Pull merges a designer's edits to a Defined Component's main component into its file; Push refuses until then", async () => {
		const { harness, buttonNode, readButton } = await pushedComponents();
		const secondary = buttonNode().children?.[1] as SyncedNode;
		secondary.cornerRadius = 20;
		const refused = await harness.callTool("push");
		expect(refused.isError).toBe(true);
		expect(text(refused)).toContain(
			"the Component app-button has Unpulled Changes",
		);
		const result = await harness.callTool("pull");
		expect(structured(result)).toMatchObject({
			components: [{ component: "app-button", status: "merged", conflicts: 0 }],
		});
		expect(await readButton()).toContain(
			'<component data-key="e3" data-variant="kind=secondary" style="display:flex; justify-content:center; padding:12px 16px; border-radius:20px; border-width:1px; border-color:var(--colors-primary)">',
		);
		const again = await harness.callTool("push");
		expect(again.isError).toBeFalsy();
	});

	test("edits to a Linked Component in its library are never Pulled", async () => {
		const { harness, plugin, designDir } = await pushedComponents();
		plugin.screens.components.addLibraryComponent({
			...avatarComponent,
			properties: {
				...avatarComponent.properties,
				initials: { type: "TEXT", default: "ZZ" },
			},
		});
		const result = await harness.callTool("pull");
		expect(structured(result)).toMatchObject({
			components: [{ component: "app-button" }],
			screens: [{ screen: "start", status: "unchanged" }],
		});
		expect(existsSync(join(designDir, "components/app-avatar.html"))).toBe(
			false,
		);
		expect(
			await readFile(join(designDir, "components/app-avatar.json"), "utf8"),
		).toBe(`{ "key": "avatar-key" }\n`);
	});
});
