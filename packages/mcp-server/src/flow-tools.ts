// Flow tools: list and set flow starting points, and trace or export the
// prototype graph the plugin's raw reactions describe.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "./bridge";
import { jsonResult, registerFigmaTool, toolError } from "./figma-tool";
import { traceFlow } from "./flow-graph";

const traceInput = {
	nodeId: z
		.string()
		.min(1)
		.describe(
			"Top-level frame the flow starts at: a flow's `nodeId` from list_flows or a frame from list_frames.",
		),
	maxDepth: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe(
			"Stop walking screens this many interactions from the start; they're listed but their interactions are left out (`truncated`). Unlimited by default.",
		),
};

const graphNotes =
	"Walks breadth-first from the starting frame over every reaction of every " +
	"layer, following NAVIGATE, OVERLAY and SWAP to other screens (cycles " +
	"end at screens already seen). Returns `screens` (with `depth`, the " +
	"interactions from the start), `edges` (from screen, source layer, " +
	"trigger, `action` NAVIGATE/OVERLAY/SWAP/SCROLL_TO/CHANGE_TO/BACK/CLOSE/" +
	"URL, destination `to` and `transition`; actions inside conditionals are " +
	"marked `conditional`) and `dangling` edges with a `reason`: " +
	"no_destination, missing (deleted), invalid (the navigation can't use it) " +
	"or other_page.";

export function registerFlowTools(server: McpServer, bridge: Bridge) {
	const fetchNodes = (nodeIds: string[]) =>
		bridge.request("get_flow_nodes", { nodeIds });

	registerFigmaTool(
		server,
		"list_flows",
		{
			description:
				"List prototype flow starting points (name, starting frame ID and " +
				"page), as Figma's prototype viewer shows them. Every page's by " +
				"default.",
			inputSchema: {
				pageId: z
					.string()
					.min(1)
					.optional()
					.describe("Page ID from list_pages; omit for every page."),
			},
		},
		async (args) =>
			jsonResult(
				await bridge.request(
					"list_flows",
					args.pageId ? { pageId: args.pageId } : {},
				),
			),
	);

	registerFigmaTool(
		server,
		"set_flow_start",
		{
			description:
				"Make a top-level frame a prototype flow starting point with this " +
				"name, or rename the flow it already starts (`created` false). The " +
				"flow shows up in Figma's prototype viewer; one undo step.",
			inputSchema: {
				nodeId: z
					.string()
					.min(1)
					.describe("Top-level frame the flow starts at."),
				name: z.string().min(1).describe("Flow name, e.g. `Onboarding`."),
			},
		},
		async (args) => jsonResult(await bridge.request("set_flow_start", args)),
	);

	registerFigmaTool(
		server,
		"trace_flow",
		{
			description: `Trace the prototype graph from a starting frame. ${graphNotes}`,
			inputSchema: traceInput,
		},
		async ({ nodeId, maxDepth }) => {
			const graph = await traceFlow(fetchNodes, nodeId, maxDepth);
			if ("code" in graph) return toolError(graph.message);
			return jsonResult(graph);
		},
	);

	registerFigmaTool(
		server,
		"export_flow_json",
		{
			description:
				"Export the prototype graph trace_flow returns as a JSON document " +
				"for other tools: `{ version, file, graph }`. Set `path` to also " +
				`write it there (folders are created). ${graphNotes}`,
			inputSchema: {
				...traceInput,
				path: z
					.string()
					.min(1)
					.optional()
					.describe(
						"File to write the JSON to, relative to the working directory; overwritten if it exists.",
					),
			},
		},
		async ({ nodeId, maxDepth, path }) => {
			const graph = await traceFlow(fetchNodes, nodeId, maxDepth);
			if ("code" in graph) return toolError(graph.message);
			const status = bridge.status();
			const exported = {
				version: 1,
				file: status.connected ? status.file : null,
				graph,
			};
			if (!path) return jsonResult(exported);
			const absolute = resolve(path);
			await mkdir(dirname(absolute), { recursive: true });
			await writeFile(absolute, `${JSON.stringify(exported, null, "\t")}\n`);
			return jsonResult({ ...exported, path: absolute });
		},
	);
}
