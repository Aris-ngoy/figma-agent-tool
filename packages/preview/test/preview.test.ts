import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type Baseline,
	loadProject,
	type ScreenFile,
	saveExports,
	writeBaseline,
} from "@figma-agent-tool/design-project";
import {
	loginScreen,
	logoPng,
	writeFixtureProject,
} from "@figma-agent-tool/design-project/fixtures";
import {
	findChrome,
	renderScreen,
	type Screenshotter,
	screenDocument,
	startPreview,
} from "../src";

const modes = `default: Light
modes:
  Dark:
    colors:
      surface: "#111111"
`;

const stops: (() => void)[] = [];
afterEach(() => {
	for (const stop of stops.splice(0)) stop();
});

async function preview(overrides: Record<string, string | null> = {}) {
	const dir = await writeFixtureProject(overrides);
	const server = startPreview({ dir, port: 0 });
	stops.push(() => server.stop());
	return { dir, server };
}

describe("Preview", () => {
	test("serves a Screen at its Screen Size with the Design System's tokens", async () => {
		const { server } = await preview();
		const html = await (await fetch(`${server.url}screens/login`)).text();
		expect(html).toContain(loginScreen.trim());
		expect(html).toContain("--colors-primary: #3366FF;");
		expect(html).toContain("--typography-title-font-size: 28px;");
		expect(html).toContain("body { width: 393px; height: 852px; }");
		expect(html).toContain('<base href="/files/screens/">');
	});

	test("sizes a Screen that overrides the Screen Size", async () => {
		const { server } = await preview({
			"screens/tablet.html":
				'<body style="display:flex; width:1024px; height:768px"></body>\n',
		});
		const html = await (await fetch(`${server.url}screens/tablet`)).text();
		expect(html).toContain("body { width: 1024px; height: 768px; }");
	});

	test("lists every Screen with its size and Check's errors", async () => {
		const { server } = await preview({
			"screens/broken.html": "<table></table>",
		});
		const html = await (await fetch(server.url)).text();
		expect(html).toContain(
			'<iframe src="/screens/login" width="393" height="852"',
		);
		expect(html).toContain('<iframe src="/screens/broken"');
		expect(html).toContain("single-root");
	});

	test("shows Screens in the Mode the switcher picks", async () => {
		const { server } = await preview({ "modes.yaml": modes });
		const index = await (await fetch(server.url)).text();
		expect(index).toContain('<select id="mode"');
		expect(index).toContain('<option value="Light" selected>Light</option>');
		expect(index).toContain('<option value="Dark">Dark</option>');
		expect(index).toContain('<iframe src="/screens/login"');
		const dark = await (await fetch(`${server.url}?mode=Dark`)).text();
		expect(dark).toContain('<option value="Dark" selected>Dark</option>');
		expect(dark).toContain('<iframe src="/screens/login?mode=Dark"');
		const screen = await (
			await fetch(`${server.url}screens/login?mode=Dark`)
		).text();
		expect(screen).toContain("--colors-surface: #111111;");
		expect(screen).toContain("--colors-primary: #3366FF;");
		const unknown = await fetch(`${server.url}screens/login?mode=Sepia`);
		expect(unknown.status).toBe(404);
		expect(await unknown.text()).toContain("No Mode named “Sepia”");
	});

	test("has no Mode switcher without Modes", async () => {
		const { server } = await preview();
		expect(await (await fetch(server.url)).text()).not.toContain("<select");
	});

	test("serves the Design Project's images, and nothing outside it", async () => {
		const { server } = await preview();
		const image = await fetch(`${server.url}files/assets/logo.png`);
		expect(Buffer.from(await image.arrayBuffer()).toString("base64")).toBe(
			logoPng,
		);
		const outside = await fetch(`${server.url}files/..%2F..%2Fetc%2Fpasswd`);
		expect(outside.status).toBe(403);
	});

	test("tells open pages to reload when a file changes", async () => {
		const { dir, server } = await preview();
		const response = await fetch(`${server.url}events`);
		const reader = (response.body as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		await reader.read(); // the ": connected" comment
		await Bun.sleep(50);
		await writeFile(
			join(dir, "screens/login.html"),
			loginScreen.replace("Welcome", "Hi"),
		);
		const next = await Promise.race([
			reader.read(),
			Bun.sleep(2000).then(() => ({ value: undefined })),
		]);
		expect(decoder.decode(next.value)).toContain("data: reload");
		await reader.cancel();
	});
});

/** The login Screen with a Figma-owned Element whose export Pull cached. */
async function withFigmaOwned() {
	const owned =
		'<figma-owned data-key="e8" data-name="Star" style="width:40px; height:38px"></figma-owned>';
	const dir = await writeFixtureProject({
		"screens/login.html": loginScreen.replace("</body>", `  ${owned}\n</body>`),
	});
	const project = { dir };
	await writeBaseline(project, "login", {
		nodes: { e8: "9:60" },
	} as unknown as Baseline);
	const star = { id: "9:60", width: 40, height: 38 } as never;
	const png = Buffer.from(logoPng, "base64");
	await saveExports(project, "login", [{ key: "e8", node: star, png }], ["e8"]);
	return dir;
}

describe("Figma-owned Elements", () => {
	test("the Preview shows one as the export Pull cached", async () => {
		const dir = await withFigmaOwned();
		const server = startPreview({ dir, port: 0 });
		stops.push(() => server.stop());
		const html = await (await fetch(`${server.url}screens/login`)).text();
		expect(html).toContain(
			'figma-owned[data-key="e8"] { background: url("../sync/exports/login/e8.png")',
		);
		const image = await fetch(`${server.url}files/sync/exports/login/e8.png`);
		expect(image.status).toBe(200);
		expect(html).not.toContain("export is");
	});

	test("the Preview says when an export is stale or missing", async () => {
		const dir = await withFigmaOwned();
		const login = join(dir, "screens/login.html");
		await writeFile(
			login,
			(await readFile(login, "utf8")).replace("width:40px", "width:80px"),
		);
		const server = startPreview({ dir, port: 0 });
		stops.push(() => server.stop());
		const stale = await (await fetch(`${server.url}screens/login`)).text();
		expect(stale).toContain("export is stale");
		expect(await (await fetch(server.url)).text()).toContain(
			"Figma-owned “Star”: its export is stale",
		);
		await rm(join(dir, "sync/exports"), { recursive: true });
		const missing = await (await fetch(`${server.url}screens/login`)).text();
		expect(missing).toContain("no export");
		expect(missing).not.toContain("url(");
	});

	test("Render reports each one's export", async () => {
		const project = await loadProject(await withFigmaOwned());
		const screenshot: Screenshotter = async (_, pngPath) => {
			await writeFile(pngPath, Buffer.from(logoPng, "base64"));
		};
		const result = await renderScreen(
			project,
			project.screens[0] as ScreenFile,
			{ screenshot },
		);
		expect(result.figmaOwned).toEqual([
			{
				key: "e8",
				name: "Star",
				export: "current",
				src: "../sync/exports/login/e8.png",
			},
		]);
	});
});

describe("Render", () => {
	test("screenshots the same document the Preview serves, at the Screen Size", async () => {
		const project = await loadProject(await writeFixtureProject());
		const screen = project.screens[0] as ScreenFile;
		const shots: { html: string; size: unknown }[] = [];
		const screenshot: Screenshotter = async (htmlPath, pngPath, size) => {
			shots.push({ html: await readFile(htmlPath, "utf8"), size });
			await writeFile(pngPath, Buffer.from(logoPng, "base64"));
		};
		const result = await renderScreen(project, screen, { screenshot });
		const baseUrl = pathToFileURL(`${project.dir}/screens/`).href;
		expect(shots).toEqual([
			{
				html: screenDocument(project, screen, { baseUrl }),
				size: { width: 393, height: 852 },
			},
		]);
		expect(Buffer.from(result.png).toString("base64")).toBe(logoPng);
		expect(result).toMatchObject({ width: 393, height: 852 });
	});

	test("renders a Screen in a Mode", async () => {
		const project = await loadProject(
			await writeFixtureProject({ "modes.yaml": modes }),
		);
		const screen = project.screens[0] as ScreenFile;
		let html = "";
		const screenshot: Screenshotter = async (htmlPath, pngPath) => {
			html = await readFile(htmlPath, "utf8");
			await writeFile(pngPath, Buffer.from(logoPng, "base64"));
		};
		await renderScreen(project, screen, { screenshot, mode: "Dark" });
		expect(html).toContain("--colors-surface: #111111;");
	});

	// Needs a Chromium that runs here: set FIGMA_AGENT_CHROME, or let Render
	// download one (it needs the usual Chrome system libraries).
	const chrome = process.env.FIGMA_AGENT_CHROME;
	test.skipIf(!chrome || !existsSync(chrome))(
		"renders a PNG of the Screen Size in headless Chromium",
		async () => {
			const project = await loadProject(await writeFixtureProject());
			await findChrome();
			const { png } = await renderScreen(
				project,
				project.screens[0] as ScreenFile,
			);
			const view = new DataView(png.buffer, png.byteOffset);
			expect([view.getUint32(16), view.getUint32(20)]).toEqual([393, 852]);
		},
	);
});
