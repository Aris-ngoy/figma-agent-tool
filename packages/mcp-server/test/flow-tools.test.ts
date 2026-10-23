import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FlowEdge, PrototypeGraph } from "@figma-agent-tool/protocol";
import {
	document,
	getFlowNodesRequest,
	getFlowNodesResponse,
	listFlowsResponse,
	setFlowStartRequest,
	setFlowStartResponse,
	setNestedFlowStartRequest,
	setNestedFlowStartResponse,
} from "@figma-agent-tool/protocol/fixtures";
import { createFakeFlows } from "./fake-flows";
import { startHarness } from "./harness";

async function connected() {
	const harness = await startHarness();
	const plugin = await harness.connectFakePlugin();
	return { ...harness, plugin };
}

function text(result: Record<string, unknown>): string {
	const [content] = result.content as { type: string; text: string }[];
	return content?.text ?? "";
}

const r = document.reactions;
const click = { type: "ON_CLICK" } as const;

/** What trace_flow returns for the Onboarding flow. */
const onboardingGraph: PrototypeGraph = {
	start: "4:1",
	page: { id: "0:3", name: "Onboarding" },
	screens: [
		{
			id: "4:1",
			name: "Welcome",
			type: "FRAME",
			width: 393,
			height: 852,
			depth: 0,
		},
		{
			id: "4:10",
			name: "Permissions",
			type: "FRAME",
			width: 393,
			height: 852,
			depth: 1,
		},
		{
			id: "4:20",
			name: "Done",
			type: "FRAME",
			width: 393,
			height: 852,
			depth: 2,
		},
		{
			id: "4:30",
			name: "Info sheet",
			type: "FRAME",
			width: 393,
			height: 400,
			depth: 2,
		},
		{
			id: "4:40",
			name: "Second tip",
			type: "FRAME",
			width: 393,
			height: 400,
			depth: 3,
		},
	],
	edges: [
		{
			from: "4:1",
			nodeId: "4:2",
			nodeName: "Get started",
			trigger: click,
			action: "NAVIGATE",
			to: "4:10",
			transition: transitionOf("4:2"),
		},
		{
			from: "4:10",
			nodeId: "4:10",
			nodeName: "Permissions",
			trigger: { type: "ON_DRAG" },
			action: "BACK",
			to: null,
			transition: null,
		},
		{
			from: "4:10",
			nodeId: "4:11",
			nodeName: "Allow",
			trigger: click,
			action: "NAVIGATE",
			to: "4:20",
			transition: transitionOf("4:11"),
		},
		{
			from: "4:10",
			nodeId: "4:12",
			nodeName: "Learn more",
			trigger: click,
			action: "OVERLAY",
			to: "4:30",
			transition: transitionOf("4:12"),
			overlayRelativePosition: { x: 0, y: 452 },
		},
		{
			from: "4:10",
			nodeId: "4:13",
			nodeName: "Privacy policy",
			trigger: click,
			action: "URL",
			to: null,
			transition: null,
			url: "https://example.com/privacy",
		},
		{
			from: "4:20",
			nodeId: "4:21",
			nodeName: "Start over",
			trigger: click,
			action: "NAVIGATE",
			to: "4:1",
			transition: null,
		},
		{
			from: "4:30",
			nodeId: "4:31",
			nodeName: "Close",
			trigger: click,
			action: "CLOSE",
			to: null,
			transition: null,
		},
		{
			from: "4:30",
			nodeId: "4:32",
			nodeName: "Next tip",
			trigger: click,
			action: "SWAP",
			to: "4:40",
			transition: transitionOf("4:32"),
		},
		{
			from: "4:30",
			nodeId: "4:33",
			nodeName: "Jump to footer",
			trigger: click,
			action: "SCROLL_TO",
			to: "4:34",
			transition: null,
		},
		{
			from: "4:40",
			nodeId: "4:41",
			nodeName: "Got it",
			trigger: click,
			action: "CLOSE",
			to: null,
			transition: null,
		},
	],
	dangling: [
		{
			from: "4:20",
			nodeId: "4:22",
			nodeName: "Broken",
			trigger: click,
			action: "NAVIGATE",
			to: "4:99",
			transition: null,
			reason: "missing",
			message:
				'NAVIGATE destination "4:99" doesn\'t exist in this file. Use a node ID from list_frames or get_node.',
		},
		{
			from: "4:20",
			nodeId: "4:22",
			nodeName: "Broken",
			trigger: { type: "ON_HOVER" },
			action: "NAVIGATE",
			to: "1:1",
			transition: null,
			reason: "other_page",
			message:
				'NAVIGATE goes to "Login" (1:1) on page "Screens", but prototypes can\'t cross pages. Link to a frame on page "Onboarding".',
		},
		{
			from: "4:20",
			nodeId: "4:23",
			nodeName: "Unwired",
			trigger: click,
			action: "NAVIGATE",
			to: null,
			transition: null,
			reason: "no_destination",
			message: 'NAVIGATE on "Unwired" (4:23) has no destination set.',
		},
		{
			from: "4:30",
			nodeId: "4:33",
			nodeName: "Jump to footer",
			trigger: { type: "ON_PRESS" },
			action: "NAVIGATE",
			to: "4:34",
			transition: null,
			reason: "invalid",
			message:
				"NAVIGATE needs a top-level frame as its destination, but 4:34 is a nested RECTANGLE. Use a frame from list_frames.",
		},
	],
};

