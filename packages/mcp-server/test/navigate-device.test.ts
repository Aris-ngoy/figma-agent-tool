import { describe, expect, test } from "bun:test";
import { yoqaScreen } from "./fake-yoqa";
import { startHarness } from "./harness";

const simulator = {
	deviceId: "A1B2C3D4-SIM",
	platform: "ios",
	connectedAt: 1_700_000_000_000,
};

async function connectedHarness() {
	const harness = await startHarness();
	harness.yoqa.state.active = simulator;
	return harness;
}

function actionRequests(harness: Awaited<ReturnType<typeof startHarness>>) {
	return harness.yoqa.requests.filter((r) => r.path.startsWith("/action"));
}

describe("navigate_device", () => {
	test("opens a deep link", async () => {
		const harness = await connectedHarness();
		const result = await harness.callTool("navigate_device", {
			deepLink: "myapp://settings",
		});
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({
			device: simulator,
			completed: 1,
			total: 1,
		});
		expect(actionRequests(harness)).toEqual([
			{
				method: "POST",
				path: "/action/batch",
				body: { steps: [{ kind: "open-url", url: "myapp://settings" }] },
			},
		]);
	});

	test("sends the deep link and coordinate or locator actions as one batch", async () => {
		const harness = await connectedHarness();
		const actions = [
			{ kind: "tap", label: "Settings" },
			{ kind: "input", id: "settings-tab", text: "dark" },
			{ kind: "swipe", x: 500, y: 800, x2: 500, y2: 200 },
		];
		const result = await harness.callTool("navigate_device", {
			deepLink: "myapp://home",
			actions,
			settleMs: 500,
		});
		expect(result.structuredContent).toMatchObject({ completed: 4, total: 4 });
		expect(actionRequests(harness)).toEqual([
			{
				method: "POST",
				path: "/action/batch",
				body: {
					steps: [{ kind: "open-url", url: "myapp://home" }, ...actions],
					settleMs: 500,
				},
			},
		]);
	});

	test("sends description steps as single actions, since Yoqa grounds them on a fresh screen", async () => {
		const harness = await connectedHarness();
		const result = await harness.callTool("navigate_device", {
			actions: [
				{ kind: "tap", x: 100, y: 100 },
				{ kind: "tap", description: "the Settings tab" },
				{ kind: "input", label: "Search", text: "fonts" },
				{ kind: "tap", description: "the search field" },
			],
		});
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({ completed: 4, total: 4 });
		expect(actionRequests(harness).map((r) => [r.path, r.body])).toEqual([
			["/action/batch", { steps: [{ kind: "tap", x: 100, y: 100 }] }],
			["/action", { kind: "tap", description: "the Settings tab" }],
			[
				"/action/batch",
				{ steps: [{ kind: "input", label: "Search", text: "fonts" }] },
			],
			// The last step settles the screen and Yoqa only waits for that
			// when asked for a screenshot.
			[
				"/action",
				{ kind: "tap", description: "the search field", screenshot: true },
			],
		]);
	});

	test("names the failing step of a batch", async () => {
		const harness = await connectedHarness();
		const result = await harness.callTool("navigate_device", {
			deepLink: "myapp://home",
			actions: [
				{ kind: "tap", label: "Settings" },
				{ kind: "tap", label: "Profile" },
				{ kind: "tap", label: "Settings" },
			],
		});
		expect(result.isError).toBe(true);
		const text = errorText(result);
		expect(text).toContain(
			'Navigation failed at actions[1] ({"kind":"tap","label":"Profile"})',
		);
		expect(text).toContain("No element matching label: Profile");
		expect(text).toContain("2 of 4 steps completed");
		expect(harness.yoqa.state.performed).toHaveLength(2);
	});

	test("names the failing single action and stops there", async () => {
		const harness = await connectedHarness();
		const result = await harness.callTool("navigate_device", {
			actions: [
				{ kind: "tap", description: "the Logout button" },
				{ kind: "tap", label: "Settings" },
			],
		});
		expect(result.isError).toBe(true);
		const text = errorText(result);
		expect(text).toContain("Navigation failed at actions[0]");
		expect(text).toContain(
			"Action failed: Could not ground description: the Logout button",
		);
		expect(text).toContain("0 of 2 steps completed");
		expect(actionRequests(harness)).toHaveLength(1);
	});

	test("names a failing deep link", async () => {
		const harness = await connectedHarness();
		const result = await harness.callTool("navigate_device", {
			deepLink: "unregistered://home",
			actions: [{ kind: "tap", label: "Settings" }],
		});
		expect(result.isError).toBe(true);
		const text = errorText(result);
		expect(text).toContain(
			'Navigation failed at deepLink ("unregistered://home")',
		);
		expect(text).toContain("No app can open unregistered://home");
		expect(text).toContain("0 of 2 steps completed");
	});

	test("returns the screen element tree when asked", async () => {
		const harness = await connectedHarness();
		const result = await harness.callTool("navigate_device", {
			actions: [{ kind: "tap", label: "Settings" }],
			includeScreen: true,
		});
		expect(result.structuredContent).toEqual({
			device: simulator,
			completed: 1,
			total: 1,
			screen: { window: yoqaScreen.window, elements: yoqaScreen.elements },
		});
		expect(harness.yoqa.requests.at(-1)?.path).toBe("/screen");
	});

	test("needs a deep link or actions", async () => {
		const harness = await connectedHarness();
		const result = await harness.callTool("navigate_device", {});
		expect(result.isError).toBe(true);
		expect(errorText(result)).toContain("Pass a deepLink, actions, or both.");
		expect(actionRequests(harness)).toEqual([]);
	});

	test("tells the agent to connect a device when none is active", async () => {
		const harness = await startHarness();
		const result = await harness.callTool("navigate_device", {
			deepLink: "myapp://home",
		});
		expect(result.isError).toBe(true);
		expect(errorText(result)).toContain(
			"No device is connected. Call list_devices to find one, then connect_device.",
		);
	});

	test("explains how to start the runner when it isn't reachable", async () => {
		const harness = await startHarness({ yoqaRunning: false });
		const result = await harness.callTool("navigate_device", {
			deepLink: "myapp://home",
		});
		expect(result.isError).toBe(true);
		expect(errorText(result)).toContain("yoqa serve");
	});
});

function errorText(result: Record<string, unknown>) {
	const [content] = result.content as { text: string }[];
	return content?.text ?? "";
}
