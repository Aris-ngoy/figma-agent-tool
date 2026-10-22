import { describe, expect, test } from "bun:test";
import {
	createdNodeId,
	createNodesRequest,
	document,
	findNode,
	fontNotFoundError,
	updateNodesRequest,
} from "@figma-agent-tool/protocol/fixtures";
import { createCommandHandler } from "../src/handler";
import { installMockFigma } from "./mock-figma";

const pluginVersion = "0.0.0";

/** A mocked file plus a `send` that runs commands through the real handler. */
function plugin() {
	const figma = installMockFigma(document);
	const handler = createCommandHandler({ pluginVersion });
	let n = 0;
	async function send(command: string, params: unknown) {
		return handler.handle({
			type: "request",
			id: `req-${++n}`,
			command,
			params,
		});
	}
	return {
		figma,
		send,
		async result(command: string, params: unknown) {
			const response = await send(command, params);
			if (!response.ok) throw new Error(response.error.message);
			return response.result as Record<string, unknown>;
		},
		async node(id: string, depth = 100) {
			const { node } = await this.result("get_node", { id, depth });
			return node;
		},
	};
}

describe("create_nodes", () => {
	test("builds the nested nodes under the parent, visible through get_node", async () => {
		const figma = plugin();
		await figma.result("create_nodes", createNodesRequest.params);
		const home = (await figma.node("1:10")) as { children: unknown[] };
		expect(home.children).toEqual([
			{
				id: createdNodeId(1),
				name: "Card",
				type: "FRAME",
				x: 0,
				y: 0,
				width: 345,
				height: 200,
				cornerRadius: 16,
				fills: [{ type: "SOLID", color: "#f5f5f5" }],
				layout: {
					mode: "VERTICAL",
					itemSpacing: 12,
					padding: { top: 24, right: 24, bottom: 24, left: 24 },
					primaryAxisAlignItems: "MIN",
					counterAxisAlignItems: "MIN",
					wrap: false,
					sizing: { horizontal: "FIXED", vertical: "HUG" },
				},
				children: [
					expect.objectContaining({
						id: createdNodeId(2),
						name: "Heading",
						type: "TEXT",
						text: {
							characters: "Sign in",
							fontName: { family: "Inter", style: "Bold" },
							fontSize: 24,
						},
					}),
					expect.objectContaining({
						id: createdNodeId(3),
						name: "Submit",
						type: "INSTANCE",
						instance: {
							mainComponent: { id: "2:1", name: "Button" },
							properties: {},
						},
					}),
				],
			},
			expect.objectContaining({
				id: createdNodeId(4),
				name: "Backdrop",
				type: "RECTANGLE",
				x: 0,
				y: 600,
				width: 393,
				height: 252,
				fills: [{ type: "SOLID", color: "#3366ff", opacity: 0.2 }],
			}),
		]);
	});

	test("creates on the current page when no parent is given", async () => {
		const figma = plugin();
		await figma.result("create_nodes", {
			nodes: [{ type: "FRAME", name: "Settings", x: 1000, width: 393 }],
		});
		const { frames } = await figma.result("list_frames", {});
		expect(frames).toContainEqual({
			id: createdNodeId(1),
			name: "Settings",
			type: "FRAME",
			x: 1000,
			y: 0,
			width: 393,
			height: 100,
		});
	});

	test("commits the whole batch as one undo step", async () => {
		const figma = plugin();
		await figma.result("create_nodes", createNodesRequest.params);
		expect(figma.figma.undoCommits).toBe(1);
	});

	test("fails the batch when the parent doesn't exist", async () => {
		const figma = plugin();
		const response = await figma.send("create_nodes", {
			parentId: "9:99",
			nodes: [{ type: "FRAME" }],
		});
		expect(response).toMatchObject({
			ok: false,
			error: { code: "node_not_found" },
		});
	});

	test("fails the batch when the parent can't hold children", async () => {
		const figma = plugin();
		const response = await figma.send("create_nodes", {
			parentId: "1:2",
			nodes: [{ type: "FRAME" }],
		});
		expect(response).toMatchObject({
			ok: false,
			error: {
				code: "invalid_parent",
				message: expect.stringContaining("TEXT"),
			},
		});
	});

	test("reports an unsupported property per node and leaves nothing behind", async () => {
		const figma = plugin();
		const { nodes } = await figma.result("create_nodes", {
			parentId: "1:10",
			nodes: [
				{ type: "TEXT", text: { characters: "x" }, cornerRadius: 4 },
				{ type: "RECTANGLE", children: [{ type: "TEXT" }] },
			],
		});
		expect(nodes).toEqual([
			{
				ok: false,
				error: {
					code: "unsupported_property",
					message: expect.stringContaining("cornerRadius"),
				},
			},
			{
				ok: false,
				error: {
					code: "cannot_have_children",
					message: expect.stringContaining("RECTANGLE"),
				},
			},
		]);
		expect(await figma.node("1:10")).not.toHaveProperty("children.0");
	});

	test("keeps a parent whose child failed and reports the child in place", async () => {
		const figma = plugin();
		const { nodes } = await figma.result("create_nodes", {
			parentId: "1:10",
			nodes: [
				{
					type: "FRAME",
					name: "Row",
					children: [
						{
							type: "TEXT",
							text: { fontName: { family: "Nope", style: "Regular" } },
						},
					],
				},
			],
		});
		expect(nodes).toEqual([
			{
				ok: true,
				id: createdNodeId(1),
				name: "Row",
				type: "FRAME",
				children: [
					{
						ok: false,
						error: fontNotFoundError({ family: "Nope", style: "Regular" }),
					},
				],
			},
		]);
	});
});

