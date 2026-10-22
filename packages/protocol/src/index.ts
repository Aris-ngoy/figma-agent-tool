import { z } from "zod";

/** Bumped whenever the bridge message shapes change incompatibly. */
export const PROTOCOL_VERSION = 1;

/** Default localhost port the MCP server hosts the bridge on. */
export const DEFAULT_BRIDGE_PORT = 3055;

export const Capabilities = z.object({
	motion: z.boolean(),
});
export type Capabilities = z.infer<typeof Capabilities>;

export const FileInfo = z.object({
	// Figma only exposes the file key to private plugins; development plugins
	// get it via `enablePrivatePluginApi`, otherwise it is null.
	key: z.string().nullable(),
	name: z.string(),
});
export type FileInfo = z.infer<typeof FileInfo>;

/** Plugin → server, first message on every connection. */
export const Handshake = z.object({
	type: z.literal("handshake"),
	protocolVersion: z.literal(PROTOCOL_VERSION),
	pluginVersion: z.string(),
	file: FileInfo,
	capabilities: Capabilities,
});
export type Handshake = z.infer<typeof Handshake>;

/** Server → plugin, acknowledges a handshake. */
export const HandshakeAck = z.object({
	type: z.literal("handshake_ack"),
	serverVersion: z.string(),
});
export type HandshakeAck = z.infer<typeof HandshakeAck>;

/** Figma reports `figma.mixed` when a property differs across a node's range. */
const Mixed = z.literal("mixed");

/** `#RRGGBB`; alpha travels separately as `opacity`. */
const HexColor = z.string().regex(/^#[0-9a-f]{6}$/);

export const ColorStop = z.object({
	position: z.number(),
	color: HexColor,
	opacity: z.number(),
});

/** A compact Figma Paint: solids as hex, gradients as stops, images by hash. */
export const Paint = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("SOLID"),
		color: HexColor,
		opacity: z.number().optional(),
		visible: z.literal(false).optional(),
	}),
	z.object({
		type: z.enum([
			"GRADIENT_LINEAR",
			"GRADIENT_RADIAL",
			"GRADIENT_ANGULAR",
			"GRADIENT_DIAMOND",
		]),
		stops: z.array(ColorStop),
		opacity: z.number().optional(),
		visible: z.literal(false).optional(),
	}),
	z.object({
		type: z.literal("IMAGE"),
		imageHash: z.string().nullable(),
		scaleMode: z.string(),
		opacity: z.number().optional(),
		visible: z.literal(false).optional(),
	}),
	z.object({
		type: z.enum(["VIDEO", "PATTERN", "SHADER"]),
		opacity: z.number().optional(),
		visible: z.literal(false).optional(),
	}),
]);
export type Paint = z.infer<typeof Paint>;

export const FontName = z.object({ family: z.string(), style: z.string() });

export const TextInfo = z.object({
	characters: z.string(),
	fontName: z.union([FontName, Mixed]),
	fontSize: z.union([z.number(), Mixed]),
	textAlignHorizontal: z.string().optional(),
});
export type TextInfo = z.infer<typeof TextInfo>;

/** Auto-layout settings of a frame whose `layoutMode` isn't NONE. */
export const AutoLayout = z.object({
	mode: z.enum(["HORIZONTAL", "VERTICAL", "GRID"]),
	itemSpacing: z.number(),
	padding: z.object({
		top: z.number(),
		right: z.number(),
		bottom: z.number(),
		left: z.number(),
	}),
	primaryAxisAlignItems: z.string(),
	counterAxisAlignItems: z.string(),
	wrap: z.boolean(),
	sizing: z.object({
		horizontal: z.enum(["FIXED", "HUG", "FILL"]),
		vertical: z.enum(["FIXED", "HUG", "FILL"]),
	}),
});
export type AutoLayout = z.infer<typeof AutoLayout>;

export const CornerRadius = z.union([
	z.number(),
	z.object({
		topLeft: z.number(),
		topRight: z.number(),
		bottomRight: z.number(),
		bottomLeft: z.number(),
	}),
]);

export const ComponentInfo = z.object({
	key: z.string(),
	description: z.string().optional(),
});

export const InstanceInfo = z.object({
	mainComponent: z.object({ id: z.string(), name: z.string() }).nullable(),
	properties: z.record(z.string(), z.union([z.string(), z.boolean()])),
});

