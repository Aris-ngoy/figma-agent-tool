// v2 tools: a Design Project in the repo (init, check, render) and its sync
// with Figma (push, pull, relink). The CLI runs the same functions.
import {
	checkProject,
	DesignProjectError,
	initProject,
	loadProject,
} from "@figma-agent-tool/design-project";
import {
	DEFAULT_PREVIEW_PORT,
	type Preview,
	RenderError,
	renderScreen,
	type Screenshotter,
	startPreview,
} from "@figma-agent-tool/preview";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { writePngArtifact } from "./artifacts";
import { type Bridge, BridgeRequestError } from "./bridge";
import {
	DesignSyncError,
	pullDesignProject,
	pushDesignProject,
	relinkDesignProject,
} from "./design-sync";
import { jsonResult, registerGuardedTool } from "./figma-tool";

const EXPECTED = [
	DesignProjectError,
	DesignSyncError,
	BridgeRequestError,
	RenderError,
];

export function registerDesignTools(
	server: McpServer,
	{
		bridge,
		designDir,
		artifactsDir,
		screenshot,
	}: {
		bridge: Bridge;
		designDir: string;
		artifactsDir: string;
		/** How Render takes screenshots; headless Chromium by default. */
		screenshot?: Screenshotter;
	},
) {
	registerGuardedTool(
		server,
		"init_design_project",
		{
			description:
				`Create a Design Project in ${designDir}/: project.json (the default Screen Size), ` +
				"a DESIGN.md Design System to fill in, screens/ for Screens and assets/ for images. " +
				"Screens are single <body> HTML files in the Screen Subset; DESIGN.md tokens are " +
				"CSS variables named after their path (var(--colors-primary), var(--spacing-md)).",
			inputSchema: {
				screenWidth: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Default Screen Size width in px (393)."),
				screenHeight: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Default Screen Size height in px (852)."),
			},
		},
		async ({ screenWidth, screenHeight }) => {
			const screenSize =
				screenWidth && screenHeight
					? { width: screenWidth, height: screenHeight }
					: undefined;
			return jsonResult(await initProject(designDir, { screenSize }));
		},
		EXPECTED,
	);

	registerGuardedTool(
		server,
		"check_design_project",
		{
			description:
				"Check every Screen against the Screen Subset and DESIGN.md's front matter. Each " +
				"error names the file, line, element (a CSS selector), rule and how to fix it. Push " +
				"refuses Screens that fail Check.",
			outputSchema: {
				ok: z.boolean(),
				errors: z.array(
					z.object({
						file: z.string(),
						line: z.number(),
						element: z.string(),
						rule: z.string(),
						message: z.string(),
					}),
				),
			},
		},
		async () => {
			const { errors } = await checkProject(await loadProject(designDir));
			return jsonResult({ ok: errors.length === 0, errors });
		},
		EXPECTED,
	);

	registerGuardedTool(
		server,
		"render_screen",
		{
			description:
				"Render a Screen to a PNG exactly as the Preview shows it (headless Chromium, " +
				"downloaded on first use), into the artifacts folder. Returns its path and size; " +
				"set `inline` to also get the image.",
			inputSchema: {
				screen: z
					.string()
					.min(1)
					.describe("Screen name: its file name in screens/ without .html."),
				inline: z
					.boolean()
					.default(false)
					.describe("Also return the image inline. Costs context."),
			},
			outputSchema: { path: z.string(), width: z.number(), height: z.number() },
		},
		async ({ screen: name, inline }) => {
			const project = await loadProject(designDir);
			const screen = project.screens.find((s) => s.name === name);
			if (!screen) {
				throw new DesignProjectError(
					`No Screen named "${name}": the Design Project has ${project.screens.map((s) => s.name).join(", ") || "no Screens"}.`,
				);
			}
			const { png } = await renderScreen(project, screen, { screenshot });
			const structuredContent = await writePngArtifact(
				artifactsDir,
				`screen-${name}`,
				png,
			);
			const result: CallToolResult = jsonResult(structuredContent);
			if (inline) {
				result.content.push({
					type: "image",
					data: Buffer.from(png).toString("base64"),
					mimeType: "image/png",
				});
			}
			return result;
		},
		EXPECTED,
	);

	let preview: Preview | undefined;
	server.server.onclose = () => preview?.stop();
	registerGuardedTool(
		server,
		"open_preview",
		{
			description:
				"Start the local Preview (once) and return its URL for the user to open: every " +
				"Screen at its Screen Size with Check's errors, reloading as files change. It " +
				"only views; Agents without a browser use render_screen to see their work.",
			outputSchema: { url: z.string() },
		},
		async () => {
			await loadProject(designDir);
			if (!preview) {
				try {
					preview = startPreview({
						dir: designDir,
						port: DEFAULT_PREVIEW_PORT,
					});
				} catch {
					// The default port is taken: any free one will do.
					preview = startPreview({ dir: designDir, port: 0 });
				}
			}
			return jsonResult({ url: preview.url });
		},
		EXPECTED,
	);

	registerGuardedTool(
		server,
		"push",
		{
			description:
				"Push Screens to the Linked File: each becomes (or updates, in place, keeping node " +
				"IDs) an auto-layout frame on the Screens Page, as one undo step. Writes a data-key " +
				"into every element. The first Push asks to confirm the Bridged File before linking " +
				"it (status confirm_link): ask the user, then call again with confirmLink. Refused " +
				"while the Bridged File isn't the Linked File, a Screen fails Check or has Sync " +
				"Conflicts, or a frame has Unpulled Changes (Pull first).",
			inputSchema: {
				screens: z
					.array(z.string().min(1))
					.optional()
					.describe("Screens to push; all by default."),
				confirmLink: z
					.boolean()
					.default(false)
					.describe("Confirms linking the Bridged File on the first Push."),
			},
		},
		async ({ screens, confirmLink }) =>
			jsonResult(
				await pushDesignProject(designDir, bridge, { screens, confirmLink }),
			),
		EXPECTED,
	);

	registerGuardedTool(
		server,
		"pull",
		{
			description:
				"Pull designers' edits from the Linked File into the Screens: a three-way merge " +
				"against the Baseline (the last Push or Pull). Where both sides changed the same " +
				"element, the file gets Sync Conflict markers (<<<<<<< Design Project / ======= / " +
				">>>>>>> Figma): keep one side, delete the markers, then Push. Layers the Screen " +
				"Subset can't express stay in Figma and are listed as `unsupported`.",
		},
		async () => jsonResult(await pullDesignProject(designDir, bridge)),
		EXPECTED,
	);

	registerGuardedTool(
		server,
		"relink_file",
		{
			description:
				"Link the Design Project to the Bridged File instead of its Linked File. The old " +
				"file's frames are forgotten: the next Push creates new ones. Only with the user's " +
				"explicit go-ahead.",
			inputSchema: {
				confirm: z
					.literal(true)
					.describe("Must be true: the user confirmed the re-link."),
			},
		},
		async () => jsonResult(await relinkDesignProject(designDir, bridge)),
		EXPECTED,
	);
}
