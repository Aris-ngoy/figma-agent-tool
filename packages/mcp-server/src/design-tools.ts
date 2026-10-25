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
	findScreen,
	pullDesignProject,
	pushDesignProject,
	relinkDesignProject,
} from "./design-sync";
import { jsonResult, registerGuardedTool } from "./figma-tool";

const CheckFinding = z.object({
	file: z.string(),
	line: z.number(),
	element: z.string(),
	rule: z.string(),
	message: z.string(),
});

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
				"CSS variables named after their path (var(--colors-primary), var(--spacing-md)). " +
				"Other Modes (dark, …) go in an optional modes.yaml next to DESIGN.md: " +
				'`default: Light` names DESIGN.md\'s Mode, and `modes: { Dark: { colors: { surface: "#111111" } } }` ' +
				"gives colors, spacing and rounded tokens other values in a Mode.",
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
				"Check every Screen against the Screen Subset, DESIGN.md against the DESIGN.md " +
				"spec (the rules of `npx @google/design.md lint`, WCAG contrast included), and the " +
				"Modes file (modes.yaml) against DESIGN.md's tokens, contrast in each Mode too. Each " +
				"finding names the file, line, element (a CSS selector, or a DESIGN.md token path), " +
				"rule and how to fix it. Push refuses while there are errors; warnings (low " +
				"contrast, tokens Figma variables can't hold) don't stop it.",
			outputSchema: {
				ok: z.boolean(),
				errors: z.array(CheckFinding),
				warnings: z.array(CheckFinding),
			},
		},
		async () => {
			const { errors, warnings } = await checkProject(
				await loadProject(designDir),
			);
			return jsonResult({ ok: errors.length === 0, errors, warnings });
		},
		EXPECTED,
	);

	registerGuardedTool(
		server,
		"render_screen",
		{
			description:
				"Render a Screen to a PNG exactly as the Preview shows it (headless Chromium, " +
				"downloaded on first use), into the artifacts folder, in the default Mode or the " +
				"`mode` given. Returns its path and size; set `inline` to also get the image.",
			inputSchema: {
				screen: z
					.string()
					.min(1)
					.describe("Screen name: its file name in screens/ without .html."),
				mode: z
					.string()
					.min(1)
					.optional()
					.describe(
						"A Mode from the Modes file (modes.yaml), such as Dark; the default Mode otherwise.",
					),
				inline: z
					.boolean()
					.default(false)
					.describe("Also return the image inline. Costs context."),
			},
			outputSchema: { path: z.string(), width: z.number(), height: z.number() },
		},
		async ({ screen: name, mode, inline }) => {
			const project = await loadProject(designDir);
			const screen = findScreen(project, name);
			const { png } = await renderScreen(project, screen, { screenshot, mode });
			const structuredContent = await writePngArtifact(
				artifactsDir,
				mode ? `screen-${name}-${mode}` : `screen-${name}`,
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
				"Screen at its Screen Size with Check's errors, in the Mode its switcher picks, " +
				"reloading as files change. It " +
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
				"Push Screens and the Design System to the Linked File: each Screen becomes (or " +
				"updates, in place, keeping node IDs) an auto-layout frame on the Screens Page, and " +
				"DESIGN.md's colors, spacing and rounded tokens become variables (typography: text " +
				"styles), updated in place too, with a variable mode per Mode in modes.yaml. Fills, spacing, radii and text written with a token's " +
				"var(--…) are bound to its variable or style. One undo step. Writes a data-key into " +
				"every element. The first Push asks to confirm the Bridged File before linking it " +
				"(status confirm_link): ask the user, then call again with confirmLink. Refused " +
				"while the Bridged File isn't the Linked File, a Screen or DESIGN.md fails Check or " +
				"has Sync Conflicts, or a frame or the Design System has Unpulled Changes (Pull first).",
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
				"Pull designers' edits from the Linked File into the Screens, and their edits to the " +
				"Design System's variables and text styles into DESIGN.md (other Modes' values into " +
				"modes.yaml): a three-way merge " +
				"against the Baseline (the last Push or Pull). Where both sides changed the same " +
				"element or token, the file gets Sync Conflict markers (<<<<<<< Design Project / " +
				"======= / >>>>>>> Figma): keep one side, delete the markers, then Push. Layers the " +
				"Screen Subset can't express stay in Figma and are listed as `unsupported`.",
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
