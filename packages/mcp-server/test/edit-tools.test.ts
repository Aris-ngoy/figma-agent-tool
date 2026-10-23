import { describe, expect, test } from "bun:test";
import {
	bindNodesRequest,
	bindNodesResponse,
	createdNodeId,
	createNodesPartlyRequest,
	createNodesPartlyResponse,
	createNodesRequest,
	createNodesResponse,
	updateNodesRequest,
	updateNodesResponse,
} from "@figma-agent-tool/protocol/fixtures";
import { startHarness } from "./harness";

async function connected() {
	const harness = await startHarness();
	await harness.connectFakePlugin();
	return harness;
}

function text(result: Record<string, unknown>): string {
	const [content] = result.content as { type: string; text: string }[];
	return content?.text ?? "";
}

describe("create_nodes", () => {
	test("creates frames, text, rectangles and instances in one call and returns their IDs", async () => {
		const harness = await connected();
		const result = await harness.callTool(
			"create_nodes",
			createNodesRequest.params,
		);
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual(createNodesResponse.result);
		expect(JSON.parse(text(result))).toEqual(createNodesResponse.result);
	});

	test("makes the created nodes visible through the read tools", async () => {
		const harness = await connected();
		await harness.callTool("create_nodes", createNodesRequest.params);
		const result = await harness.callTool("get_node", {
			id: createdNodeId(1),
			depth: 1,
		});
		expect(result.structuredContent).toEqual({
			node: {
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
						text: {
							characters: "Sign in",
							fontName: { family: "Inter", style: "Bold" },
							fontSize: 24,
						},
					}),
					expect.objectContaining({
						id: createdNodeId(3),
						type: "INSTANCE",
						instance: {
							mainComponent: { id: "2:1", name: "Button" },
							properties: {},
						},
					}),
				],
			},
		});
	});

	test("puts nodes without a parent on the current page, where list_frames finds them", async () => {
		const harness = await connected();
		await harness.callTool("create_nodes", {
			nodes: [{ type: "FRAME", name: "Settings", x: 1000, width: 393 }],
		});
		const result = await harness.callTool("list_frames");
		expect(
			(result.structuredContent as { frames: unknown[] }).frames,
		).toContainEqual({
			id: createdNodeId(1),
			name: "Settings",
			type: "FRAME",
			x: 1000,
			y: 0,
			width: 393,
			height: 100,
		});
	});

	test("reports each failed spec in place without dropping the rest", async () => {
		const harness = await connected();
		const result = await harness.callTool(
			"create_nodes",
			createNodesPartlyRequest.params,
		);
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual(createNodesPartlyResponse.result);
	});

	test("explains an unknown parent as a tool error", async () => {
		const harness = await connected();
		const result = await harness.callTool("create_nodes", {
			parentId: "9:99",
			nodes: [{ type: "FRAME" }],
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain('No node with ID "9:99"');
	});

	test("rejects an empty batch", async () => {
		const harness = await connected();
		const result = await harness.callTool("create_nodes", { nodes: [] });
		expect(result.isError).toBe(true);
	});

	test("tells the agent to open the plugin when none is connected", async () => {
		const harness = await startHarness();
		const result = await harness.callTool("create_nodes", {
			nodes: [{ type: "FRAME" }],
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("No Figma plugin is connected");
	});
});

describe("update_nodes", () => {
	test("applies property and auto-layout changes to many nodes, visible through get_node", async () => {
		const harness = await connected();
		const result = await harness.callTool("update_nodes", {
			updates: [
				{
					id: "1:10",
					name: "Home v2",
					cornerRadius: 0,
					layout: {
						mode: "VERTICAL",
						itemSpacing: 8,
						padding: { top: 16 },
						sizing: { vertical: "HUG" },
					},
				},
				{
					id: "1:2",
					width: 300,
					fills: [{ type: "SOLID", color: "#222222" }],
					text: { characters: "Hello", fontSize: 32 },
				},
			],
		});
		expect(result.structuredContent).toEqual({
			nodes: [
				{ id: "1:10", ok: true },
				{ id: "1:2", ok: true },
			],
		});
		const home = await harness.callTool("get_node", { id: "1:10", depth: 0 });
		expect(home.structuredContent).toEqual({
			node: {
				id: "1:10",
				name: "Home v2",
				type: "FRAME",
				x: 493,
				y: 0,
				width: 393,
				height: 852,
				fills: [
					{
						type: "GRADIENT_LINEAR",
						stops: [
							{ position: 0, color: "#3366ff", opacity: 1 },
							{ position: 1, color: "#000000", opacity: 0.5 },
						],
					},
				],
				layout: {
					mode: "VERTICAL",
					itemSpacing: 8,
					padding: { top: 16, right: 0, bottom: 0, left: 0 },
					primaryAxisAlignItems: "MIN",
					counterAxisAlignItems: "MIN",
					wrap: false,
					sizing: { horizontal: "FIXED", vertical: "HUG" },
				},
			},
		});
		const title = await harness.callTool("get_node", { id: "1:2" });
		expect(title.structuredContent).toMatchObject({
			node: {
				width: 300,
				fills: [{ type: "SOLID", color: "#222222" }],
				text: { characters: "Hello", fontSize: 32 },
			},
		});
	});

	test("reports unknown nodes and missing fonts per node", async () => {
		const harness = await connected();
		const result = await harness.callTool(
			"update_nodes",
			updateNodesRequest.params,
		);
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual(updateNodesResponse.result);
	});
});

describe("update_nodes bindings", () => {
	test("binds variables and applies styles, reporting bad IDs and types per node", async () => {
		const harness = await connected();
		const result = await harness.callTool(
			"update_nodes",
			bindNodesRequest.params,
		);
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual(bindNodesResponse.result);
	});

	test("shows the bound variables, resolved values and styles through get_node", async () => {
		const harness = await connected();
		await harness.callTool("update_nodes", bindNodesRequest.params);
		const node = async (id: string) =>
			(await harness.callTool("get_node", { id, depth: 0 })).structuredContent;
		expect(await node("1:1")).toMatchObject({
			node: {
				layout: {
					itemSpacing: 16,
					// space/page is an alias of space/lg.
					padding: { top: 24, right: 24, bottom: 34, left: 24 },
				},
				variables: {
					itemSpacing: "VariableID:2:1",
					paddingTop: "VariableID:2:4",
				},
			},
		});
		expect(await node("1:10")).toMatchObject({
			node: {
				fills: [
					{ type: "SOLID", color: "#ffffff", variable: "VariableID:1:2" },
				],
				styles: { effect: "S:shadow-card," },
			},
		});
		expect(await node("1:4")).toMatchObject({
			node: {
				text: {
					fontName: { family: "Inter", style: "Regular" },
					fontSize: 16,
				},
				styles: { text: "S:body," },
			},
		});
		expect(await node("1:5")).toMatchObject({
			node: {
				strokes: [{ type: "SOLID", color: "#111111" }],
				styles: { stroke: "S:text-primary," },
			},
		});
	});

	test("unbinds variables and detaches styles with null", async () => {
		const harness = await connected();
		await harness.callTool("update_nodes", {
			updates: [
				{
					id: "1:3",
					variables: { paddingLeft: null },
					fills: [{ type: "SOLID", color: "#3366ff" }],
				},
				{ id: "1:2", styles: { text: null, fill: null } },
			],
		});
		const button = await harness.callTool("get_node", { id: "1:3", depth: 0 });
		const { node } = button.structuredContent as {
			node: { fills: unknown; variables: Record<string, string> };
		};
		expect(node.fills).toEqual([{ type: "SOLID", color: "#3366ff" }]);
		expect(node.variables).not.toHaveProperty("paddingLeft");
		const title = await harness.callTool("get_node", { id: "1:2" });
		expect(title.structuredContent).not.toHaveProperty("node.styles");
	});
});
