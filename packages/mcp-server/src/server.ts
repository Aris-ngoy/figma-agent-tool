// The MCP tool surface. Figma-backed tools go through `registerFigmaTool`,
// which turns bridge failures into actionable tool errors.
import type {
	McpServer,
	ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as Server } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };
import {
	type Bridge,
	BridgeNotConnectedError,
	PluginCommandError,
} from "./bridge";

export function createMcpServer({ bridge }: { bridge: Bridge }): McpServer {
	const server = new Server({
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

	return server;
}

type FigmaToolConfig<Shape extends z.ZodRawShape> = {
	title?: string;
	description: string;
	inputSchema?: Shape;
};

/** Registers a tool that needs the plugin; bridge failures become tool errors. */
export function registerFigmaTool<Shape extends z.ZodRawShape>(
	server: McpServer,
	name: string,
	config: FigmaToolConfig<Shape>,
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