/**
 * A document node as agents see it. Defaults (visible, opacity 1, no
 * rotation, no paints) are omitted to keep payloads small. When the depth
 * limit cuts a subtree off, `children` is absent and `childCount` says how
 * many children were left out.
 */
export const SerializedNode = z.object({
	id: z.string(),
	name: z.string(),
	type: z.string(),
	visible: z.literal(false).optional(),
	x: z.number().optional(),
	y: z.number().optional(),
	width: z.number().optional(),
	height: z.number().optional(),
	rotation: z.number().optional(),
	opacity: z.number().optional(),
	cornerRadius: CornerRadius.optional(),
	fills: z.union([z.array(Paint), Mixed]).optional(),
	strokes: z.array(Paint).optional(),
	strokeWeight: z.union([z.number(), Mixed]).optional(),
	text: TextInfo.optional(),
	layout: AutoLayout.optional(),
	component: ComponentInfo.optional(),
	instance: InstanceInfo.optional(),
	childCount: z.number().int().optional(),
	get children() {
		return z.array(SerializedNode).optional();
	},
});
export type SerializedNode = z.infer<typeof SerializedNode>;

export const PageRef = z.object({ id: z.string(), name: z.string() });
export type PageRef = z.infer<typeof PageRef>;

export const FrameSummary = z.object({
	id: z.string(),
	name: z.string(),
	type: z.string(),
	x: z.number(),
	y: z.number(),
	width: z.number(),
	height: z.number(),
});
export type FrameSummary = z.infer<typeof FrameSummary>;

/** Node types `list_frames` treats as a page's top-level frames. */
export const FRAME_TYPES = [
	"FRAME",
	"COMPONENT",
	"COMPONENT_SET",
	"SECTION",
] as const;

/** How many levels of children to include below each returned node. */
export const Depth = z.number().int().min(0).max(100);
export const DEFAULT_DEPTH = 2;

/**
 * Commands the server can send to the plugin, with their params and results.
 * Each Figma-backed MCP tool maps onto one of these.
 */
export const commands = {
	ping: {
		params: z.object({}),
		result: z.object({ pong: z.literal(true) }),
	},
	get_selection: {
		params: z.object({ depth: Depth }),
		result: z.object({ page: PageRef, nodes: z.array(SerializedNode) }),
	},
	get_node: {
		params: z.object({ id: z.string().min(1), depth: Depth }),
		result: z.object({ node: SerializedNode }),
	},
	list_pages: {
		params: z.object({}),
		result: z.object({
			pages: z.array(PageRef.extend({ current: z.boolean() })),
		}),
	},
	list_frames: {
		params: z.object({ pageId: z.string().min(1).optional() }),
		result: z.object({ page: PageRef, frames: z.array(FrameSummary) }),
	},
} as const;

export type CommandName = keyof typeof commands;
export type CommandParams<C extends CommandName> = z.infer<
	(typeof commands)[C]["params"]
>;
export type CommandResult<C extends CommandName> = z.infer<
	(typeof commands)[C]["result"]
>;

const commandNames = Object.keys(commands) as [CommandName, ...CommandName[]];

/** Server → plugin. `id` correlates the plugin's response. */
export const Request = z.object({
	type: z.literal("request"),
	id: z.string().min(1),
	command: z.enum(commandNames),
	params: z.unknown(),
});
export type Request = z.infer<typeof Request>;

export const BridgeError = z.object({
	code: z.string(),
	message: z.string(),
});
export type BridgeError = z.infer<typeof BridgeError>;

/** Plugin → server, answers the request with the same `id`. */
export const Response = z.discriminatedUnion("ok", [
	z.object({
		type: z.literal("response"),
		id: z.string().min(1),
		ok: z.literal(true),
		result: z.unknown(),
	}),
	z.object({
		type: z.literal("response"),
		id: z.string().min(1),
		ok: z.literal(false),
		error: BridgeError,
	}),
]);
export type Response = z.infer<typeof Response>;

export const PluginMessage = z.union([Handshake, Response]);
export type PluginMessage = z.infer<typeof PluginMessage>;

export const ServerMessage = z.union([HandshakeAck, Request]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export function parsePluginMessage(data: unknown): PluginMessage {
	return PluginMessage.parse(data);
}

export function parseServerMessage(data: unknown): ServerMessage {
	return ServerMessage.parse(data);
}
