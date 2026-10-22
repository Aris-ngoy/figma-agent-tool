// Seam 1 harness: the real MCP server and bridge, driven by an in-memory MCP
// client, with a fake plugin that speaks the real protocol over WebSocket.
import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Handshake,
	parseServerMessage,
	type Response,
	type ServerMessage,
} from "@figma-agent-tool/protocol";
import {
	document,
	exchanges,
	handshake as handshakeFixture,
} from "@figma-agent-tool/protocol/fixtures";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Bridge, startBridge } from "../src/bridge";
import { createMcpServer } from "../src/server";

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export async function startHarness({
	setup,
	artifactsDir,
}: {
	setup?: (server: McpServer, bridge: Bridge) => void;
	artifactsDir?: string;
} = {}) {
	const bridge = startBridge({ port: 0 });
	cleanups.push(() => bridge.stop());

	const scratch = await mkdtemp(join(tmpdir(), "figma-agent-test-"));
	cleanups.push(() => rm(scratch, { recursive: true, force: true }));
	artifactsDir ??= join(scratch, "artifacts");

	const server = createMcpServer({ bridge, artifactsDir });
	setup?.(server, bridge);
	const client = new Client({ name: "test-client", version: "0.0.0" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	cleanups.push(() => client.close());

	return {
		bridge,
		client,
		artifactsDir,
		async callTool(name: string, args: Record<string, unknown> = {}) {
			return client.callTool({ name, arguments: args });
		},
		async connectFakePlugin(handshake: Handshake = handshakeFixture) {
			const plugin = await connectFakePlugin(bridge.port, handshake);
			cleanups.push(() => plugin.close());
			return plugin;
		},
	};
}

/** Answers server requests by replaying the shared message fixtures. */
function answer(message: ServerMessage): Response | undefined {
	if (message.type !== "request") return undefined;
	const exchange = exchanges.find(
		([request]) =>
			request.command === message.command &&
			Bun.deepEquals(request.params, message.params),
	);
	if (!exchange) {
		return {
			type: "response",
			id: message.id,
			ok: false,
			error: {
				code: "no_fixture",
				message: `Fake plugin has no fixture for ${message.command} ${JSON.stringify(message.params)}`,
			},
		};
	}
	return { ...exchange[1], id: message.id };
}

async function connectFakePlugin(port: number, handshake: Handshake) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}`);
	const acknowledged = new Promise<void>((resolve, reject) => {
		socket.addEventListener("error", () => reject(new Error("socket error")));
		socket.addEventListener("message", (event) => {
			const message = parseServerMessage(JSON.parse(String(event.data)));
			if (message.type === "handshake_ack") resolve();
			const response = answer(message);
			if (response) socket.send(JSON.stringify(response));
		});
	});
	await new Promise((resolve) =>
		socket.addEventListener("open", resolve, { once: true }),
	);
	socket.send(JSON.stringify(handshake));
	await acknowledged;

	return {
		document,
		async close() {
			if (socket.readyState === WebSocket.CLOSED) return;
			const closed = new Promise((resolve) =>
				socket.addEventListener("close", resolve, { once: true }),
			);
			socket.close();
			await closed;
		},
	};
}
