import { describe, expect, test } from "bun:test";
import type { Reaction } from "@figma-agent-tool/protocol";
import {
	brokenReactionNodeIds,
	document,
} from "@figma-agent-tool/protocol/fixtures";
import { createCommandHandler } from "../src/handler";
import { installMockFigma } from "./mock-figma";

/** A mocked file plus a `send` that runs commands through the real handler. */
function plugin() {
	const figma = installMockFigma(document);
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
		send,
		async result(command: string, params: unknown) {
			const response = await send(command, params);
			if (!response.ok) throw new Error(response.error.message);
			return response.result as Record<string, unknown>;
		},
		async reactions(nodeId: string) {
			const { reactions } = await this.result("get_reactions", { nodeId });
			return reactions as Reaction[];
		},
	};
}

const navigateTo = (destinationId: string, navigation = "NAVIGATE") => ({
	trigger: { type: "ON_CLICK" },
	actions: [{ type: "NODE", destinationId, navigation, transition: null }],
});

describe("get_reactions", () => {
	test("reads a node's reactions without the deprecated `action` field", async () => {
		expect(await plugin().reactions("1:2")).toEqual(
			document.reactions["1:2"] as Reaction[],
		);
	});

	test("reads no reactions from a node without any", async () => {
		expect(await plugin().reactions("1:1")).toEqual([]);
	});

	test("fails for a page, which can't have reactions", async () => {
		const response = await plugin().send("get_reactions", { nodeId: "0:1" });
		expect(response).toMatchObject({
			ok: false,
			error: { code: "no_reactions", message: expect.stringContaining("PAGE") },
		});
	});
});

describe("set_reactions", () => {
	test("writing every node's reactions back leaves them unchanged", async () => {
		const figma = plugin();
		const writable = Object.keys(document.reactions).filter(
			(nodeId) => !brokenReactionNodeIds.includes(nodeId),
		);
		for (const nodeId of writable) {
			const reactions = await figma.reactions(nodeId);
			await figma.result("set_reactions", { nodeId, reactions });
			expect(await figma.reactions(nodeId)).toEqual(
				document.reactions[nodeId] as Reaction[],
			);
		}
	});

	test("replaces by default and returns the node's reactions", async () => {
		const figma = plugin();
		const result = await figma.result("set_reactions", {
			nodeId: "1:3",
			reactions: [navigateTo("1:1")],
		});
		expect(result).toEqual({ nodeId: "1:3", reactions: [navigateTo("1:1")] });
		expect(await figma.reactions("1:3")).toEqual([navigateTo("1:1")] as never);
	});

	test("defaults matchLayers to false on directional transitions", async () => {
		const figma = plugin();
		const easing = { type: "EASE_OUT" };
		await figma.result("set_reactions", {
			nodeId: "1:1",
			reactions: [
				{
					trigger: { type: "ON_CLICK" },
					actions: [
						{
							type: "NODE",
							destinationId: "1:10",
							navigation: "NAVIGATE",
							transition: {
								type: "PUSH",
								direction: "LEFT",
								easing,
								duration: 0.3,
							},
						},
					],
				},
			],
		});
		expect(await figma.reactions("1:1")).toMatchObject([
			{ actions: [{ transition: { matchLayers: false } }] },
		]);
	});

	test("commits the write as one undo step", async () => {
		const figma = plugin();
		await figma.result("set_reactions", { nodeId: "1:1", reactions: [] });
		expect(figma.figma.undoCommits).toBe(1);
	});

	test.each([
		["NAVIGATE", "1:4", "nested TEXT"],
		["OVERLAY", "1:20", "top-level TEXT"],
		["CHANGE_TO", "1:10", "is a FRAME"],
		["SCROLL_TO", "0:2", "is a PAGE"],
	])(
		"rejects %s to %s and writes nothing",
		async (navigation, destination, why) => {
			const figma = plugin();
			const response = await figma.send("set_reactions", {
				nodeId: "1:3",
				reactions: [navigateTo(destination, navigation)],
			});
			expect(response).toMatchObject({
				ok: false,
				error: {
					code: "invalid_destination",
					message: expect.stringContaining(why),
				},
			});
			expect(await figma.reactions("1:3")).toEqual(
				document.reactions["1:3"] as Reaction[],
			);
			expect(figma.figma.undoCommits).toBe(0);
		},
	);

	test("checks destinations inside conditional actions", async () => {
		const response = await plugin().send("set_reactions", {
			nodeId: "1:1",
			reactions: [
				{
					trigger: { type: "ON_CLICK" },
					actions: [
						{
							type: "CONDITIONAL",
							conditionalBlocks: [{ actions: navigateTo("9:99").actions }],
						},
					],
				},
			],
		});
		expect(response).toMatchObject({
			ok: false,
			error: { code: "invalid_destination" },
		});
	});

	test("accepts CHANGE_TO a component and SCROLL_TO a nested layer", async () => {
		const figma = plugin();
		const reactions = [
			navigateTo("2:1", "CHANGE_TO"),
			navigateTo("1:4", "SCROLL_TO"),
		];
		await figma.result("set_reactions", { nodeId: "1:3", reactions });
		expect(await figma.reactions("1:3")).toEqual(reactions as never);
	});
});

describe("remove_reactions", () => {
	test("clears every reaction without a match", async () => {
		const figma = plugin();
		const result = await figma.result("remove_reactions", { nodeId: "1:2" });
		expect(result).toEqual({ nodeId: "1:2", removed: 3, reactions: [] });
		expect(await figma.reactions("1:2")).toEqual([]);
		expect(figma.figma.undoCommits).toBe(1);
	});

	test("removes only reactions matching the trigger and destination", async () => {
		const figma = plugin();
		const result = await figma.result("remove_reactions", {
			nodeId: "1:3",
			match: { trigger: "ON_CLICK", destinationId: "1:10" },
		});
		const [, ...kept] = document.reactions["1:3"] as Reaction[];
		expect(result).toEqual({ nodeId: "1:3", removed: 1, reactions: kept });
	});

	test("fails for an unknown node", async () => {
		const response = await plugin().send("remove_reactions", {
			nodeId: "9:99",
		});
		expect(response).toMatchObject({
			ok: false,
			error: { code: "node_not_found" },
		});
	});
});
