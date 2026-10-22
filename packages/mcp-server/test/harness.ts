// Seam 1 harness: the real MCP server and bridge, driven by an in-memory MCP
// client, with a fake plugin that speaks the real protocol over WebSocket.
import { afterEach } from "bun:test";
import {
	commands,
	type Handshake,
	isFrameType,
	parseServerMessage,
	type Response,
	type SerializedNode,
	type ServerMessage,
} from "@figma-agent-tool/protocol";
import {
	document,
	findNode,
	handshake as handshakeFixture,
	limitDepth,
	nodeNotFoundResponse,
	pageNotFoundResponse,
	pingResponse,
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
}: {
	setup?: (server: McpServer, bridge: Bridge) => void;
} = {}) {
	const bridge = startBridge({ port: 0 });
	cleanups.push(() => bridge.stop());

	const server = createMcpServer({ bridge });
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

/** Answers server requests from the shared document and message fixtures. */
function answer(message: ServerMessage): Response | undefined {
	if (message.type !== "request") return undefined;
	const { id } = message;
	const ok = (result: unknown): Response => ({
		type: "response",
		id,
		ok: true,
		result,
	});
	const currentPage = document.pages.find(
		(page) => page.id === document.currentPageId,
	);
	const pageRef = (page: { id: string; name: string }) => ({
		id: page.id,
		name: page.name,
	});
	switch (message.command) {
		case "ping":
			return { ...pingResponse, id };
		case "get_selection": {
			const { depth } = commands.get_selection.params.parse(message.params);
			return ok({
				page: currentPage && pageRef(currentPage),
				nodes: document.selection.map((nodeId) =>
					limitDepth(findNode(nodeId) as SerializedNode, depth),
				),
			});
		}
		case "get_node": {
			const params = commands.get_node.params.parse(message.params);
			const node = findNode(params.id);
			if (!node) return nodeNotFoundResponse(id, params.id);
			return ok({ node: limitDepth(node, params.depth) });
		}
		case "list_pages":
			return ok({
				pages: document.pages.map((page) => ({
					...pageRef(page),
					current: page.id === document.currentPageId,
				})),
			});
		case "list_frames": {
			const { pageId = document.currentPageId } =
				commands.list_frames.params.parse(message.params);
			const page = document.pages.find((p) => p.id === pageId);
			if (!page) return pageNotFoundResponse(id, pageId);
			return ok({
				page: pageRef(page),
				frames: page.children
					.filter((node) => isFrameType(node.type))
					.map(({ id, name, type, x, y, width, height }) => ({
						id,
						name,
						type,
						x,
						y,
						width,
						height,
					})),
			});
		}
	}
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
