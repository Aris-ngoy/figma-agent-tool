import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startHarness } from "./harness";

async function connected() {
	const harness = await startHarness();
	const plugin = await harness.connectFakePlugin();
	return { ...harness, plugin };
}

function texts(result: Record<string, unknown>): string[] {
	return (result.content as { type: string; text: string }[]).map(
		(content) => content.text,
	);
}

/** The Markdown a handoff tool returns (its last text content). */
function markdown(result: Record<string, unknown>): string {
	return texts(result).at(-1) ?? "";
}

/** The lines of the section under `heading`, up to the next heading. */
function section(md: string, heading: string): string[] {
	const lines = md.split("\n");
	const start = lines.indexOf(heading);
	if (start === -1) throw new Error(`No "${heading}" in:\n${md}`);
	const end = lines.findIndex(
		(line, index) => index > start && line.startsWith("#"),
	);
	return lines.slice(start + 1, end === -1 ? undefined : end).filter(Boolean);
}

describe("export_flow_markdown", () => {
	test("renders every screen of the flow in walk order", async () => {
		const harness = await connected();
		const result = await harness.callTool("export_flow_markdown", {
			nodeId: "4:1",
		});
		expect(result.isError).toBeFalsy();
		const md = markdown(result);
		expect(md).toMatchSnapshot();
		expect(md.split("\n")[0]).toBe("# Flow: Onboarding");
		expect(md.match(/^## .*/gm)).toEqual([
			"## Screen: Welcome (4:1)",
			"## Screen: Permissions (4:10)",
			"## Screen: Done (4:20)",
			"## Screen: Info sheet (4:30)",
			"## Screen: Second tip (4:40)",
		]);
	});

	test("writes each interaction's trigger, destination and transition", async () => {
		const harness = await connected();
		const result = await harness.callTool("export_flow_markdown", {
			nodeId: "4:1",
		});
		const md = markdown(result);
		const welcome = md.slice(md.indexOf("## Screen: Welcome"));
		expect(section(welcome, "### Interactions")).toEqual([
			"| Layer | Trigger | Action | Destination | Transition | Direction | Easing | Duration |",
			"| --- | --- | --- | --- | --- | --- | --- | --- |",
			"| Get started (4:2) | ON_CLICK | NAVIGATE | Permissions (4:10) | PUSH | LEFT | EASE_IN_AND_OUT | 300ms |",
		]);
		const permissions = md.slice(md.indexOf("## Screen: Permissions"));
		expect(section(permissions, "### Interactions").slice(2)).toEqual([
			"| Permissions (4:10) | ON_DRAG | BACK | — | INSTANT | — | — | — |",
			"| Allow (4:11) | ON_CLICK | NAVIGATE | Done (4:20) | DISSOLVE | — | EASE_OUT | 200ms |",
			"| Learn more (4:12) | ON_CLICK | OVERLAY at 0,452 | Info sheet (4:30) | MOVE_IN | BOTTOM | EASE_OUT | 300ms |",
			"| Privacy policy (4:13) | ON_CLICK | URL | https://example.com/privacy | INSTANT | — | — | — |",
		]);
	});

	test("lists broken interactions with the reason", async () => {
		const harness = await connected();
		const result = await harness.callTool("export_flow_markdown", {
			nodeId: "4:1",
		});
		const md = markdown(result);
		const done = md.slice(md.indexOf("## Screen: Done"));
		expect(section(done, "### Broken interactions").slice(2)).toEqual([
			"| Broken (4:22) | ON_CLICK | NAVIGATE | 4:99 | missing |",
			"| Broken (4:22) | ON_HOVER | NAVIGATE | 1:1 | other_page |",
			"| Unwired (4:23) | ON_CLICK | NAVIGATE | — | no_destination |",
		]);
	});

	test("lists the tokens and component instances each screen uses", async () => {
		const harness = await connected();
		const result = await harness.callTool("export_flow_markdown", {
			nodeId: "4:1",
		});
		const md = markdown(result);
		const welcome = md.slice(
			md.indexOf("## Screen: Welcome"),
			md.indexOf("## Screen: Permissions"),
		);
		// The hidden hint's Body style is left out.
		expect(section(welcome, "### Tokens")).toEqual([
			"| Token | Kind | Value | Used for |",
			"| --- | --- | --- | --- |",
			"| color/primary | COLOR variable | Light: #3366ff; Dark: #6699ff | fill |",
			"| space/page | FLOAT variable | → space/lg | paddingLeft |",
			"| Heading/Large | TEXT style | Inter Bold 28/34px | text |",
			"| Text/Primary | PAINT style | #111111 | fill |",
		]);
		expect(section(welcome, "### Components")).toEqual([
			"| Layer | Component | Properties |",
			"| --- | --- | --- |",
			"| Step chip (4:4) | Chip / Size=Large (3:3) | Size=Large |",
		]);
		const permissions = md.slice(md.indexOf("## Screen: Permissions"));
		expect(section(permissions, "### Tokens")).toEqual(["None."]);
		expect(section(permissions, "### Components")).toEqual(["None."]);
	});

	test("resolves styles, variables and instance properties on Sign in", async () => {
		const harness = await connected();
		const result = await harness.callTool("export_flow_markdown", {
			nodeId: "1:1",
		});
		const md = markdown(result);
		expect(md).toMatchSnapshot();
		expect(md.split("\n")[0]).toBe("# Flow: Sign in");
		const login = md.slice(
			md.indexOf("## Screen: Login"),
			md.indexOf("## Screen: Home"),
		);
		expect(section(login, "### Components").slice(2)).toEqual([
			"| Button (1:3) | Button (2:1) | Disabled=false, Label=Sign in |",
		]);
		expect(section(login, "### Tokens").slice(2)).toEqual([
			"| color/primary | COLOR variable | Light: #3366ff; Dark: #6699ff | fill |",
			"| radius/md | FLOAT variable | 12 | bottomLeftRadius, bottomRightRadius, topLeftRadius, topRightRadius |",
			"| space/md | FLOAT variable | 16 | paddingLeft, paddingRight |",
			"| Heading/Large | TEXT style | Inter Bold 28/34px | text |",
			"| Text/Primary | PAINT style | #111111 | fill |",
		]);
		expect(section(login, "### Interactions").slice(2, 4)).toEqual([
			"| Title (1:2) | MOUSE_ENTER 0.2s | OVERLAY at 0,400 | Home (1:10) | MOVE_IN | BOTTOM | spring(mass 1, stiffness 300, damping 20, velocity 0) | 800ms |",
			"| Title (1:2) | MOUSE_LEAVE | CLOSE | — | INSTANT | — | — | — |",
		]);
	});

	test("links each screen to Figma and gives its size", async () => {
		const harness = await connected();
		const result = await harness.callTool("export_flow_markdown", {
			nodeId: "4:1",
		});
		const md = markdown(result);
		expect(section(md, "## Screen: Info sheet (4:30)")).toEqual([
			"- Link: https://www.figma.com/design/FILEKEY123/Sample-App?node-id=4-30",
			"- Size: 393×400",
			"- Depth: 2",
		]);
	});

	test("produces byte-identical output for the same document", async () => {
		const harness = await connected();
		const first = await harness.callTool("export_flow_markdown", {
			nodeId: "4:1",
		});
		const second = await harness.callTool("export_flow_markdown", {
			nodeId: "4:1",
		});
		expect(markdown(second)).toBe(markdown(first));
	});

	test("says when maxDepth cut the flow short", async () => {
		const harness = await connected();
		const result = await harness.callTool("export_flow_markdown", {
			nodeId: "4:1",
			maxDepth: 1,
		});
		const md = markdown(result);
		expect(section(md, "# Flow: Onboarding")).toContain(
			"- Truncated: screens at depth 1 are listed without their interactions",
		);
		expect(md.match(/^## .*/gm)).toHaveLength(2);
	});

	test("writes the Markdown to a path, creating folders", async () => {
		const harness = await connected();
		const path = join(harness.artifactsDir, "docs", "onboarding.md");
		const result = await harness.callTool("export_flow_markdown", {
			nodeId: "4:1",
			path,
		});
		expect(texts(result)[0]).toBe(`Wrote ${path}`);
		expect(await readFile(path, "utf8")).toBe(markdown(result));
	});

	test("rejects a nested layer as the start", async () => {
		const harness = await connected();
		const result = await harness.callTool("export_flow_markdown", {
			nodeId: "4:34",
		});
		expect(result.isError).toBe(true);
		expect(markdown(result)).toContain("nested RECTANGLE");
	});

	test("tells the agent to open the plugin when none is connected", async () => {
		const harness = await startHarness();
		const result = await harness.callTool("export_flow_markdown", {
			nodeId: "4:1",
		});
		expect(result.isError).toBe(true);
		expect(markdown(result)).toContain("No Figma plugin is connected");
	});
});

describe("export_screen_markdown", () => {
	test("renders one screen with its outgoing interactions", async () => {
		const harness = await connected();
		const result = await harness.callTool("export_screen_markdown", {
			nodeId: "4:10",
		});
		expect(result.isError).toBeFalsy();
		const md = markdown(result);
		expect(md).toMatchSnapshot();
		expect(md.match(/^#+ .*/gm)).toEqual([
			"# Screen: Permissions (4:10)",
			"## Interactions",
			"## Broken interactions",
			"## Tokens",
			"## Components",
		]);
		expect(section(md, "# Screen: Permissions (4:10)")).toEqual([
			"- File: Sample App",
			"- Page: Onboarding (0:3)",
			"- Link: https://www.figma.com/design/FILEKEY123/Sample-App?node-id=4-10",
			"- Size: 393×852",
		]);
		expect(section(md, "## Interactions")).toHaveLength(6);
		expect(section(md, "## Broken interactions")).toEqual(["None."]);
	});

	test("matches the screen's section in the flow export", async () => {
		const harness = await connected();
		const screen = markdown(
			await harness.callTool("export_screen_markdown", { nodeId: "4:1" }),
		);
		const flow = markdown(
			await harness.callTool("export_flow_markdown", { nodeId: "4:1" }),
		);
		for (const heading of ["Tokens", "Components", "Interactions"]) {
			expect(section(screen, `## ${heading}`)).toEqual(
				section(flow, `### ${heading}`),
			);
		}
	});

	test("writes the Markdown to a path", async () => {
		const harness = await connected();
		const path = join(harness.artifactsDir, "welcome.md");
		const result = await harness.callTool("export_screen_markdown", {
			nodeId: "4:1",
			path,
		});
		expect(await readFile(path, "utf8")).toBe(markdown(result));
	});

	test("rejects an unknown node", async () => {
		const harness = await connected();
		const result = await harness.callTool("export_screen_markdown", {
			nodeId: "9:99",
		});
		expect(result.isError).toBe(true);
		expect(markdown(result)).toContain('No node with ID "9:99"');
	});
});
