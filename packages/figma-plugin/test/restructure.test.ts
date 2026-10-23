import { describe, expect, test } from "bun:test";
import {
	createdNodeId,
	document,
	findNode,
} from "@figma-agent-tool/protocol/fixtures";
import { createCommandHandler } from "../src/handler";
import { installMockFigma } from "./mock-figma";

/** A mocked file plus helpers that run commands through the real handler. */
function plugin() {
	const figma = installMockFigma(document);
	const handler = createCommandHandler({ pluginVersion: "0.0.0" });
	let n = 0;
	async function send(command: string, params: unknown) {
		return handler.handle({
			type: "request",
			id: `req-${++n}`,
			command,
			params,
		});
	}
	async function result(command: string, params: unknown) {
		const response = await send(command, params);
		if (!response.ok) throw new Error(response.error.message);
		return response.result as Record<string, unknown>;
	}
	return {
		figma,
		send,
		result,
		/** IDs of the node's children, in layer order. */
		async childIds(id: string) {
			const { node } = await result("get_node", { id, depth: 1 });
			const { children = [] } = node as { children?: { id: string }[] };
			return children.map((child) => child.id);
		},
	};
}

describe("delete_nodes", () => {
	test("removes each node and reports it, failing missing ones alone", async () => {
		const figma = plugin();
		const { nodes } = await figma.result("delete_nodes", {
			ids: ["1:2", "9:99", "1:5"],
		});
		expect(nodes).toEqual([
			{ id: "1:2", ok: true },
			{
				id: "9:99",
				ok: false,
				error: expect.objectContaining({ code: "node_not_found" }),
			},
			{ id: "1:5", ok: true },
		]);
		expect(await figma.childIds("1:1")).toEqual(["1:3"]);
		expect(figma.figma.undoCommits).toBe(1);
	});

	test("counts a node deleted along with its ancestor as deleted", async () => {
		const figma = plugin();
		const { nodes } = await figma.result("delete_nodes", {
			ids: ["1:1", "1:4"],
		});
		expect(nodes).toEqual([
			{ id: "1:1", ok: true },
			{ id: "1:4", ok: true },
		]);
		expect(await figma.childIds("0:1")).toEqual(["1:10", "1:20"]);
	});

	test("refuses pages and instance sublayers", async () => {
		const figma = plugin();
		const { nodes } = await figma.result("delete_nodes", {
			ids: ["0:2", "1:4"],
		});
		expect(nodes).toEqual([
			{
				id: "0:2",
				ok: false,
				error: {
					code: "cannot_delete",
					message: expect.stringContaining("PAGE"),
				},
			},
			{
				id: "1:4",
				ok: false,
				error: {
					code: "cannot_delete",
					message: expect.stringContaining("inside an instance"),
				},
			},
		]);
		expect(await figma.childIds("1:3")).toEqual(["1:4"]);
	});
});

describe("duplicate_node", () => {
	test("puts copies with fresh IDs right after the original", async () => {
		const figma = plugin();
		const { nodes } = await figma.result("duplicate_node", {
			id: "1:3",
			count: 2,
		});
		expect(nodes).toEqual([
			{ id: createdNodeId(1), name: "Button", type: "INSTANCE" },
			{ id: createdNodeId(3), name: "Button", type: "INSTANCE" },
		]);
		expect(await figma.childIds("1:1")).toEqual([
			"1:2",
			"1:3",
			createdNodeId(1),
			createdNodeId(3),
			"1:5",
		]);
		// The copy's sublayers get their own IDs too.
		expect(await figma.childIds(createdNodeId(1))).toEqual([createdNodeId(2)]);
		expect(figma.figma.undoCommits).toBe(1);
	});

	test("copies into another parent at an index", async () => {
		const figma = plugin();
		await figma.result("duplicate_node", {
			id: "1:2",
			parentId: "1:10",
			index: 0,
		});
		const { node } = await figma.result("get_node", {
			id: createdNodeId(1),
			depth: 0,
		});
		expect(node).toEqual({ ...findNode("1:2"), id: createdNodeId(1) });
		expect(await figma.childIds("1:10")).toEqual([createdNodeId(1)]);
		expect(await figma.childIds("1:1")).toEqual(["1:2", "1:3", "1:5"]);
	});

	test("fails for a parent that can't hold children or an index past the end", async () => {
		const figma = plugin();
		expect(
			await figma.send("duplicate_node", { id: "1:2", parentId: "1:5" }),
		).toMatchObject({ ok: false, error: { code: "invalid_parent" } });
		expect(
			await figma.send("duplicate_node", { id: "1:2", index: 4 }),
		).toMatchObject({
			ok: false,
			error: {
				code: "invalid_index",
				message: expect.stringContaining("0 to 3"),
			},
		});
		expect(await figma.childIds("1:1")).toEqual(["1:2", "1:3", "1:5"]);
	});
});