function transitionOf(nodeId: string) {
	const [reaction] = r[nodeId] ?? [];
	const [action] = reaction?.actions ?? [];
	return action?.type === "NODE" ? action.transition : null;
}

describe("list_flows", () => {
	test("lists every page's flow starting points", async () => {
		const harness = await connected();
		const result = await harness.callTool("list_flows");
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual(listFlowsResponse.result);
	});

	test("lists one page's flows", async () => {
		const harness = await connected();
		const result = await harness.callTool("list_flows", { pageId: "0:2" });
		expect(result.structuredContent).toEqual({ flows: [] });
	});

	test("tells the agent to open the plugin when none is connected", async () => {
		const harness = await startHarness();
		const result = await harness.callTool("list_flows");
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("No Figma plugin is connected");
	});
});

describe("set_flow_start", () => {
	test("creates a flow that list_flows then shows", async () => {
		const harness = await connected();
		const result = await harness.callTool(
			"set_flow_start",
			setFlowStartRequest.params,
		);
		expect(result.structuredContent).toEqual(setFlowStartResponse.result);
		const listed = await harness.callTool("list_flows", { pageId: "0:1" });
		expect(listed.structuredContent).toEqual({
			flows: [
				listFlowsResponse.result.flows[0],
				setFlowStartResponse.result.flow,
			],
		});
	});

	test("renames the flow a frame already starts", async () => {
		const harness = await connected();
		const result = await harness.callTool("set_flow_start", {
			nodeId: "1:1",
			name: "Log in",
		});
		expect(result.structuredContent).toMatchObject({ created: false });
		const listed = await harness.callTool("list_flows", { pageId: "0:1" });
		expect(listed.structuredContent).toEqual({
			flows: [
				{ nodeId: "1:1", name: "Log in", page: { id: "0:1", name: "Screens" } },
			],
		});
	});

	test("rejects a nested layer", async () => {
		const harness = await connected();
		const result = await harness.callTool(
			"set_flow_start",
			setNestedFlowStartRequest.params,
		);
		expect(result.isError).toBe(true);
		expect(text(result)).toBe(setNestedFlowStartResponse.error.message);
	});
});

