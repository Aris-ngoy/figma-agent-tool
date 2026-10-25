#!/usr/bin/env bun
// The CLI: the same Design Project workflow as the MCP tools, for harnesses
// without MCP, scripts and CI. Push, Pull and relink host the plugin bridge
// themselves for the length of the command, so the MCP server mustn't be
// holding its port at the same time.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
	checkProject,
	chooseDirection,
	DEFAULT_DESIGN_DIR,
	DesignProjectError,
	directionName,
	initProject,
	loadProject,
} from "@figma-agent-tool/design-project";
import {
	exportNote,
	RenderError,
	renderScreen,
	startPreview,
} from "@figma-agent-tool/preview";
import { DEFAULT_BRIDGE_PORT, type FileInfo } from "@figma-agent-tool/protocol";
import { type Bridge, BridgeRequestError, startBridge } from "./bridge";
import {
	DesignSyncError,
	findDirection,
	formatCheckError,
	pullDesignProject,
	pushDesignProject,
	pushDirections,
	relinkDesignProject,
} from "./design-sync";

export type CliIo = {
	out: (line: string) => void;
	err: (line: string) => void;
	/** Asks a yes/no question; absent when there's no terminal to ask on. */
	confirm?: (question: string) => Promise<boolean>;
	env?: Record<string, string | undefined>;
};

const USAGE = `Usage: figma-agent-tool <command> [options]

Commands:
  init [--size 393x852]     Create a Design Project
  check                     Check Screens, DESIGN.md and modes.yaml
  render <screen> [--direction <direction>] [--mode <mode>] [--out <file.png>]
                            Render a Screen (or one of its Directions) as the
                            Preview shows it, in a Mode
  preview [--port 4321]     Serve the Preview, reloading on every change
  choose <screen> <direction>
                            Make a Direction the Screen, deleting the others
  push [<screen>...] [--directions] [--yes]
                            Push Screens to the Linked File (--yes confirms
                            linking the Bridged File on the first Push);
                            --directions copies their Directions to the
                            Explorations Page instead
  pull                      Pull designers' edits into the Screens
  relink [--yes]            Link the Design Project to the Bridged File instead
  mcp                       Run the MCP server on stdio

Options:
  --dir <folder>            The Design Project (default: ${DEFAULT_DESIGN_DIR}, or FIGMA_AGENT_DESIGN_DIR)
  --port <port>             For push, pull and relink: the plugin bridge's port (default ${DEFAULT_BRIDGE_PORT})
  --wait <seconds>          For push, pull and relink: how long to wait for the plugin (default 60)
`;

type Args = { positional: string[]; flags: Map<string, string | true> };

function parseArgs(argv: string[]): Args {
	const positional: string[] = [];
	const flags = new Map<string, string | true>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const name = arg.slice(2);
		const next = argv[i + 1];
		if (
			["yes", "help", "directions"].includes(name) ||
			next === undefined ||
			next.startsWith("--")
		) {
			flags.set(name, true);
		} else {
			flags.set(name, next);
			i++;
		}
	}
	return { positional, flags };
}

