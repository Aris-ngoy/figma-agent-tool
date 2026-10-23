// Shared protocol fixtures. The fake plugin (MCP server tests) and the real
// plugin's command handler (plugin tests) replay these same messages, so the
// two can't drift apart.
import type {
	Handshake,
	Reaction,
	Request,
	Response,
	SerializedNode,
} from "../src";
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
 * Prototype reactions by node ID, covering every trigger, transition and
 * easing kind (written as the Plugin API reports them, durations in seconds).
 */
const reactions: Record<string, Reaction[]> = {
	// Button: sign in pushes to Home, Enter jumps there, hover scrolls to the title.
	"1:3": [
		{
			trigger: { type: "ON_CLICK" },
			actions: [
				{
					type: "NODE",
					destinationId: "1:10",
					navigation: "NAVIGATE",
					transition: {
						type: "PUSH",
						direction: "LEFT",
						matchLayers: false,
						easing: {
							type: "CUSTOM_CUBIC_BEZIER",
							easingFunctionCubicBezier: { x1: 0.2, y1: 0, x2: 0, y2: 1 },
						},
						duration: 0.3,
					},
					resetScrollPosition: true,
				},
			],
		},
		{
			trigger: { type: "ON_KEY_DOWN", device: "KEYBOARD", keyCodes: [13] },
			actions: [
				{
					type: "NODE",
					destinationId: "1:10",
					navigation: "NAVIGATE",
					transition: null,
				},
			],
		},
		{
			trigger: { type: "ON_HOVER" },
			actions: [
				{
					type: "NODE",
					destinationId: "1:2",
					navigation: "SCROLL_TO",
					transition: {
						type: "SMART_ANIMATE",
						easing: { type: "GENTLE" },
						duration: 0.6,
					},
				},
			],
		},
	],
	// Title: hovering opens Home as an overlay, leaving closes it.
	"1:2": [
		{
			trigger: { type: "MOUSE_ENTER", delay: 0.2, deprecatedVersion: false },
			actions: [
				{
					type: "NODE",
					destinationId: "1:10",
					navigation: "OVERLAY",
					transition: {
						type: "MOVE_IN",
						direction: "BOTTOM",
						matchLayers: false,
						easing: {
							type: "CUSTOM_SPRING",
							easingFunctionSpring: {
								mass: 1,
								stiffness: 300,
								damping: 20,
								initialVelocity: 0,
							},
						},
						duration: 0.8,
					},
					overlayRelativePosition: { x: 0, y: 400 },
				},
			],
		},
		{
			trigger: { type: "MOUSE_LEAVE", delay: 0, deprecatedVersion: false },
			actions: [{ type: "CLOSE" }],
		},
		{
			trigger: { type: "ON_PRESS" },
			actions: [
				{ type: "URL", url: "https://example.com/help", openInNewTab: true },
			],
		},
	],
	"1:10": [
		{
			trigger: { type: "AFTER_TIMEOUT", timeout: 3 },
			actions: [
				{
					type: "NODE",
					destinationId: "1:1",
					navigation: "NAVIGATE",
					transition: {
						type: "DISSOLVE",
						easing: { type: "EASE_OUT" },
						duration: 0.2,
					},
				},
			],
		},
		{ trigger: { type: "ON_DRAG" }, actions: [{ type: "BACK" }] },
		{
			trigger: { type: "ON_KEY_DOWN", device: "PS4", keyCodes: [1] },
			actions: [
				{
					type: "NODE",
					destinationId: "1:1",
					navigation: "SWAP",
					transition: {
						type: "SLIDE_OUT",
						direction: "RIGHT",
						matchLayers: true,
						easing: { type: "EASE_IN_AND_OUT_BACK" },
						duration: 0.4,
					},
				},
			],
		},
		{
			trigger: { type: "MOUSE_DOWN", delay: 0 },
			actions: [
				{
					type: "SET_VARIABLE_MODE",
					variableCollectionId: "VariableCollectionId:1:1",
					variableModeId: "1:0",
				},
				{
					type: "CONDITIONAL",
					conditionalBlocks: [
						{
							condition: {
								type: "BOOLEAN",
								resolvedType: "BOOLEAN",
								value: true,
							},
							actions: [{ type: "BACK" }],
						},
						{ actions: [{ type: "CLOSE" }] },
					],
				},
			],
		},
	],
	"1:20": [
		{
			trigger: { type: "MOUSE_UP", delay: 0.1 },
			actions: [
				{
					type: "SET_VARIABLE",
					variableId: "VariableID:1:2",
					variableValue: { type: "FLOAT", resolvedType: "FLOAT", value: 2 },
				},
			],
		},
		{
			trigger: { type: "ON_MEDIA_HIT", mediaHitTime: 1.5 },
			actions: [
				{
					type: "UPDATE_MEDIA_RUNTIME",
					destinationId: null,
					mediaAction: "SKIP_TO",
					newTimestamp: 0,
				},
			],
		},
		{
			trigger: { type: "ON_MEDIA_END" },
			actions: [
				{
					type: "UPDATE_MEDIA_RUNTIME",
					destinationId: null,
					mediaAction: "PLAY",
				},
			],
		},
		{ trigger: null, actions: [{ type: "BACK" }] },
	],
};

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
	reactions,
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

