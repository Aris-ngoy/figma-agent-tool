// Visual QA tools. `compare_images` needs neither Figma nor a device: it
// diffs two local PNGs, so it also works in CI against stored baselines.
// `run_visual_qa` chains navigate, capture, export and compare.
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Depth } from "@figma-agent-tool/protocol";
import {
	ComparisonError,
	compare,
	DEFAULT_COMPARE_OPTIONS,
	type Rect,
	renderMarkdown,
} from "@figma-agent-tool/visual-diff";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createArtifactFolder, pngSize, writeArtifact } from "./artifacts";
import { type Bridge, BridgeRequestError } from "./bridge";
import {
	ActiveDevice,
	type DeviceRunner,
	DeviceRunnerError,
} from "./device-runner";
import { navigate, navigationShape } from "./device-tools";
import { registerGuardedTool, toolError } from "./figma-tool";
import { layerBoxes, overlapping } from "./frame-layers";
import { QA_FILES, type QaReport, renderQaReport } from "./qa-report";

const rect = z.object({
	x: z.number(),
	y: z.number(),
	width: z.number().positive(),
	height: z.number().positive(),
});

/** What a comparison reports, besides where its images are. */
const comparisonShape = {
	pass: z.boolean(),
	mismatchPercent: z.number(),
	mismatchBudget: z.number(),
	mismatchedPixels: z.number(),
	comparedPixels: z.number(),
	dimensions: z.object({ width: z.number(), height: z.number() }),
	scale: z.object({ x: z.number(), y: z.number() }),
	regions: z.array(rect.extend({ mismatchedPixels: z.number() })),
	masks: z.array(
		rect.extend({
			kind: z.enum(["status-bar", "home-indicator", "ignore-region"]),
		}),
	),
};

const reportShape = {
	...comparisonShape,
	designPath: z.string(),
	actualPath: z.string(),
	diffPath: z.string(),
	markdown: z.string().optional(),
};

/** Comparison settings shared by compare_images and run_visual_qa. */
const compareOptionsShape = {
	scale: z
		.union([z.literal("auto"), z.number().positive()])
		.default(DEFAULT_COMPARE_OPTIONS.scale)
		.describe(
			'Device pixels per design pixel (the device pixel ratio for a 1x design), or "auto" to derive it from the widths.',
		),
	platform: z
		.enum(["ios", "android", "none"])
		.default(DEFAULT_COMPARE_OPTIONS.platform)
		.describe(
			"Mask the platform's status bar and home indicator (iOS: top 59pt, bottom 34pt; Android: top 48dp, bottom 48dp, in design pixels).",
		),
	ignoreRegions: z
		.array(rect)
		.default([])
		.describe("Rectangles to leave out of the score, in design image pixels."),
	threshold: z
		.number()
		.min(0)
		.max(1)
		.default(DEFAULT_COMPARE_OPTIONS.threshold)
		.describe(
			"Per-pixel color distance (0–1) below which pixels count as equal.",
		),
	detectAntiAliasing: z
		.boolean()
		.default(DEFAULT_COMPARE_OPTIONS.detectAntiAliasing)
		.describe("Don't count anti-aliasing differences as mismatches."),
	mismatchBudget: z
		.number()
		.min(0)
		.max(100)
		.default(DEFAULT_COMPARE_OPTIONS.mismatchBudget)
		.describe("Pass when at most this percentage of pixels differs."),
	aspectTolerance: z
		.number()
		.min(0)
		.max(1)
		.default(DEFAULT_COMPARE_OPTIONS.aspectTolerance)
		.describe(
			"How far the aspect ratios may differ (as a fraction) before the comparison is refused.",
		),
};

const inlineDiff = z
	.boolean()
	.default(false)
	.describe(
		"Also return the diff image inline. Costs context; off by default.",
	);

const nodeRef = z.object({
	id: z.string(),
	name: z.string(),
	type: z.string(),
});

const qaShape = {
	...comparisonShape,
	regions: z.array(
		rect.extend({ mismatchedPixels: z.number(), nodes: z.array(nodeRef) }),
	),
	screen: z.object({
		id: z.string(),
		name: z.string(),
		width: z.number(),
		height: z.number(),
	}),
	device: ActiveDevice,
	navigation: z.object({ completed: z.number(), total: z.number() }).optional(),
	exportScale: z.number(),
	dir: z.string(),
	figmaPath: z.string(),
	devicePath: z.string(),
	diffPath: z.string(),
	reportPath: z.string(),
};

