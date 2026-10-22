// Shared protocol fixtures. The fake plugin (MCP server tests) and the real
// plugin's command handler (plugin tests) replay these same messages, so the
// two can't drift apart.
import type { Handshake, Request, Response, SerializedNode } from "../src";
import { PROTOCOL_VERSION } from "../src";

const loginScreen = {
	id: "1:1",
	name: "Login",
	type: "FRAME",
	x: 0,
	y: 0,
	width: 393,
	height: 852,
	fills: [{ type: "SOLID", color: "#ffffff" }],
	layout: {
		mode: "VERTICAL",
		itemSpacing: 16,
		padding: { top: 64, right: 24, bottom: 34, left: 24 },
		primaryAxisAlignItems: "MIN",
		counterAxisAlignItems: "CENTER",
		wrap: false,
		sizing: { horizontal: "FIXED", vertical: "FIXED" },
	},
	children: [
		{
			id: "1:2",
			name: "Title",
			type: "TEXT",
			x: 24,
			y: 64,
			width: 345,
			height: 34,
			fills: [{ type: "SOLID", color: "#111111" }],
			text: {
				characters: "Welcome back",
				fontName: { family: "Inter", style: "Bold" },
				fontSize: 28,
				textAlignHorizontal: "CENTER",
			},
		},
		{
			id: "1:3",
			name: "Button",
			type: "INSTANCE",
			x: 24,
			y: 114,
			width: 345,
			height: 48,
			cornerRadius: 12,
			fills: [{ type: "SOLID", color: "#3366ff" }],
			layout: {
				mode: "HORIZONTAL",
				itemSpacing: 8,
				padding: { top: 12, right: 16, bottom: 12, left: 16 },
				primaryAxisAlignItems: "CENTER",
				counterAxisAlignItems: "CENTER",
				wrap: false,
				sizing: { horizontal: "FILL", vertical: "HUG" },
			},
			instance: {
				mainComponent: { id: "2:1", name: "Button" },
				properties: { "Label#2:0": "Sign in", "Disabled#2:1": false },
			},
			children: [
				{
					id: "1:4",
					name: "Label",
					type: "TEXT",
					x: 140,
					y: 12,
					width: 65,
					height: 24,
					fills: [{ type: "SOLID", color: "#ffffff" }],
					text: {
						characters: "Sign in",
						fontName: { family: "Inter", style: "Semi Bold" },
						fontSize: 16,
					},
				},
			],
		},
		{
			id: "1:5",
			name: "Divider",
			type: "RECTANGLE",
			visible: false,
			x: 24,
			y: 178,
			width: 345,
			height: 1,
			opacity: 0.5,
			strokes: [{ type: "SOLID", color: "#dddddd", opacity: 0.8 }],
			strokeWeight: 1,
		},
	],
} satisfies SerializedNode;

const homeScreen = {
	id: "1:10",
	name: "Home",
	type: "FRAME",
	x: 493,
	y: 0,
	width: 393,
	height: 852,
	cornerRadius: { topLeft: 40, topRight: 40, bottomRight: 0, bottomLeft: 0 },
	fills: [
		{
			type: "GRADIENT_LINEAR",
			stops: [
				{ position: 0, color: "#3366ff", opacity: 1 },
				{ position: 1, color: "#000000", opacity: 0.5 },
			],
		},
	],
	children: [],
} satisfies SerializedNode;

const stickyNote = {
	id: "1:20",
	name: "Note",
	type: "TEXT",
	x: 0,
	y: -120,
	width: 200,
	height: 20,
	rotation: 15,
	fills: [{ type: "SOLID", color: "#000000" }],
	text: {
		characters: "Draft: copy TBD",
		fontName: "mixed",
		fontSize: "mixed",
	},
} satisfies SerializedNode;

