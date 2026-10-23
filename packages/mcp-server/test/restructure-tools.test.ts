import { describe, expect, test } from "bun:test";
import {
	createdNodeId,
	deleteNodesRequest,
	deleteNodesResponse,
	duplicateNodeRequest,
	duplicateNodeResponse,
	findNode,
	groupNodesRequest,
	groupNodesResponse,
	reparentIntoTextRequest,
	reparentIntoTextResponse,
	reparentNodesRequest,
	reparentNodesResponse,
	ungroupFrameRequest,
	ungroupFrameResponse,
} from "@figma-agent-tool/protocol/fixtures";
import { startHarness } from "./harness";

async function connected() {
	const harness = await startHarness();
	await harness.connectFakePlugin();
	return {
		...harness,
		/** IDs of the node's children, in layer order. */
		async childIds(id: string) {
			const result = await harness.callTool("get_node", { id, depth: 1 });
			const { node } = result.structuredContent as {
				node: { children?: { id: string }[] };
			};
			return (node.children ?? []).map((child) => child.id);
		},
	};
}

function text(result: Record<string, unknown>): string {
	const [content] = result.content as { type: string; text: string }[];
	return content?.text ?? "";
}

describe("delete_nodes", () => {
	test("deletes nodes and reports each, failing missing nodes and pages alone", async () => {
		const harness = await connected();
		const result = await harness.callTool(
			"delete_nodes",
			deleteNodesRequest.params,
		);
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual(deleteNodesResponse.result);
		expect(JSON.parse(text(result))).toEqual(deleteNodesResponse.result);
		expect(await harness.childIds("1:1")).toEqual(["1:2", "1:3"]);
	});

	test("refuses layers inside an instance", async () => {
		const harness = await connected();
		const result = await harness.callTool("delete_nodes", { ids: ["1:4"] });
		expect(result.structuredContent).toEqual({
			nodes: [
				{
					id: "1:4",
					ok: false,
					error: {
						code: "cannot_delete",
						message: expect.stringContaining("inside an instance"),
					},
				},
			],
		});
	});
});