describe("update_nodes", () => {
	test("applies properties and auto-layout to many nodes in one batch", async () => {
		const figma = plugin();
		const { nodes } = await figma.result("update_nodes", {
			updates: [
				{
					id: "1:10",
					name: "Home v2",
					width: 400,
					cornerRadius: {
						topLeft: 8,
						topRight: 8,
						bottomRight: 8,
						bottomLeft: 0,
					},
					fills: [{ type: "SOLID", color: "#000000" }],
					strokes: [{ type: "SOLID", color: "#ff0000" }],
					strokeWeight: 2,
					layout: {
						mode: "HORIZONTAL",
						itemSpacing: 4,
						padding: { left: 8 },
						primaryAxisAlignItems: "SPACE_BETWEEN",
						counterAxisAlignItems: "CENTER",
						wrap: true,
						sizing: { vertical: "HUG" },
					},
				},
				{ id: "1:5", x: 10, y: 20, opacity: 1, visible: true, rotation: 45 },
			],
		});
		expect(nodes).toEqual([
			{ id: "1:10", ok: true },
			{ id: "1:5", ok: true },
		]);
		expect(await figma.node("1:10")).toEqual({
			id: "1:10",
			name: "Home v2",
			type: "FRAME",
			x: 493,
			y: 0,
			width: 400,
			height: 852,
			cornerRadius: { topLeft: 8, topRight: 8, bottomRight: 8, bottomLeft: 0 },
			fills: [{ type: "SOLID", color: "#000000" }],
			strokes: [{ type: "SOLID", color: "#ff0000" }],
			strokeWeight: 2,
			layout: {
				mode: "HORIZONTAL",
				itemSpacing: 4,
				padding: { top: 0, right: 0, bottom: 0, left: 8 },
				primaryAxisAlignItems: "SPACE_BETWEEN",
				counterAxisAlignItems: "CENTER",
				wrap: true,
				sizing: { horizontal: "FIXED", vertical: "HUG" },
			},
			children: [],
		});
		expect(await figma.node("1:5")).toMatchObject({
			x: 10,
			y: 20,
			rotation: 45,
		});
		expect(await figma.node("1:5")).not.toHaveProperty("opacity");
		expect(await figma.node("1:5")).not.toHaveProperty("visible");
	});

	test("edits text after loading its fonts, including mixed-font text", async () => {
		const figma = plugin();
		await figma.result("update_nodes", {
			updates: [
				{
					id: "1:2",
					text: {
						characters: "Hello",
						fontName: { family: "Inter", style: "Italic" },
						fontSize: 20,
						textAlignHorizontal: "LEFT",
					},
				},
				{ id: "1:20", text: { characters: "Final copy" } },
			],
		});
		expect(await figma.node("1:2")).toMatchObject({
			text: {
				characters: "Hello",
				fontName: { family: "Inter", style: "Italic" },
				fontSize: 20,
			},
		});
		expect(await figma.node("1:20")).toMatchObject({
			text: { characters: "Final copy" },
		});
	});

	test("leaves a node untouched when its font is missing", async () => {
		const figma = plugin();
		await figma.result("update_nodes", {
			updates: [
				{
					id: "1:4",
					name: "Renamed",
					text: { fontName: { family: "Comic Neue", style: "Bold" } },
				},
			],
		});
		expect(await figma.node("1:4")).toEqual(findNode("1:4") as never);
	});

	test("reports properties the node type doesn't have", async () => {
		const figma = plugin();
		const { nodes } = await figma.result("update_nodes", {
			updates: [
				{ id: "1:5", layout: { mode: "VERTICAL" } },
				{ id: "1:1", text: { characters: "x" } },
			],
		});
		expect(nodes).toEqual([
			{
				id: "1:5",
				ok: false,
				error: {
					code: "unsupported_property",
					message: "Node 1:5 is a RECTANGLE, which has no layout.",
				},
			},
			{
				id: "1:1",
				ok: false,
				error: {
					code: "unsupported_property",
					message: "Node 1:1 is a FRAME, which has no text.",
				},
			},
		]);
	});

	test("commits the batch as one undo step", async () => {
		const figma = plugin();
		await figma.result("update_nodes", updateNodesRequest.params);
		expect(figma.figma.undoCommits).toBe(1);
	});
});
