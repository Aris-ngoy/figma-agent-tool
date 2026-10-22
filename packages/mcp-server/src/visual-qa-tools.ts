// Visual QA tools. `compare_images` needs neither Figma nor a device: it
// diffs two local PNGs, so it also works in CI against stored baselines.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	ComparisonError,
	compare,
	DEFAULT_COMPARE_OPTIONS,
	renderMarkdown,
} from "@figma-agent-tool/visual-diff";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { writeArtifact } from "./artifacts";
import { toolError } from "./figma-tool";

const rect = z.object({
	x: z.number(),
	y: z.number(),
	width: z.number().positive(),
	height: z.number().positive(),
});

const reportShape = {
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
	designPath: z.string(),
	actualPath: z.string(),
	diffPath: z.string(),
	markdown: z.string().optional(),
};

export function registerVisualQaTools(
	server: McpServer,
	{ artifactsDir }: { artifactsDir: string },
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
					.describe(
						"Rectangles to leave out of the score, in design image pixels.",
					),
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
				markdown: z
					.boolean()
					.default(false)
					.describe("Also return a Markdown summary, e.g. for a PR."),
				inline: z
					.boolean()
					.default(false)
					.describe(
						"Also return the diff image inline. Costs context; off by default.",
					),
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
			const content: CallToolResult["content"] = [
				{ type: "text", text: JSON.stringify(structuredContent) },
			];
			if (inline) {
				content.push({
					type: "image",
					data: Buffer.from(diffPng).toString("base64"),
					mimeType: "image/png",
				});
			}
			return { content, structuredContent };
		},
	);
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