/** A 4×2 px PNG; the mock plugin returns it for every export. */
export const framePng =
	"iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAEklEQVR4nGMwTvv/HxkzoAsAAFR1FLllEk5AAAAAAElFTkSuQmCC";

export const exportFrameRequest = {
	type: "request",
	id: "req-5",
	command: "export_node_image",
	params: { nodeId: "1:2", scale: 2 },
} satisfies Request;

export const exportFrameResponse = {
	type: "response",
	id: "req-5",
	ok: true,
	result: { png: framePng },
} satisfies Response;

export const exportPageRequest = {
	type: "request",
	id: "req-6",
	command: "export_node_image",
	params: { nodeId: "0:1", scale: 1 },
} satisfies Request;

export const exportPageResponse = {
	type: "response",
	id: "req-6",
	ok: false,
	error: {
		code: "not_exportable",
		message:
			"Node 0:1 is a PAGE and cannot be exported. Export a frame, component or other layer on the canvas instead.",
	},
} satisfies Response;

export const exportMissingNodeRequest = {
	type: "request",
	id: "req-7",
	command: "export_node_image",
	params: { nodeId: "9:99", scale: 1 },
} satisfies Request;

export const exportMissingNodeResponse = nodeNotFoundResponse(
	exportMissingNodeRequest.id,
	exportMissingNodeRequest.params.nodeId,
);

/** Fonts installed for the fixture file; loading any other font fails. */
export const availableFonts = [
	{ family: "Inter", style: "Regular" },
	{ family: "Inter", style: "Italic" },
	{ family: "Inter", style: "Semi Bold" },
	{ family: "Inter", style: "Bold" },
];

/** The ID the fakes give the `n`th node created in a session (from 1). */
export function createdNodeId(n: number): string {
	return `100:${n}`;
}

/** Copies a subtree with every ID prefixed, as Figma does for instance sublayers. */
export function prefixIds(
	node: SerializedNode,
	prefix: string,
): SerializedNode {
	return {
		...node,
		id: `${prefix}${node.id}`,
		children: node.children?.map((child) => prefixIds(child, prefix)),
	};
}

/** Per-node error when a text edit needs a font that isn't installed. */
export function fontNotFoundError(font: { family: string; style: string }) {
	return {
		code: "font_not_found",
		message: `Font "${font.family} ${font.style}" isn't available in this file. Use an installed font, such as one an existing text node's fontName shows.`,
	};
}