/** Runs one CLI command; resolves to the exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
	const { positional, flags } = parseArgs(argv);
	const [command, ...rest] = positional;
	const env = io.env ?? process.env;
	const dir = String(
		flags.get("dir") ?? env.FIGMA_AGENT_DESIGN_DIR ?? DEFAULT_DESIGN_DIR,
	);
	if (!command || flags.has("help")) {
		(command ? io.out : io.err)(USAGE);
		return command ? 0 : 1;
	}
	try {
		switch (command) {
			case "init":
				return await init(dir, flags, io);
			case "check":
				return await check(dir, io);
			case "render":
				return await render(dir, rest[0], flags, io);
			case "preview":
				return await preview(dir, flags, io);
			case "choose":
				return await choose(dir, rest, io);
			case "push":
				return await withBridge(flags, env, io, (bridge) =>
					flags.has("directions")
						? pushExplorations(dir, bridge, rest, flags.has("yes"), io)
						: push(dir, bridge, rest, flags.has("yes"), io),
				);
			case "pull":
				return await withBridge(flags, env, io, (bridge) =>
					pull(dir, bridge, io),
				);
			case "relink":
				return await withBridge(flags, env, io, (bridge) =>
					relink(dir, bridge, flags.has("yes"), io),
				);
			case "mcp":
				await import("./main");
				return await new Promise<number>(() => {});
			default:
				io.err(`Unknown command "${command}".\n\n${USAGE}`);
				return 1;
		}
	} catch (error) {
		if (
			error instanceof DesignProjectError ||
			error instanceof DesignSyncError ||
			error instanceof BridgeRequestError ||
			error instanceof RenderError
		) {
			io.err(error.message);
			return 1;
		}
		throw error;
	}
}

async function init(
	dir: string,
	flags: Args["flags"],
	io: CliIo,
): Promise<number> {
	const size = flags.get("size");
	const match = typeof size === "string" ? /^(\d+)x(\d+)$/.exec(size) : null;
	if (size && !match) {
		io.err(`--size takes WIDTHxHEIGHT in px, like 393x852.`);
		return 1;
	}
	const screenSize = match
		? { width: Number(match[1]), height: Number(match[2]) }
		: undefined;
	const { dir: created, created: files } = await initProject(dir, {
		screenSize,
	});
	io.out(`Created a Design Project in ${created}: ${files.join(", ")}`);
	return 0;
}

async function check(dir: string, io: CliIo): Promise<number> {
	const project = await loadProject(dir);
	const { errors, warnings } = await checkProject(project);
	for (const error of errors) {
		io.out(formatCheckError(error));
	}
	for (const warning of warnings) {
		io.out(`warning: ${formatCheckError(warning)}`);
	}
	const warned =
		warnings.length > 0 ? `, ${plural(warnings.length, "warning")}` : "";
	const directions =
		project.directions.length > 0
			? `, ${plural(project.directions.length, "Direction")}`
			: "";
	io.out(
		errors.length === 0
			? `${plural(project.screens.length, "Screen")}${directions} and DESIGN.md checked: no errors${warned}.`
			: `${errors.length} error${errors.length === 1 ? "" : "s"}${warned}.`,
	);
	return errors.length === 0 ? 0 : 1;
}

const plural = (count: number, noun: string) =>
	`${count} ${noun}${count === 1 ? "" : "s"}`;

async function render(
	dir: string,
	name: string | undefined,
	flags: Args["flags"],
	io: CliIo,
): Promise<number> {
	const project = await loadProject(dir);
	const found = project.screens.find((s) => s.name === name);
	if (!found || name === undefined) {
		io.err(
			`Name a Screen to render: ${project.screens.map((s) => s.name).join(", ") || "the Design Project has none"}.`,
		);
		return 1;
	}
	const mode = flags.get("mode");
	const direction = flags.get("direction");
	if (mode === true || direction === true) {
		io.err(
			mode === true
				? `--mode takes a Mode's name: ${project.modes.names.join(", ")}.`
				: "--direction takes a Direction's name.",
		);
		return 1;
	}
	const screen = direction ? findDirection(project, name, direction) : found;
	const { png, width, height, figmaOwned } = await renderScreen(
		project,
		screen,
		{ mode },
	);
	let defaultOut = name;
	if (direction) defaultOut += `-${direction}`;
	if (mode) defaultOut += `-${mode}`;
	defaultOut += ".png";
	const out = resolve(String(flags.get("out") ?? defaultOut));
	await writeFile(out, png);
	io.out(`Rendered ${screen.file} at ${width}×${height} to ${out}`);
	for (const owned of figmaOwned) {
		const note = exportNote(owned);
		if (note) io.out(`  ${note}`);
	}
	return 0;
}

async function preview(
	dir: string,
	flags: Args["flags"],
	io: CliIo,
): Promise<number> {
	await loadProject(dir);
	const port = flags.has("port") ? Number(flags.get("port")) : undefined;
	const server = startPreview({ dir, port });
	io.out(`Preview of ${resolve(dir)} at ${server.url} (Ctrl+C to stop)`);
	return new Promise<number>(() => {});
}

async function choose(
	dir: string,
	[screen, name]: string[],
	io: CliIo,
): Promise<number> {
	if (!screen || !name) {
		io.err(
			"choose takes a Screen and one of its Directions: choose <screen> <direction>.",
		);
		return 1;
	}
	const project = await loadProject(dir);
	const { file, chose, discarded } = await chooseDirection(
		project,
		findDirection(project, screen, name),
	);
	const deleted =
		discarded.length > 0
			? `; deleted the Directions ${discarded.join(", ")}`
			: "";
	io.out(`${chose} is now the ${screen} Screen (${file})${deleted}.`);
	return 0;
}

async function withBridge(
	flags: Args["flags"],
	env: Record<string, string | undefined>,
	io: CliIo,
	run: (bridge: Bridge) => Promise<number>,
): Promise<number> {
	const port = Number(
		flags.get("port") ?? env.FIGMA_AGENT_BRIDGE_PORT ?? DEFAULT_BRIDGE_PORT,
	);
	const waitMs = Number(flags.get("wait") ?? 60) * 1000;
	let bridge: Bridge;
	try {
		bridge = startBridge({ port, log: () => {} });
	} catch (error) {
		io.err(
			`Can't host the plugin bridge on port ${port} (${(error as Error).message}). If the MCP server is running, it holds that port: use its push and pull tools, or stop it first.`,
		);
		return 1;
	}
	try {
		if (!bridge.status().connected) {
			io.err(
				`Waiting for the Figma plugin on ws://localhost:${port}… (open it in the Linked File)`,
			);
			const deadline = Date.now() + waitMs;
			while (!bridge.status().connected) {
				if (Date.now() > deadline) {
					io.err(`The Figma plugin didn't connect within ${waitMs / 1000} s.`);
					return 1;
				}
				await Bun.sleep(100);
			}
		}
		return await run(bridge);
	} finally {
		bridge.stop();
	}
}

/** The user's answer; no without a terminal to ask on. */
async function ask(io: CliIo, question: string): Promise<boolean> {
	return io.confirm ? io.confirm(question) : false;
}

