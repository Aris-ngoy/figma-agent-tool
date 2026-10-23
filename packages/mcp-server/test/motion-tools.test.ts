import { describe, expect, test } from "bun:test";
import {
	motionUnsupportedError,
	type NodeMotion,
} from "@figma-agent-tool/protocol";
import {
	appliedStyleId,
	document,
	getMotionRequest,
	getMotionResponse,
	noMotionHandshake,
	setMotionRequest,
	setMotionResponse,
	setUnknownMotionStyleRequest,
	setUnknownMotionStyleResponse,
} from "@figma-agent-tool/protocol/fixtures";
import { startHarness } from "./harness";

async function connected() {
	const harness = await startHarness();
	await harness.connectFakePlugin();
	return harness;
}

function text(result: Record<string, unknown>): string {
	const [content] = result.content as { type: string; text: string }[];
	return content?.text ?? "";
}

async function motionOf(
	harness: Awaited<ReturnType<typeof connected>>,
	nodeId: string,
) {
	const result = await harness.callTool("get_motion", { nodeId });
	return result.structuredContent as NodeMotion;
}

describe("get_motion", () => {
	test("returns a node's animation styles, keyframe tracks and timeline, and the styles on offer", async () => {
		const harness = await connected();
		const result = await harness.callTool(
			"get_motion",
			getMotionRequest.params,
		);
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual(getMotionResponse.result);
		expect(JSON.parse(text(result))).toEqual(getMotionResponse.result);
	});

	test("leaves out the available styles unless asked", async () => {
		const harness = await connected();
		const motion = await motionOf(harness, "1:3");
		expect(motion).not.toHaveProperty("availableStyles");
	});

	test("explains a page as a tool error", async () => {
		const harness = await connected();
		const result = await harness.callTool("get_motion", { nodeId: "0:1" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("can't be animated");
	});

	test("tells the agent to open the plugin when none is connected", async () => {
		const harness = await startHarness();
		const result = await harness.callTool("get_motion", { nodeId: "1:3" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("No Figma plugin is connected");
	});
});

describe("set_motion", () => {
	test("applies styles and keyframes and sets the timeline duration", async () => {
		const harness = await connected();
		const result = await harness.callTool(
			"set_motion",
			setMotionRequest.params,
		);
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual(setMotionResponse.result);
		expect(await motionOf(harness, "1:10")).toEqual(
			setMotionResponse.result as never,
		);
	});

	test("round trip: writing every node's Motion back leaves its tracks unchanged", async () => {
		const harness = await connected();
		for (const nodeId of Object.keys(document.motion.nodes)) {
			const { timelines: _, ...motion } = await motionOf(harness, nodeId);
			const result = await harness.callTool("set_motion", motion);
			expect(result.isError).toBeFalsy();
			const after = await motionOf(harness, nodeId);
			expect(after.keyframeTracks).toEqual(motion.keyframeTracks);
			expect(after.animationStyles).toEqual(
				motion.animationStyles.map((style, i) => ({
					...style,
					id: appliedStyleId(nodeId, motion.animationStyles.length + i + 1),
				})),
			);
		}
	});

	test("appends a style after the existing ones", async () => {
		const harness = await connected();
		const result = await harness.callTool("set_motion", {
			nodeId: "1:2",
			mode: "append",
			animationStyles: [{ styleId: "motion:fade-in", duration: 0.2 }],
		});
		expect(
			(result.structuredContent as NodeMotion).animationStyles.map(
				(style) => style.styleId,
			),
		).toEqual(["S:card-enter,", "motion:fade-in"]);
	});

	test("rejects an unknown animation style and writes nothing", async () => {
		const harness = await connected();
		const result = await harness.callTool(
			"set_motion",
			setUnknownMotionStyleRequest.params,
		);
		expect(result.isError).toBe(true);
		expect(text(result)).toBe(setUnknownMotionStyleResponse.error.message);
		expect(await motionOf(harness, "1:3")).toMatchObject(
			document.motion.nodes["1:3"] as never,
		);
	});

	test("rejects two tracks on one field before reaching Figma", async () => {
		const harness = await connected();
		const track = {
			field: { type: "PROPERTY", name: "OPACITY" },
			keyframes: [],
		};
		const result = await harness.callTool("set_motion", {
			nodeId: "1:3",
			keyframeTracks: [track, track],
		});
		expect(result.isError).toBe(true);
	});
});

describe("without the Motion capability", () => {
	test.each([
		["get_motion", { nodeId: "1:3" }],
		["set_motion", setMotionRequest.params],
	])(
		"%s returns a clear unsupported error and asks nothing of the plugin",
		async (tool, args) => {
			const harness = await startHarness();
			const plugin = await harness.connectFakePlugin({
				handshake: noMotionHandshake,
			});
			const result = await harness.callTool(tool, args);
			expect(result.isError).toBe(true);
			expect(text(result)).toBe(motionUnsupportedError().message);
			expect(text(result)).toContain("not supported in this Figma version");
			expect(plugin.requests).toEqual([]);
		},
	);
});
