import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFixtureProject } from "@figma-agent-tool/design-project/fixtures";
import { handshake } from "@figma-agent-tool/protocol/fixtures";
import { type CliIo, runCli } from "../src/cli";
import { connectFakePlugin } from "./harness";

function io(answers: boolean[] = []) {
	const out: string[] = [];
	const err: string[] = [];
	const cli: CliIo = {
		out: (line) => out.push(line),
		err: (line) => err.push(line),
		confirm:
			answers.length > 0 ? async () => answers.shift() as boolean : undefined,
		env: {},
	};
	return { cli, out, err };
}

function freePort(): number {
	const server = Bun.serve({ port: 0, fetch: () => new Response() });
	const { port } = server;
	server.stop(true);
	return port as number;
}

/** Runs a push/pull/relink command with a fake plugin connecting to its bridge. */
async function withPlugin(
	argv: string[],
	cli: CliIo,
	linkId: string | null = null,
) {
	const port = freePort();
	const running = runCli([...argv, "--port", String(port), "--wait", "5"], cli);
	let plugin: Awaited<ReturnType<typeof connectFakePlugin>> | undefined;
	for (let attempt = 0; !plugin && attempt < 50; attempt++) {
		plugin = await connectFakePlugin(port, {
			handshake: { ...handshake, linkId },
		}).catch(() => undefined);
		if (!plugin) await Bun.sleep(20);
	}
	const code = await running;
	await plugin?.close();
	return { code, plugin };
}

describe("figma-agent-tool CLI", () => {
	test("init creates a Design Project at the given Screen Size", async () => {
		const dir = join(await mkdtemp(join(tmpdir(), "cli-")), "design");
		const { cli, out } = io();
		expect(await runCli(["init", "--dir", dir, "--size", "390x844"], cli)).toBe(
			0,
		);
		expect(out[0]).toContain("Created a Design Project");
		expect(
			JSON.parse(await readFile(join(dir, "project.json"), "utf8")).screenSize,
		).toEqual({
			width: 390,
			height: 844,
		});
		await rm(dir, { recursive: true, force: true });
	});

	test("check prints each error with file, line, element and rule, and fails", async () => {
		const dir = await writeFixtureProject({
			"screens/bad.html":
				'<body style="display:flex">\n  <table></table>\n</body>\n',
		});
		const { cli, out } = io();
		expect(await runCli(["check", "--dir", dir], cli)).toBe(1);
		expect(out[0]).toStartWith(
			"screens/bad.html:2 body > table [unknown-element]",
		);
		expect(out.at(-1)).toBe("1 error.");
	});

	test("check passes a valid Design Project", async () => {
		const { cli, out } = io();
		expect(
			await runCli(["check", "--dir", await writeFixtureProject()], cli),
		).toBe(0);
		expect(out).toEqual(["1 Screen checked: no errors."]);
	});

	test("push asks before linking the Bridged File, and links it once confirmed", async () => {
		const dir = await writeFixtureProject();
		const declined = io([false]);
		const first = await withPlugin(["push", "--dir", dir], declined.cli);
		expect(first.code).toBe(1);
		expect(declined.err.join("\n")).toContain("Not linked");
		expect(existsSync(join(dir, "sync/link.json"))).toBe(false);

		const confirmed = io([true]);
		const second = await withPlugin(["push", "--dir", dir], confirmed.cli);
		expect(second.code).toBe(0);
		expect(confirmed.out).toEqual([
			expect.stringMatching(/^Created login \(frame 100:\d+\)$/),
			"Pushed to “Sample App”, page “Screens”.",
		]);
		expect(existsSync(join(dir, "sync/screens/login.json"))).toBe(true);
	});

	test("push --yes links without asking; pull then finds nothing to merge", async () => {
		const dir = await writeFixtureProject();
		const pushed = io();
		expect(
			(await withPlugin(["push", "--dir", dir, "--yes"], pushed.cli)).code,
		).toBe(0);
		const before = await readFile(join(dir, "screens/login.html"), "utf8");
		// Each fake plugin has its own document, which knows the Link ID but
		// has none of the first one's frames.
		const { linkId } = JSON.parse(
			await readFile(join(dir, "sync/link.json"), "utf8"),
		);
		const pulled = io();
		const { code } = await withPlugin(
			["pull", "--dir", dir],
			pulled.cli,
			linkId,
		);
		// This fake plugin has no frames, so the Screen's frame reads as deleted.
		expect(code).toBe(0);
		expect(pulled.out).toEqual(["login: missing"]);
		expect(await readFile(join(dir, "screens/login.html"), "utf8")).toBe(
			before,
		);
	});

	test("push refuses a Screen that fails Check", async () => {
		const dir = await writeFixtureProject({ "screens/bad.html": "<p>Hi</p>" });
		const { cli, err } = io();
		expect((await withPlugin(["push", "--dir", dir, "--yes"], cli)).code).toBe(
			1,
		);
		expect(err.join("\n")).toContain("screens/bad.html:1 [single-root]");
	});

	test("push explains when the bridge's port is taken", async () => {
		const taken = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response(),
		});
		const { cli, err } = io();
		const code = await runCli(
			[
				"push",
				"--dir",
				await writeFixtureProject(),
				"--port",
				String(taken.port),
			],
			cli,
		);
		taken.stop(true);
		expect(code).toBe(1);
		expect(err.join("\n")).toContain(
			"If the MCP server is running, it holds that port",
		);
	});

	test("prints usage for an unknown command", async () => {
		const { cli, err } = io();
		expect(await runCli(["frobnicate"], cli)).toBe(1);
		expect(err[0]).toContain("Usage: figma-agent-tool");
	});
});
