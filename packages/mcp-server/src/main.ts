#!/usr/bin/env bun
// MCP server entry point: stdio transport for the MCP client, plus the
// localhost WebSocket bridge the Figma plugin connects to. stdout belongs to
// the MCP protocol, so all logging goes to stderr.
import { DEFAULT_BRIDGE_PORT } from "@figma-agent-tool/protocol";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BRIDGE_HOSTNAME, startBridge } from "./bridge";
import { createMcpServer } from "./server";

const port = Number(process.env.FIGMA_AGENT_BRIDGE_PORT ?? DEFAULT_BRIDGE_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
	console.error(
		`Invalid FIGMA_AGENT_BRIDGE_PORT: ${process.env.FIGMA_AGENT_BRIDGE_PORT}`,
	);
	process.exit(1);
}

const bridge = startBridge({ port });
console.error(`[bridge] listening on ws://${BRIDGE_HOSTNAME}:${bridge.port}`);

const server = createMcpServer({ bridge });
await server.connect(new StdioServerTransport());

async function shutdown() {
	await server.close();
	await bridge.stop();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);
