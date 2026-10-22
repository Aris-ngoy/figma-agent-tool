// The MCP tool surface. Figma-backed tools go through `registerFigmaTool`,
// which turns bridge failures into actionable tool errors.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };
import type { Bridge } from "./bridge";
import { registerReadTools } from "./read-tools";

export { registerFigmaTool } from "./figma-tool";

export function createMcpServer({ bridge }: { bridge: Bridge }): McpServer {
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

	registerReadTools(server, bridge);

	return server;
}
