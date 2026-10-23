import { describe, expect, test } from "bun:test";
import type { Reaction } from "@figma-agent-tool/protocol";
import {
	appendReactionsRequest,
	appendReactionsResponse,
	brokenReactionNodeIds,
	document,
	getReactionsRequest,
	getReactionsResponse,
	removeReactionsRequest,
	removeReactionsResponse,
	setDanglingReactionRequest,
	setDanglingReactionResponse,
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

async function reactionsOf(
	harness: Awaited<ReturnType<typeof connected>>,
	nodeId: string,
) {
	const result = await harness.callTool("get_reactions", { nodeId });
	return (result.structuredContent as { reactions: Reaction[] }).reactions;
}

describe("get_reactions", () => {
	test("returns a node's triggers, actions and transitions", async () => {
		const harness = await connected();
		const result = await harness.callTool(
			"get_reactions",
			getReactionsRequest.params,
		);
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual(getReactionsResponse.result);
		expect(JSON.parse(text(result))).toEqual(getReactionsResponse.result);
	});

	test("explains an unknown node as a tool error", async () => {
		const harness = await connected();
		const result = await harness.callTool("get_reactions", { nodeId: "9:99" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain('No node with ID "9:99"');
	});

	test("tells the agent to open the plugin when none is connected", async () => {
		const harness = await startHarness();
		const result = await harness.callTool("get_reactions", { nodeId: "1:3" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("No Figma plugin is connected");
	});
});

describe("set_reactions", () => {
	test("round trip: writing every node's reactions back leaves them unchanged", async () => {
		const harness = await connected();
		const writable = Object.keys(document.reactions).filter(
			(nodeId) => !brokenReactionNodeIds.includes(nodeId),
		);
		for (const nodeId of writable) {
			const reactions = await reactionsOf(harness, nodeId);
			const result = await harness.callTool("set_reactions", {
				nodeId,
				reactions,
			});
			expect(result.isError).toBeFalsy();
			expect(await reactionsOf(harness, nodeId)).toEqual(
				document.reactions[nodeId] as Reaction[],
			);
		}
	});

	test("appends after the existing reactions", async () => {
		const harness = await connected();
		const result = await harness.callTool(
			"set_reactions",
			appendReactionsRequest.params,
		);
		expect(result.structuredContent).toEqual(appendReactionsResponse.result);
		expect(await reactionsOf(harness, "1:10")).toEqual(
			appendReactionsResponse.result.reactions as Reaction[],
		);
	});

	test("replaces by default, filling in matchLayers", async () => {
		const harness = await connected();
		const reaction = {
			trigger: { type: "AFTER_TIMEOUT", timeout: 1 },
			actions: [
				{
					type: "NODE",
					destinationId: "1:10",
					navigation: "NAVIGATE",
					transition: {
						type: "MOVE_OUT",
						direction: "TOP",
						easing: { type: "LINEAR" },
						duration: 0.25,
					},
				},
			],
		};
		await harness.callTool("set_reactions", {
			nodeId: "1:3",
			reactions: [reaction],
		});
		expect(await reactionsOf(harness, "1:3")).toEqual([
			{
				...reaction,
				actions: [
					{
						...reaction.actions[0],
						transition: {
							...reaction.actions[0]?.transition,
							matchLayers: false,
						},
					},
				],
			},
		] as never);
	});

	test("rejects an invalid destination with a clear error and writes nothing", async () => {
		const harness = await connected();
		const result = await harness.callTool(
			"set_reactions",
			setDanglingReactionRequest.params,
		);
		expect(result.isError).toBe(true);
		expect(text(result)).toBe(setDanglingReactionResponse.error.message);
		expect(await reactionsOf(harness, "1:2")).toEqual(
			document.reactions["1:2"] as Reaction[],
		);
	});

	test("rejects navigating to a nested layer", async () => {
		const harness = await connected();
		const result = await harness.callTool("set_reactions", {
			nodeId: "1:3",
			reactions: [
				{
					trigger: { type: "ON_CLICK" },
					actions: [
						{
							type: "NODE",
							destinationId: "1:4",
							navigation: "NAVIGATE",
							transition: null,
						},
					],
				},
			],
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("needs a top-level frame");
	});

	test("rejects an unknown trigger type before reaching Figma", async () => {
		const harness = await connected();
		const result = await harness.callTool("set_reactions", {
			nodeId: "1:3",
			reactions: [{ trigger: { type: "ON_WINK" }, actions: [] }],
		});
		expect(result.isError).toBe(true);
	});
});

describe("remove_reactions", () => {
	test("removes the reactions matching a trigger type", async () => {
		const harness = await connected();
		const result = await harness.callTool(
			"remove_reactions",
			removeReactionsRequest.params,
		);
		expect(result.structuredContent).toEqual(removeReactionsResponse.result);
		expect(await reactionsOf(harness, "1:10")).toEqual(
			removeReactionsResponse.result.reactions,
		);
	});

	test("removes the reactions that go to a destination", async () => {
		const harness = await connected();
		const result = await harness.callTool("remove_reactions", {
			nodeId: "1:3",
			match: { destinationId: "1:10" },
		});
		expect(result.structuredContent).toMatchObject({ removed: 2 });
		expect(await reactionsOf(harness, "1:3")).toEqual([
			(document.reactions["1:3"] as Reaction[])[2] as Reaction,
		]);
	});

	test("clears every reaction without a match", async () => {
		const harness = await connected();
		const result = await harness.callTool("remove_reactions", {
			nodeId: "1:20",
		});
		expect(result.structuredContent).toEqual({
			nodeId: "1:20",
			removed: 4,
			reactions: [],
		});
	});
});
