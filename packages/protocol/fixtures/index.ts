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
	frames: [{ id: "1:2", pageId: "0:1", name: "Login", width: 2, height: 1 }],
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

/** A 4×2 px PNG: `frame` exported at 2x. */
export const framePng =
	"iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAEklEQVR4nGMwTvv/HxkzoAsAAFR1FLllEk5AAAAAAElFTkSuQmCC";

export const exportFrameRequest = {
	type: "request",
	id: "req-2",
	command: "export_node_image",
	params: { nodeId: "1:2", scale: 2 },
} satisfies Request;

export const exportFrameResponse = {
	type: "response",
	id: "req-2",
	ok: true,
	result: { png: framePng },
} satisfies Response;

export const exportPageRequest = {
	type: "request",
	id: "req-3",
	command: "export_node_image",
	params: { nodeId: "0:1", scale: 1 },
} satisfies Request;

export const exportPageResponse = {
	type: "response",
	id: "req-3",
	ok: false,
	error: {
		code: "not_exportable",
		message:
			"Node 0:1 is a PAGE and cannot be exported. Export a frame, component or other layer on the canvas instead.",
	},
} satisfies Response;

export const exportMissingNodeRequest = {
	type: "request",
	id: "req-4",
	command: "export_node_image",
	params: { nodeId: "9:99", scale: 1 },
} satisfies Request;

export const exportMissingNodeResponse = {
	type: "response",
	id: "req-4",
	ok: false,
	error: {
		code: "node_not_found",
		message: "No node with ID 9:99 exists in this file.",
	},
} satisfies Response;

/**
 * Every request the fakes know how to answer, paired with the plugin's
 * response. The fake plugin matches on command + params; the plugin tests
 * replay each pair against the real handler.
 */
export const exchanges: [Request, Response][] = [
	[pingRequest, pingResponse],
	[exportFrameRequest, exportFrameResponse],
	[exportPageRequest, exportPageResponse],
	[exportMissingNodeRequest, exportMissingNodeResponse],
];
