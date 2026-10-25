#!/usr/bin/env node
// The `figma-agent-tool` bin: the CLI, whose `mcp` command runs the MCP
// server. Bundled for Node, so it runs with npx without Bun.
import { createInterface } from "node:readline/promises";
import { runCli } from "./cli";

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
