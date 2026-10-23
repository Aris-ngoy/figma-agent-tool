import { describe, expect, test } from "bun:test";
import { handshake } from "@figma-agent-tool/protocol/fixtures";
import { startHarness } from "./harness";

describe("get_status", () => {
	test("reports the bridge as disconnected when no plugin is connected", async () => {
		const harness = await startHarness();
		const result = await harness.callTool("get_status");
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({
			bridge: { connected: false, port: harness.bridge.port },
		});
	});

	test("reports the bridged file, plugin version and capabilities after the handshake", async () => {
		const harness = await startHarness();
		await harness.connectFakePlugin();
		const result = await harness.callTool("get_status");
		expect(result.structuredContent).toMatchObject({
			bridge: {
				connected: true,
				port: harness.bridge.port,
				file: handshake.file,
				pluginVersion: handshake.pluginVersion,
				capabilities: handshake.capabilities,
			},
		});
	});

	test("reports the bridge as disconnected again once the plugin closes", async () => {
		const harness = await startHarness();
		const plugin = await harness.connectFakePlugin();
		await plugin.close();
		await waitFor(async () => {
			const result = await harness.callTool("get_status");
			return (
				(result.structuredContent as { bridge: { connected: boolean } }).bridge
					.connected === false
			);
		});
	});

	test("reports the Yoqa runner as reachable with no active device", async () => {
		const harness = await startHarness();
		const result = await harness.callTool("get_status");
		expect(result.structuredContent).toMatchObject({
			runner: {
				url: harness.yoqa.url,
				reachable: true,
				version: "1.0.4",
				activeDevice: null,
			},
		});
	});

	test("reports the runner's active device", async () => {
		const harness = await startHarness();
		const active = {
			deviceId: "00008110-PHONE",
			platform: "ios",
			connectedAt: 1_700_000_000_000,
		};
		harness.yoqa.state.active = active;
		const result = await harness.callTool("get_status");
		expect(result.structuredContent).toMatchObject({
			runner: { reachable: true, activeDevice: active },
		});
	});

	test("reports an unreachable runner with how to start it, without failing", async () => {
		const harness = await startHarness({ yoqaRunning: false });
		const result = await harness.callTool("get_status");
		expect(result.isError).toBeFalsy();
		const { runner } = result.structuredContent as {
			runner: { url: string; reachable: boolean; error: string };
		};
		expect(runner.url).toBe(harness.yoqa.url);
		expect(runner.reachable).toBe(false);
		expect(runner.error).toContain("yoqa serve");
	});

	test("returns its status as text for clients without structured content", async () => {
		const harness = await startHarness();
		const result = await harness.callTool("get_status");
		const [content] = result.content as { type: string; text: string }[];
		expect(content?.type).toBe("text");
		expect(JSON.parse(content?.text ?? "")).toEqual(result.structuredContent);
	});
});

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 1000) {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(10);
	}
}