/** Per-node error when an INSTANCE spec's componentId isn't a component. */
export function notAComponentError(id: string, type?: string) {
	return {
		code: "component_not_found",
		message: `${type ? `Node ${id} is a ${type}, not` : `No node with ID "${id}" exists, so it isn't`} a COMPONENT. Use a component's ID (a variant's, for component sets); list_frames lists the components on each page.`,
	};
}

/** Builds a sign-in card inside the empty Home frame. */
export const createNodesRequest = {
	type: "request",
	id: "req-8",
	command: "create_nodes",
	params: {
		parentId: "1:10",
		nodes: [
			{
				type: "FRAME",
				name: "Card",
				width: 345,
				height: 200,
				cornerRadius: 16,
				fills: [{ type: "SOLID", color: "#f5f5f5" }],
				layout: {
					mode: "VERTICAL",
					itemSpacing: 12,
					padding: { top: 24, right: 24, bottom: 24, left: 24 },
					sizing: { vertical: "HUG" },
				},
				children: [
					{
						type: "TEXT",
						name: "Heading",
						text: {
							characters: "Sign in",
							fontName: { family: "Inter", style: "Bold" },
							fontSize: 24,
						},
					},
					{ type: "INSTANCE", componentId: "2:1", name: "Submit" },
				],
			},
			{
				type: "RECTANGLE",
				name: "Backdrop",
				x: 0,
				y: 600,
				width: 393,
				height: 252,
				fills: [{ type: "SOLID", color: "#3366ff", opacity: 0.2 }],
			},
		],
	},
} satisfies Request;

export const createNodesResponse = {
	type: "response",
	id: "req-8",
	ok: true,
	result: {
		nodes: [
			{
				ok: true,
				id: createdNodeId(1),
				name: "Card",
				type: "FRAME",
				children: [
					{ ok: true, id: createdNodeId(2), name: "Heading", type: "TEXT" },
					{ ok: true, id: createdNodeId(3), name: "Submit", type: "INSTANCE" },
				],
			},
			{ ok: true, id: createdNodeId(4), name: "Backdrop", type: "RECTANGLE" },
		],
	},
} satisfies Response;

/** A batch where some specs fail: each failure is reported in place. */
export const createNodesPartlyRequest = {
	type: "request",
	id: "req-9",
	command: "create_nodes",
	params: {
		nodes: [
			{
				type: "TEXT",
				text: {
					characters: "Hello",
					fontName: { family: "Comic Neue", style: "Regular" },
				},
			},
			{ type: "INSTANCE", componentId: "1:1" },
			{ type: "RECTANGLE", name: "Kept" },
		],
	},
} satisfies Request;

export const createNodesPartlyResponse = {
	type: "response",
	id: "req-9",
	ok: true,
	result: {
		nodes: [
			{
				ok: false,
				error: fontNotFoundError({ family: "Comic Neue", style: "Regular" }),
			},
			{ ok: false, error: notAComponentError("1:1", "FRAME") },
			{ ok: true, id: createdNodeId(1), name: "Kept", type: "RECTANGLE" },
		],
	},
} satisfies Response;

/** Updates three nodes; the unknown ID and the missing font fail alone. */
export const updateNodesRequest = {
	type: "request",
	id: "req-10",
	command: "update_nodes",
	params: {
		updates: [
			{ id: "1:2", text: { characters: "Hi again" } },
			{ id: "9:99", opacity: 0.5 },
			{
				id: "1:4",
				text: { fontName: { family: "Comic Neue", style: "Bold" } },
			},
		],
	},
} satisfies Request;

export const updateNodesResponse = {
	type: "response",
	id: "req-10",
	ok: true,
	result: {
		nodes: [
			{ id: "1:2", ok: true },
			{ id: "9:99", ok: false, error: nodeNotFoundResponse("", "9:99").error },
			{
				id: "1:4",
				ok: false,
				error: fontNotFoundError({ family: "Comic Neue", style: "Bold" }),
			},
		],
	},
} satisfies Response;

export const getReactionsRequest = {
	type: "request",
	id: "req-11",
	command: "get_reactions",
	params: { nodeId: "1:3" },
} satisfies Request;

export const getReactionsResponse = {
	type: "response",
	id: "req-11",
	ok: true,
	result: { nodeId: "1:3", reactions: reactions["1:3"] as Reaction[] },
} satisfies Response;

/** Tapping Home slides Login in from the top, after Home's own reactions. */
const slideToLogin = {
	trigger: { type: "ON_CLICK" },
	actions: [
		{
			type: "NODE",
			destinationId: "1:1",
			navigation: "NAVIGATE",
			transition: {
				type: "SLIDE_IN",
				direction: "TOP",
				matchLayers: false,
				easing: { type: "EASE_IN_AND_OUT" },
				duration: 0.5,
			},
		},
	],
} satisfies Reaction;

export const appendReactionsRequest = {
	type: "request",
	id: "req-12",
	command: "set_reactions",
	params: { nodeId: "1:10", mode: "append", reactions: [slideToLogin] },
} satisfies Request;

export const appendReactionsResponse = {
	type: "response",
	id: "req-12",
	ok: true,
	result: {
		nodeId: "1:10",
		reactions: [...(reactions["1:10"] as Reaction[]), slideToLogin],
	},
} satisfies Response;

/** Navigating to a node that doesn't exist fails, and nothing is written. */
export const setDanglingReactionRequest = {
	type: "request",
	id: "req-13",
	command: "set_reactions",
	params: {
		nodeId: "1:2",
		mode: "replace",
		reactions: [
			{
				trigger: { type: "ON_CLICK" },
				actions: [
					{
						type: "NODE",
						destinationId: "9:99",
						navigation: "NAVIGATE",
						transition: null,
					},
				],
			},
		],
	},
} satisfies Request;

export const setDanglingReactionResponse = {
	type: "response",
	id: "req-13",
	ok: false,
	error: {
		code: "invalid_destination",
		message:
			'NAVIGATE destination "9:99" doesn\'t exist in this file. Use a node ID from list_frames or get_node.',
	},
} satisfies Response;

export const removeReactionsRequest = {
	type: "request",
	id: "req-14",
	command: "remove_reactions",
	params: { nodeId: "1:10", match: { trigger: "ON_KEY_DOWN" } },
} satisfies Request;

export const removeReactionsResponse = {
	type: "response",
	id: "req-14",
	ok: true,
	result: {
		nodeId: "1:10",
		removed: 1,
		reactions: (reactions["1:10"] as Reaction[]).filter(
			(reaction) => reaction.trigger?.type !== "ON_KEY_DOWN",
		),
	},
} satisfies Response;

/**
 * Every request the fakes know how to answer, paired with the plugin's
 * response. The fake plugin matches on command + params; the plugin tests
 * replay each pair against the real handler.
 */
export const exchanges: [Request, Response][] = [
	[pingRequest, pingResponse],
	[getNodeRequest, getNodeResponse],
	[getUnknownNodeRequest, getUnknownNodeResponse],
	[listPagesRequest, listPagesResponse],
	[exportFrameRequest, exportFrameResponse],
	[exportPageRequest, exportPageResponse],
	[exportMissingNodeRequest, exportMissingNodeResponse],
	[createNodesRequest, createNodesResponse],
	[createNodesPartlyRequest, createNodesPartlyResponse],
	[updateNodesRequest, updateNodesResponse],
	[getReactionsRequest, getReactionsResponse],
	[appendReactionsRequest, appendReactionsResponse],
	[setDanglingReactionRequest, setDanglingReactionResponse],
	[removeReactionsRequest, removeReactionsResponse],
];
