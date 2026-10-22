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
