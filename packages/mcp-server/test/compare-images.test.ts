import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	designLayout,
	pngFixtures,
} from "@figma-agent-tool/visual-diff/fixtures";
import { PNG } from "pngjs";
import { startHarness } from "./harness";

type Rect = { x: number; y: number; width: number; height: number };

type CompareResult = {
	pass: boolean;
	mismatchPercent: number;
	mismatchBudget: number;
	mismatchedPixels: number;
	comparedPixels: number;
	dimensions: { width: number; height: number };
	scale: { x: number; y: number };
	regions: (Rect & { mismatchedPixels: number })[];
	masks: (Rect & { kind: string })[];
	designPath: string;
	actualPath: string;
	diffPath: string;
	markdown?: string;
};

async function compareImages(args: Record<string, unknown>) {
	const harness = await startHarness();
	const result = await harness.callTool("compare_images", args);
	return {
		harness,
		result,
		report: result.structuredContent as CompareResult,
		text: (result.content as { text?: string }[])[0]?.text ?? "",
	};
}

/** `inner` lies within `outer` grown by `slack` pixels on every side. */
function within(inner: Rect, outer: Rect, slack = 0) {
	return (
		inner.x >= outer.x - slack &&
		inner.y >= outer.y - slack &&
		inner.x + inner.width <= outer.x + outer.width + slack &&
		inner.y + inner.height <= outer.y + outer.height + slack
	);
}

const at3x = ({ x, y, width, height }: Rect) => ({
	x: x * 3,
	y: y * 3,
	width: width * 3,
	height: height * 3,
});

