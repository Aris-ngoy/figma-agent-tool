// v2 tools: a Design Project in the repo (init, check, render) and its sync
// with Figma (push, pull, relink). The CLI runs the same functions.
import {
	checkProject,
	chooseDirection,
	DesignProjectError,
	initProject,
	loadProject,
} from "@figma-agent-tool/design-project";
import {
	DEFAULT_PREVIEW_PORT,
	exportNote,
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
	findDirection,
	findScreen,
	pullDesignProject,
	pushDesignProject,
	pushDirections,
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
				'Link Screens into a prototype with href="other-screen.html" on any element (or <a href>), ' +
				'animated by data-transition (instant by default; "push left", "smart-animate 400ms ease-in-out", …). ' +
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
				"Render a Screen, or one of its Directions, to a PNG exactly as the Preview shows it " +
				"(headless Chromium, downloaded on first use), into the artifacts folder, in the default Mode or the " +
				"`mode` given. Returns its path and size, and its Figma-owned Elements, drawn " +
				"from the exports Pull cached (`export`: current, stale once the Screen resized " +
				"one, or missing); set `inline` to also get the image.",
			inputSchema: {
				screen: z
					.string()
					.min(1)
					.describe("Screen name: its file name in screens/ without .html."),
				direction: z
					.string()
					.min(1)
					.optional()
					.describe(
						"A Direction of the Screen to render instead: its file name in screens/<screen>.directions/ without .html.",
					),
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
			outputSchema: {
				path: z.string(),
				width: z.number(),
				height: z.number(),
				figmaOwned: z.array(
					z.object({
						key: z.string(),
						name: z.string().optional(),
						export: z.enum(["current", "stale", "missing"]),
						note: z.string().optional(),
					}),
				),
			},
		},
		async ({ screen: name, direction, mode, inline }) => {
			const project = await loadProject(designDir);
			const screen = direction
				? findDirection(project, name, direction)
				: findScreen(project, name);
			const { png, figmaOwned } = await renderScreen(project, screen, {
				screenshot,
				mode,
			});
			let artifact = `screen-${name}`;
			if (direction) artifact += `-${direction}`;
			if (mode) artifact += `-${mode}`;
			const structuredContent = {
				...(await writePngArtifact(artifactsDir, artifact, png)),
				figmaOwned: figmaOwned.map(({ src: _, ...owned }) => {
					const note = exportNote(owned);
					return note ? { ...owned, note } : owned;
				}),
			};
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

	registerGuardedTool(
		server,
		"choose_direction",
		{
			description:
				"Choose one of a Screen's Directions (alternative versions in " +
				"screens/<screen>.directions/, compared side by side in the Preview): it becomes the " +
				"Screen (screens/<screen>.html, created if there was none) and the other Directions " +
				"are deleted with their folder; git keeps them. The Screen's frame in Figma updates " +
				"in place at the next Push. Only when the user picked the Direction.",
			inputSchema: {
				screen: z.string().min(1).describe("The Screen's name."),
				direction: z
					.string()
					.min(1)
					.describe(
						"The Direction's file name in screens/<screen>.directions/ without .html.",
					),
			},
			outputSchema: {
				screen: z.string(),
				file: z.string(),
				chose: z.string(),
				discarded: z.array(z.string()),
			},
		},
		async ({ screen, direction }) => {
			const project = await loadProject(designDir);
			return jsonResult(
				await chooseDirection(
					project,
					findDirection(project, screen, direction),
				),
			);
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
				"var(--…) are bound to its variable or style. Prototype Links (href) become on-click " +
				"NAVIGATEs to their Screen's frame; other interactions designers made stay as they are. " +
				"One undo step. Writes a data-key into " +
				"every element. The first Push asks to confirm the Bridged File before linking it " +
				"(status confirm_link): ask the user, then call again with confirmLink. Refused " +
				"while the Bridged File isn't the Linked File, a Screen or DESIGN.md fails Check or " +
				"has Sync Conflicts, or a frame or the Design System has Unpulled Changes (Pull first). " +
				"A Screen's Directions are never pushed to the Screens Page: with `directions`, Push " +
				"instead copies them, labelled “<screen> / <direction>”, side by side on the " +
				"Explorations Page (replacing earlier copies), which Pull never reads.",
			inputSchema: {
				screens: z
					.array(z.string().min(1))
					.optional()
					.describe("Screens to push; all by default."),
				confirmLink: z
					.boolean()
					.default(false)
					.describe("Confirms linking the Bridged File on the first Push."),
				directions: z
					.boolean()
					.default(false)
					.describe(
						"Instead, copy the Screens' Directions to the Explorations Page for designers to compare (status pushed_directions).",
					),
			},
		},
		async ({ screens, confirmLink, directions }) =>
			jsonResult(
				directions
					? await pushDirections(designDir, bridge, { screens, confirmLink })
					: await pushDesignProject(designDir, bridge, {
							screens,
							confirmLink,
						}),
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
