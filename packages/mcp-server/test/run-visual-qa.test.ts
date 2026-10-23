import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
	designLayout,
	pngFixtures,
} from "@figma-agent-tool/visual-diff/fixtures";
import { startHarness } from "./harness";

type Rect = { x: number; y: number; width: number; height: number };
type NodeRef = { id: string; name: string; type: string };

type QaResult = {
	pass: boolean;
	mismatchPercent: number;
	mismatchBudget: number;
	dimensions: { width: number; height: number };
	scale: { x: number; y: number };
	exportScale: number;
	regions: (Rect & { mismatchedPixels: number; nodes: NodeRef[] })[];
	masks: (Rect & { kind: string })[];
	screen: { id: string; name: string; width: number; height: number };
	device: { deviceId: string; platform: string };
	navigation?: { completed: number; total: number };
	dir: string;
	figmaPath: string;
	devicePath: string;
	diffPath: string;
	reportPath: string;
};

const simulator = {
	deviceId: "A1B2C3D4-SIM",
	platform: "ios",
	connectedAt: 1_700_000_000_000,
};

const base64 = async (path: string) =>
	(await readFile(path)).toString("base64");

// The Login frame (1:1) is 393×852pt, like the visual-diff design fixture:
// the fake plugin exports that design for it, at 1x or 3x.
const loginExports = {
	1: await base64(pngFixtures.design),
	3: await base64(pngFixtures.identical),
};

/** A plugin and an active simulator whose screen shows `capture`. */
async function qaHarness(capture = pngFixtures.identical) {
	const harness = await startHarness();
	const plugin = await harness.connectFakePlugin({
		exportPng: (nodeId, scale) =>
			nodeId === "1:1"
				? loginExports[scale as keyof typeof loginExports]
				: undefined,
	});
	harness.yoqa.state.active = simulator;
	harness.yoqa.state.screen = await readFile(capture);
	return { harness, plugin };
}

async function runQa(
	harness: Awaited<ReturnType<typeof startHarness>>,
	args: Record<string, unknown> = {},
) {
	const result = await harness.callTool("run_visual_qa", {
		nodeId: "1:1",
		...args,
	});
	const [content] = result.content as { text: string }[];
	return {
		result,
		report: result.structuredContent as QaResult,
		text: content?.text ?? "",
	};
}

