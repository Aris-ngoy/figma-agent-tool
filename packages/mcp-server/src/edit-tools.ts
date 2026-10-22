// Write tools: create and update nodes in batches.
import { NodeSpec, NodeUpdate } from "@figma-agent-tool/protocol";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "./bridge";
import { jsonResult, registerFigmaTool } from "./figma-tool";

const batchNotes =
	"Properties mirror get_node's output (colors as #rrggbb hex, `layout` for " +
	"auto-layout and `layout.sizing` for HUG/FILL/FIXED). Each item succeeds " +
	"or fails on its own: results come back in input order with `ok` and, on " +
	"failure, an error code and message. The batch is one undo step in Figma.";

export function registerEditTools(server: McpServer, bridge: Bridge) {
	registerFigmaTool(
		server,
		"create_nodes",
		{
			description:
				"Create FRAME, TEXT, RECTANGLE and INSTANCE nodes under a parent in " +
				"one call, nesting `children` inside frames, and return their IDs. " +
				"Text fonts are loaded first (default Inter Regular). " +
				batchNotes,
			inputSchema: {
				parentId: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Page, frame or other container to create in; defaults to the current page.",
					),
				nodes: z
					.array(NodeSpec)
					.min(1)
					.describe(
						"Nodes to create. INSTANCE needs `componentId`, the ID of a COMPONENT.",
					),
			},
		},
		async (args) => jsonResult(await bridge.request("create_nodes", args)),
	);

	registerFigmaTool(
		server,
		"update_nodes",
		{
			description:
				"Change size, position, rotation, opacity, visibility, fills, " +
				"strokes, corner radius, text (characters, font, size, alignment) " +
				"and auto-layout of many nodes in one call. Only the given " +
				`properties change. ${batchNotes}`,
			inputSchema: {
				updates: z
					.array(NodeUpdate)
					.min(1)
					.describe("One entry per node: its `id` plus the properties to set."),
			},
		},
		async (args) => jsonResult(await bridge.request("update_nodes", args)),
	);
}
