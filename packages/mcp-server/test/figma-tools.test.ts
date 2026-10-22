import { describe, expect, test } from "bun:test";
import { registerFigmaTool } from "../src/server";
import { startHarness } from "./harness";

// No Figma-backed tool ships in the walking skeleton, so these tests register
// one on the plugin's `ping` command through the same helper real tools use.
function withPingTool() {
	return startHarness({
		setup: (server, bridge) =>
			registerFigmaTool(
				server,
				"ping_plugin",
				{ description: "Round-trips a ping through the plugin." },
				async () => {
					const result = await bridge.request("ping", {});
					return { content: [{ type: "text", text: JSON.stringify(result) }] };
				},
			),
	});
}

describe("Figma-backed tools", () => {
	test("tell the agent to open the plugin when none is connected", async () => {
		const harness = await withPingTool();
		const result = await harness.callTool("ping_plugin");
		expect(result.isError).toBe(true);
		const [content] = result.content as { type: string; text: string }[];
		expect(content?.text).toContain("No Figma plugin is connected");
		expect(content?.text).toContain("Open the Figma Agent Tool plugin");
	});

	test("round-trip a request through the connected plugin", async () => {
		const harness = await withPingTool();
		await harness.connectFakePlugin();
		const result = await harness.callTool("ping_plugin");
		expect(result.isError).toBeFalsy();
		expect(result.content).toEqual([
			{ type: "text", text: JSON.stringify({ pong: true }) },
		]);
	});
});
