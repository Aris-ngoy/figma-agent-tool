// The MCP tool surface. Figma-backed tools go through `registerFigmaTool`,
// which turns bridge failures into actionable tool errors.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };
import { DEFAULT_ARTIFACTS_DIR, writePngArtifact } from "./artifacts";
import type { Bridge } from "./bridge";
import { type DeviceRunner, RunnerStatus } from "./device-runner";
import { registerDeviceTools } from "./device-tools";
import { registerEditTools } from "./edit-tools";
import { registerFigmaTool } from "./figma-tool";
import { registerFlowTools } from "./flow-tools";
import { registerReactionTools } from "./reaction-tools";
import { registerReadTools } from "./read-tools";
import { registerRestructureTools } from "./restructure-tools";
import { registerVisualQaTools } from "./visual-qa-tools";

export function createMcpServer({
	bridge,
	artifactsDir = DEFAULT_ARTIFACTS_DIR,
	deviceRunner,
}: {
	bridge: Bridge;
	deviceRunner: DeviceRunner;
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
				"Report whether the Figma plugin bridge is connected and which file " +
				"it bridges, whether the Yoqa device runner is reachable, and which " +
				"device is active.",
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
				runner: RunnerStatus,
			},
		},
		async () => {
			const structuredContent = {
				bridge: bridge.status(),
				runner: await deviceRunner.status(),
			};
			return {
				content: [{ type: "text", text: JSON.stringify(structuredContent) }],
				structuredContent,
			};
		},
	);

	registerReadTools(server, bridge);
	registerEditTools(server, bridge);
	registerRestructureTools(server, bridge);
	registerReactionTools(server, bridge);
	registerFlowTools(server, bridge);
	registerVisualQaTools(server, { artifactsDir, bridge, deviceRunner });
	registerDeviceTools(server, deviceRunner, artifactsDir);

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
			const structuredContent = await writePngArtifact(
				artifactsDir,
				`node-${nodeId}@${scale}x`,
				Buffer.from(png, "base64"),
			);
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