describe("trace_flow", () => {
	test("the fake plugin reads flow nodes as the real one does", () => {
		const flows = createFakeFlows(structuredClone(document));
		expect(flows.get_flow_nodes(getFlowNodesRequest.params)).toEqual(
			getFlowNodesResponse.result,
		);
	});

	test("walks every reachable screen breadth-first, with dangling edges", async () => {
		const harness = await connected();
		const result = await harness.callTool("trace_flow", { nodeId: "4:1" });
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual(onboardingGraph);
		expect(JSON.parse(text(result))).toEqual(onboardingGraph);
	});

	test("fetches each level of the walk in one plugin request", async () => {
		const harness = await connected();
		await harness.callTool("trace_flow", { nodeId: "4:1" });
		const fetched = harness.plugin.requests
			.filter((request) => request.command === "get_flow_nodes")
			.map((request) => request.params);
		expect(fetched).toEqual([
			{ nodeIds: ["4:1"] },
			{ nodeIds: ["4:10"] },
			{ nodeIds: ["4:20", "4:30"] },
			{ nodeIds: ["4:99", "1:1", "4:40", "4:34"] },
		]);
	});

	test("terminates on cycles and keeps the edges that close them", async () => {
		const harness = await connected();
		const result = await harness.callTool("trace_flow", { nodeId: "1:1" });
		const graph = result.structuredContent as PrototypeGraph;
		expect(graph.screens.map(({ id, depth }) => [id, depth])).toEqual([
			["1:1", 0],
			["1:10", 1],
		]);
		const summary = (edge: FlowEdge) => [
			edge.from,
			edge.nodeId,
			edge.action,
			edge.to,
			edge.conditional ?? false,
		];
		expect(graph.edges.map(summary)).toEqual([
			["1:1", "1:2", "OVERLAY", "1:10", false],
			["1:1", "1:2", "CLOSE", null, false],
			["1:1", "1:2", "URL", null, false],
			["1:1", "1:3", "NAVIGATE", "1:10", false],
			["1:1", "1:3", "NAVIGATE", "1:10", false],
			["1:1", "1:3", "SCROLL_TO", "1:2", false],
			["1:10", "1:10", "NAVIGATE", "1:1", false],
			["1:10", "1:10", "BACK", null, false],
			["1:10", "1:10", "SWAP", "1:1", false],
			["1:10", "1:10", "BACK", null, true],
			["1:10", "1:10", "CLOSE", null, true],
		]);
		expect(graph.dangling).toEqual([]);
	});

	test("stops at maxDepth and says the graph is truncated", async () => {
		const harness = await connected();
		const result = await harness.callTool("trace_flow", {
			nodeId: "4:1",
			maxDepth: 1,
		});
		const graph = result.structuredContent as PrototypeGraph;
		expect(graph.screens.map((screen) => screen.id)).toEqual(["4:1", "4:10"]);
		expect(graph.edges.map((edge) => edge.from)).toEqual(["4:1"]);
		expect(graph.truncated).toBe(true);
	});

	test.each([
		["9:99", 'No node with ID "9:99"'],
		["4:34", "nested RECTANGLE"],
	])("rejects %s as a starting point", async (nodeId, why) => {
		const harness = await connected();
		const result = await harness.callTool("trace_flow", { nodeId });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain(why);
	});

	test("sees reactions set_reactions just wired", async () => {
		const harness = await connected();
		await harness.callTool("set_reactions", {
			nodeId: "4:41",
			mode: "append",
			reactions: [
				{
					trigger: { type: "ON_CLICK" },
					actions: [
						{
							type: "NODE",
							destinationId: "4:50",
							navigation: "NAVIGATE",
							transition: null,
						},
					],
				},
			],
		});
		const result = await harness.callTool("trace_flow", { nodeId: "4:1" });
		const graph = result.structuredContent as PrototypeGraph;
		expect(graph.screens.at(-1)).toMatchObject({ id: "4:50", depth: 4 });
	});
});

describe("export_flow_json", () => {
	test("returns the graph with the file it came from", async () => {
		const harness = await connected();
		const result = await harness.callTool("export_flow_json", {
			nodeId: "4:1",
		});
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({
			version: 1,
			file: { key: document.fileKey, name: document.name },
			graph: onboardingGraph,
		});
	});

	test("writes the same JSON to a path, creating folders", async () => {
		const harness = await connected();
		const path = join(harness.artifactsDir, "flows", "onboarding.json");
		const result = await harness.callTool("export_flow_json", {
			nodeId: "4:1",
			path,
		});
		const { path: written, ...exported } = result.structuredContent as {
			path: string;
		};
		expect(written).toBe(path);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual(exported);
	});
});
