// Shared protocol fixtures. The fake plugin (MCP server tests) and the real
// plugin's command handler (plugin tests) replay these same messages, so the
// two can't drift apart.
import type {
	DesignSystem,
	Handshake,
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
			styles: { fill: "S:text-primary,", text: "S:heading," },
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
			fills: [{ type: "SOLID", color: "#3366ff", variable: "VariableID:1:1" }],
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
			variables: {
				paddingLeft: "VariableID:2:1",
				paddingRight: "VariableID:2:1",
				topLeftRadius: "VariableID:2:2",
				topRightRadius: "VariableID:2:2",
				bottomRightRadius: "VariableID:2:2",
				bottomLeftRadius: "VariableID:2:2",
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
	component: {
		key: "c0ffee",
		description: "Primary call to action",
		properties: {
			"Label#2:0": { type: "TEXT", defaultValue: "Button" },
			"Disabled#2:1": { type: "BOOLEAN", defaultValue: false },
		},
	},
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

function chipVariant(id: string, size: string, width: number) {
	return {
		id,
		name: `Size=${size}`,
		type: "COMPONENT",
		x: 0,
		y: size === "Small" ? 0 : 48,
		width,
		height: 32,
		cornerRadius: 16,
		fills: [{ type: "SOLID", color: "#eeeeee" }],
		component: { key: `ch1p-${size}`, variantProperties: { Size: size } },
	} satisfies SerializedNode;
}

const chipSet = {
	id: "3:1",
	name: "Chip",
	type: "COMPONENT_SET",
	x: 200,
	y: 0,
	width: 120,
	height: 80,
	component: {
		key: "ch1p",
		properties: {
			Size: {
				type: "VARIANT",
				defaultValue: "Small",
				variantOptions: ["Small", "Large"],
			},
		},
	},
	children: [chipVariant("3:2", "Small", 80), chipVariant("3:3", "Large", 120)],
} satisfies SerializedNode;

/** The file's local styles, as get_design_system returns them. */
const styles = {
	paint: [
		{
			id: "S:brand-primary,",
			name: "Brand/Primary",
			description: "Main brand color",
			paints: [{ type: "SOLID", color: "#3366ff" }],
		},
		{
			id: "S:text-primary,",
			name: "Text/Primary",
			paints: [{ type: "SOLID", color: "#111111" }],
		},
	],
	text: [
		{
			id: "S:heading,",
			name: "Heading/Large",
			fontName: { family: "Inter", style: "Bold" },
			fontSize: 28,
			lineHeight: { value: 34, unit: "PIXELS" },
		},
		{
			id: "S:body,",
			name: "Body",
			fontName: { family: "Inter", style: "Regular" },
			fontSize: 16,
			letterSpacing: { value: -1, unit: "PERCENT" },
		},
	],
	effect: [
		{
			id: "S:shadow-card,",
			name: "Shadow/Card",
			effects: [
				{
					type: "DROP_SHADOW",
					color: "#000000",
					opacity: 0.1,
					offset: { x: 0, y: 4 },
					radius: 12,
				},
				{ type: "BACKGROUND_BLUR", radius: 8 },
			],
		},
	],
} satisfies DesignSystem["styles"];

/** The file's local variables, as get_design_system returns them. */
const collections = [
	{
		id: "VariableCollectionId:1:0",
		name: "Theme",
		modes: [
			{ id: "1:0", name: "Light" },
			{ id: "1:1", name: "Dark" },
		],
		defaultMode: "Light",
		variables: [
			{
				id: "VariableID:1:1",
				name: "color/primary",
				type: "COLOR",
				scopes: ["ALL_FILLS", "STROKE_COLOR"],
				valuesByMode: {
					Light: { color: "#3366ff" },
					Dark: { color: "#6699ff" },
				},
			},
			{
				id: "VariableID:1:2",
				name: "color/surface",
				type: "COLOR",
				valuesByMode: {
					Light: { color: "#ffffff" },
					Dark: { color: "#111111" },
				},
			},
			{
				id: "VariableID:1:3",
				name: "color/scrim",
				type: "COLOR",
				description: "Behind modals",
				valuesByMode: {
					Light: { color: "#000000", opacity: 0.5 },
					Dark: { alias: "VariableID:1:2" },
				},
			},
		],
	},
	{
		id: "VariableCollectionId:2:0",
		name: "Tokens",
		modes: [{ id: "2:0", name: "Value" }],
		defaultMode: "Value",
		variables: [
			{
				id: "VariableID:2:1",
				name: "space/md",
				type: "FLOAT",
				scopes: ["GAP"],
				valuesByMode: { Value: 16 },
			},
			{
				id: "VariableID:2:2",
				name: "radius/md",
				type: "FLOAT",
				scopes: ["CORNER_RADIUS"],
				valuesByMode: { Value: 12 },
			},
			{
				id: "VariableID:2:3",
				name: "space/lg",
				type: "FLOAT",
				scopes: ["GAP"],
				valuesByMode: { Value: 24 },
			},
			{
				id: "VariableID:2:4",
				name: "space/page",
				type: "FLOAT",
				description: "Screen edge padding",
				valuesByMode: { Value: { alias: "VariableID:2:3" } },
			},
			{
				id: "VariableID:2:5",
				name: "font/body",
				type: "STRING",
				valuesByMode: { Value: "Inter" },
			},
		],
	},
] satisfies DesignSystem["collections"];

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
			children: [buttonComponent, chipSet] as SerializedNode[],
		},
	],
	styles: styles as DesignSystem["styles"],
	collections: collections as DesignSystem["collections"],
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

