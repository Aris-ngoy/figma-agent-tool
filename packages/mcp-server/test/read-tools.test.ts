import { describe, expect, test } from "bun:test";
import {
	document,
	findNode,
	getDesignSystemResponse,
	limitDepth,
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

function node(id: string) {
	const found = findNode(id);
	if (!found) throw new Error(`fixture has no node ${id}`);
	return found;
}

const currentPage = { id: "0:1", name: "Screens" };

describe("get_selection", () => {
	test("returns the selected nodes with their subtree to the default depth", async () => {
		const harness = await connected();
		const result = await harness.callTool("get_selection");
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({
			page: currentPage,
			nodes: document.selection.map((id) => limitDepth(node(id), 2)),
		});
	});

	test("cuts the subtree off at the requested depth", async () => {
		const harness = await connected();
		const result = await harness.callTool("get_selection", { depth: 0 });
		expect(result.structuredContent).toEqual({
			page: currentPage,
			nodes: [
				expect.objectContaining({ id: "1:1", childCount: 3 }),
				expect.objectContaining({ id: "1:20" }),
			],
		});
		const [frame] = (result.structuredContent as { nodes: object[] }).nodes;
		expect(frame).not.toHaveProperty("children");
	});

	test("returns its result as JSON text for clients without structured content", async () => {
		const harness = await connected();
		const result = await harness.callTool("get_selection");
		expect(JSON.parse(text(result))).toEqual(result.structuredContent);
	});
});

describe("get_node", () => {
	test("reports the variables and styles a node is bound to", async () => {
		const harness = await connected();
		const button = await harness.callTool("get_node", { id: "1:3", depth: 0 });
		expect(button.structuredContent).toMatchObject({
			node: {
				fills: [
					{ type: "SOLID", color: "#3366ff", variable: "VariableID:1:1" },
				],
				variables: {
					paddingLeft: "VariableID:2:1",
					topLeftRadius: "VariableID:2:2",
				},
			},
		});
		const title = await harness.callTool("get_node", { id: "1:2" });
		expect(title.structuredContent).toMatchObject({
			node: { styles: { fill: "S:text-primary,", text: "S:heading," } },
		});
	});

	test("returns a node by ID with its type, geometry, paints, layout and instance info", async () => {
		const harness = await connected();
		const result = await harness.callTool("get_node", { id: "1:3" });
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({ node: node("1:3") });
	});

	test("limits the subtree to the requested depth", async () => {
		const harness = await connected();
		const result = await harness.callTool("get_node", { id: "1:1", depth: 1 });
		const { node: frame } = result.structuredContent as {
			node: { children: object[] };
		};
		expect(frame as object).toEqual(limitDepth(node("1:1"), 1));
		expect(frame.children[1]).toMatchObject({ id: "1:3", childCount: 1 });
	});

	test("returns pages and components too", async () => {
		const harness = await connected();
		const result = await harness.callTool("get_node", { id: "2:1", depth: 0 });
		expect(result.structuredContent).toEqual({
			node: limitDepth(node("2:1"), 0),
		});
	});

	test("explains an unknown node ID as a tool error", async () => {
		const harness = await connected();
		const result = await harness.callTool("get_node", { id: "9:999" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain('No node with ID "9:999"');
	});

	test("rejects a negative depth", async () => {
		const harness = await connected();
		const result = await harness.callTool("get_node", { id: "1:1", depth: -1 });
		expect(result.isError).toBe(true);
	});

	test("tells the agent to open the plugin when none is connected", async () => {
		const harness = await startHarness();
		const result = await harness.callTool("get_node", { id: "1:1" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("No Figma plugin is connected");
	});
});

describe("list_pages", () => {
	test("returns every page's ID and name and marks the current one", async () => {
		const harness = await connected();
		const result = await harness.callTool("list_pages");
		expect(result.structuredContent).toEqual({
			pages: [
				{ id: "0:1", name: "Screens", current: true },
				{ id: "0:2", name: "Components", current: false },
			],
		});
	});
});

describe("list_frames", () => {
	test("returns the current page's top-level frames with their sizes", async () => {
		const harness = await connected();
		const result = await harness.callTool("list_frames");
		expect(result.structuredContent).toEqual({
			page: currentPage,
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

	test("lists another page's frames and components by page ID", async () => {
		const harness = await connected();
		const result = await harness.callTool("list_frames", { pageId: "0:2" });
		expect(result.structuredContent).toEqual({
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
				{
					id: "3:1",
					name: "Chip",
					type: "COMPONENT_SET",
					x: 200,
					y: 0,
					width: 120,
					height: 80,
				},
			],
		});
	});

	test("explains a page ID that isn't a page", async () => {
		const harness = await connected();
		const result = await harness.callTool("list_frames", { pageId: "1:1" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain('"1:1"');
		expect(text(result)).toContain("list_pages");
	});
});

describe("get_design_system", () => {
	test("lists components with variant properties, styles and variables by collection and mode", async () => {
		const harness = await connected();
		const result = await harness.callTool("get_design_system");
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual(getDesignSystemResponse.result);
		expect(JSON.parse(text(result))).toEqual(getDesignSystemResponse.result);
	});

	test("tells the agent to open the plugin when none is connected", async () => {
		const harness = await startHarness();
		const result = await harness.callTool("get_design_system");
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("No Figma plugin is connected");
	});
});
