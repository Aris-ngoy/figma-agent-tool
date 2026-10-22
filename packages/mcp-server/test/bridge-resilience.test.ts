import { describe, expect, test } from "bun:test";
import { CLOSE_CODE_REPLACED } from "@figma-agent-tool/protocol";
import { handshake } from "@figma-agent-tool/protocol/fixtures";
import { registerFigmaTool } from "../src/figma-tool";
import { startHarness } from "./harness";

// Registers a tool on the plugin's `ping` command through the same helper
// real Figma-backed tools use.
function withPingTool(options: { requestTimeoutMs?: number } = {}) {
	return startHarness({
		...options,
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

function text(result: { [key: string]: unknown }): string {
	const [content] = result.content as { type: string; text: string }[];
	return content?.text ?? "";
}

describe("bridge resilience", () => {
	test("a command the plugin never answers times out with an error naming it", async () => {
		const harness = await withPingTool({ requestTimeoutMs: 50 });
		await harness.connectFakePlugin({ answers: false });
		const result = await harness.callTool("ping_plugin");
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("`ping`");
		expect(text(result)).toContain("timed out");
	});

	test("a command in flight when the plugin disconnects fails instead of hanging", async () => {
		const harness = await withPingTool();
		const plugin = await harness.connectFakePlugin({ answers: false });
		const call = harness.callTool("ping_plugin");
		await waitFor(async () => plugin.requests.length === 1);
		await plugin.close();
		const result = await call;
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("`ping`");
	});

	test("accepts a plugin reconnecting after Figma reloads it", async () => {
		const harness = await withPingTool();
		const first = await harness.connectFakePlugin();
		await first.close();
		await waitFor(async () => !harness.bridge.status().connected);

		await harness.connectFakePlugin();
		const result = await harness.callTool("ping_plugin");
		expect(result.isError).toBeFalsy();
		expect(text(result)).toBe(JSON.stringify({ pong: true }));
	});

	test("a newer plugin connection replaces the older one and logs a warning", async () => {
		const harness = await withPingTool();
		const older = await harness.connectFakePlugin();
		const newer = await harness.connectFakePlugin({
			handshake: { ...handshake, file: { key: "OTHER", name: "Other File" } },
		});

		expect((await older.closed).code).toBe(CLOSE_CODE_REPLACED);
		expect(harness.logs.some((line) => /warn/i.test(line))).toBe(true);
		expect(harness.logs.join("\n")).toContain("Other File");

		const result = await harness.callTool("ping_plugin");
		expect(result.isError).toBeFalsy();
		expect(older.requests).toHaveLength(0);
		expect(newer.requests).toHaveLength(1);

		const status = await harness.callTool("get_status");
		expect(status.structuredContent).toMatchObject({
			bridge: { connected: true, file: { key: "OTHER", name: "Other File" } },
		});
	});

	test("a command in flight on a replaced connection fails with an explanation", async () => {
		const harness = await withPingTool();
		const older = await harness.connectFakePlugin({ answers: false });
		const call = harness.callTool("ping_plugin");
		await waitFor(async () => older.requests.length === 1);
		await harness.connectFakePlugin();
		const result = await call;
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("replaced");
	});
});

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 1000) {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(10);
	}
}
