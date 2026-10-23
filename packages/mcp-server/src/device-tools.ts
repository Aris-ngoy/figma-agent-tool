// Device tools: list, connect, navigate and capture devices through the
// DeviceRunner.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { writePngArtifact } from "./artifacts";
import {
	ActiveDevice,
	Device,
	DevicePlatform,
	type DeviceRunner,
	DeviceRunnerError,
	NavigationAction,
	Screen,
} from "./device-runner";
import { jsonResult, registerGuardedTool, toolError } from "./figma-tool";

export function registerDeviceTools(
	server: McpServer,
	runner: DeviceRunner,
	artifactsDir: string,
) {
	registerGuardedTool(
		server,
		"list_devices",
		{
			description:
				"List the iOS simulators, Android emulators and physical iOS and " +
				"Android devices the Yoqa runner can reach, with platform, kind and status.",
			inputSchema: {
				platform: DevicePlatform.optional().describe(
					"Only list this platform; both by default.",
				),
			},
			outputSchema: { devices: z.array(Device) },
		},
		async ({ platform }) => {
			const platforms = platform ? [platform] : DevicePlatform.options;
			const lists = await Promise.all(
				platforms.map((p) => runner.listDevices(p)),
			);
			return jsonResult({ devices: lists.flat() });
		},
		DeviceRunnerError,
	);

	registerGuardedTool(
		server,
		"connect_device",
		{
			description:
				"Connect a device from list_devices through Yoqa. Reuses the active " +
				"session if it is already this device; otherwise the runner's one " +
				"session moves to this device and the result names the one it replaced.",
			inputSchema: {
				deviceId: z.string().min(1).describe("Device `id` from list_devices."),
				platform: DevicePlatform,
				bundleId: z
					.string()
					.min(1)
					.optional()
					.describe("iOS app bundle ID to target."),
				appPackage: z
					.string()
					.min(1)
					.optional()
					.describe("Android app package to target."),
			},
			outputSchema: {
				device: ActiveDevice,
				reused: z.boolean(),
				replaced: ActiveDevice.optional(),
			},
		},
		async (options) => {
			const active = await runner.activeDevice();
			if (
				active?.deviceId === options.deviceId &&
				active.platform === options.platform
			) {
				return jsonResult({ device: active, reused: true });
			}
			const device = await runner.connect(options);
			return jsonResult({
				device,
				reused: false,
				...(active && { replaced: active }),
			});
		},
		DeviceRunnerError,
	);

	registerGuardedTool(
		server,
		"capture_device_screenshot",
		{
			description:
				"Capture the active device's screen (simulator, emulator or " +
				"physical phone) as a PNG in the artifacts folder and return its " +
				"path and pixel size. Set `inline` to also get the image in the result.",
			inputSchema: {
				inline: z
					.boolean()
					.default(false)
					.describe(
						"Also return the image inline. Costs context; off by default.",
					),
			},
			outputSchema: {
				path: z.string(),
				width: z.number(),
				height: z.number(),
				device: ActiveDevice,
			},
		},
		async ({ inline }) => {
			const { device, png } = await runner.screenshot();
			const image = await writePngArtifact(
				artifactsDir,
				`device-${device.platform}-${device.deviceId}`,
				png,
			);
			const result: CallToolResult = jsonResult({ ...image, device });
			if (inline) {
				result.content.push({
					type: "image",
					data: Buffer.from(png).toString("base64"),
					mimeType: "image/png",
				});
			}
			return result;
		},
		DeviceRunnerError,
	);
	registerGuardedTool(
		server,
		"navigate_device",
		{
			description:
				"Bring the app on the active device to the screen under test before " +
				"capturing: open a `deepLink`, run Yoqa `actions` (tap, swipe, type " +
				"by coordinates, element id/label or description), or both, deep " +
				"link first. Stops at the first failing step and names it. Set " +
				"`includeScreen` to get the element tree afterwards to verify where you are.",
			inputSchema: {
				deepLink: z
					.string()
					.min(1)
					.optional()
					.describe("URL to open first, e.g. myapp://settings."),
				actions: z
					.array(NavigationAction)
					.min(1)
					.optional()
					.describe("Steps to run in order, after the deep link if any."),
				settleMs: z
					.number()
					.int()
					.min(0)
					.max(10_000)
					.optional()
					.describe("How long to let the screen settle after the last step."),
				includeScreen: z
					.boolean()
					.default(false)
					.describe("Also return the screen element tree after navigating."),
			},
			outputSchema: {
				device: ActiveDevice,
				completed: z.number(),
				total: z.number(),
				screen: Screen.optional(),
			},
		},
		async ({ deepLink, actions = [], settleMs, includeScreen }) => {
			const steps: NavigationAction[] = [
				...(deepLink ? [{ kind: "open-url" as const, url: deepLink }] : []),
				...actions,
			];
			if (steps.length === 0) {
				return toolError("Pass a deepLink, actions, or both.");
			}
			const { device, completed, failure } = await runner.perform(steps, {
				settleMs,
			});
			if (failure) {
				const actionIndex = failure.index - (deepLink ? 1 : 0);
				const step =
					actionIndex < 0
						? `deepLink (${JSON.stringify(deepLink)})`
						: `actions[${actionIndex}] (${JSON.stringify(actions[actionIndex])})`;
				return toolError(
					`Navigation failed at ${step}: ${failure.error}. ` +
						`${completed} of ${steps.length} steps completed; later ones were not run.`,
				);
			}
			return jsonResult({
				device,
				completed,
				total: steps.length,
				...(includeScreen && { screen: await runner.screen() }),
			});
		},
		DeviceRunnerError,
	);
}
