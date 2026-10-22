import { describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { framePng } from "@figma-agent-tool/protocol/fixtures";
import { startHarness } from "./harness";

type ExportResult = { path: string; width: number; height: number };

describe("export_node_image", () => {
	test("writes the PNG to the artifacts folder and returns its path and pixel size", async () => {
		const harness = await startHarness();
		await harness.connectFakePlugin();
		const result = await harness.callTool("export_node_image", {
			nodeId: "1:2",
			scale: 2,
		});
		expect(result.isError).toBeFalsy();
		const { path, width, height } = result.structuredContent as ExportResult;
		expect(dirname(path)).toBe(harness.artifactsDir);
		expect(path).toEndWith(".png");
		expect({ width, height }).toEqual({ width: 4, height: 2 });
		expect(await readFile(path)).toEqual(Buffer.from(framePng, "base64"));
	});

	test("returns no inline image unless asked", async () => {
		const harness = await startHarness();
		await harness.connectFakePlugin();
		const result = await harness.callTool("export_node_image", {
			nodeId: "1:2",
			scale: 2,
		});
		const content = result.content as { type: string }[];
		expect(content.map((item) => item.type)).toEqual(["text"]);
	});

	test("includes the image inline when asked", async () => {
		const harness = await startHarness();
		await harness.connectFakePlugin();
		const result = await harness.callTool("export_node_image", {
			nodeId: "1:2",
			scale: 2,
			inline: true,
		});
		expect(result.content).toContainEqual({
			type: "image",
			data: framePng,
			mimeType: "image/png",
		});
	});

	test("writes to the configured artifacts folder, creating it if needed", async () => {
		const root = join(
			tmpdir(),
			`figma-agent-configured-${crypto.randomUUID()}`,
		);
		try {
			const harness = await startHarness({
				artifactsDir: join(root, "nested"),
			});
			await harness.connectFakePlugin();
			const result = await harness.callTool("export_node_image", {
				nodeId: "1:2",
				scale: 2,
			});
			const { path } = result.structuredContent as ExportResult;
			expect(dirname(path)).toBe(harness.artifactsDir);
			expect(await Bun.file(path).exists()).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("keeps earlier exports instead of overwriting them", async () => {
		const harness = await startHarness();
		await harness.connectFakePlugin();
		const args = { nodeId: "1:2", scale: 2 };
		const first = await harness.callTool("export_node_image", args);
		const second = await harness.callTool("export_node_image", args);
		expect((first.structuredContent as ExportResult).path).not.toBe(
			(second.structuredContent as ExportResult).path,
		);
	});

	test("explains why a node cannot be exported", async () => {
		const harness = await startHarness();
		await harness.connectFakePlugin();
		const result = await harness.callTool("export_node_image", {
			nodeId: "0:1",
			scale: 1,
		});
		expect(result.isError).toBe(true);
		const [content] = result.content as { text: string }[];
		expect(content?.text).toContain(
			"Node 0:1 is a PAGE and cannot be exported",
		);
	});

	test("reports a node ID that does not exist", async () => {
		const harness = await startHarness();
		await harness.connectFakePlugin();
		const result = await harness.callTool("export_node_image", {
			nodeId: "9:99",
			scale: 1,
		});
		expect(result.isError).toBe(true);
		const [content] = result.content as { text: string }[];
		expect(content?.text).toContain("No node with ID 9:99");
	});

	test("tells the agent to open the plugin when none is connected", async () => {
		const harness = await startHarness();
		const result = await harness.callTool("export_node_image", {
			nodeId: "1:2",
			scale: 2,
		});
		expect(result.isError).toBe(true);
		const [content] = result.content as { text: string }[];
		expect(content?.text).toContain("No Figma plugin is connected");
	});
});