/** Whether the user confirms linking the Bridged File on the first Push. */
async function confirmLink(
	file: FileInfo,
	yes: boolean,
	io: CliIo,
): Promise<boolean> {
	const question = `Link the Design Project to the Bridged File, “${file.name}”? Push and Pull will only work with that file.`;
	const confirmed = yes || (await ask(io, question));
	if (!confirmed)
		io.err(`${question}\nNot linked. Run push again with --yes to confirm.`);
	return confirmed;
}

async function push(
	dir: string,
	bridge: Bridge,
	screens: string[],
	yes: boolean,
	io: CliIo,
): Promise<number> {
	let result = await pushDesignProject(dir, bridge, { screens });
	if (result.status === "confirm_link") {
		if (!(await confirmLink(result.file, yes, io))) return 1;
		result = await pushDesignProject(dir, bridge, {
			screens,
			confirmLink: true,
		});
	}
	if (result.status !== "pushed") return 1;
	for (const screen of result.screens) {
		io.out(
			`${screen.created ? "Created" : "Updated"} ${screen.screen} (frame ${screen.frameId})`,
		);
	}
	io.out(`Pushed to “${result.linkedFile.name}”, page “${result.page.name}”.`);
	return 0;
}

async function pushExplorations(
	dir: string,
	bridge: Bridge,
	screens: string[],
	yes: boolean,
	io: CliIo,
): Promise<number> {
	let result = await pushDirections(dir, bridge, { screens });
	if (result.status === "confirm_link") {
		if (!(await confirmLink(result.file, yes, io))) return 1;
		result = await pushDirections(dir, bridge, { screens, confirmLink: true });
	}
	if (result.status !== "pushed_directions") return 1;
	for (const { screen, directions } of result.screens) {
		for (const { direction, frameId } of directions) {
			io.out(`Copied ${directionName(screen, direction)} (frame ${frameId})`);
		}
	}
	io.out(
		`Pushed Directions to “${result.linkedFile.name}”, page “${result.page.name}”.`,
	);
	return 0;
}

async function pull(dir: string, bridge: Bridge, io: CliIo): Promise<number> {
	const result = await pullDesignProject(dir, bridge);
	const { designSystem } = result;
	if (designSystem.status !== "not_pushed") {
		const conflicts =
			designSystem.conflicts > 0
				? `, ${designSystem.conflicts} Sync Conflict${designSystem.conflicts === 1 ? "" : "s"}`
				: "";
		const changed =
			designSystem.changed.length > 0
				? ` (${designSystem.changed.join(", ")})`
				: "";
		io.out(`DESIGN.md: ${designSystem.status}${changed}${conflicts}`);
	}
	for (const screen of result.screens) {
		const conflicts =
			screen.conflicts > 0
				? `, ${screen.conflicts} Sync Conflict${screen.conflicts === 1 ? "" : "s"}`
				: "";
		io.out(`${screen.screen}: ${screen.status}${conflicts}`);
		for (const layer of screen.figmaOwned) {
			io.out(
				`  ${layer.key ? `Figma-owned Element ${layer.key}` : "kept in Figma"}: “${layer.name}” (${layer.nodeId}) ${layer.reason}`,
			);
		}
	}
	if (result.conflicts > 0) {
		io.out(
			"Resolve the Sync Conflict markers (keep one side, delete the marker lines), then push.",
		);
	}
	return 0;
}

async function relink(
	dir: string,
	bridge: Bridge,
	yes: boolean,
	io: CliIo,
): Promise<number> {
	const status = bridge.status();
	const name = status.connected ? status.file.name : "the Bridged File";
	const question = `Relink the Design Project to “${name}”? The next Push creates new frames there.`;
	const confirmed = yes || (await ask(io, question));
	if (!confirmed) {
		io.err(
			`${question}\nNot relinked. Run relink again with --yes to confirm.`,
		);
		return 1;
	}
	const { linkedFile } = await relinkDesignProject(dir, bridge);
	io.out(`Linked to “${linkedFile.name}”.`);
	return 0;
}

if (import.meta.main) {
	const confirm = process.stdin.isTTY
		? async (question: string) => {
				const prompt = createInterface({
					input: process.stdin,
					output: process.stderr,
				});
				const answer = await prompt.question(`${question} [y/N] `);
				prompt.close();
				return /^y(es)?$/i.test(answer.trim());
			}
		: undefined;
	const code = await runCli(process.argv.slice(2), {
		out: (line) => console.log(line),
		err: (line) => console.error(line),
		confirm,
	});
	process.exit(code);
}