describe("reparent_nodes", () => {
	test("moves nodes into an auto-layout frame at an index, in order", async () => {
		const figma = plugin();
		const { nodes } = await figma.result("reparent_nodes", {
			parentId: "1:1",
			ids: ["1:20", "1:10"],
			index: 1,
		});
		expect(nodes).toEqual([
			{ id: "1:20", ok: true },
			{ id: "1:10", ok: true },
		]);
		expect(await figma.childIds("1:1")).toEqual([
			"1:2",
			"1:20",
			"1:10",
			"1:3",
			"1:5",
		]);
		expect(await figma.childIds("0:1")).toEqual(["1:1"]);
		expect(figma.figma.undoCommits).toBe(1);
	});

	test("reorders within the same parent", async () => {
		const figma = plugin();
		await figma.result("reparent_nodes", {
			parentId: "1:1",
			ids: ["1:2"],
			index: 2,
		});
		expect(await figma.childIds("1:1")).toEqual(["1:3", "1:5", "1:2"]);
		await figma.result("reparent_nodes", {
			parentId: "1:1",
			ids: ["1:5", "1:2"],
			index: 0,
		});
		expect(await figma.childIds("1:1")).toEqual(["1:5", "1:2", "1:3"]);
	});

	test("appends to the top without an index", async () => {
		const figma = plugin();
		await figma.result("reparent_nodes", { parentId: "1:10", ids: ["1:2"] });
		expect(await figma.childIds("1:10")).toEqual(["1:2"]);
	});

	test("fails the call for a parent that can't hold children", async () => {
		const figma = plugin();
		for (const parentId of ["1:2", "1:3", "0:0"]) {
			expect(
				await figma.send("reparent_nodes", { parentId, ids: ["1:5"] }),
			).toMatchObject({ ok: false, error: { code: "invalid_parent" } });
		}
		expect(await figma.childIds("1:1")).toEqual(["1:2", "1:3", "1:5"]);
	});

	test("fails nodes that can't move on their own", async () => {
		const figma = plugin();
		const { nodes } = await figma.result("reparent_nodes", {
			parentId: "1:10",
			ids: ["0:2", "1:4", "9:99", "1:5"],
		});
		expect(nodes).toEqual([
			{
				id: "0:2",
				ok: false,
				error: expect.objectContaining({ code: "cannot_move" }),
			},
			{
				id: "1:4",
				ok: false,
				error: expect.objectContaining({ code: "cannot_move" }),
			},
			{
				id: "9:99",
				ok: false,
				error: expect.objectContaining({ code: "node_not_found" }),
			},
			{ id: "1:5", ok: true },
		]);
		await figma.result("create_nodes", {
			parentId: "1:10",
			nodes: [{ type: "FRAME" }],
		});
		const { nodes: cycle } = await figma.result("reparent_nodes", {
			parentId: createdNodeId(1),
			ids: ["1:10"],
		});
		expect(cycle).toEqual([
			{
				id: "1:10",
				ok: false,
				error: {
					code: "cannot_move",
					message: `Node 1:10 contains ${createdNodeId(1)}, so it can't move into it.`,
				},
			},
		]);
	});
});

describe("group_nodes and ungroup_nodes", () => {
	test("groups nodes where the topmost was, spanning them, and ungroups them back", async () => {
		const figma = plugin();
		const { node } = await figma.result("group_nodes", {
			ids: ["1:5", "1:2"],
			name: "Header",
		});
		const id = createdNodeId(1);
		expect(node).toEqual({ id, name: "Header", type: "GROUP" });
		expect(await figma.childIds("1:1")).toEqual(["1:3", id]);
		const { node: group } = await figma.result("get_node", { id, depth: 1 });
		expect(group).toEqual({
			id,
			name: "Header",
			type: "GROUP",
			x: 24,
			y: 64,
			width: 345,
			height: 115,
			children: [findNode("1:2"), findNode("1:5")],
		});

		const { nodes } = await figma.result("ungroup_nodes", { ids: [id, "1:1"] });
		expect(nodes).toEqual([
			{ id, ok: true, children: ["1:2", "1:5"] },
			{
				id: "1:1",
				ok: false,
				error: {
					code: "not_a_group",
					message:
						"Node 1:1 is a FRAME, not a GROUP; only groups can be ungrouped.",
				},
			},
		]);
		expect(await figma.childIds("1:1")).toEqual(["1:3", "1:2", "1:5"]);
		expect(figma.figma.undoCommits).toBe(2);
	});

	test("fails the whole group for pages, instance sublayers or nested picks", async () => {
		const figma = plugin();
		for (const ids of [["0:2"], ["1:4"], ["1:1", "1:2"], ["1:2", "9:99"]]) {
			const response = await figma.send("group_nodes", { ids });
			expect(response.ok).toBe(false);
		}
		expect(
			await figma.send("group_nodes", { ids: ["1:1", "1:2"] }),
		).toMatchObject({
			ok: false,
			error: {
				code: "cannot_group",
				message: expect.stringContaining("inside 1:1"),
			},
		});
		expect(await figma.childIds("1:1")).toEqual(["1:2", "1:3", "1:5"]);
	});
});
