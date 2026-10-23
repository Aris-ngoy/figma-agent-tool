// Handoff tools: the traced prototype graph, each screen's layers and the
// design system, rendered as Markdown by the handoff package.
import {
	type Handoff,
	renderFlowMarkdown,
	renderScreenMarkdown,
} from "@figma-agent-tool/handoff";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { writeExport } from "./artifacts";
import type { Bridge } from "./bridge";
import { registerFigmaTool, toolError } from "./figma-tool";
import { traceFlow } from "./flow-graph";
import { traceInput } from "./flow-tools";

/** Deep enough for any real screen; the plugin's maximum. */
const SCREEN_DEPTH = 100;

const pathInput = z
	.string()
	.min(1)
	.optional()
	.describe(
		"File to write the Markdown to, relative to the working directory; overwritten if it exists. Folders are created.",
	);

const sections =
	"Per screen: node ID, Figma link and size; `Interactions` (layer, " +
	"trigger, action, destination, transition type, direction, easing, " +
	"duration); `Broken interactions` with a reason; `Tokens` (variables and " +
	"styles the visible layers use, with values and the fields using them); " +
	"`Components` (instances with their property values). Empty sections say " +
	"`None.`. Same document state, same bytes.";

export function registerHandoffTools(server: McpServer, bridge: Bridge) {
	const fetchNodes = (nodeIds: string[]) =>
		bridge.request("get_flow_nodes", { nodeIds });

	/**
	 * Traces from `nodeId` and fetches what the Markdown needs besides: the
	 * design system and the layer trees of every screen (or just the start).
	 */
	async function handoffFrom(
		nodeId: string,
		{ maxDepth, startOnly = false }: { maxDepth?: number; startOnly?: boolean },
	): Promise<Handoff | CallToolResult> {
		const graph = await traceFlow(fetchNodes, nodeId, maxDepth);
		if ("code" in graph) return toolError(graph.message);
		const screens = startOnly ? graph.screens.slice(0, 1) : graph.screens;
		const [designSystem, ...trees] = await Promise.all([
			bridge.request("get_design_system", {}),
			...screens.map(async ({ id }) => {
				const { node } = await bridge.request("get_node", {
					id,
					depth: SCREEN_DEPTH,
				});
				return node;
			}),
		]);
		const status = bridge.status();
		return {
			file: status.connected ? (status.file ?? null) : null,
			graph,
			trees,
			designSystem,
		};
	}

	async function written(markdown: string, path?: string) {
		const content: CallToolResult["content"] = [
			{ type: "text", text: markdown },
		];
		if (path) {
			const absolute = await writeExport(path, markdown);
			content.unshift({ type: "text", text: `Wrote ${absolute}` });
		}
		return { content };
	}

	registerFigmaTool(
		server,
		"export_flow_markdown",
		{
			description:
				"Export a prototype flow as handoff Markdown for developers and " +
				"coding agents: a header (file, page, start, screen count), then " +
				"one `## Screen` section per screen trace_flow reaches, in walk " +
				`order. ${sections}`,
			inputSchema: { ...traceInput, path: pathInput },
		},
		async ({ nodeId, maxDepth, path }) => {
			const handoff = await handoffFrom(nodeId, { maxDepth });
			if ("content" in handoff) return handoff;
			const { flows } = await bridge.request("list_flows", {
				pageId: handoff.graph.page.id,
			});
			const flow = flows.find((f) => f.nodeId === handoff.graph.start);
			const name = flow?.name ?? handoff.graph.screens[0]?.name ?? nodeId;
			return written(renderFlowMarkdown({ ...handoff, name }), path);
		},
	);

	registerFigmaTool(
		server,
		"export_screen_markdown",
		{
			description:
				"Export one screen (a top-level frame) as handoff Markdown, the " +
				"same as its section in export_flow_markdown, with the file and " +
				`page. ${sections}`,
			inputSchema: {
				nodeId: z
					.string()
					.min(1)
					.describe("Top-level frame to export, e.g. from list_frames."),
				path: pathInput,
			},
		},
		async ({ nodeId, path }) => {
			// One level of the walk names the screens it leads to.
			const handoff = await handoffFrom(nodeId, {
				maxDepth: 1,
				startOnly: true,
			});
			if ("content" in handoff) return handoff;
			return written(renderScreenMarkdown(handoff), path);
		},
	);
}
