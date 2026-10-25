// Seam 1 harness: the real MCP server and bridge, driven by an in-memory MCP
// client, with a fake plugin that speaks the real protocol over WebSocket.
import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesignerFile } from "@figma-agent-tool/design-project/fixtures";
import type { Screenshotter } from "@figma-agent-tool/preview";
import {
	type BridgeError,
	commands,
	type Handshake,
	isFrameType,
	parseServerMessage,
	type Request,
	type Response,
	type SerializedNode,
	type ServerMessage,
} from "@figma-agent-tool/protocol";
import {
	createdNodeId,
	type DocumentFixture,
	document,
	exchanges,
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
import { createYoqaRunner } from "../src/yoqa-runner";
import { createFakeEditor } from "./fake-edits";
import { createFakeFlows } from "./fake-flows";
import { createFakeMotion } from "./fake-motion";
import { createFakeReactions } from "./fake-reactions";
import { createFakeRestructure } from "./fake-restructure";
import { createFakeScreens } from "./fake-screens";
import { startFakeYoqa } from "./fake-yoqa";

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export async function startHarness({
	setup,
	requestTimeoutMs,
	artifactsDir,
	designDir,
	screenshot,
	yoqaRunning = true,
}: {
	setup?: (server: McpServer, bridge: Bridge) => void;
	requestTimeoutMs?: number;
	artifactsDir?: string;
	/** The Design Project's folder; an empty scratch folder by default. */
	designDir?: string;
	screenshot?: Screenshotter;
	/** When false, the runner URL points at a port nothing listens on. */
	yoqaRunning?: boolean;
} = {}) {
	const logs: string[] = [];
	const bridge = startBridge({
		port: 0,
		requestTimeoutMs,
		log: (message) => logs.push(message),
	});
	cleanups.push(() => bridge.stop());

	const scratch = await mkdtemp(join(tmpdir(), "figma-agent-test-"));
	cleanups.push(() => rm(scratch, { recursive: true, force: true }));
	artifactsDir ??= join(scratch, "artifacts");
	designDir ??= join(scratch, "design");

	const yoqa = startFakeYoqa();
	cleanups.push(() => yoqa.stop());
	if (!yoqaRunning) yoqa.stop();
	const deviceRunner = createYoqaRunner({ baseUrl: yoqa.url });

	const server = createMcpServer({
		bridge,
		artifactsDir,
		designDir,
		deviceRunner,
		screenshot,
	});
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
		/** Everything the bridge logged, in order. */
		logs,
		artifactsDir,
		designDir,
		yoqa,
		async callTool(name: string, args: Record<string, unknown> = {}) {
			return client.callTool({ name, arguments: args });
		},
		async connectFakePlugin(options: FakePluginOptions = {}) {
			const plugin = await connectFakePlugin(bridge.port, options);
			cleanups.push(() => plugin.close());
			return plugin;
		},
	};
}

type FakeDocument = {
	document: DocumentFixture;
	editor: ReturnType<typeof createFakeEditor>;
	reactions: ReturnType<typeof createFakeReactions>;
	flows: ReturnType<typeof createFakeFlows>;
	motion: ReturnType<typeof createFakeMotion>;
	restructure: ReturnType<typeof createFakeRestructure>;
	screens: ReturnType<typeof createFakeScreens>;
};

/** A copy of the document fixture that this fake plugin's edits change. */
function fakeDocument(): FakeDocument {
	const copy = structuredClone(document);
	let created = 0;
	const nextId = () => createdNodeId(++created);
	const screens = createFakeScreens(copy, nextId);
	return {
		document: copy,
		editor: createFakeEditor(copy, nextId),
		reactions: createFakeReactions(copy),
		flows: createFakeFlows(copy, screens.frames),
		motion: createFakeMotion(copy),
		restructure: createFakeRestructure(copy, nextId),
		screens,
	};
}

