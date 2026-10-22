// Shared protocol fixtures. The fake plugin (MCP server tests) and the real
// plugin's command handler (plugin tests) replay these same messages, so the
// two can't drift apart.
import type { Handshake, Request, Response } from "../src";
import { PROTOCOL_VERSION } from "../src";

/** In-memory Figma document both test seams are built from. */
export const document = {
	fileKey: "FILEKEY123",
	name: "Sample App",
	pages: [
		{ id: "0:1", name: "Screens" },
		{ id: "0:2", name: "Components" },
	],
};

export const handshake = {
	type: "handshake",
	protocolVersion: PROTOCOL_VERSION,
	pluginVersion: "0.0.0",
	file: { key: document.fileKey, name: document.name },
	capabilities: { motion: false },
} satisfies Handshake;

export const pingRequest = {
	type: "request",
	id: "req-1",
	command: "ping",
	params: {},
} satisfies Request;

export const pingResponse = {
	type: "response",
	id: "req-1",
	ok: true,
	result: { pong: true },
} satisfies Response;