describe("compare_images", () => {
	test("reports identical images as a 0% mismatch that passes", async () => {
		const { result, report } = await compareImages({
			designPath: pngFixtures.design,
			actualPath: pngFixtures.design,
		});
		expect(result.isError).toBeFalsy();
		expect(report.mismatchPercent).toBe(0);
		expect(report.pass).toBe(true);
		expect(report.regions).toEqual([]);
	});

	test("lines a 393pt design up with a 1179px capture by auto scaling", async () => {
		const { report } = await compareImages({
			designPath: pngFixtures.design,
			actualPath: pngFixtures.identical,
		});
		expect(report.dimensions).toEqual({ width: 1179, height: 2556 });
		expect(report.scale).toEqual({ x: 3, y: 3 });
		expect(report.mismatchPercent).toBe(0);
		expect(report.pass).toBe(true);
	});

	test("accepts an explicit device pixel ratio", async () => {
		const { report } = await compareImages({
			designPath: pngFixtures.design,
			actualPath: pngFixtures.identical,
			scale: 3,
		});
		expect(report.pass).toBe(true);
	});

	test("explains an explicit pixel ratio that does not fit the capture", async () => {
		const { result, text } = await compareImages({
			designPath: pngFixtures.design,
			actualPath: pngFixtures.identical,
			scale: 2,
		});
		expect(result.isError).toBe(true);
		expect(text).toContain("should line up with a 786×1704 image");
		expect(text).toContain("1179×2556");
	});

	test("refuses images with the wrong aspect ratio instead of scoring them", async () => {
		const { result, text } = await compareImages({
			designPath: pngFixtures.design,
			actualPath: pngFixtures.wrongAspect,
		});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toBeUndefined();
		expect(text).toContain("differ in aspect ratio");
		expect(text).toContain("393×852");
		expect(text).toContain("1179×1179");
	});

	test("fails a moved element and boxes where it was and where it went", async () => {
		const { report } = await compareImages({
			designPath: pngFixtures.design,
			actualPath: pngFixtures.shifted,
		});
		expect(report.pass).toBe(false);
		expect(report.mismatchPercent).toBeGreaterThan(report.mismatchBudget);
		const card = at3x(designLayout.card);
		const movedCard = { ...card, height: card.height + 16 * 3 };
		expect(report.regions.length).toBeGreaterThan(0);
		for (const region of report.regions)
			expect(within(region, movedCard)).toBe(true);
	});

	test("fails a recolored element and boxes it", async () => {
		const { report } = await compareImages({
			designPath: pngFixtures.design,
			actualPath: pngFixtures.recolored,
		});
		expect(report.pass).toBe(false);
		const button = at3x(designLayout.button);
		expect(report.regions).toEqual([
			{ ...button, mismatchedPixels: button.width * button.height },
		]);
		expect(report.mismatchedPixels).toBe(button.width * button.height);
	});

	test("counts status bar differences without platform masks", async () => {
		const { report } = await compareImages({
			designPath: pngFixtures.design,
			actualPath: pngFixtures.statusBar,
		});
		expect(report.mismatchedPixels).toBeGreaterThan(0);
		expect(report.masks).toEqual([]);
	});

	for (const platform of ["ios", "android"]) {
		test(`passes status-bar-only differences with the default ${platform} masks`, async () => {
			const { report } = await compareImages({
				designPath: pngFixtures.design,
				actualPath: pngFixtures.statusBar,
				platform,
			});
			expect(report.mismatchPercent).toBe(0);
			expect(report.pass).toBe(true);
			expect(report.masks.map((mask) => mask.kind)).toEqual([
				"status-bar",
				"home-indicator",
			]);
		});
	}

	test("reports the iOS masks in aligned pixels and leaves them out of the score", async () => {
		const { report } = await compareImages({
			designPath: pngFixtures.design,
			actualPath: pngFixtures.identical,
			platform: "ios",
		});
		expect(report.masks).toEqual([
			{ kind: "status-bar", x: 0, y: 0, width: 1179, height: 59 * 3 },
			{
				kind: "home-indicator",
				x: 0,
				y: (852 - 34) * 3,
				width: 1179,
				height: 34 * 3,
			},
		]);
		expect(report.comparedPixels).toBe(1179 * (2556 - (59 + 34) * 3));
	});

	test("leaves custom ignore regions out of the score", async () => {
		const { report } = await compareImages({
			designPath: pngFixtures.design,
			actualPath: pngFixtures.recolored,
			ignoreRegions: [designLayout.button],
		});
		expect(report.mismatchPercent).toBe(0);
		expect(report.pass).toBe(true);
		const button = at3x(designLayout.button);
		expect(report.masks).toEqual([{ kind: "ignore-region", ...button }]);
		expect(report.comparedPixels).toBe(
			1179 * 2556 - button.width * button.height,
		);
	});

	test("passes a difference that fits within the mismatch budget", async () => {
		const { report } = await compareImages({
			designPath: pngFixtures.design,
			actualPath: pngFixtures.recolored,
			mismatchBudget: 10,
		});
		expect(report.mismatchPercent).toBeGreaterThan(0);
		expect(report.mismatchBudget).toBe(10);
		expect(report.pass).toBe(true);
	});

	test("lets a looser per-pixel threshold accept a small color change", async () => {
		const strict = await compareImages({
			designPath: pngFixtures.design,
			actualPath: pngFixtures.recolored,
		});
		const loose = await compareImages({
			designPath: pngFixtures.design,
			actualPath: pngFixtures.recolored,
			threshold: 1,
		});
		expect(strict.report.mismatchedPixels).toBeGreaterThan(0);
		expect(loose.report.mismatchedPixels).toBe(0);
	});

	test("writes a diff image of the aligned size to the artifacts folder", async () => {
		const { harness, report } = await compareImages({
			designPath: pngFixtures.design,
			actualPath: pngFixtures.recolored,
		});
		expect(dirname(report.diffPath)).toBe(harness.artifactsDir);
		const diff = PNG.sync.read(await readFile(report.diffPath));
		expect({ width: diff.width, height: diff.height }).toEqual(
			report.dimensions,
		);
		const button = at3x(designLayout.button);
		const pixel = (button.y * diff.width + button.x) * 4;
		expect([...diff.data.subarray(pixel, pixel + 3)]).toEqual([255, 0, 0]);
	});

	test("returns the absolute input paths and no inline image unless asked", async () => {
		const { result, report } = await compareImages({
			designPath: pngFixtures.design,
			actualPath: pngFixtures.identical,
		});
		expect(report.designPath).toBe(pngFixtures.design);
		expect(report.actualPath).toBe(pngFixtures.identical);
		expect(report.markdown).toBeUndefined();
		const content = result.content as { type: string }[];
		expect(content.map((item) => item.type)).toEqual(["text"]);
	});

	test("includes the diff image inline when asked", async () => {
		const { result, report } = await compareImages({
			designPath: pngFixtures.design,
			actualPath: pngFixtures.recolored,
			inline: true,
		});
		expect(result.content).toContainEqual({
			type: "image",
			data: (await readFile(report.diffPath)).toString("base64"),
			mimeType: "image/png",
		});
	});

	test("summarizes the comparison as Markdown when asked", async () => {
		const { report } = await compareImages({
			designPath: pngFixtures.design,
			actualPath: pngFixtures.recolored,
			platform: "ios",
			markdown: true,
		});
		const markdown = report.markdown ?? "";
		expect(markdown).toStartWith("## Visual comparison: FAIL\n");
		expect(markdown).toContain(
			`| Mismatch | ${report.mismatchPercent}% (budget 0.5%) |`,
		);
		expect(markdown).toContain(
			"| Aligned size | 1179×2556 px (design scaled ×3) |",
		);
		expect(markdown).toContain("status bar (1179×177 at 0,0)");
		expect(markdown).toContain("| 1 | 72 | 2100 | 1035 | 156 | 161460 |");
		expect(markdown).toContain(`- Diff: \`${report.diffPath}\``);
	});

	test("explains a missing input file", async () => {
		const missing = join(dirname(pngFixtures.design), "missing.png");
		const { result, text } = await compareImages({
			designPath: missing,
			actualPath: pngFixtures.identical,
		});
		expect(result.isError).toBe(true);
		expect(text).toBe(
			`Could not read the design image at ${missing}: the file does not exist.`,
		);
	});

	test("explains an input that is not a PNG", async () => {
		const { result, text } = await compareImages({
			designPath: pngFixtures.design,
			actualPath: join(dirname(pngFixtures.design), "index.ts"),
		});
		expect(result.isError).toBe(true);
		expect(text).toContain("The actual image is not a valid PNG");
	});
});
