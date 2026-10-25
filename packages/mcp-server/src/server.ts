// The MCP tool surface. Figma-backed tools go through `registerFigmaTool`,
// which turns bridge failures into actionable tool errors.
import { DEFAULT_DESIGN_DIR } from "@figma-agent-tool/design-project";
import type { Screenshotter } from "@figma-agent-tool/preview";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };
import { DEFAULT_ARTIFACTS_DIR, writePngArtifact } from "./artifacts";
import type { Bridge } from "./bridge";
import { designProjectStatus } from "./design-sync";
import { registerDesignTools } from "./design-tools";
import { type DeviceRunner, RunnerStatus } from "./device-runner";
import { registerDeviceTools } from "./device-tools";
import { registerEditTools } from "./edit-tools";
import { registerFigmaTool } from "./figma-tool";
import { registerFlowTools } from "./flow-tools";
import { registerHandoffTools } from "./handoff-tools";
import { registerMotionTools } from "./motion-tools";
import { registerReactionTools } from "./reaction-tools";
import { registerReadTools } from "./read-tools";
import { registerRestructureTools } from "./restructure-tools";
import { registerVisualQaTools } from "./visual-qa-tools";

export function createMcpServer({
	bridge,
	artifactsDir = DEFAULT_ARTIFACTS_DIR,
	designDir = DEFAULT_DESIGN_DIR,
	deviceRunner,
	screenshot,
}: {
	bridge: Bridge;
	deviceRunner: DeviceRunner;
	/** Where image outputs are written. */
	artifactsDir?: string;
	/** The Design Project's folder. */
	designDir?: string;
	/** How Render takes screenshots; headless Chromium by default. */
	screenshot?: Screenshotter;
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
				"device is active; and the Design Project: its Screens, Linked File, " +
				"and Screens with Unpulled Changes or Sync Conflicts.",
			outputSchema: {
				bridge: z.object({
					connected: z.boolean(),
					port: z.number(),
					file: z
						.object({ key: z.string().nullable(), name: z.string() })
						.optional(),
					pluginVersion: z.string().optional(),
					capabilities: z.object({ motion: z.boolean() }).optional(),
					linkId: z.string().nullable().optional(),
				}),
				runner: RunnerStatus,
				designProject: z
					.object({
						dir: z.string(),
						screens: z.array(z.string()),
						linkedFile: z
							.object({ key: z.string().nullable(), name: z.string() })
							.nullable(),
						bridgedFileIsLinked: z.boolean().nullable(),
						unpulledChanges: z.array(z.string()).nullable(),
						syncConflicts: z.array(z.string()),
						designSystem: z.object({
							unpulledChanges: z.array(z.string()).nullable(),
							syncConflicts: z.boolean(),
						}),
					})
					.nullable(),
			},
		},
		async () => {
			const structuredContent = {
				bridge: bridge.status(),
				runner: await deviceRunner.status(),
				designProject: await designProjectStatus(designDir, bridge),
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
	registerHandoffTools(server, bridge);
	registerMotionTools(server, bridge);
	registerVisualQaTools(server, { artifactsDir, bridge, deviceRunner });
	registerDeviceTools(server, deviceRunner, artifactsDir);
	registerDesignTools(server, { bridge, designDir, artifactsDir, screenshot });

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
