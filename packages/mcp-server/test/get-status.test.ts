import { describe, expect, test } from "bun:test";
import { handshake } from "@figma-agent-tool/protocol/fixtures";
import { startHarness } from "./harness";

describe("get_status", () => {
	test("reports the bridge as disconnected when no plugin is connected", async () => {
		const harness = await startHarness();
		const result = await harness.callTool("get_status");
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({
			bridge: { connected: false, port: harness.bridge.port },
		});
	});

	test("reports the bridged file, plugin version and capabilities after the handshake", async () => {
		const harness = await startHarness();
		await harness.connectFakePlugin();
		const result = await harness.callTool("get_status");
		expect(result.structuredContent).toEqual({
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
