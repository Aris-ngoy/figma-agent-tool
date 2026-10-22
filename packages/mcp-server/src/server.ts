// The MCP tool surface. Figma-backed tools go through `registerFigmaTool`,
// which turns bridge failures into actionable tool errors.
import {
	McpServer,
	type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };
import { DEFAULT_ARTIFACTS_DIR, pngSize, writeArtifact } from "./artifacts";
import {
	type Bridge,
	BridgeNotConnectedError,
	PluginCommandError,
} from "./bridge";

export function createMcpServer({
	bridge,
	artifactsDir = DEFAULT_ARTIFACTS_DIR,
}: {
	bridge: Bridge;
	/** Where image outputs are written. */
	artifactsDir?: string;
}): McpServer {
	const server = new McpServer({
		name: "figma-agent-tool",
		version: packageJson.version,
	});

	server.registerTool(
		"get_status",
		{
			description:
				"Report whether the Figma plugin bridge is connected and which file it bridges.",
			outputSchema: {
				bridge: z.object({
					connected: z.boolean(),
					port: z.number(),
					file: z
						.object({ key: z.string().nullable(), name: z.string() })
						.optional(),
					pluginVersion: z.string().optional(),
					capabilities: z.object({ motion: z.boolean() }).optional(),
				}),
			},
		},
		async () => {
			const structuredContent = { bridge: bridge.status() };
			return {
				content: [{ type: "text", text: JSON.stringify(structuredContent) }],
				structuredContent,
			};
		},
	);

	registerFigmaTool(
		server,
		"export_node_image",
		{
			description:
				"Export a node as a PNG into the artifacts folder and return its path " +
				"and pixel size. Set `inline` to also get the image in the result.",
			inputSchema: {
				nodeId: z.string().min(1).describe("Figma node ID, e.g. `1:2`."),
				scale: z
					.number()
					.positive()
					.max(4)
					.default(1)
					.describe("Export scale, as in Figma's export panel (up to 4)."),
				inline: z
					.boolean()
					.default(false)
					.describe(
						"Also return the image inline. Costs context; off by default.",
					),
			},
			outputSchema: {
				path: z.string(),
				width: z.number(),
				height: z.number(),
			},
		},
		async ({ nodeId, scale, inline }) => {
			const { png } = await bridge.request("export_node_image", {
				nodeId,
				scale,
			});
			const bytes = Buffer.from(png, "base64");
			const { width, height } = pngSize(bytes);
			const path = await writeArtifact(
				artifactsDir,
				`node-${nodeId}@${scale}x`,
				"png",
				bytes,
			);
			const structuredContent = { path, width, height };
			const content: CallToolResult["content"] = [
				{ type: "text", text: JSON.stringify(structuredContent) },
			];
			if (inline)
				content.push({ type: "image", data: png, mimeType: "image/png" });
			return { content, structuredContent };
		},
	);

	return server;
}

type FigmaToolConfig<
	Shape extends z.ZodRawShape,
	OutputShape extends z.ZodRawShape,
> = {
	title?: string;
	description: string;
	inputSchema?: Shape;
	outputSchema?: OutputShape;
};

/** Registers a tool that needs the plugin; bridge failures become tool errors. */
export function registerFigmaTool<
	Shape extends z.ZodRawShape,
	OutputShape extends z.ZodRawShape = z.ZodRawShape,
>(
	server: McpServer,
	name: string,
	config: FigmaToolConfig<Shape, OutputShape>,
	handler: ToolCallback<Shape>,
) {
	const callback = (async (...args: Parameters<typeof handler>) => {
		try {
			return await (handler as (...a: typeof args) => Promise<CallToolResult>)(
				...args,
			);
		} catch (error) {
			if (
				error instanceof BridgeNotConnectedError ||
				error instanceof PluginCommandError
			) {
				return toolError(error.message);
			}
			throw error;
		}
	}) as ToolCallback<Shape>;
	server.registerTool(name, config, callback);
}

function toolError(message: string): CallToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}
