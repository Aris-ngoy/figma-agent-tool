import { describe, expect, test } from "bun:test";
import type { NodeMotion } from "@figma-agent-tool/protocol";
import {
	appliedStyleId,
	document,
	getMotionResponse,
	handshake,
	noMotionHandshake,
	setMotionRequest,
	setMotionResponse,
} from "@figma-agent-tool/protocol/fixtures";
import { createCommandHandler } from "../src/handler";
import { installMockFigma } from "./mock-figma";

/** A mocked file plus a `send` that runs commands through the real handler. */
function plugin({ motion = true } = {}) {
	const figma = installMockFigma(document, { motion });
	const handler = createCommandHandler({ pluginVersion: "0.0.0" });
	let n = 0;
	async function send(command: string, params: unknown) {
		return handler.handle({
			type: "request",
			id: `req-${++n}`,
			command,
			params,
		});
	}
	return {
		figma,
		handler,
		send,
		async result(command: string, params: unknown) {
			const response = await send(command, params);
			if (!response.ok) throw new Error(response.error.message);
			return response.result as Record<string, unknown>;
		},
		async motion(nodeId: string) {
			return (await this.result("get_motion", { nodeId })) as NodeMotion;
		},
	};
}

const motionOf = (nodeId: string) =>
	document.motion.nodes[nodeId] ?? { animationStyles: [], keyframeTracks: [] };

describe("Motion capability", () => {
	test("the handshake reports Motion when the Plugin API has it", () => {
		expect(plugin().handler.handshake()).toEqual(handshake);
	});

	test("the handshake reports no Motion in a Figma version without it", () => {
		expect(plugin({ motion: false }).handler.handshake()).toEqual(
			noMotionHandshake,
		);
	});

	test.each([
		["get_motion", { nodeId: "1:3" }],
		["set_motion", setMotionRequest.params],
	])(
		"%s fails with motion_unsupported without the Motion API",
		async (command, params) => {
			const response = await plugin({ motion: false }).send(command, params);
			expect(response).toMatchObject({
				ok: false,
				error: {
					code: "motion_unsupported",
					message: expect.stringContaining(
						"not supported in this Figma version",
					),
				},
			});
		},
	);
});

describe("get_motion", () => {
	test("reads applied styles, keyframe tracks and the timeline", async () => {
		const { availableStyles: _, ...motion } = getMotionResponse.result;
		expect(await plugin().motion("1:3")).toEqual(motion as never);
	});

	test("reads a node without animations as empty, with no timeline", async () => {
		expect(await plugin().motion("1:20")).toEqual({
			nodeId: "1:20",
			timelines: [],
			animationStyles: [],
			keyframeTracks: [],
		});
	});

	test("lists the Figma presets and the file's custom styles on request", async () => {
		const result = await plugin().result("get_motion", {
			nodeId: "1:2",
			availableStyles: true,
		});
		expect(result.availableStyles).toEqual(document.motion.styles);
	});

	test.each([
		["0:1", "no_motion"],
		["9:99", "node_not_found"],
	])("fails for %s with %s", async (nodeId, code) => {
		const response = await plugin().send("get_motion", { nodeId });
		expect(response).toMatchObject({ ok: false, error: { code } });
	});
});

describe("set_motion", () => {
	test("writing every node's Motion back leaves it unchanged", async () => {
		const figma = plugin();
		for (const nodeId of Object.keys(document.motion.nodes)) {
			const { timelines, ...motion } = await figma.motion(nodeId);
			await figma.result("set_motion", motion);
			expect(await figma.motion(nodeId)).toEqual({
				nodeId,
				timelines,
				animationStyles: motionOf(nodeId).animationStyles.map((style, i) => ({
					...style,
					// Re-applying a style gives it a new application ID.
					id: appliedStyleId(
						nodeId,
						motionOf(nodeId).animationStyles.length + i + 1,
					),
				})),
				keyframeTracks: motionOf(nodeId).keyframeTracks,
			});
		}
	});

	test("replace swaps out the styles and tracks it's given, and nothing else", async () => {
		const figma = plugin();
		await figma.result("set_motion", {
			nodeId: "1:3",
			keyframeTracks: [],
		});
		expect(await figma.motion("1:3")).toMatchObject({
			animationStyles: motionOf("1:3").animationStyles,
			keyframeTracks: [],
		});
	});

	test("append adds styles after the existing ones and replaces a field's track", async () => {
		const figma = plugin();
		const [, fillTrack] = motionOf("1:3").keyframeTracks;
		const rise = {
			field: { type: "PROPERTY", name: "TRANSLATION_Y" },
			keyframes: [
				{
					id: "kf",
					timelinePosition: 0,
					easing: { type: "LINEAR" },
					value: { type: "FLOAT", value: 8 },
				},
			],
		};
		const result = await figma.result("set_motion", {
			nodeId: "1:3",
			mode: "append",
			animationStyles: [{ type: "CUSTOM", styleId: "S:card-enter," }],
			keyframeTracks: [rise],
		});
		expect(result.animationStyles).toEqual([
			...motionOf("1:3").animationStyles,
			{
				type: "CUSTOM",
				id: appliedStyleId("1:3", 2),
				styleId: "S:card-enter,",
				name: "Card enter",
			},
		]);
		expect(result.keyframeTracks).toEqual([
			{ ...rise, id: "1:3/track-TRANSLATION_Y" },
			fillTrack,
		]);
	});

	test("answers the fixture exchange in one undo step", async () => {
		const figma = plugin();
		expect(await figma.result("set_motion", setMotionRequest.params)).toEqual(
			setMotionResponse.result as never,
		);
		expect(figma.figma.undoCommits).toBe(1);
	});

	test.each([
		[
			"an unknown custom style",
			{ animationStyles: [{ type: "CUSTOM", styleId: "S:nope" }] },
			"animation_style_not_found",
		],
		[
			"a paint the node doesn't have",
			{
				keyframeTracks: [
					{
						field: { type: "INDEXED_ITEM", collection: "strokes", index: 0 },
						keyframes: [],
					},
				],
			},
			"invalid_keyframe_field",
		],
		[
			"a timeline duration outside any timeline",
			{ timelineDuration: 1 },
			"no_timeline",
		],
	])("rejects %s and writes nothing", async (_name, change, code) => {
		const figma = plugin();
		const nodeId = "1:3";
		const target = "timelineDuration" in change ? "1:20" : nodeId;
		const response = await figma.send("set_motion", {
			nodeId: target,
			animationStyles: [],
			keyframeTracks: [],
			...change,
		});
		expect(response).toMatchObject({ ok: false, error: { code } });
		expect(await figma.motion(target)).toMatchObject({
			animationStyles: motionOf(target).animationStyles,
			keyframeTracks: motionOf(target).keyframeTracks,
		});
		expect(figma.figma.undoCommits).toBe(0);
	});
});
