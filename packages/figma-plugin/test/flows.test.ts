import { describe, expect, test } from "bun:test";
import { document } from "@figma-agent-tool/protocol/fixtures";
import { createCommandHandler } from "../src/handler";
import { installMockFigma } from "./mock-figma";

function plugin() {
	const figma = installMockFigma(document);
	const handler = createCommandHandler({ pluginVersion: "0.0.0" });
	let n = 0;
	return {
		figma,
		async send(command: string, params: unknown) {
			return handler.handle({
				type: "request",
				id: `req-${++n}`,
				command,
				params,
			});
		},
		/** The flow starting points Figma's prototype viewer shows for a page. */
		viewerFlows(pageId: string) {
			const page = figma.root.children.find((p) => p.id === pageId);
			return (page as unknown as PageNode).flowStartingPoints;
		},
	};
}

describe("list_flows", () => {
	test("lists one page's flows", async () => {
		const response = await plugin().send("list_flows", { pageId: "0:3" });
		expect(response).toMatchObject({
			ok: true,
			result: {
				flows: [
					{
						nodeId: "4:1",
						name: "Onboarding",
						page: { id: "0:3", name: "Onboarding" },
					},
				],
			},
		});
	});

	test("fails for an ID that isn't a page", async () => {
		const response = await plugin().send("list_flows", { pageId: "1:1" });
		expect(response).toMatchObject({
			ok: false,
			error: { code: "page_not_found" },
		});
	});
});

describe("set_flow_start", () => {
	test("adds a flow the prototype viewer shows, as one undo step", async () => {
		const figma = plugin();
		await figma.send("set_flow_start", { nodeId: "1:10", name: "Home" });
		expect(figma.viewerFlows("0:1")).toEqual([
			{ nodeId: "1:1", name: "Sign in" },
			{ nodeId: "1:10", name: "Home" },
		]);
		expect(figma.figma.undoCommits).toBe(1);
	});

	test("renames the flow a frame already starts", async () => {
		const figma = plugin();
		const response = await figma.send("set_flow_start", {
			nodeId: "4:1",
			name: "First run",
		});
		expect(response).toMatchObject({ ok: true, result: { created: false } });
		expect(figma.viewerFlows("0:3")).toEqual([
			{ nodeId: "4:1", name: "First run" },
		]);
	});

	test.each([
		["9:99", "No node"],
		["0:1", "PAGE"],
		["1:20", "top-level TEXT"],
	])("rejects %s and changes nothing", async (nodeId, why) => {
		const figma = plugin();
		const response = await figma.send("set_flow_start", {
			nodeId,
			name: "Nope",
		});
		expect(response).toMatchObject({
			ok: false,
			error: {
				code: "invalid_flow_start",
				message: expect.stringContaining(why),
			},
		});
		expect(figma.viewerFlows("0:1")).toEqual(document.pages[0]?.flows ?? []);
		expect(figma.figma.undoCommits).toBe(0);
	});
});

describe("get_flow_nodes", () => {
	test("collects reactions from instance sublayers and the screen itself", async () => {
		const response = await plugin().send("get_flow_nodes", {
			nodeIds: ["1:1"],
		});
		expect(response).toMatchObject({
			ok: true,
			result: {
				nodes: [
					{
						id: "1:1",
						topLevel: true,
						reactions: [
							{ nodeId: "1:2", nodeName: "Title" },
							{ nodeId: "1:3", nodeName: "Button" },
						],
					},
				],
				missing: [],
			},
		});
	});

	test("doesn't walk a page's layers", async () => {
		const response = await plugin().send("get_flow_nodes", {
			nodeIds: ["0:1"],
		});
		expect(response).toMatchObject({
			ok: true,
			result: { nodes: [{ id: "0:1", type: "PAGE", reactions: [] }] },
		});
	});
});
