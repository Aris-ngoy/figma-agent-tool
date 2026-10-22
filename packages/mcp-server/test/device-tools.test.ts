import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { devicePng, yoqaDevices } from "./fake-yoqa";
import { startHarness } from "./harness";

describe("list_devices", () => {
	test("lists simulators, emulators and physical devices on both platforms", async () => {
		const harness = await startHarness();
		const result = await harness.callTool("list_devices");
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({
			devices: [
				{
					id: "A1B2C3D4-SIM",
					name: "iPhone 16 Pro",
					platform: "ios",
					kind: "simulator",
					osVersion: "18.2",
					status: "Booted",
				},
				{
					id: "00008110-PHONE",
					name: "QA iPhone",
					platform: "ios",
					kind: "physical",
					osVersion: "18.1",
					status: "connected",
					model: "iPhone15,2",
				},
				{
					id: "emulator-5554",
					name: "Pixel 8 API 35",
					platform: "android",
					kind: "emulator",
					osVersion: "15",
					status: "device",
				},
				{
					id: "R5CT1234ABC",
					name: "Galaxy S23",
					platform: "android",
					kind: "physical",
					osVersion: "14",
					status: "unauthorized",
					unavailableReason: "Accept the USB debugging prompt on the device.",
				},
			],
		});
	});

	test("lists one platform when asked", async () => {
		const harness = await startHarness();
		const result = await harness.callTool("list_devices", {
			platform: "android",
		});
		const { devices } = result.structuredContent as {
			devices: { id: string }[];
		};
		expect(devices.map((d) => d.id)).toEqual(
			yoqaDevices.android.map((d) => d.id),
		);
		expect(harness.yoqa.requests.map((r) => r.path)).toEqual(["/devices"]);
	});

	test("explains how to start the runner when it isn't reachable", async () => {
		const harness = await startHarness({ yoqaRunning: false });
		const result = await harness.callTool("list_devices");
		expect(result.isError).toBe(true);
		const text = errorText(result);
		expect(text).toContain(
			`The Yoqa runner isn't reachable at ${harness.yoqa.url}`,
		);
		expect(text).toContain("yoqa serve");
		expect(text).toContain("FIGMA_AGENT_YOQA_URL");
	});
});

describe("connect_device", () => {
	test("connects the device when no session is active", async () => {
		const harness = await startHarness();
		const result = await harness.callTool("connect_device", {
			deviceId: "A1B2C3D4-SIM",
			platform: "ios",
			bundleId: "com.example.app",
		});
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({
			device: { deviceId: "A1B2C3D4-SIM", platform: "ios" },
			reused: false,
		});
		expect(harness.yoqa.requests).toContainEqual({
			method: "POST",
			path: "/devices/connect",
			body: {
				deviceId: "A1B2C3D4-SIM",
				platform: "ios",
				bundleId: "com.example.app",
			},
		});
	});

	test("reuses the active session when it is the same device", async () => {
		const harness = await startHarness();
		const active = {
			deviceId: "emulator-5554",
			platform: "android",
			connectedAt: 1_700_000_000_000,
		};
		harness.yoqa.state.active = active;
		const result = await harness.callTool("connect_device", {
			deviceId: "emulator-5554",
			platform: "android",
		});
		expect(result.structuredContent).toEqual({ device: active, reused: true });
		expect(harness.yoqa.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
			"GET /devices/active",
		]);
	});

	test("switches the runner's one session to a different device and says which it replaced", async () => {
		const harness = await startHarness();
		harness.yoqa.state.active = {
			deviceId: "emulator-5554",
			platform: "android",
			connectedAt: 1_700_000_000_000,
		};
		const result = await harness.callTool("connect_device", {
			deviceId: "00008110-PHONE",
			platform: "ios",
		});
		expect(result.structuredContent).toMatchObject({
			device: { deviceId: "00008110-PHONE", platform: "ios" },
			reused: false,
			replaced: { deviceId: "emulator-5554", platform: "android" },
		});
	});

	test("passes the runner's error through", async () => {
		const harness = await startHarness();
		const result = await harness.callTool("connect_device", {
			deviceId: "nope",
			platform: "ios",
		});
		expect(result.isError).toBe(true);
		expect(errorText(result)).toContain(
			"Yoqa runner error: Failed to connect device: Device nope not found",
		);
	});
});

describe("capture_device_screenshot", () => {
	const simulator = {
		deviceId: "A1B2C3D4-SIM",
		platform: "ios",
		connectedAt: 1_700_000_000_000,
	};

	test("writes the active device's screen to the artifacts folder and returns path and pixel size", async () => {
		const harness = await startHarness();
		harness.yoqa.state.active = simulator;
		const result = await harness.callTool("capture_device_screenshot");
		expect(result.isError).toBeFalsy();
		const { path, width, height, device } = result.structuredContent as {
			path: string;
			width: number;
			height: number;
			device: unknown;
		};
		expect(dirname(path)).toBe(harness.artifactsDir);
		expect(path).toEndWith(".png");
		expect({ width, height }).toEqual({ width: 3, height: 6 });
		expect(device).toEqual(simulator);
		expect(await readFile(path)).toEqual(Buffer.from(devicePng, "base64"));
		const content = result.content as { type: string }[];
		expect(content.map((item) => item.type)).toEqual(["text"]);
	});

	test("includes the image inline when asked", async () => {
		const harness = await startHarness();
		harness.yoqa.state.active = simulator;
		const result = await harness.callTool("capture_device_screenshot", {
			inline: true,
		});
		expect(result.content).toContainEqual({
			type: "image",
			data: devicePng,
			mimeType: "image/png",
		});
	});

	test("tells the agent to connect a device when none is active", async () => {
		const harness = await startHarness();
		const result = await harness.callTool("capture_device_screenshot");
		expect(result.isError).toBe(true);
		expect(errorText(result)).toContain(
			"No device is connected. Call list_devices to find one, then connect_device.",
		);
	});

	test("explains how to start the runner when it isn't reachable", async () => {
		const harness = await startHarness({ yoqaRunning: false });
		const result = await harness.callTool("capture_device_screenshot");
		expect(result.isError).toBe(true);
		expect(errorText(result)).toContain("yoqa serve");
	});
});

function errorText(result: Record<string, unknown>) {
	const [content] = result.content as { text: string }[];
	return content?.text ?? "";
}