export function registerVisualQaTools(
	server: McpServer,
	{
		artifactsDir,
		bridge,
		deviceRunner,
	}: { artifactsDir: string; bridge: Bridge; deviceRunner: DeviceRunner },
) {
	server.registerTool(
		"compare_images",
		{
			description:
				"Pixel-diff a design PNG against an actual (device) PNG. The design is " +
				"scaled to the actual image's size; returns the mismatch percentage " +
				"over unmasked pixels, pass/fail against the budget, bounding boxes " +
				"of mismatched regions (in actual-image pixels) and the path of a " +
				"diff image (red: mismatch, yellow: anti-aliasing, blue: masked).",
			inputSchema: {
				designPath: z
					.string()
					.min(1)
					.describe("PNG of the design, e.g. a Figma frame exported at 1x."),
				actualPath: z
					.string()
					.min(1)
					.describe("PNG of what was rendered, e.g. a device screenshot."),
				...compareOptionsShape,
				markdown: z
					.boolean()
					.default(false)
					.describe("Also return a Markdown summary, e.g. for a PR."),
				inline: inlineDiff,
			},
			outputSchema: reportShape,
		},
		async ({ designPath, actualPath, markdown, inline, ...options }) => {
			const design = await readPng(designPath, "design");
			if (typeof design === "string") return toolError(design);
			const actual = await readPng(actualPath, "actual");
			if (typeof actual === "string") return toolError(actual);

			let report: ReturnType<typeof compare>;
			try {
				report = compare(design.bytes, actual.bytes, options);
			} catch (error) {
				if (error instanceof ComparisonError) return toolError(error.message);
				throw error;
			}
			const { diffPng, ...summary } = report;
			const diffPath = await writeArtifact(
				artifactsDir,
				"diff",
				"png",
				diffPng,
			);
			const structuredContent = {
				...summary,
				designPath: design.path,
				actualPath: actual.path,
				diffPath,
				...(markdown && {
					markdown: renderMarkdown(summary, {
						design: design.path,
						actual: actual.path,
						diff: diffPath,
					}),
				}),
			};
			return withDiff(structuredContent, inline && diffPng);
		},
	);

	registerGuardedTool(
		server,
		"run_visual_qa",
		{
			description:
				"Visual QA in one call: optionally navigate the active device (as " +
				"navigate_device), capture it, export the Figma frame at the " +
				"device's pixel ratio and compare the two. Returns the " +
				"compare_images report plus, per mismatched region, the visible " +
				"Figma layers drawn there (none: the app shows something the " +
				"design doesn't). The export, capture, diff and a Markdown QA " +
				"report for a PR are written to a timestamped folder.",
			inputSchema: {
				nodeId: z
					.string()
					.min(1)
					.describe("The Figma frame of the screen, e.g. from list_frames."),
				...navigationShape,
				...compareOptionsShape,
				scale: compareOptionsShape.scale.describe(
					'Device pixels per frame point (the device pixel ratio), or "auto" to derive it from the widths. The frame is exported at this scale (up to 4).',
				),
				platform: compareOptionsShape.platform
					.unwrap()
					.optional()
					.describe(
						"Mask the platform's status bar and home indicator (iOS: top 59pt, bottom 34pt; Android: top 48dp, bottom 48dp). Defaults to the device's platform.",
					),
				ignoreRegions: compareOptionsShape.ignoreRegions.describe(
					"Rectangles to leave out of the score, in frame points.",
				),
				ignoreNodes: z
					.array(z.string().min(1))
					.default([])
					.describe(
						"IDs of layers in the frame to leave out of the score, e.g. timestamps or avatars.",
					),
				inline: inlineDiff,
			},
			outputSchema: qaShape,
		},
		async ({
			nodeId,
			deepLink,
			actions,
			settleMs,
			ignoreNodes,
			inline,
			...options
		}) => {
			// Fails fast on a missing plugin or node, before touching the device.
			const { node: frame } = await bridge.request("get_node", {
				id: nodeId,
				depth: Depth.maxValue as number,
			});
			const { width: frameWidth, height: frameHeight } = frame;
			if (frameWidth === undefined || frameHeight === undefined) {
				return toolError(
					`Node ${nodeId} is a ${frame.type} and has no size. Pass a frame from list_frames.`,
				);
			}
			const layers = layerBoxes(frame);
			const ignoredLayers: Rect[] = [];
			for (const id of ignoreNodes) {
				const layer = layers.find((box) => box.id === id);
				if (!layer) {
					return toolError(
						`ignoreNodes: ${id} is not a visible layer inside ${frame.name} (${nodeId}).`,
					);
				}
				const { x, y, width, height } = layer;
				ignoredLayers.push({ x, y, width, height });
			}

			let navigation: { completed: number; total: number } | undefined;
			if (deepLink || actions) {
				const outcome = await navigate(deviceRunner, {
					deepLink,
					actions,
					settleMs,
				});
				if ("error" in outcome) return toolError(outcome.error);
				navigation = { completed: outcome.completed, total: outcome.total };
			}
			const capture = await deviceRunner.screenshot();
			const { device } = capture;

			const deviceSize = pngSize(capture.png);
			const exportScale = Math.min(
				round(
					options.scale === "auto"
						? deviceSize.width / frameWidth
						: options.scale,
				),
				MAX_EXPORT_SCALE,
			);
			const { png } = await bridge.request("export_node_image", {
				nodeId,
				scale: exportScale,
			});
			const figmaPng = Buffer.from(png, "base64");

			const dir = await createArtifactFolder(artifactsDir, "qa");
			const figmaPath = join(dir, QA_FILES.figma);
			const devicePath = join(dir, QA_FILES.device);
			await writeFile(figmaPath, figmaPng);
			await writeFile(devicePath, capture.png);

			let comparison: ReturnType<typeof compare>;
			try {
				comparison = compare(figmaPng, capture.png, {
					...options,
					platform: options.platform ?? device.platform,
					ignoreRegions: [...options.ignoreRegions, ...ignoredLayers],
					designScale: pngSize(figmaPng).width / frameWidth,
				});
			} catch (error) {
				if (!(error instanceof ComparisonError)) throw error;
				return toolError(
					`${error.message} Figma export: ${figmaPath}; device capture: ${devicePath}.`,
				);
			}
			const { diffPng, ...summary } = comparison;
			const report: QaReport = {
				...summary,
				regions: summary.regions.map((region) => ({
					...region,
					nodes: overlapping(layers, {
						x: region.x / summary.scale.x,
						y: region.y / summary.scale.y,
						width: region.width / summary.scale.x,
						height: region.height / summary.scale.y,
					}),
				})),
				screen: {
					id: frame.id,
					name: frame.name,
					width: frameWidth,
					height: frameHeight,
				},
				device,
				...(navigation && { navigation }),
			};
			const diffPath = join(dir, QA_FILES.diff);
			const reportPath = join(dir, QA_FILES.report);
			await writeFile(diffPath, diffPng);
			await writeFile(reportPath, renderQaReport(report));
			return withDiff(
				{
					...report,
					exportScale,
					dir,
					figmaPath,
					devicePath,
					diffPath,
					reportPath,
				},
				inline && diffPng,
			);
		},
		[BridgeRequestError, DeviceRunnerError],
	);
}

/** Figma's export UI, and the bridge's export command, stop at 4x. */
const MAX_EXPORT_SCALE = 4;

const round = (value: number) => Math.round(value * 1000) / 1000;

/** A JSON result, with the diff image inline when given. */
function withDiff(
	structuredContent: Record<string, unknown>,
	diffPng: Uint8Array | false,
): CallToolResult {
	const content: CallToolResult["content"] = [
		{ type: "text", text: JSON.stringify(structuredContent) },
	];
	if (diffPng) {
		content.push({
			type: "image",
			data: Buffer.from(diffPng).toString("base64"),
			mimeType: "image/png",
		});
	}
	return { content, structuredContent };
}

/** The file's absolute path and bytes, or an error message for the agent. */
async function readPng(
	path: string,
	label: string,
): Promise<{ path: string; bytes: Uint8Array } | string> {
	const absolute = resolve(path);
	try {
		return { path: absolute, bytes: await readFile(absolute) };
	} catch (error) {
		const reason =
			(error as NodeJS.ErrnoException).code === "ENOENT"
				? "the file does not exist"
				: (error as Error).message;
		return `Could not read the ${label} image at ${absolute}: ${reason}.`;
	}
}
