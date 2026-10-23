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
	type NavigationAction,
	NoActiveDeviceError,
	type RunnerStatus,
	RunnerUnreachableError,
	Screen,
	type StepsOutcome,
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
const YoqaBatchResult = z.object({
	ok: z.boolean(),
	completed: z.number(),
	failedIndex: z.number().optional(),
	error: z.string().optional(),
});
/** Statuses Yoqa uses for a step that failed, rather than for a lost session. */
const STEP_FAILURE_STATUSES = [400, 404, 422, 500];
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

	function post(path: string, body: unknown): Promise<Response> {
		return send(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	async function requireActiveDevice() {
		const device = await activeDevice();
		if (!device) throw new NoActiveDeviceError();
		return device;
	}

	/** Runs consecutive locator/coordinate steps in one request. */
	async function performBatch(
		steps: NavigationAction[],
		settleMs: number | undefined,
	): Promise<StepsOutcome> {
		const response = await post("/action/batch", { steps, settleMs });
		// Yoqa answers a batch that stopped at a step with 422 and the result.
		if (!response.ok && response.status !== 422) {
			throw await runnerError(response);
		}
		const result = YoqaBatchResult.parse(await response.json());
		if (result.ok) return { completed: result.completed };
		return {
			completed: result.completed,
			failure: {
				index: result.failedIndex ?? result.completed,
				error: result.error ?? "Step failed",
			},
		};
	}

	/**
	 * Runs one step on its own. Yoqa only settles the screen after an action
	 * when asked for a screenshot, so the last step asks for one.
	 */
	async function performSingle(
		step: NavigationAction,
		settle: { settleMs?: number } | undefined,
	): Promise<StepsOutcome> {
		const response = await post(
			"/action",
			settle ? { ...step, screenshot: true, ...settle } : step,
		);
		if (response.ok) return { completed: 1 };
		if (!STEP_FAILURE_STATUSES.includes(response.status)) {
			throw await runnerError(response);
		}
		return {
			completed: 0,
			failure: { index: 0, error: await yoqaReason(response) },
		};
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

		// Yoqa answers a missing session with a generic 500, so the session
		// methods check for one first.
		async screenshot() {
			const device = await requireActiveDevice();
			const response = await expectOk(await send("/screenshot/image"));
			const png = new Uint8Array(await response.arrayBuffer());
			return { device, png };
		},

		async perform(steps, { settleMs } = {}) {
			const device = await requireActiveDevice();
			// Yoqa grounds a description on a fresh screen, so it refuses those
			// steps in a batch; they go one at a time between batches.
			let completed = 0;
			while (completed < steps.length) {
				const start = completed;
				const step = steps[start] as NavigationAction;
				let end = start + 1;
				if (!step.description) {
					while (end < steps.length && !steps[end]?.description) end++;
				}
				const isLast = end === steps.length;
				const outcome = step.description
					? await performSingle(step, isLast ? { settleMs } : undefined)
					: await performBatch(
							steps.slice(start, end),
							isLast ? settleMs : undefined,
						);
				completed += outcome.completed;
				if (outcome.failure) {
					const index = start + outcome.failure.index;
					return { device, completed, failure: { ...outcome.failure, index } };
				}
			}
			return { device, completed };
		},

		async screen() {
			await requireActiveDevice();
			const { window, elements = [] } = Screen.extend({
				elements: Screen.shape.elements.optional(),
			}).parse(await json("/screen"));
			return { window, elements };
		},
	};
}

async function yoqaReason(response: Response): Promise<string> {
	const text = await response.text();
	let body: z.infer<typeof YoqaError> | undefined;
	try {
		body = YoqaError.parse(JSON.parse(text));
	} catch {}
	if (!body) return `HTTP ${response.status}${text ? ` ${text}` : ""}`;
	if (body.detail) return `${body.error}: ${body.detail}`;
	return body.error;
}

async function runnerError(response: Response): Promise<DeviceRunnerError> {
	return new DeviceRunnerError(
		`Yoqa runner error: ${await yoqaReason(response)}. See ${YOQA_DOCS_URL} for device setup.`,
	);
}