/** Per-node error when a variable ID doesn't exist. */
export function variableNotFoundError(id: string) {
	return {
		code: "variable_not_found",
		message: `No variable with ID "${id}" exists in this file. Get variable IDs from get_design_system.`,
	};
}

/** Per-node error when a variable's type doesn't fit the field. */
export function variableTypeMismatchError(
	field: string,
	variable: { id: string; name: string; type: string },
	expected: string,
) {
	return {
		code: "variable_type_mismatch",
		message: `Variable "${variable.name}" (${variable.id}) is a ${variable.type} variable; ${field} needs a ${expected} one.`,
	};
}

/** Per-node error when a style ID doesn't exist. */
export function styleNotFoundError(id: string) {
	return {
		code: "style_not_found",
		message: `No style with ID "${id}" exists in this file. Get style IDs from get_design_system.`,
	};
}

/** Per-node error when a style's type doesn't fit the slot. */
export function styleTypeMismatchError(
	slot: string,
	style: { id: string; name: string; type: string },
	expected: string,
) {
	return {
		code: "style_type_mismatch",
		message: `Style "${style.name}" (${style.id}) is a ${style.type} style; styles.${slot} needs a ${expected} one.`,
	};
}

export const getDesignSystemRequest = {
	type: "request",
	id: "req-11",
	command: "get_design_system",
	params: {},
} satisfies Request;

export const getDesignSystemResponse = {
	type: "response",
	id: "req-11",
	ok: true,
	result: {
		components: [
			{
				id: "2:1",
				name: "Button",
				type: "COMPONENT",
				key: "c0ffee",
				description: "Primary call to action",
				page: { id: "0:2", name: "Components" },
				properties: buttonComponent.component.properties,
			},
			{
				id: "3:1",
				name: "Chip",
				type: "COMPONENT_SET",
				key: "ch1p",
				page: { id: "0:2", name: "Components" },
				properties: chipSet.component.properties,
				variants: [
					{ id: "3:2", name: "Size=Small", properties: { Size: "Small" } },
					{ id: "3:3", name: "Size=Large", properties: { Size: "Large" } },
				],
			},
		],
		styles: document.styles,
		collections: document.collections,
	},
} satisfies Response;

/**
 * Binds variables and applies styles; bad IDs and types fail per node:
 * auto-layout spacing (one through an alias), a fill color, an effect style,
 * a text style and a stroke style.
 */
export const bindNodesRequest = {
	type: "request",
	id: "req-12",
	command: "update_nodes",
	params: {
		updates: [
			{
				id: "1:1",
				variables: {
					itemSpacing: "VariableID:2:1",
					paddingTop: "VariableID:2:4",
				},
			},
			{
				id: "1:10",
				fills: [{ type: "SOLID", variable: "VariableID:1:2" }],
				styles: { effect: "S:shadow-card," },
			},
			{ id: "1:4", styles: { text: "S:body," } },
			{ id: "1:5", styles: { stroke: "S:text-primary," } },
			{ id: "1:20", variables: { fontSize: "VariableID:1:1" } },
			{ id: "1:3", variables: { opacity: "VariableID:9:9" } },
			{ id: "1:2", styles: { fill: "S:nope," } },
			{ id: "1:2", styles: { text: "S:brand-primary," } },
		],
	},
} satisfies Request;

export const bindNodesResponse = {
	type: "response",
	id: "req-12",
	ok: true,
	result: {
		nodes: [
			{ id: "1:1", ok: true },
			{ id: "1:10", ok: true },
			{ id: "1:4", ok: true },
			{ id: "1:5", ok: true },
			{
				id: "1:20",
				ok: false,
				error: variableTypeMismatchError(
					"fontSize",
					{ id: "VariableID:1:1", name: "color/primary", type: "COLOR" },
					"FLOAT",
				),
			},
			{ id: "1:3", ok: false, error: variableNotFoundError("VariableID:9:9") },
			{ id: "1:2", ok: false, error: styleNotFoundError("S:nope,") },
			{
				id: "1:2",
				ok: false,
				error: styleTypeMismatchError(
					"text",
					{ id: "S:brand-primary,", name: "Brand/Primary", type: "PAINT" },
					"TEXT",
				),
			},
		],
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
	[getDesignSystemRequest, getDesignSystemResponse],
	[bindNodesRequest, bindNodesResponse],
];
