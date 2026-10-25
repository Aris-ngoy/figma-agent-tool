import { describe, expect, test } from "bun:test";
import {
	bindNodesRequest,
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
function plugin(options?: Parameters<typeof installMockFigma>[1]) {
	const figma = installMockFigma(document, options);
	const handler = createCommandHandler({ pluginVersion });
	let n = 0;
	async function send(command: string, params: unknown, timeoutMs?: number) {
		return handler.handle({
			type: "request",
			id: `req-${++n}`,
			command,
			params,
			timeoutMs,
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
							// A new instance has its component's defaults.
							properties: { "Label#2:0": "Button", "Disabled#2:1": false },
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

// Figma can stall a plugin for a minute at any `await` while its window is
// hidden, so edits do every async step before touching the document.
describe("edits in a hidden Figma window", () => {
	const text = (characters: string, style = "Regular") => ({
		type: "TEXT",
		text: { characters, fontName: { family: "Inter", style } },
	});

	test("create_nodes loads each font once, before creating any node", async () => {
		const figma = plugin();
		await figma.result("create_nodes", {
			parentId: "1:10",
			nodes: [
				text("Title", "Bold"),
				{ type: "FRAME", children: [text("Email"), text("Password")] },
				text("Footer"),
			],
		});
		expect(figma.figma.fontLoads).toEqual([
			{ font: "Inter Bold", createdBefore: 0 },
			{ font: "Inter Regular", createdBefore: 0 },
		]);
	});

	test("update_nodes loads each font once, before changing any node", async () => {
		const figma = plugin();
		await figma.result("update_nodes", {
			updates: [
				{ id: "1:2", text: { characters: "One" } },
				{ id: "1:4", text: { characters: "Two" } },
			],
		});
		const fonts = figma.figma.fontLoads.map(({ font }) => font);
		expect(fonts).toEqual([...new Set(fonts)]);
	});

	test("create_nodes past its deadline creates nothing and says so", async () => {
		const figma = plugin({ fontLoadDelayMs: 40 });
		const before = await figma.node("1:10");
		const response = await figma.send(
			"create_nodes",
			{ parentId: "1:10", nodes: [text("Late")] },
			20,
		);
		expect(response).toMatchObject({
			ok: false,
			error: { code: "timed_out" },
		});
		expect(await figma.node("1:10")).toEqual(before);
		expect(figma.figma.undoCommits).toBe(0);
	});

	test("update_nodes past its deadline changes nothing", async () => {
		const figma = plugin({ fontLoadDelayMs: 40 });
		const response = await figma.send(
			"update_nodes",
			{ updates: [{ id: "1:2", name: "Late", text: { characters: "Late" } }] },
			20,
		);
		expect(response).toMatchObject({
			ok: false,
			error: { code: "timed_out" },
		});
		expect(await figma.node("1:2")).toEqual(findNode("1:2") as never);
	});

	test("edits that finish in time are unaffected by the deadline", async () => {
		const figma = plugin();
		const response = await figma.send(
			"create_nodes",
			{ parentId: "1:10", nodes: [text("On time")] },
			30_000,
		);
		expect(response).toMatchObject({ ok: true });
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

describe("binding variables and styles", () => {
	test("binds fields and paints to variables and applies styles, visible through get_node", async () => {
		const figma = plugin();
		await figma.result("update_nodes", bindNodesRequest.params);
		expect(await figma.node("1:1", 0)).toMatchObject({
			layout: {
				itemSpacing: 16,
				// space/page is an alias of space/lg.
				padding: { top: 24, right: 24, bottom: 34, left: 24 },
			},
			variables: {
				itemSpacing: "VariableID:2:1",
				paddingTop: "VariableID:2:4",
			},
		});
		expect(await figma.node("1:10", 0)).toMatchObject({
			fills: [{ type: "SOLID", color: "#ffffff", variable: "VariableID:1:2" }],
			styles: { effect: "S:shadow-card," },
		});
		expect(await figma.node("1:4")).toMatchObject({
			text: {
				fontName: { family: "Inter", style: "Regular" },
				fontSize: 16,
			},
			styles: { text: "S:body," },
		});
		expect(await figma.node("1:5")).toMatchObject({
			strokes: [{ type: "SOLID", color: "#111111" }],
			styles: { stroke: "S:text-primary," },
		});
	});

	test("binds text fields after loading the node's fonts", async () => {
		const figma = plugin();
		const { nodes } = await figma.result("update_nodes", {
			updates: [
				{
					id: "1:2",
					variables: {
						fontFamily: "VariableID:2:5",
						fontSize: "VariableID:2:3",
					},
				},
			],
		});
		expect(nodes).toEqual([{ id: "1:2", ok: true }]);
		expect(await figma.node("1:2")).toMatchObject({
			text: { fontName: { family: "Inter", style: "Bold" }, fontSize: 24 },
			variables: {
				fontFamily: "VariableID:2:5",
				fontSize: "VariableID:2:3",
			},
		});
	});

	test("unbinds variables and detaches styles with null, keeping the values", async () => {
		const figma = plugin();
		await figma.result("update_nodes", {
			updates: [
				{
					id: "1:3",
					variables: { paddingLeft: null, topLeftRadius: null },
					fills: [{ type: "SOLID", color: "#3366ff" }],
				},
				{ id: "1:2", styles: { text: null, fill: null } },
			],
		});
		const button = (await figma.node("1:3", 0)) as { variables?: unknown };
		expect(button).toMatchObject({
			cornerRadius: 12,
			fills: [{ type: "SOLID", color: "#3366ff" }],
			layout: { padding: { left: 16 } },
		});
		expect(button.variables).toEqual({
			paddingRight: "VariableID:2:1",
			topRightRadius: "VariableID:2:2",
			bottomRightRadius: "VariableID:2:2",
			bottomLeftRadius: "VariableID:2:2",
		});
		expect(await figma.node("1:2")).not.toHaveProperty("styles");
	});

	test("setting paints directly detaches their style", async () => {
		const figma = plugin();
		await figma.result("update_nodes", {
			updates: [{ id: "1:2", fills: [{ type: "SOLID", color: "#000000" }] }],
		});
		expect(await figma.node("1:2")).toMatchObject({
			styles: { text: "S:heading," },
		});
		expect(await figma.node("1:2")).not.toHaveProperty("styles.fill");
	});

	test("leaves the node untouched when a binding fails", async () => {
		const figma = plugin();
		const { nodes } = await figma.result("update_nodes", {
			updates: [
				{
					id: "1:1",
					name: "Renamed",
					fills: [{ type: "SOLID", variable: "VariableID:2:1" }],
				},
				{ id: "1:5", variables: { paddingTop: "VariableID:2:1" } },
				{ id: "1:1", styles: { text: "S:heading," } },
			],
		});
		expect(nodes).toEqual([
			{
				id: "1:1",
				ok: false,
				error: {
					code: "variable_type_mismatch",
					message: expect.stringContaining("fills needs a COLOR one"),
				},
			},
			{
				id: "1:5",
				ok: false,
				error: {
					code: "unsupported_property",
					message:
						"Node 1:5 is a RECTANGLE, which has no variables.paddingTop.",
				},
			},
			{
				id: "1:1",
				ok: false,
				error: {
					code: "unsupported_property",
					message: "Node 1:1 is a FRAME, which has no styles.text.",
				},
			},
		]);
		expect(await figma.node("1:1")).toEqual(findNode("1:1") as never);
	});

	test("creates nodes bound to variables and styles", async () => {
		const figma = plugin();
		const { nodes } = await figma.result("create_nodes", {
			parentId: "1:10",
			nodes: [
				{
					type: "TEXT",
					text: { characters: "Hi" },
					styles: { text: "S:heading," },
				},
				{
					type: "RECTANGLE",
					fills: [{ type: "SOLID", variable: "VariableID:1:1" }],
					variables: { topLeftRadius: "VariableID:2:2" },
				},
			],
		});
		expect(nodes).toMatchObject([{ ok: true }, { ok: true }]);
		expect(await figma.node(createdNodeId(1))).toMatchObject({
			text: { fontName: { family: "Inter", style: "Bold" }, fontSize: 28 },
			styles: { text: "S:heading," },
		});
		expect(await figma.node(createdNodeId(2))).toMatchObject({
			cornerRadius: { topLeft: 12, topRight: 0 },
			fills: [{ type: "SOLID", color: "#3366ff", variable: "VariableID:1:1" }],
			variables: { topLeftRadius: "VariableID:2:2" },
		});
	});
});
