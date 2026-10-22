import { describe, expect, test } from "bun:test";
import {
	document,
	findNode,
	getNodeRequest,
	getNodeResponse,
	getUnknownNodeRequest,
	getUnknownNodeResponse,
	handshake,
	limitDepth,
	listPagesRequest,
	listPagesResponse,
	pageNotFoundResponse,
	pingRequest,
	pingResponse,
} from "@figma-agent-tool/protocol/fixtures";
import { createCommandHandler } from "../src/handler";
import { installMockFigma } from "./mock-figma";

const pluginVersion = handshake.pluginVersion;

describe("plugin command handler", () => {
	test("builds the handshake from the open file", () => {
		installMockFigma(document);
		expect(createCommandHandler({ pluginVersion }).handshake()).toEqual(
			handshake,
		);
	});

	test("reports a null file key when Figma withholds it", () => {
		installMockFigma({ ...document, fileKey: undefined as never });
		expect(createCommandHandler({ pluginVersion }).handshake().file).toEqual({
			key: null,
			name: document.name,
		});
	});

	test("answers a ping request with the correlated response", async () => {
		installMockFigma(document);
		expect(
			await createCommandHandler({ pluginVersion }).handle(pingRequest),
		).toEqual(pingResponse);
	});

	test("answers an unknown command with an error response", async () => {
		installMockFigma(document);
		const response = await createCommandHandler({ pluginVersion }).handle({
			...pingRequest,
			command: "does_not_exist",
		});
		expect(response).toMatchObject({
			type: "response",
			id: pingRequest.id,
			ok: false,
			error: { code: "invalid_request" },
		});
	});
});

function request(command: string, params: unknown, id = "req-x") {
	return { type: "request", id, command, params };
}

async function handle(command: string, params: unknown) {
	installMockFigma(document);
	const response = await createCommandHandler({ pluginVersion }).handle(
		request(command, params),
	);
	if (!response.ok) throw new Error(response.error.message);
	return response.result;
}

describe("reading the document", () => {
	test("answers get_node with the node cut off at the requested depth", async () => {
		installMockFigma(document);
		expect(
			await createCommandHandler({ pluginVersion }).handle(getNodeRequest),
		).toEqual(getNodeResponse);
	});

	test("serializes every fixture node identically at full depth", async () => {
		for (const page of document.pages) {
			for (const node of page.children) {
				expect(await handle("get_node", { id: node.id, depth: 100 })).toEqual({
					node,
				});
			}
		}
	});

	test("reads a node on a page that isn't loaded yet", async () => {
		expect(await handle("get_node", { id: "0:2", depth: 1 })).toEqual({
			node: limitDepth(findNode("0:2") as never, 1),
		});
	});

	test("answers an unknown node ID with a node_not_found error", async () => {
		installMockFigma(document);
		expect(
			await createCommandHandler({ pluginVersion }).handle(
				getUnknownNodeRequest,
			),
		).toEqual(getUnknownNodeResponse);
	});

	test("answers get_selection with the selected subtrees", async () => {
		expect(await handle("get_selection", { depth: 1 })).toEqual({
			page: { id: "0:1", name: "Screens" },
			nodes: document.selection.map((id) =>
				limitDepth(findNode(id) as never, 1),
			),
		});
	});

	test("answers an empty selection with no nodes", async () => {
		installMockFigma({ ...document, selection: [] });
		const response = await createCommandHandler({ pluginVersion }).handle(
			request("get_selection", { depth: 1 }),
		);
		expect(response).toMatchObject({ ok: true, result: { nodes: [] } });
	});

	test("answers list_pages with every page", async () => {
		installMockFigma(document);
		expect(
			await createCommandHandler({ pluginVersion }).handle(listPagesRequest),
		).toEqual(listPagesResponse);
	});

	test("answers list_frames with the current page's top-level frames", async () => {
		expect(await handle("list_frames", {})).toEqual({
			page: { id: "0:1", name: "Screens" },
			frames: [
				{
					id: "1:1",
					name: "Login",
					type: "FRAME",
					x: 0,
					y: 0,
					width: 393,
					height: 852,
				},
				{
					id: "1:10",
					name: "Home",
					type: "FRAME",
					x: 493,
					y: 0,
					width: 393,
					height: 852,
				},
			],
		});
	});

	test("answers list_frames for another page after loading it", async () => {
		expect(await handle("list_frames", { pageId: "0:2" })).toEqual({
			page: { id: "0:2", name: "Components" },
			frames: [
				{
					id: "2:1",
					name: "Button",
					type: "COMPONENT",
					x: 0,
					y: 0,
					width: 120,
					height: 48,
				},
			],
		});
	});

	test("answers list_frames for a non-page ID with a page_not_found error", async () => {
		installMockFigma(document);
		const id = "req-5";
		expect(
			await createCommandHandler({ pluginVersion }).handle(
				request("list_frames", { pageId: "1:1" }, id),
			),
		).toEqual(pageNotFoundResponse(id, "1:1"));
	});
});
