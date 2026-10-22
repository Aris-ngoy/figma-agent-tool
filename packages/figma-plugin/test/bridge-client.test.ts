import { afterEach, describe, expect, test } from "bun:test";
import {
	CLOSE_CODE_REPLACED,
	type PluginMessage,
	parsePluginMessage,
	type Request,
} from "@figma-agent-tool/protocol";
import {
	handshake,
	pingRequest,
	pingResponse,
} from "@figma-agent-tool/protocol/fixtures";
import type { ServerWebSocket } from "bun";
import {
	type BridgeClientState,
	createBridgeClient,
} from "../src/bridge-client";

const cleanups: (() => unknown)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A stand-in for the MCP server's bridge: acks handshakes, records messages. */
function startFakeServer(port = 0) {
	const received: PluginMessage[] = [];
	const sockets = new Set<ServerWebSocket<unknown>>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		fetch(request, server) {
			if (server.upgrade(request, { data: undefined })) return;
			return new Response("WebSocket only", { status: 426 });
		},
		websocket: {
			open: (socket) => void sockets.add(socket),
			close: (socket) => void sockets.delete(socket),
			message(socket, data) {
				const message = parsePluginMessage(JSON.parse(String(data)));
				received.push(message);
				if (message.type === "handshake") {
					socket.send(
						JSON.stringify({ type: "handshake_ack", serverVersion: "0.0.0" }),
					);
				}
			},
		},
	});
	const stop = () => void server.stop(true);
	cleanups.push(stop);
	return {
		port: server.port as number,
		url: `ws://127.0.0.1:${server.port}`,
		received,
		send(message: Request) {
			for (const socket of sockets) socket.send(JSON.stringify(message));
		},
		close(code?: number, reason?: string) {
			for (const socket of sockets) socket.close(code, reason);
		},
		stop,
	};
}

function startClient(
	url: string,
	backoff = { initialMs: 10, maxMs: 40 },
	onRequest: (request: Request) => void = () => {},
) {
	const states: BridgeClientState[] = [];
	const client = createBridgeClient({
		url,
		backoff,
		onRequest,
		onChange: (state) => states.push(state),
	});
	cleanups.push(() => client.close());
	client.setHandshake(handshake);
	return { client, states };
}

describe("plugin bridge client", () => {
	test("handshakes and reports connected once the server acknowledges", async () => {
		const server = startFakeServer();
		const { client } = startClient(server.url);
		await waitFor(() => client.state().status === "connected");
		expect(server.received).toEqual([handshake]);
	});

	test("reconnects with backoff after the server restarts", async () => {
		const server = startFakeServer();
		const { client } = startClient(server.url);
		await waitFor(() => client.state().status === "connected");

		server.stop();
		await waitFor(() => client.state().status === "waiting");
		await Bun.sleep(30);
		const restarted = startFakeServer(server.port);
		await waitFor(() => client.state().status === "connected");
		expect(restarted.received).toEqual([handshake]);
	});

	test("backs off exponentially up to a ceiling while the server is down", async () => {
		const server = startFakeServer();
		server.stop();
		const { states } = startClient(server.url);
		await waitFor(() => states.filter((state) => state.retryInMs).length >= 4);
		const delays = states.flatMap((state) =>
			state.retryInMs ? [state.retryInMs] : [],
		);
		expect(delays.slice(0, 4)).toEqual([10, 20, 40, 40]);
	});

	test("resets the backoff once a connection succeeds", async () => {
		const server = startFakeServer();
		const { client, states } = startClient(server.url);
		await waitFor(() => client.state().status === "connected");
		for (let restart = 0; restart < 2; restart++) {
			server.close();
			await waitFor(() => client.state().status === "waiting");
			await waitFor(() => client.state().status === "connected");
		}
		const delays = states.flatMap((state) =>
			state.retryInMs ? [state.retryInMs] : [],
		);
		expect(delays).toEqual([10, 10]);
	});

	test("stays disconnected when a newer plugin connection replaces it", async () => {
		const server = startFakeServer();
		const { client } = startClient(server.url);
		await waitFor(() => client.state().status === "connected");
		server.close(CLOSE_CODE_REPLACED, "Replaced by a newer plugin connection");
		await waitFor(() => client.state().status === "replaced");
		await Bun.sleep(50);
		expect(client.state().status).toBe("replaced");
		expect(server.received).toEqual([handshake]);
	});

	test("reconnect() resumes after being replaced, optionally on another port", async () => {
		const server = startFakeServer();
		const other = startFakeServer();
		const { client } = startClient(server.url);
		await waitFor(() => client.state().status === "connected");
		server.close(CLOSE_CODE_REPLACED);
		await waitFor(() => client.state().status === "replaced");

		client.reconnect(other.url);
		await waitFor(() => client.state().status === "connected");
		expect(client.state().url).toBe(other.url);
		expect(other.received).toEqual([handshake]);
	});

	test("relays requests and tracks the last command it executed", async () => {
		const server = startFakeServer();
		const { client } = startClient(server.url, undefined, (request) =>
			client.respond({ ...pingResponse, id: request.id }),
		);
		await waitFor(() => client.state().status === "connected");
		expect(client.state().lastCommand).toBeUndefined();

		server.send(pingRequest);
		await waitFor(() => server.received.length === 2);
		expect(server.received[1]).toEqual(pingResponse);
		expect(client.state().lastCommand).toEqual({
			command: "ping",
			status: "ok",
		});
	});

	test("marks the last command failed when the plugin answers with an error", async () => {
		const server = startFakeServer();
		const { client } = startClient(server.url, undefined, (request) =>
			client.respond({
				type: "response",
				id: request.id,
				ok: false,
				error: { code: "command_failed", message: "boom" },
			}),
		);
		await waitFor(() => client.state().status === "connected");
		server.send(pingRequest);
		await waitFor(() => client.state().lastCommand?.status === "failed");
		expect(client.state().lastCommand?.command).toBe("ping");
	});
});

async function waitFor(condition: () => boolean, timeoutMs = 1000) {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(5);
	}
}