const buttonComponent = {
	id: "2:1",
	name: "Button",
	type: "COMPONENT",
	x: 0,
	y: 0,
	width: 120,
	height: 48,
	cornerRadius: 12,
	fills: [{ type: "SOLID", color: "#3366ff" }],
	component: { key: "c0ffee", description: "Primary call to action" },
	children: [
		{
			id: "2:2",
			name: "Label",
			type: "TEXT",
			x: 16,
			y: 12,
			width: 88,
			height: 24,
			fills: [{ type: "SOLID", color: "#ffffff" }],
			text: {
				characters: "Button",
				fontName: { family: "Inter", style: "Semi Bold" },
				fontSize: 16,
			},
		},
	],
} satisfies SerializedNode;

/**
 * In-memory Figma document both test seams are built from. Nodes are written
 * in their serialized (agent-facing) form at full depth: the fake plugin
 * serves them directly and the mocked `figma` global is built from them.
 */
export const document = {
	fileKey: "FILEKEY123",
	name: "Sample App",
	currentPageId: "0:1",
	selection: ["1:1", "1:20"],
	pages: [
		{
			id: "0:1",
			name: "Screens",
			children: [loginScreen, homeScreen, stickyNote] as SerializedNode[],
		},
		{
			id: "0:2",
			name: "Components",
			children: [buttonComponent] as SerializedNode[],
		},
	],
};
export type DocumentFixture = typeof document;

/** Every node in the document, pages included, keyed by ID. */
export function findNode(
	id: string,
	doc: DocumentFixture = document,
): SerializedNode | undefined {
	const pages = doc.pages.map((page) => ({ ...page, type: "PAGE" }));
	const stack: SerializedNode[] = [...pages];
	while (stack.length > 0) {
		const node = stack.pop() as SerializedNode;
		if (node.id === id) return node;
		stack.push(...(node.children ?? []));
	}
	return undefined;
}

/** Cuts a serialized node off `depth` levels below it, as the plugin does. */
export function limitDepth(
	node: SerializedNode,
	depth: number,
): SerializedNode {
	const { children, ...rest } = node;
	if (!children) return node;
	if (depth > 0) {
		return {
			...rest,
			children: children.map((child) => limitDepth(child, depth - 1)),
		};
	}
	return children.length > 0 ? { ...rest, childCount: children.length } : rest;
}

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

export const getNodeRequest = {
	type: "request",
	id: "req-2",
	command: "get_node",
	params: { id: "1:1", depth: 1 },
} satisfies Request;

export const getNodeResponse = {
	type: "response",
	id: "req-2",
	ok: true,
	result: { node: limitDepth(loginScreen, 1) },
} satisfies Response;

export const getUnknownNodeRequest = {
	type: "request",
	id: "req-3",
	command: "get_node",
	params: { id: "9:999", depth: 1 },
} satisfies Request;

/** The plugin's answer when `get_node` is asked for an ID that isn't there. */
export function nodeNotFoundResponse(requestId: string, nodeId: string) {
	return {
		type: "response",
		id: requestId,
		ok: false,
		error: {
			code: "node_not_found",
			message: `No node with ID "${nodeId}" exists in this file. Node IDs look like "12:34"; get them from get_selection, list_frames or a parent node's children.`,
		},
	} satisfies Response;
}

export const getUnknownNodeResponse = nodeNotFoundResponse(
	getUnknownNodeRequest.id,
	getUnknownNodeRequest.params.id,
);

export const listPagesRequest = {
	type: "request",
	id: "req-4",
	command: "list_pages",
	params: {},
} satisfies Request;

export const listPagesResponse = {
	type: "response",
	id: "req-4",
	ok: true,
	result: {
		pages: [
			{ id: "0:1", name: "Screens", current: true },
			{ id: "0:2", name: "Components", current: false },
		],
	},
} satisfies Response;

/** The plugin's answer when `list_frames` is given an ID that isn't a page. */
export function pageNotFoundResponse(requestId: string, pageId: string) {
	return {
		type: "response",
		id: requestId,
		ok: false,
		error: {
			code: "page_not_found",
			message: `No page with ID "${pageId}" exists in this file. Get page IDs from list_pages.`,
		},
	} satisfies Response;
}
