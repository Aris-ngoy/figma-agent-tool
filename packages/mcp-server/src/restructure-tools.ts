// Restructuring tools: delete, duplicate, move, rename, group and ungroup.
import { ChildIndex } from "@figma-agent-tool/protocol";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "./bridge";
import { jsonResult, registerFigmaTool } from "./figma-tool";

const ids = (what: string) =>
	z.array(z.string().min(1)).min(1).describe(`IDs of the nodes to ${what}.`);

const index = ChildIndex.optional().describe(
	"Position among the parent's children: 0 is the bottom layer (first in auto-layout), the child count the top (last).",
);

const perNode =
	"Each node succeeds or fails on its own: results come back in input " +
	"order with `ok` and, on failure, an error code and message. One undo step.";

export function registerRestructureTools(server: McpServer, bridge: Bridge) {
	registerFigmaTool(
		server,
		"delete_nodes",
		{
			description:
				"Delete nodes and everything inside them. Pages and layers inside " +
				`instances can't be deleted (cannot_delete). ${perNode}`,
			inputSchema: { ids: ids("delete") },
		},
		async (args) => jsonResult(await bridge.request("delete_nodes", args)),
	);

	registerFigmaTool(
		server,
		"duplicate_node",
		{
			description:
				"Duplicate a node, with everything inside it, `count` times. Copies " +
				"go right after the original in its parent, or into `parentId` at " +
				"`index`; they keep the original's x/y. Returns the copies' IDs; " +
				"read their sublayers with get_node. One undo step.",
			inputSchema: {
				id: z.string().min(1).describe("ID of the node to copy."),
				count: z
					.number()
					.int()
					.min(1)
					.max(100)
					.default(1)
					.describe("How many copies to make."),
				parentId: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Container to put the copies in; defaults to the original's parent.",
					),
				index,
			},
		},
		async (args) => jsonResult(await bridge.request("duplicate_node", args)),
	);

	registerFigmaTool(
		server,
		"reparent_nodes",
		{
			description:
				"Move nodes into a page, frame, group, section or component, or " +
				"reorder them within their parent. They land at `index` in the " +
				"order given (default: on top, i.e. last in auto-layout); x/y stay " +
				"relative, and auto-layout parents position them. A parent that " +
				"can't hold children or is an instance fails the call " +
				"(invalid_parent); so does an index past the child count " +
				"(invalid_index). Pages, instance sublayers and moves into a node's " +
				`own subtree fail per node (cannot_move). ${perNode}`,
			inputSchema: {
				parentId: z.string().min(1).describe("ID of the new parent."),
				ids: ids("move"),
				index,
			},
		},
		async (args) => jsonResult(await bridge.request("reparent_nodes", args)),
	);

	registerFigmaTool(
		server,
		"rename_nodes",
		{
			description: `Rename layers in one call. ${perNode}`,
			inputSchema: {
				renames: z
					.array(z.object({ id: z.string().min(1), name: z.string() }))
					.min(1)
					.describe("One entry per node: its `id` and new `name`."),
			},
		},
		async ({ renames }) =>
			jsonResult(await bridge.request("update_nodes", { updates: renames })),
	);

	registerFigmaTool(
		server,
		"group_nodes",
		{
			description:
				"Group nodes into a new GROUP in the first node's parent, where the " +
				"topmost of them was; it keeps their layer order and positions. " +
				"Returns the group's ID. Fails as a whole (cannot_group) for pages, " +
				"instance sublayers, or a node picked along with its ancestor. One " +
				"undo step.",
			inputSchema: {
				ids: ids("group"),
				name: z
					.string()
					.optional()
					.describe('Name of the group; Figma\'s default is "Group".'),
			},
		},
		async (args) => jsonResult(await bridge.request("group_nodes", args)),
	);

	registerFigmaTool(
		server,
		"ungroup_nodes",
		{
			description:
				"Ungroup GROUP nodes: their children move into the group's parent, " +
				"in its place, and each result lists them. Other node types fail " +
				`(not_a_group). ${perNode}`,
			inputSchema: { ids: ids("ungroup") },
		},
		async (args) => jsonResult(await bridge.request("ungroup_nodes", args)),
	);
}
