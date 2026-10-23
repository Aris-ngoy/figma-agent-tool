// Read tools: the selection, nodes by ID, pages, top-level frames and the
// design system.
import { DEFAULT_DEPTH, Depth } from "@figma-agent-tool/protocol";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "./bridge";
import { jsonResult, registerFigmaTool } from "./figma-tool";

const depth = Depth.optional().describe(
	`Levels of children to include below each node (default ${DEFAULT_DEPTH}). ` +
		"Nodes cut off by the limit report `childCount` instead of `children`; " +
		"fetch them with get_node.",
);

export function registerReadTools(server: McpServer, bridge: Bridge) {
	registerFigmaTool(
		server,
		"get_selection",
		{
			description:
				"Return the nodes the designer has selected on the current page, " +
				"with type, geometry, fills, strokes, text, auto-layout and " +
				"component/instance info, plus their subtree up to `depth`.",
			inputSchema: { depth },
		},
		async (args) =>
			jsonResult(
				await bridge.request("get_selection", {
					depth: args.depth ?? DEFAULT_DEPTH,
				}),
			),
	);

	registerFigmaTool(
		server,
		"get_node",
		{
			description:
				"Return one node by ID (for example `12:34`) with its subtree up " +
				"to `depth`. Works for pages, frames, components and any layer.",
			inputSchema: {
				id: z.string().min(1).describe("Figma node ID, for example `12:34`."),
				depth,
			},
		},
		async (args) =>
			jsonResult(
				await bridge.request("get_node", {
					id: args.id,
					depth: args.depth ?? DEFAULT_DEPTH,
				}),
			),
	);

	registerFigmaTool(
		server,
		"list_pages",
		{ description: "List the file's pages with their IDs and names." },
		async () => jsonResult(await bridge.request("list_pages", {})),
	);

	registerFigmaTool(
		server,
		"list_frames",
		{
			description:
				"List the top-level frames, components, component sets and " +
				"sections on a page with their IDs, names, positions and sizes.",
			inputSchema: {
				pageId: z
					.string()
					.min(1)
					.optional()
					.describe("Page ID from list_pages; defaults to the current page."),
			},
		},
		async (args) =>
			jsonResult(
				await bridge.request(
					"list_frames",
					args.pageId ? { pageId: args.pageId } : {},
				),
			),
	);

	registerFigmaTool(
		server,
		"get_design_system",
		{
			description:
				"List the file's local design system: components and component " +
				"sets (with property definitions and variants), paint, text and " +
				"effect styles, and variables grouped by collection with a value " +
				"per mode (colors as hex, aliases as `{ alias: variableId }`). Use " +
				"the IDs with create_nodes/update_nodes: component IDs for " +
				"INSTANCE `componentId`, variable IDs in `variables` or a SOLID " +
				"paint's `variable`, style IDs in `styles`.",
		},
		async () => jsonResult(await bridge.request("get_design_system", {})),
	);
}
