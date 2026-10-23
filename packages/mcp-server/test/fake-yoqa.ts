// In-process stand-in for the Yoqa local runner: the HTTP endpoints the
// device adapter uses, serving fixture devices and a fixture PNG. Shapes
// follow @yoqa/runner's own response schemas.

export const yoqaDevices = {
	ios: [
		{
			id: "A1B2C3D4-SIM",
			name: "iPhone 16 Pro",
			osVersion: "18.2",
			platform: "ios",
			kind: "simulator",
			state: "Booted",
		},
		{
			id: "00008110-PHONE",
			name: "QA iPhone",
			osVersion: "18.1",
			platform: "ios",
			kind: "physical",
			state: "connected",
			model: "iPhone15,2",
		},
	],
	android: [
		{
			id: "emulator-5554",
			name: "Pixel 8 API 35",
			osVersion: "15",
			platform: "android",
			kind: "emulator",
			state: "device",
		},
		{
			id: "R5CT1234ABC",
			name: "Galaxy S23",
			osVersion: "14",
			platform: "android",
			kind: "physical",
			state: "unauthorized",
			unavailableReason: "Accept the USB debugging prompt on the device.",
		},
	],
} as const;

/** A 3 × 6 PNG standing in for a device screen. */
export const devicePng =
	"iVBORw0KGgoAAAANSUhEUgAAAAMAAAAGCAIAAACJh7NbAAAAEElEQVR4nGMwTpsJQQwkswB+phWFBHinVAAAAABJRU5ErkJggg==";

/** The screen element tree the fake serves; x/y/size are 0–1000 like Yoqa's. */
export const yoqaScreen = {
	full: false,
	window: { width: 393, height: 852 },
	elements: [
		{
			type: "Button",
			label: "Settings",
			id: "settings-tab",
			x: 750,
			y: 920,
			width: 200,
			height: 60,
			enabled: true,
			visible: true,
		},
		{
			type: "TextField",
			label: "Search",
			x: 50,
			y: 120,
			width: 900,
			height: 50,
		},
	],
};

type FakeAction = {
	kind: string;
	label?: string;
	id?: string;
	description?: string;
	url?: string;
};

export type FakeActiveDevice = {
	deviceId: string;
	platform: string;
	connectedAt: number;
};

export type FakeYoqaRequest = { method: string; path: string; body?: unknown };

export function startFakeYoqa() {
	const requests: FakeYoqaRequest[] = [];
	const state: {
		active: FakeActiveDevice | null;
		/** Steps the device performed, in order. */
		performed: FakeAction[];
		/** PNG bytes the device's screen shows; `devicePng` by default. */
		screen?: Uint8Array;
	} = { active: null, performed: [] };

	// Locator taps fail when no element matches, description taps when no
	// element's label appears in the description, open-url when no app handles
	// the scheme.
	function perform(step: FakeAction): string | undefined {
		const elements = yoqaScreen.elements;
		if (step.id && !elements.some((e) => e.id === step.id)) {
			return `No element matching id: ${step.id}`;
		}
		if (step.label && !elements.some((e) => e.label === step.label)) {
			return `No element matching label: ${step.label}`;
		}
		const description = step.description?.toLowerCase();
		if (
			description &&
			!elements.some((e) => description.includes(e.label.toLowerCase()))
		) {
			return `Could not ground description: ${step.description}`;
		}
		if (step.url?.startsWith("unregistered://")) {
			return `No app can open ${step.url}`;
		}
		state.performed.push(step);
	}

	const noSession = (error: string) =>
		Response.json(
			{
				error,
				detail:
					"No active device session. Run: yoqa devices connect <device_id>",
			},
			{ status: 500 },
		);

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const body = request.method === "POST" ? await request.json() : undefined;
			requests.push({ method: request.method, path: url.pathname, body });
			const route = `${request.method} ${url.pathname}`;
			switch (route) {
				case "GET /health":
					return Response.json({
						ok: true,
						service: "yoqa-runner",
						version: "1.0.4",
						uptimeMs: 1000,
					});
				case "GET /devices": {
					const platform = url.searchParams.get("platform");
					if (platform !== "ios" && platform !== "android") {
						return Response.json(
							{
								error:
									"Query param platform is required and must be 'ios', 'android' or 'web'",
							},
							{ status: 400 },
						);
					}
					return Response.json({ platform, devices: yoqaDevices[platform] });
				}
				case "GET /devices/active":
					return state.active
						? Response.json(state.active)
						: Response.json(
								{ error: "No active device session" },
								{ status: 404 },
							);
				case "POST /devices/connect": {
					const { deviceId, platform } = body as {
						deviceId: string;
						platform: string;
					};
					const known = Object.values(yoqaDevices)
						.flat()
						.some((d) => d.id === deviceId && d.platform === platform);
					if (!known) {
						return Response.json(
							{
								error: "Failed to connect device",
								detail: `Device ${deviceId} not found`,
							},
							{ status: 500 },
						);
					}
					state.active = { deviceId, platform, connectedAt: Date.now() };
					return Response.json(state.active);
				}
				case "GET /screenshot/image":
					if (!state.active) {
						return Response.json(
							{
								error: "Failed to take screenshot",
								detail:
									"No active device session. Run: yoqa devices connect <device_id>",
							},
							{ status: 500 },
						);
					}
					return new Response(
						state.screen ?? Buffer.from(devicePng, "base64"),
						{
							headers: { "Content-Type": "image/png" },
						},
					);
				case "POST /action": {
					if (!state.active) return noSession("Action failed");
					const error = perform(body as FakeAction);
					if (error?.startsWith("No element")) {
						return Response.json({ error }, { status: 404 });
					}
					if (error) {
						return Response.json(
							{ error: "Action failed", detail: error },
							{ status: 500 },
						);
					}
					return Response.json({ ok: true, kind: (body as FakeAction).kind });
				}
				case "POST /action/batch": {
					if (!state.active) return noSession("Action batch failed");
					const { steps } = body as { steps: FakeAction[] };
					const grounded = steps.findIndex((step) => step.description);
					if (grounded >= 0) {
						return Response.json(
							{
								error: `Batch step ${grounded} uses a description; Grounding needs a fresh screen. Use a single Action instead.`,
							},
							{ status: 400 },
						);
					}
					const results: { ok: true; kind: string }[] = [];
					for (const [index, step] of steps.entries()) {
						const error = perform(step);
						if (error) {
							return Response.json(
								{
									ok: false,
									completed: results.length,
									total: steps.length,
									failedIndex: index,
									error,
									steps: results,
								},
								{ status: 422 },
							);
						}
						results.push({ ok: true, kind: step.kind });
					}
					return Response.json({
						ok: true,
						completed: results.length,
						total: steps.length,
						steps: results,
					});
				}
				case "GET /screen":
					return state.active
						? Response.json(yoqaScreen)
						: noSession("Failed to read screen");
				default:
					return Response.json({ error: "Not found" }, { status: 404 });
			}
		},
	});

	return {
		url: `http://127.0.0.1:${server.port}`,
		/** Requests the adapter sent, in order. */
		requests,
		/** The runner's session; set it to simulate a device connected elsewhere. */
		state,
		stop() {
			void server.stop(true);
		},
	};
}
