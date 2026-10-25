import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	checkProject,
	initProject,
	loadProject,
} from "@figma-agent-tool/design-project";
import { startHarness } from "./harness";

const skill = await readFile(
	join(import.meta.dir, "../skill/SKILL.md"),
	"utf8",
);

/** The skill's example files: fenced blocks whose info string names a path. */
function exampleFiles(markdown: string): Map<string, string> {
	const files = new Map<string, string>();
	for (const [, path, body] of markdown.matchAll(
		/^```\w+ (\S+)\n([\s\S]*?)^```$/gm,
	)) {
		files.set(path as string, body as string);
	}
	return files;
}

describe("the agent skill", () => {
	test("teaches with a Design Project that passes Check", async () => {
		const files = exampleFiles(skill);
		expect([...files.keys()].sort()).toEqual([
			"DESIGN.md",
			"components/app-button.html",
			"screens/home.html",
			"screens/login.html",
		]);
		const dir = join(await mkdtemp(join(tmpdir(), "skill-")), "design");
		await initProject(dir);
		for (const [path, content] of files) {
			await mkdir(dirname(join(dir, path)), { recursive: true });
			await writeFile(join(dir, path), content);
		}
		const { errors, warnings } = await checkProject(await loadProject(dir));
		expect(errors).toEqual([]);
		expect(warnings).toEqual([]);
		await rm(dirname(dir), { recursive: true, force: true });
	});

	test("names every Design Project tool", async () => {
		const { client } = await startHarness();
		const { tools } = await client.listTools();
		const designTools = tools
			.map((tool) => tool.name)
			.filter((name) =>
				/design_project|screen$|preview|^push$|^pull$|direction|_file$/.test(
					name,
				),
			);
		expect(designTools.length).toBeGreaterThanOrEqual(9);
		for (const name of designTools) expect(skill).toContain(`\`${name}\``);
	});
});

describe("the MCP server's instructions", () => {
	test("teach the workflow in brief and point at the skill", async () => {
		const { client } = await startHarness();
		const instructions = client.getInstructions() ?? "";
		for (const point of [
			"check_design_project",
			"render_screen",
			"Pull before",
			"confirmLink",
			"Sync Conflict",
			"data-key",
			"<figma-owned>",
			"display:flex",
			"var(--colors-primary)",
			"modes.yaml",
			".directions/",
			"components/",
			"href=",
			"npx figma-agent-tool skill",
		]) {
			expect(instructions).toContain(point);
		}
	});
});
