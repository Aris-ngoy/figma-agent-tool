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

export type FakeActiveDevice = {
	deviceId: string;
	platform: string;
	connectedAt: number;
};

export type FakeYoqaRequest = { method: string; path: string; body?: unknown };

export function startFakeYoqa() {
	const requests: FakeYoqaRequest[] = [];
	const state: { active: FakeActiveDevice | null } = { active: null };

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
					return new Response(Buffer.from(devicePng, "base64"), {
						headers: { "Content-Type": "image/png" },
					});
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