/** Answers server requests from the plugin's document and the fixtures. */
function answer(
	message: ServerMessage,
	{
		document,
		editor,
		reactions,
		flows,
		motion,
		restructure,
		screens,
	}: FakeDocument,
	exportPng: FakePluginOptions["exportPng"],
): Response | undefined {
	if (message.type !== "request") return undefined;
	const { id } = message;
	const ok = (result: unknown): Response => ({
		type: "response",
		id,
		ok: true,
		result,
	});
	const okOrFailure = (result: object | BridgeError): Response =>
		"code" in result
			? { type: "response", id, ok: false, error: result }
			: ok(result);
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
					limitDepth(findNode(nodeId, document) as SerializedNode, depth),
				),
			});
		}
		case "get_node": {
			const params = commands.get_node.params.parse(message.params);
			const node = findNode(params.id, document);
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
		case "create_nodes":
			return okOrFailure(
				editor.create_nodes(commands.create_nodes.params.parse(message.params)),
			);
		case "update_nodes":
			return ok(
				editor.update_nodes(commands.update_nodes.params.parse(message.params)),
			);
		case "delete_nodes":
		case "duplicate_node":
		case "reparent_nodes":
		case "group_nodes":
		case "ungroup_nodes": {
			const { command } = message;
			const params = commands[command].params.parse(message.params);
			const handle = restructure[command] as (params: unknown) => object;
			return okOrFailure(handle(params));
		}
		case "get_reactions":
		case "set_reactions":
		case "remove_reactions": {
			const { command } = message;
			const params = commands[command].params.parse(message.params);
			const handle = reactions[command] as (params: unknown) => object;
			return okOrFailure(handle(params));
		}
		case "export_node_image": {
			const { nodeId, scale } = commands.export_node_image.params.parse(
				message.params,
			);
			const png = exportPng?.(nodeId, scale);
			return png ? ok({ png }) : replayExchange(message);
		}
		case "list_flows":
		case "set_flow_start":
		case "get_flow_nodes": {
			const { command } = message;
			const params = commands[command].params.parse(message.params);
			const handle = flows[command] as (params: unknown) => object;
			return okOrFailure(handle(params));
		}
		case "get_motion":
		case "set_motion": {
			const { command } = message;
			const params = commands[command].params.parse(message.params);
			const handle = motion[command] as (params: unknown) => object;
			return okOrFailure(handle(params));
		}
		case "get_design_system": {
			const designed = screens.get_design_system();
			return designed ? ok(designed) : replayExchange(message);
		}
		case "push_screens":
		case "push_explorations":
		case "read_screens":
		case "read_components":
		case "read_design_system":
		case "link_file":
		case "get_image": {
			const { command } = message;
			const params = commands[command].params.parse(message.params);
			const handle = screens[command] as (params: unknown) => object;
			return okOrFailure(handle(params));
		}
		default:
			return replayExchange(message);
	}
}

/** Answers from the recorded fixture exchanges, matching command + params. */
function replayExchange(message: Request): Response {
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

type FakePluginOptions = {
	handshake?: Handshake;
	/** When false, the plugin receives requests but never answers them. */
	answers?: boolean;
	/** Base64 PNG to export for a node and scale; fixtures otherwise. */
	exportPng?: (nodeId: string, scale: number) => string | undefined;
	/** Loopback address to connect to, as a URL host. */
	host?: string;
	/** Designers' file to be in instead of the document fixture, for Adopt. */
	designerFile?: DesignerFile;
};

/** Connects a fake plugin to a bridge on `port`, such as one the CLI hosts. */
export async function connectFakePlugin(
	port: number,
	{
		handshake = handshakeFixture,
		answers = true,
		exportPng,
		host = "127.0.0.1",
		designerFile,
	}: FakePluginOptions,
) {
	const socket = new WebSocket(`ws://${host}:${port}`);
	const requests: Request[] = [];
	const fake = fakeDocument();
	if (designerFile) fake.screens.addDesignerFile(designerFile);
	const closed = new Promise<CloseEvent>((resolve) =>
		socket.addEventListener("close", resolve, { once: true }),
	);
	const acknowledged = new Promise<void>((resolve, reject) => {
		socket.addEventListener("error", () => reject(new Error("socket error")));
		socket.addEventListener("message", (event) => {
			const message = parseServerMessage(JSON.parse(String(event.data)));
			if (message.type === "handshake_ack") resolve();
			if (message.type === "request") requests.push(message);
			const response = answers ? answer(message, fake, exportPng) : undefined;
			if (response) socket.send(JSON.stringify(response));
		});
	});
	await new Promise((resolve) =>
		socket.addEventListener("open", resolve, { once: true }),
	);
	socket.send(JSON.stringify(handshake));
	await acknowledged;

	return {
		/** This plugin's copy of the document fixture, edits included. */
		document: fake.document,
		/** The frames Push made, which tests edit as a designer would. */
		screens: fake.screens,
		/** Requests the server sent this plugin, in order. */
		requests,
		/** Resolves when the connection closes, from either side. */
		closed,
		async close() {
			if (socket.readyState !== WebSocket.CLOSED) socket.close();
			await closed;
		},
	};
}
