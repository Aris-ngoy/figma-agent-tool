#!/usr/bin/env bun
// MCP server entry point: stdio transport for the MCP client, plus the
// localhost WebSocket bridge the Figma plugin connects to. stdout belongs to
// the MCP protocol, so all logging goes to stderr.
import { DEFAULT_BRIDGE_PORT } from "@figma-agent-tool/protocol";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	BRIDGE_HOSTNAME,
	DEFAULT_REQUEST_TIMEOUT_MS,
	startBridge,
} from "./bridge";
import { createMcpServer } from "./server";

function integerEnv(
	name: string,
	fallback: number,
	{ min, max }: { min: number; max: number },
): number {
	const raw = process.env[name];
	const value = Number(raw ?? fallback);
	if (!Number.isInteger(value) || value < min || value > max) {
		console.error(`Invalid ${name}: ${raw}`);
		process.exit(1);
	}
	return value;
}

const bridge = startBridge({
	port: integerEnv("FIGMA_AGENT_BRIDGE_PORT", DEFAULT_BRIDGE_PORT, {
		min: 0,
		max: 65535,
	}),
	requestTimeoutMs: integerEnv(
		"FIGMA_AGENT_REQUEST_TIMEOUT_MS",
		DEFAULT_REQUEST_TIMEOUT_MS,
		// setTimeout's ceiling.
		{ min: 1, max: 2_147_483_647 },
	),
});
console.error(`[bridge] listening on ws://${BRIDGE_HOSTNAME}:${bridge.port}`);

const server = createMcpServer({
	bridge,
	artifactsDir: process.env.FIGMA_AGENT_ARTIFACTS_DIR || undefined,
});
await server.connect(new StdioServerTransport());

async function shutdown() {
	await server.close();
	bridge.stop();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);
