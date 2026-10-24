import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	layerByKey,
	logoPng,
	writeFixtureProject,
} from "@figma-agent-tool/design-project/fixtures";
import type { SyncedNode } from "@figma-agent-tool/protocol";
import { handshake } from "@figma-agent-tool/protocol/fixtures";
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
async function withProject(overrides: Record<string, string | null> = {}) {
	const designDir = await writeFixtureProject(overrides);
	const harness = await startHarness({ designDir });
	const plugin = await harness.connectFakePlugin();
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
async function pushed(overrides: Record<string, string | null> = {}) {
	const setup = await withProject(overrides);
	const result = await setup.harness.callTool("push", { confirmLink: true });
	expect(result.isError).toBeFalsy();
	return { ...setup, frame: () => setup.plugin.screens.frame("login") };
}

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
		});
		expect(
			await readFile(join(harness.designDir, "DESIGN.md"), "utf8"),
		).toStartWith("---\nversion: alpha");
		expect(existsSync(join(harness.designDir, "screens"))).toBe(true);
		const check = await harness.callTool("check_design_project");
		expect(structured(check)).toEqual({ ok: true, errors: [] });
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
				{ screen: "login", status: "unchanged", conflicts: 0, unsupported: [] },
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
