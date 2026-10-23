// Device access (simulators, emulators, physical phones) sits behind this
// interface; the Yoqa runner's HTTP API is the only implementation in v1.
import { z } from "zod";

export const DevicePlatform = z.enum(["ios", "android"]);
export type DevicePlatform = z.infer<typeof DevicePlatform>;

export const Device = z.object({
	id: z.string(),
	name: z.string(),
	platform: DevicePlatform,
	kind: z.enum(["simulator", "emulator", "physical"]),
	osVersion: z.string(),
	/** The runner's own state string, e.g. `Booted` or `device`. */
	status: z.string().optional(),
	model: z.string().optional(),
	unavailableReason: z.string().optional(),
});
export type Device = z.infer<typeof Device>;

export const ActiveDevice = z.object({
	deviceId: z.string(),
	platform: DevicePlatform,
	/** Epoch milliseconds. */
	connectedAt: z.number(),
});
export type ActiveDevice = z.infer<typeof ActiveDevice>;

export const RunnerStatus = z.object({
	url: z.string(),
	reachable: z.boolean(),
	version: z.string().optional(),
	activeDevice: ActiveDevice.nullable().optional(),
	error: z.string().optional(),
});
export type RunnerStatus = z.infer<typeof RunnerStatus>;

/** Coordinates are 0–1000 of the screen's width and height, as in Yoqa. */
const Coordinate = z.number().min(0).max(1000);

/** One navigation action; a subset of Yoqa's action request. */
export const NavigationAction = z.object({
	kind: z
		.enum([
			"tap",
			"swipe",
			"input",
			"open-url",
			"key",
			"alert",
			"activate-app",
			"restart-app",
		])
		.describe(
			"`tap` and `input` target x/y, an element `id` or `label` from the " +
				"screen tree, or a natural-language `description`. `input` types " +
				"`text` (after tapping the target, if any). `swipe` goes from x/y to x2/y2.",
		),
	x: Coordinate.optional().describe("0–1000 of the screen width."),
	y: Coordinate.optional().describe("0–1000 of the screen height."),
	x2: Coordinate.optional(),
	y2: Coordinate.optional(),
	id: z.string().min(1).optional().describe("Element id from the screen tree."),
	label: z
		.string()
		.min(1)
		.optional()
		.describe("Element label from the screen tree."),
	description: z
		.string()
		.min(1)
		.optional()
		.describe(
			'What to tap, in words ("the Settings tab"); Yoqa grounds it on the current screen.',
		),
	text: z.string().optional().describe("Text for `input`."),
	double: z.boolean().optional().describe("Double tap."),
	durationMs: z.number().min(0).optional().describe("Press or swipe duration."),
	url: z.string().min(1).optional().describe("URL for `open-url`."),
	key: z.string().min(1).optional().describe("Key name for `key`, e.g. Enter."),
	alertAction: z.enum(["accept", "dismiss"]).optional(),
	appId: z
		.string()
		.min(1)
		.optional()
		.describe("Bundle ID or package for `activate-app` / `restart-app`."),
});
export type NavigationAction = z.infer<typeof NavigationAction>;

export type StepsOutcome = {
	completed: number;
	/** The first step that failed; later steps were not run. */
	failure?: { index: number; error: string };
};

const ScreenElement = z.object({
	type: z.string(),
	label: z.string(),
	id: z.string().optional(),
	/** 0–1000 of the screen, like action coordinates. */
	x: z.number(),
	y: z.number(),
	width: z.number(),
	height: z.number(),
	enabled: z.boolean().optional(),
	visible: z.boolean().optional(),
});

export const Screen = z.object({
	window: z.object({ width: z.number(), height: z.number() }),
	elements: z.array(ScreenElement),
});
export type Screen = z.infer<typeof Screen>;

export type ConnectOptions = {
	deviceId: string;
	platform: DevicePlatform;
	/** iOS app to target. */
	bundleId?: string;
	/** Android app to target. */
	appPackage?: string;
};

export interface DeviceRunner {
	/** Reachability and the active device; never throws. */
	status(): Promise<RunnerStatus>;
	listDevices(platform: DevicePlatform): Promise<Device[]>;
	/** The runner's current session, or null when none is active. */
	activeDevice(): Promise<ActiveDevice | null>;
	/** Starts a session; the runner ends any other session first. */
	connect(options: ConnectOptions): Promise<ActiveDevice>;
	/** The active device and its screen as PNG bytes. */
	screenshot(): Promise<{ device: ActiveDevice; png: Uint8Array }>;
	/**
	 * Runs the steps in order on the active device, stopping at the first
	 * failure, and waits for the screen to settle after the last one.
	 */
	perform(
		steps: NavigationAction[],
		options?: { settleMs?: number },
	): Promise<{ device: ActiveDevice } & StepsOutcome>;
	/** The active device's on-screen element tree. */
	screen(): Promise<Screen>;
}

/** Base class for runner failures that tools report as actionable errors. */
export class DeviceRunnerError extends Error {}

export class RunnerUnreachableError extends DeviceRunnerError {}

export class NoActiveDeviceError extends DeviceRunnerError {
	constructor() {
		super(
			"No device is connected. Call list_devices to find one, then connect_device.",
		);
	}
}
