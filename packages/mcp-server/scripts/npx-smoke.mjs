// Runs the packed figma-agent-tool tarball with npx on Node, without Bun:
// init, skill, check, render (when FIGMA_AGENT_CHROME is set), preview, and
// the MCP server with a plugin connecting to its bridge. CI runs it on Node
// LTS; locally: `bun run build && bun pm pack --destination /tmp/pack`, then
// `node scripts/npx-smoke.mjs /tmp/pack/figma-agent-tool-<version>.tgz`.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const tarball = resolve(process.argv[2] ?? "");
assert.ok(existsSync(tarball), "Pass the packed tarball's path.");
const work = mkdtempSync(join(tmpdir(), "npx-smoke-"));

// Bun mustn't be what runs the package: drop it from the PATH.
const PATH = (process.env.PATH ?? "")
	.split(delimiter)
	.filter((dir) => !existsSync(join(dir, "bun")))
	.join(delimiter);
const env = { ...process.env, PATH, npm_config_yes: "true" };
assert.equal(
	spawnSync("bun", ["--version"], { env }).error?.code,
	"ENOENT",
	"bun is still on the PATH",
);

const npx = ["--yes", "--package", tarball, "figma-agent-tool"];

function cli(args, expectedCode = 0) {
	const run = spawnSync("npx", [...npx, ...args], {
		cwd: work,
		env,
		encoding: "utf8",
	});
	const output = `${run.stdout}${run.stderr}`;
	assert.equal(run.status, expectedCode, `${args.join(" ")}:\n${output}`);
	console.log(`ok: figma-agent-tool ${args.join(" ")}`);
	return output;
}

/** Starts a long-running command; resolves once a line matches `ready`. */
function start(args, ready, extraEnv = {}) {
	const child = spawn("npx", [...npx, ...args], {
		cwd: work,
		env: { ...env, ...extraEnv },
		stdio: ["pipe", "pipe", "pipe"],
		// Its own process group, so that stop() ends npx's child too.
		detached: true,
	});
	const stop = () => process.kill(-child.pid);
	const err = createInterface({ input: child.stderr });
	const out = createInterface({ input: child.stdout });
	const match = new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${args[0]} didn't start`)),
			60_000,
		);
		for (const stream of [err, out]) {
			stream.on("line", (line) => {
				const found = ready.exec(line);
				if (found) {
					clearTimeout(timer);
					resolve(found);
				}
			});
		}
		child.on("exit", (code) => reject(new Error(`${args[0]} exited ${code}`)));
	});
	return { child, out, match, stop };
}

const screen = `<body style="display:flex; flex-direction:column; gap:var(--spacing-md); padding:var(--spacing-lg); background:var(--colors-surface)">
  <h1 style="font-size:28px; font-weight:700; color:var(--colors-text)">Welcome back</h1>
  <div style="display:flex; justify-content:center; align-self:stretch; padding:12px 16px; background:var(--colors-primary); border-radius:var(--rounded-md)">
    <p style="color:var(--colors-on-primary)">Sign in</p>
  </div>
</body>
`;

try {
	assert.match(cli(["init"]), /Created a Design Project/);
	cli(["skill"]);
	assert.match(
		readFileSync(
			join(work, ".claude/skills/figma-agent-tool/SKILL.md"),
			"utf8",
		),
		/^---\nname: figma-agent-tool\n/,
	);

	writeFileSync(join(work, "design/screens/login.html"), screen);
	assert.match(cli(["check"]), /1 Screen and DESIGN.md checked: no errors/);
	writeFileSync(
		join(work, "design/screens/bad.html"),
		'<body style="display:flex">\n  <table></table>\n</body>\n',
	);
	assert.match(cli(["check"], 1), /unknown-element/);
	rmSync(join(work, "design/screens/bad.html"));

	if (process.env.FIGMA_AGENT_CHROME) {
		cli(["render", "login", "--out", "login.png"]);
		const png = readFileSync(join(work, "login.png"));
		assert.equal(png.subarray(1, 4).toString(), "PNG");
	} else {
		console.log("skipped: render (set FIGMA_AGENT_CHROME)");
	}

	const preview = start(["preview", "--port", "0"], /at (http:\S+)/);
	const [, url] = await preview.match;
	const page = await (await fetch(`${url}screens/login`)).text();
	assert.match(page, /Welcome back/);
	preview.stop();
	console.log("ok: figma-agent-tool preview");

	await mcp();
	console.log("npx smoke test passed");
} finally {
	rmSync(work, { recursive: true, force: true });
}

/** The MCP server on stdio: its instructions, and a plugin connecting to its bridge. */
async function mcp() {
	const server = start(["mcp"], /listening on ws:\/\/127\.0\.0\.1:(\d+)/, {
		FIGMA_AGENT_BRIDGE_PORT: "0",
	});
	const [, port] = await server.match;
	const replies = new Map();
	server.out.on("line", (line) => {
		const message = JSON.parse(line);
		replies.get(message.id)?.(message);
	});
	let id = 0;
	const call = (method, params) =>
		new Promise((resolve) => {
			replies.set(++id, resolve);
			server.child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
			);
		});
	const status = async () =>
		JSON.parse(
			(await call("tools/call", { name: "get_status", arguments: {} })).result
				.content[0].text,
		);

	const { result } = await call("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "npx-smoke", version: "0.0.0" },
	});
	assert.match(result.instructions, /Pull before you edit or Push/);
	server.child.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
	);
	assert.equal((await status()).bridge.connected, false);

	const plugin = new WebSocket(`ws://127.0.0.1:${port}`);
	await new Promise((resolve, reject) => {
		plugin.onopen = resolve;
		plugin.onerror = reject;
	});
	const acked = new Promise((resolve) => {
		plugin.onmessage = (event) => resolve(JSON.parse(event.data));
	});
	plugin.send(
		JSON.stringify({
			type: "handshake",
			protocolVersion: 1,
			pluginVersion: "0.0.0",
			file: { key: "smoke", name: "Smoke file" },
			capabilities: { motion: false },
			linkId: null,
		}),
	);
	assert.equal((await acked).type, "handshake_ack");
	const connected = await status();
	assert.equal(connected.bridge.connected, true);
	assert.equal(connected.bridge.file.name, "Smoke file");
	assert.deepEqual(connected.designProject.screens, ["login"]);
	plugin.close();
	server.stop();
	console.log("ok: figma-agent-tool mcp");
}