describe("run_visual_qa", () => {
	test("exports the frame at the device's scale, captures the device and passes a match", async () => {
		const { harness, plugin } = await qaHarness();
		const { result, report } = await runQa(harness);
		expect(result.isError).toBeFalsy();
		expect(report.pass).toBe(true);
		expect(report.mismatchPercent).toBe(0);
		expect(report.exportScale).toBe(3);
		expect(report.scale).toEqual({ x: 3, y: 3 });
		expect(report.dimensions).toEqual({ width: 1179, height: 2556 });
		expect(report.screen).toEqual({
			id: "1:1",
			name: "Login",
			width: 393,
			height: 852,
		});
		expect(report.device).toEqual(simulator);
		expect(
			plugin.requests
				.filter((r) => r.command === "export_node_image")
				.map((r) => r.params),
		).toEqual([{ nodeId: "1:1", scale: 3 }]);
	});

	test("writes the export, capture, diff and report to a timestamped folder", async () => {
		const { harness } = await qaHarness();
		const { report } = await runQa(harness);
		expect(dirname(report.dir)).toBe(harness.artifactsDir);
		expect(basename(report.dir)).toMatch(/^qa-\d{4}-\d{2}-\d{2}T[\d-]+Z-/);
		for (const path of [
			report.figmaPath,
			report.devicePath,
			report.diffPath,
			report.reportPath,
		]) {
			expect(dirname(path)).toBe(report.dir);
		}
		expect((await readdir(report.dir)).sort()).toEqual([
			"device.png",
			"diff.png",
			"figma.png",
			"report.md",
		]);
		expect(await readFile(report.figmaPath)).toEqual(
			await readFile(pngFixtures.identical),
		);
		expect(await readFile(report.devicePath)).toEqual(
			await readFile(pngFixtures.identical),
		);

		const again = await runQa(harness);
		expect(again.report.dir).not.toBe(report.dir);
	});

	test("masks the active device's platform insets by default", async () => {
		const { harness } = await qaHarness(pngFixtures.statusBar);
		const { report } = await runQa(harness);
		expect(report.pass).toBe(true);
		expect(report.masks.map((mask) => mask.kind)).toEqual([
			"status-bar",
			"home-indicator",
		]);
		expect(report.masks[0]).toMatchObject({ height: 59 * 3 });

		const unmasked = await runQa(harness, { platform: "none" });
		expect(unmasked.report.masks).toEqual([]);
		expect(unmasked.report.mismatchPercent).toBeGreaterThan(0);
	});

	test("lists the Figma nodes that overlap each mismatched region", async () => {
		const { harness, plugin } = await qaHarness(pngFixtures.shifted);
		// A hidden layer in the region doesn't count.
		const login = plugin.document.pages[0]?.children[0];
		const divider = login?.children?.find((node) => node.id === "1:5");
		if (divider) divider.y = 145;

		const { report } = await runQa(harness);
		expect(report.pass).toBe(false);
		// The card's top edge (y 140–156pt) runs through the Button instance
		// and its Label; its new bottom edge (y 340–356pt) through nothing.
		const nodeIds = report.regions.map((region) =>
			region.nodes.map((node) => node.id),
		);
		expect(nodeIds).toContainEqual(["1:3", "1:4"]);
		expect(nodeIds).toContainEqual([]);
		const top = report.regions.find((region) => region.nodes.length > 0);
		expect(top?.nodes).toEqual([
			{ id: "1:3", name: "Button", type: "INSTANCE" },
			{ id: "1:4", name: "Label", type: "TEXT" },
		]);
	});

	test("accepts compare_images options, with ignore regions in frame points", async () => {
		const { harness } = await qaHarness(pngFixtures.recolored);
		const strict = await runQa(harness);
		expect(strict.report.pass).toBe(false);

		const budget = await runQa(harness, { mismatchBudget: 10 });
		expect(budget.report.pass).toBe(true);
		expect(budget.report.mismatchBudget).toBe(10);

		const loose = await runQa(harness, { threshold: 1 });
		expect(loose.report.mismatchPercent).toBe(0);

		const ignored = await runQa(harness, {
			platform: "none",
			ignoreRegions: [designLayout.button],
		});
		expect(ignored.report.pass).toBe(true);
		const { x, y, width, height } = designLayout.button;
		expect(ignored.report.masks).toEqual([
			{
				kind: "ignore-region",
				x: x * 3,
				y: y * 3,
				width: width * 3,
				height: height * 3,
			},
		]);
	});

	test("ignores the boxes of the given Figma nodes", async () => {
		const { harness } = await qaHarness(pngFixtures.shifted);
		const { report } = await runQa(harness, {
			platform: "none",
			ignoreNodes: ["1:4"],
		});
		// The Label sits at 164,126 in the frame (Button at 24,114 + 140,12).
		expect(report.masks).toEqual([
			{
				kind: "ignore-region",
				x: 164 * 3,
				y: 126 * 3,
				width: 65 * 3,
				height: 24 * 3,
			},
		]);
	});

	test("uses an explicit device pixel ratio as the export scale", async () => {
		const { harness, plugin } = await qaHarness();
		const { report } = await runQa(harness, { scale: 3 });
		expect(report.pass).toBe(true);
		expect(plugin.requests.at(-1)?.params).toEqual({ nodeId: "1:1", scale: 3 });
	});

	test("writes a Markdown QA report for a PR and returns its path", async () => {
		const { harness } = await qaHarness(pngFixtures.recolored);
		const { report } = await runQa(harness);
		const markdown = await readFile(report.reportPath, "utf8");
		expect(markdown).toStartWith("## Visual QA: Login — FAIL\n");
		expect(markdown).toContain("| Screen | Login (`1:1`), 393×852 pt |");
		expect(markdown).toContain("| Device | ios A1B2C3D4-SIM |");
		expect(markdown).toContain(
			`| Mismatch | ${report.mismatchPercent}% (budget 0.5%) |`,
		);
		expect(markdown).toContain("| 1 | 72 | 2100 | 1035 | 156 | 161460 | — |");
		expect(markdown).toContain("![Figma](figma.png)");
		expect(markdown).toContain("![Device](device.png)");
		expect(markdown).toContain("![Diff](diff.png)");
	});

	test("navigates before capturing and reports the steps", async () => {
		const { harness } = await qaHarness();
		const { report } = await runQa(harness, {
			deepLink: "myapp://login",
			actions: [{ kind: "tap", label: "Settings" }],
		});
		expect(report.navigation).toEqual({ completed: 2, total: 2 });
		const paths = harness.yoqa.requests.map((r) => r.path);
		expect(paths.indexOf("/action/batch")).toBeLessThan(
			paths.indexOf("/screenshot/image"),
		);
	});

	test("stops at a failing navigation step without capturing", async () => {
		const { harness } = await qaHarness();
		const { result, text } = await runQa(harness, {
			actions: [{ kind: "tap", label: "Profile" }],
		});
		expect(result.isError).toBe(true);
		expect(text).toContain(
			'Navigation failed at actions[0] ({"kind":"tap","label":"Profile"})',
		);
		expect(
			harness.yoqa.requests.some((r) => r.path === "/screenshot/image"),
		).toBe(false);
	});

	test("explains a frame that doesn't fit the device screen and keeps both images", async () => {
		const { harness } = await qaHarness(pngFixtures.wrongAspect);
		const { result, text } = await runQa(harness);
		expect(result.isError).toBe(true);
		expect(text).toContain("differ in aspect ratio");
		const figmaPath = text.match(/Figma export: (\S+\.png)/)?.[1] ?? "";
		const devicePath = text.match(/device capture: (\S+\.png)/)?.[1] ?? "";
		expect(await Bun.file(figmaPath).exists()).toBe(true);
		expect(await Bun.file(devicePath).exists()).toBe(true);
	});

	test("reports a node ID that does not exist", async () => {
		const { harness } = await qaHarness();
		const { result, text } = await runQa(harness, { nodeId: "9:99" });
		expect(result.isError).toBe(true);
		expect(text).toContain('No node with ID "9:99"');
	});

	test("tells the agent to open the plugin when none is connected", async () => {
		const harness = await startHarness();
		harness.yoqa.state.active = simulator;
		const { result, text } = await runQa(harness);
		expect(result.isError).toBe(true);
		expect(text).toContain("No Figma plugin is connected");
	});

	test("tells the agent to connect a device when none is active", async () => {
		const { harness } = await qaHarness();
		harness.yoqa.state.active = null;
		const { result, text } = await runQa(harness);
		expect(result.isError).toBe(true);
		expect(text).toContain("No device is connected");
	});
});