describe("duplicate_node", () => {
	test("puts copies with fresh IDs right after the original", async () => {
		const harness = await connected();
		const result = await harness.callTool(
			"duplicate_node",
			duplicateNodeRequest.params,
		);
		expect(result.structuredContent).toEqual(duplicateNodeResponse.result);
		expect(await harness.childIds("1:1")).toEqual([
			"1:2",
			"1:3",
			createdNodeId(1),
			createdNodeId(3),
			"1:5",
		]);
		expect(await harness.childIds(createdNodeId(1))).toEqual([
			createdNodeId(2),
		]);
	});

	test("copies into another parent at an index, readable through get_node", async () => {
		const harness = await connected();
		await harness.callTool("duplicate_node", {
			id: "1:2",
			parentId: "1:10",
			index: 0,
		});
		const result = await harness.callTool("get_node", {
			id: createdNodeId(1),
			depth: 0,
		});
		expect(result.structuredContent).toEqual({
			node: { ...findNode("1:2"), id: createdNodeId(1) },
		});
		expect(await harness.childIds("1:10")).toEqual([createdNodeId(1)]);
	});

	test("explains an index past the end as a tool error", async () => {
		const harness = await connected();
		const result = await harness.callTool("duplicate_node", {
			id: "1:2",
			index: 4,
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("Index 4 is out of range");
	});
});

describe("reparent_nodes", () => {
	test("moves nodes into an auto-layout frame at an index, in order", async () => {
		const harness = await connected();
		const result = await harness.callTool(
			"reparent_nodes",
			reparentNodesRequest.params,
		);
		expect(result.structuredContent).toEqual(reparentNodesResponse.result);
		expect(await harness.childIds("1:1")).toEqual([
			"1:2",
			"1:20",
			"1:10",
			"1:3",
			"1:5",
		]);
		const frames = await harness.callTool("list_frames");
		expect(
			(frames.structuredContent as { frames: { id: string }[] }).frames.map(
				(frame) => frame.id,
			),
		).toEqual(["1:1"]);
	});

	test("reorders within the same parent", async () => {
		const harness = await connected();
		await harness.callTool("reparent_nodes", {
			parentId: "1:1",
			ids: ["1:5", "1:2"],
			index: 0,
		});
		expect(await harness.childIds("1:1")).toEqual(["1:5", "1:2", "1:3"]);
	});

	test("explains a parent that can't hold children as a tool error", async () => {
		const harness = await connected();
		const result = await harness.callTool(
			"reparent_nodes",
			reparentIntoTextRequest.params,
		);
		expect(result.isError).toBe(true);
		expect(text(result)).toContain(reparentIntoTextResponse.error.message);
		expect(await harness.childIds("1:1")).toEqual(["1:2", "1:3", "1:5"]);
	});

	test("refuses to move a node into its own subtree or an instance", async () => {
		const harness = await connected();
		const cycle = await harness.callTool("reparent_nodes", {
			parentId: "1:1",
			ids: ["1:1"],
		});
		expect(cycle.structuredContent).toEqual({
			nodes: [
				{
					id: "1:1",
					ok: false,
					error: {
						code: "cannot_move",
						message: "Node 1:1 can't move into itself.",
					},
				},
			],
		});
		const instance = await harness.callTool("reparent_nodes", {
			parentId: "1:3",
			ids: ["1:5"],
		});
		expect(instance.isError).toBe(true);
		expect(text(instance)).toContain("is an instance");
	});
});

describe("rename_nodes", () => {
	test("renames layers, failing unknown IDs alone", async () => {
		const harness = await connected();
		const result = await harness.callTool("rename_nodes", {
			renames: [
				{ id: "1:2", name: "Heading" },
				{ id: "9:99", name: "Ghost" },
			],
		});
		expect(result.structuredContent).toEqual({
			nodes: [
				{ id: "1:2", ok: true },
				{
					id: "9:99",
					ok: false,
					error: expect.objectContaining({ code: "node_not_found" }),
				},
			],
		});
		const node = await harness.callTool("get_node", { id: "1:2", depth: 0 });
		expect(node.structuredContent).toMatchObject({ node: { name: "Heading" } });
	});
});

describe("group_nodes and ungroup_nodes", () => {
	test("groups nodes where the topmost was and ungroups them back", async () => {
		const harness = await connected();
		const result = await harness.callTool(
			"group_nodes",
			groupNodesRequest.params,
		);
		expect(result.structuredContent).toEqual(groupNodesResponse.result);
		const id = createdNodeId(1);
		expect(await harness.childIds("1:1")).toEqual(["1:3", id]);
		const group = await harness.callTool("get_node", { id, depth: 1 });
		expect(group.structuredContent).toEqual({
			node: {
				id,
				name: "Header",
				type: "GROUP",
				x: 24,
				y: 64,
				width: 345,
				height: 115,
				children: [findNode("1:2"), findNode("1:5")],
			},
		});

		const ungrouped = await harness.callTool("ungroup_nodes", { ids: [id] });
		expect(ungrouped.structuredContent).toEqual({
			nodes: [{ id, ok: true, children: ["1:2", "1:5"] }],
		});
		expect(await harness.childIds("1:1")).toEqual(["1:3", "1:2", "1:5"]);
	});

	test("explains grouping a node with its ancestor as a tool error", async () => {
		const harness = await connected();
		const result = await harness.callTool("group_nodes", {
			ids: ["1:1", "1:2"],
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("inside 1:1");
	});

	test("fails ungrouping anything but a group", async () => {
		const harness = await connected();
		const result = await harness.callTool(
			"ungroup_nodes",
			ungroupFrameRequest.params,
		);
		expect(result.structuredContent).toEqual(ungroupFrameResponse.result);
	});
});

test("restructuring tools tell the agent to open the plugin when none is connected", async () => {
	const harness = await startHarness();
	const result = await harness.callTool("delete_nodes", { ids: ["1:2"] });
	expect(result.isError).toBe(true);
	expect(text(result)).toContain("No Figma plugin is connected");
});
