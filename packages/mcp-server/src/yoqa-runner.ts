// DeviceRunner over the Yoqa local runner's HTTP API. Yoqa is installed and
// started separately; its errors are passed through with a pointer to its docs.
import { z } from "zod";
import {
	ActiveDevice,
	type ConnectOptions,
	Device,
	DevicePlatform,
	type DeviceRunner,
	DeviceRunnerError,
	NoActiveDeviceError,
	type RunnerStatus,
	RunnerUnreachableError,
} from "./device-runner";

export const DEFAULT_YOQA_URL = "http://127.0.0.1:7420";

const YOQA_DOCS_URL = "https://yoqa.mintlify.app/docs/cli";

/** get_status shouldn't stall on a runner that accepts but never answers. */
const STATUS_TIMEOUT_MS = 2000;

const YoqaDevice = z.object({
	id: z.string(),
	name: z.string(),
	osVersion: z.string(),
	platform: DevicePlatform,
	kind: Device.shape.kind,
	state: z.string().optional(),
	model: z.string().optional(),
	unavailableReason: z.string().optional(),
});
const YoqaDeviceList = z.object({ devices: z.array(YoqaDevice) });
const YoqaHealth = z.object({ version: z.string() });
const YoqaError = z.object({
	error: z.string(),
	detail: z.string().optional(),
});

export function createYoqaRunner({
	baseUrl = DEFAULT_YOQA_URL,
}: {
	baseUrl?: string;
} = {}): DeviceRunner {
	const url = baseUrl.replace(/\/+$/, "");

	async function send(path: string, init?: RequestInit): Promise<Response> {
		try {
			return await fetch(`${url}${path}`, init);
		} catch {
			throw new RunnerUnreachableError(
				`The Yoqa runner isn't reachable at ${url}. Start it with ` +
					"`yoqa serve` (or the `yoqa-runner` bin from @yoqa/runner), or set " +
					"FIGMA_AGENT_YOQA_URL if it listens elsewhere. Yoqa is installed " +
					`separately: ${YOQA_DOCS_URL}`,
			);
		}
	}

	async function expectOk(response: Response): Promise<Response> {
		if (!response.ok) throw await runnerError(response);
		return response;
	}

	async function json(path: string, init?: RequestInit): Promise<unknown> {
		return (await expectOk(await send(path, init))).json();
	}

	async function activeDevice(signal?: AbortSignal) {
		const response = await send("/devices/active", { signal });
		// Yoqa answers 404 when no session is active.
		if (response.status === 404) return null;
		return ActiveDevice.parse(await (await expectOk(response)).json());
	}

	return {
		async status(): Promise<RunnerStatus> {
			try {
				const signal = AbortSignal.timeout(STATUS_TIMEOUT_MS);
				const { version } = YoqaHealth.parse(await json("/health", { signal }));
				return {
					url,
					reachable: true,
					version,
					activeDevice: await activeDevice(signal),
				};
			} catch (error) {
				return {
					url,
					reachable: false,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},

		async listDevices(platform): Promise<Device[]> {
			const { devices } = YoqaDeviceList.parse(
				await json(`/devices?platform=${platform}`),
			);
			return devices.map(({ state, ...device }) =>
				state === undefined ? device : { ...device, status: state },
			);
		},

		activeDevice: () => activeDevice(),

		async connect(options: ConnectOptions) {
			return ActiveDevice.parse(
				await json("/devices/connect", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(options),
				}),
			);
		},

		async screenshot() {
			// Yoqa answers a missing session with a generic 500, so check first.
			const device = await activeDevice();
			if (!device) throw new NoActiveDeviceError();
			const response = await expectOk(await send("/screenshot/image"));
			const png = new Uint8Array(await response.arrayBuffer());
			return { device, png };
		},
	};
}

async function runnerError(response: Response): Promise<DeviceRunnerError> {
	const text = await response.text();
	let body: z.infer<typeof YoqaError> | undefined;
	try {
		body = YoqaError.parse(JSON.parse(text));
	} catch {}
	let reason: string;
	if (!body) reason = `HTTP ${response.status}${text ? ` ${text}` : ""}`;
	else if (body.detail) reason = `${body.error}: ${body.detail}`;
	else reason = body.error;
	return new DeviceRunnerError(
		`Yoqa runner error: ${reason}. See ${YOQA_DOCS_URL} for device setup.`,
	);
}
