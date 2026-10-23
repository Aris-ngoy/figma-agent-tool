import { z } from "zod";

/** Bumped whenever the bridge message shapes change incompatibly. */
export const PROTOCOL_VERSION = 1;

/** Default localhost port the MCP server hosts the bridge on. */
export const DEFAULT_BRIDGE_PORT = 3055;

/**
 * WebSocket close code the server uses when a newer plugin connection
 * replaces this one. The plugin must not reconnect on it, or two open plugin
 * instances would keep replacing each other.
 */
export const CLOSE_CODE_REPLACED = 4001;

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

const paintExtras = {
	opacity: z.number().optional(),
	visible: z.literal(false).optional(),
};
const SolidPaint = z.object({
	type: z.literal("SOLID"),
	color: HexColor,
	...paintExtras,
});
const GradientPaint = z.object({
	type: z.enum([
		"GRADIENT_LINEAR",
		"GRADIENT_RADIAL",
		"GRADIENT_ANGULAR",
		"GRADIENT_DIAMOND",
	]),
	stops: z.array(ColorStop),
	...paintExtras,
});
const ImagePaint = z.object({
	type: z.literal("IMAGE"),
	imageHash: z.string().nullable(),
	scaleMode: z.string(),
	...paintExtras,
});

/** A compact Figma Paint: solids as hex, gradients as stops, images by hash. */
export const Paint = z.discriminatedUnion("type", [
	SolidPaint,
	GradientPaint,
	ImagePaint,
	z.object({
		type: z.enum(["VIDEO", "PATTERN", "SHADER"]),
		...paintExtras,
	}),
]);
export type Paint = z.infer<typeof Paint>;

/** The paints agents can write: the read shape, minus video/pattern/shader. */
export const PaintInput = z.discriminatedUnion("type", [
	SolidPaint,
	GradientPaint,
	ImagePaint,
]);
export type PaintInput = z.infer<typeof PaintInput>;

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

export function isFrameType(type: string): boolean {
	return (FRAME_TYPES as readonly string[]).includes(type);
}

/** A failure the plugin reports, with a machine-readable code. */
export const BridgeError = z.object({
	code: z.string(),
	message: z.string(),
});
export type BridgeError = z.infer<typeof BridgeError>;

const Sizing = z.enum(["FIXED", "HUG", "FILL"]);

/**
 * Properties `create_nodes` and `update_nodes` set. They mirror the read
 * shape (`SerializedNode`), every field optional; only the given ones change.
 */
export const NodeProps = z.object({
	name: z.string().optional(),
	x: z.number().optional(),
	y: z.number().optional(),
	width: z.number().positive().optional(),
	height: z.number().positive().optional(),
	rotation: z.number().optional(),
	opacity: z.number().min(0).max(1).optional(),
	visible: z.boolean().optional(),
	cornerRadius: CornerRadius.optional(),
	fills: z.array(PaintInput).optional(),
	strokes: z.array(PaintInput).optional(),
	strokeWeight: z.number().min(0).optional(),
	text: z
		.object({
			characters: z.string(),
			fontName: FontName,
			fontSize: z.number().positive(),
			textAlignHorizontal: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]),
		})
		.partial()
		.optional(),
	layout: z
		.object({
			// NONE turns auto-layout off.
			mode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]),
			itemSpacing: z.number(),
			padding: z
				.object({
					top: z.number(),
					right: z.number(),
					bottom: z.number(),
					left: z.number(),
				})
				.partial(),
			primaryAxisAlignItems: z.enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"]),
			counterAxisAlignItems: z.enum(["MIN", "CENTER", "MAX", "BASELINE"]),
			wrap: z.boolean(),
			// Applies to the node itself: HUG its content, FILL its auto-layout
			// parent, or keep a FIXED size.
			sizing: z.object({ horizontal: Sizing, vertical: Sizing }).partial(),
		})
		.partial()
		.optional(),
});
export type NodeProps = z.infer<typeof NodeProps>;

export const CREATABLE_TYPES = [
	"FRAME",
	"TEXT",
	"RECTANGLE",
	"INSTANCE",
] as const;

export type NodeSpec = NodeProps & {
	type: (typeof CREATABLE_TYPES)[number];
	componentId?: string;
	children?: NodeSpec[];
};

/** One node to create, with its children nested below it. */
export const NodeSpec: z.ZodType<NodeSpec> = NodeProps.extend({
	type: z.enum(CREATABLE_TYPES),
	// The COMPONENT an INSTANCE is created from.
	componentId: z.string().min(1).optional(),
	get children() {
		return z.array(NodeSpec).optional();
	},
});

export type CreatedNode =
	| {
			ok: true;
			id: string;
			name: string;
			type: string;
			children?: CreatedNode[];
	  }
	| { ok: false; error: BridgeError };

/** Per-spec outcome of `create_nodes`, in the order the specs were given. */
export const CreatedNode: z.ZodType<CreatedNode> = z.discriminatedUnion("ok", [
	z.object({
		ok: z.literal(true),
		id: z.string(),
		name: z.string(),
		type: z.string(),
		get children() {
			return z.array(CreatedNode).optional();
		},
	}),
	z.object({ ok: z.literal(false), error: BridgeError }),
]);

export const NodeUpdate = NodeProps.extend({ id: z.string().min(1) });
export type NodeUpdate = z.infer<typeof NodeUpdate>;

/** Per-update outcome of `update_nodes`, in the order the updates were given. */
export const UpdatedNode = z.discriminatedUnion("ok", [
	z.object({ id: z.string(), ok: z.literal(true) }),
	z.object({ id: z.string(), ok: z.literal(false), error: BridgeError }),
]);
export type UpdatedNode = z.infer<typeof UpdatedNode>;

const Vector = z.object({ x: z.number(), y: z.number() });

export const TRIGGER_TYPES = [
	"ON_CLICK",
	"ON_HOVER",
	"ON_PRESS",
	"ON_DRAG",
	"AFTER_TIMEOUT",
	"MOUSE_UP",
	"MOUSE_DOWN",
	"MOUSE_ENTER",
	"MOUSE_LEAVE",
	"ON_KEY_DOWN",
	"ON_MEDIA_HIT",
	"ON_MEDIA_END",
] as const;

/**
 * What starts a reaction, as in the Plugin API. Times (`timeout`, `delay`,
 * `mediaHitTime`) are in seconds; `keyCodes` are key or gamepad button codes.
 */
export const Trigger = z.discriminatedUnion("type", [
	z.object({ type: z.enum(["ON_CLICK", "ON_HOVER", "ON_PRESS", "ON_DRAG"]) }),
	z.object({ type: z.literal("AFTER_TIMEOUT"), timeout: z.number().min(0) }),
	z.object({
		type: z.enum(["MOUSE_UP", "MOUSE_DOWN"]),
		delay: z.number().min(0),
	}),
	z.object({
		type: z.enum(["MOUSE_ENTER", "MOUSE_LEAVE"]),
		delay: z.number().min(0),
		deprecatedVersion: z.boolean().optional(),
	}),
	z.object({
		type: z.literal("ON_KEY_DOWN"),
		device: z.enum([
			"KEYBOARD",
			"XBOX_ONE",
			"PS4",
			"SWITCH_PRO",
			"UNKNOWN_CONTROLLER",
		]),
		keyCodes: z.array(z.number().int()),
	}),
	z.object({ type: z.literal("ON_MEDIA_HIT"), mediaHitTime: z.number() }),
	z.object({ type: z.literal("ON_MEDIA_END") }),
]);
export type Trigger = z.infer<typeof Trigger>;

/** A preset curve, a custom cubic bezier, or a custom spring. */
export const Easing = z.discriminatedUnion("type", [
	z.object({
		type: z.enum([
			"EASE_IN",
			"EASE_OUT",
			"EASE_IN_AND_OUT",
			"LINEAR",
			"EASE_IN_BACK",
			"EASE_OUT_BACK",
			"EASE_IN_AND_OUT_BACK",
			// Spring presets.
			"GENTLE",
			"QUICK",
			"BOUNCY",
			"SLOW",
		]),
	}),
	z.object({
		type: z.literal("CUSTOM_CUBIC_BEZIER"),
		easingFunctionCubicBezier: z.object({
			x1: z.number(),
			y1: z.number(),
			x2: z.number(),
			y2: z.number(),
		}),
	}),
	z.object({
		type: z.literal("CUSTOM_SPRING"),
		easingFunctionSpring: z.object({
			mass: z.number(),
			stiffness: z.number(),
			damping: z.number(),
			initialVelocity: z.number(),
		}),
	}),
]);
export type Easing = z.infer<typeof Easing>;

/** How a NODE action animates; `duration` is in seconds. Null is instant. */
export const Transition = z.discriminatedUnion("type", [
	z.object({
		type: z.enum(["DISSOLVE", "SMART_ANIMATE", "SCROLL_ANIMATE"]),
		easing: Easing,
		duration: z.number().min(0),
	}),
	z.object({
		type: z.enum(["MOVE_IN", "MOVE_OUT", "PUSH", "SLIDE_IN", "SLIDE_OUT"]),
		direction: z.enum(["LEFT", "RIGHT", "TOP", "BOTTOM"]),
		matchLayers: z.boolean().default(false),
		easing: Easing,
		duration: z.number().min(0),
	}),
]);
export type Transition = z.infer<typeof Transition>;

export const NAVIGATIONS = [
	"NAVIGATE",
	"SWAP",
	"OVERLAY",
	"SCROLL_TO",
	"CHANGE_TO",
] as const;

/** A variable value or expression, passed through as Figma reports it. */
const VariableData = z.object({
	type: z.string().optional(),
	resolvedType: z.string().optional(),
	value: z.unknown().optional(),
});

export type Action =
	| { type: "BACK" | "CLOSE" }
	| { type: "URL"; url: string; openInNewTab?: boolean }
	| {
			type: "UPDATE_MEDIA_RUNTIME";
			destinationId?: string | null;
			mediaAction: (typeof MEDIA_ACTIONS)[number];
			amountToSkip?: number;
			newTimestamp?: number;
	  }
	| {
			type: "SET_VARIABLE";
			variableId: string | null;
			variableValue?: z.infer<typeof VariableData>;
	  }
	| {
			type: "SET_VARIABLE_MODE";
			variableCollectionId: string | null;
			variableModeId: string | null;
	  }
	| {
			type: "CONDITIONAL";
			conditionalBlocks: {
				condition?: z.infer<typeof VariableData>;
				actions: Action[];
			}[];
	  }
	| {
			type: "NODE";
			destinationId: string | null;
			navigation: (typeof NAVIGATIONS)[number];
			transition: Transition | null;
			preserveScrollPosition?: boolean;
			overlayRelativePosition?: { x: number; y: number };
			resetVideoPosition?: boolean;
			resetScrollPosition?: boolean;
			resetInteractiveComponents?: boolean;
	  };

const MEDIA_ACTIONS = [
	"PLAY",
	"PAUSE",
	"TOGGLE_PLAY_PAUSE",
	"MUTE",
	"UNMUTE",
	"TOGGLE_MUTE_UNMUTE",
	"SKIP_FORWARD",
	"SKIP_BACKWARD",
	"SKIP_TO",
] as const;

/**
 * What a reaction does, as in the Plugin API. NODE actions go to
 * `destinationId`: NAVIGATE, OVERLAY and SWAP (swap overlay) need a top-level
 * frame, CHANGE_TO a component variant, SCROLL_TO any layer.
 */
export const Action: z.ZodType<Action, unknown> = z.discriminatedUnion("type", [
	z.object({ type: z.enum(["BACK", "CLOSE"]) }),
	z.object({
		type: z.literal("URL"),
		url: z.string(),
		openInNewTab: z.boolean().optional(),
	}),
	z.object({
		type: z.literal("UPDATE_MEDIA_RUNTIME"),
		destinationId: z.string().nullable().optional(),
		mediaAction: z.enum(MEDIA_ACTIONS),
		// Seconds, for SKIP_FORWARD/SKIP_BACKWARD and SKIP_TO.
		amountToSkip: z.number().optional(),
		newTimestamp: z.number().optional(),
	}),
	z.object({
		type: z.literal("SET_VARIABLE"),
		variableId: z.string().nullable(),
		variableValue: VariableData.optional(),
	}),
	z.object({
		type: z.literal("SET_VARIABLE_MODE"),
		variableCollectionId: z.string().nullable(),
		variableModeId: z.string().nullable(),
	}),
	z.object({
		type: z.literal("CONDITIONAL"),
		conditionalBlocks: z.array(
			z.object({
				// The last block may have no condition: it's the "else".
				condition: VariableData.optional(),
				get actions() {
					return z.array(Action);
				},
			}),
		),
	}),
	z.object({
		type: z.literal("NODE"),
		destinationId: z.string().min(1).nullable(),
		navigation: z.enum(NAVIGATIONS),
		transition: Transition.nullable(),
		preserveScrollPosition: z.boolean().optional(),
		overlayRelativePosition: Vector.optional(),
		resetVideoPosition: z.boolean().optional(),
		resetScrollPosition: z.boolean().optional(),
		resetInteractiveComponents: z.boolean().optional(),
	}),
]);

/** A prototype interaction: a trigger and the actions it runs, in order. */
export const Reaction = z.object({
	trigger: Trigger.nullable(),
	actions: z.array(Action),
});
export type Reaction = z.infer<typeof Reaction>;

/** Which reactions `remove_reactions` removes; every given field must match. */
export const ReactionMatch = z.object({
	trigger: z.enum(TRIGGER_TYPES).optional(),
	// Matches when any action (conditional ones included) goes to this node.
	destinationId: z.string().min(1).optional(),
});
export type ReactionMatch = z.infer<typeof ReactionMatch>;

export function matchesReaction(
	reaction: Reaction,
	{ trigger, destinationId }: ReactionMatch,
): boolean {
	if (trigger && reaction.trigger?.type !== trigger) return false;
	if (
		destinationId &&
		!nodeActions(reaction.actions).some(
			(action) => action.destinationId === destinationId,
		)
	) {
		return false;
	}
	return true;
}

export type NodeAction = Extract<Action, { type: "NODE" }>;

/** Every NODE action, including those inside conditional blocks. */
export function nodeActions(actions: Action[]): NodeAction[] {
	return actions.flatMap((action) => {
		if (action.type === "NODE") return [action];
		if (action.type === "CONDITIONAL") {
			return action.conditionalBlocks.flatMap((block) =>
				nodeActions(block.actions),
			);
		}
		return [];
	});
}

/**
 * Why a NODE action can't go to `destination` (undefined when it can). A
 * top-level node is a direct child of a page.
 */
export function destinationError(
	{ destinationId, navigation }: NodeAction,
	destination: { type: string; topLevel: boolean } | undefined,
): BridgeError | undefined {
	if (destinationId === null) return undefined;
	const invalid = (message: string) => ({
		code: "invalid_destination",
		message,
	});
	if (!destination) {
		return invalid(
			`${navigation} destination "${destinationId}" doesn't exist in this file. Use a node ID from list_frames or get_node.`,
		);
	}
	const { type, topLevel } = destination;
	switch (navigation) {
		case "NAVIGATE":
		case "OVERLAY":
		case "SWAP":
			if (topLevel && (type === "FRAME" || type === "COMPONENT")) return;
			return invalid(
				`${navigation} needs a top-level frame as its destination, but ${destinationId} is a ${topLevel ? "top-level" : "nested"} ${type}. Use a frame from list_frames.`,
			);
		case "CHANGE_TO":
			if (type === "COMPONENT") return;
			return invalid(
				`CHANGE_TO needs a component variant as its destination, but ${destinationId} is a ${type}.`,
			);
		case "SCROLL_TO":
			if (type !== "PAGE" && type !== "DOCUMENT") return;
			return invalid(
				`SCROLL_TO needs a layer as its destination, but ${destinationId} is a ${type}.`,
			);
	}
}

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
	export_node_image: {
		params: z.object({
			nodeId: z.string().min(1),
			// Figma's own export UI offers 0.5x–4x.
			scale: z.number().positive().max(4),
		}),
		// PNG bytes, base64-encoded so they survive the JSON bridge.
		result: z.object({ png: z.base64() }),
	},
	create_nodes: {
		params: z.object({
			// Defaults to the current page.
			parentId: z.string().min(1).optional(),
			nodes: z.array(NodeSpec).min(1),
		}),
		result: z.object({ nodes: z.array(CreatedNode) }),
	},
	update_nodes: {
		params: z.object({ updates: z.array(NodeUpdate).min(1) }),
		result: z.object({ nodes: z.array(UpdatedNode) }),
	},
	get_reactions: {
		params: z.object({ nodeId: z.string().min(1) }),
		result: z.object({ nodeId: z.string(), reactions: z.array(Reaction) }),
	},
	set_reactions: {
		params: z.object({
			nodeId: z.string().min(1),
			reactions: z.array(Reaction),
			// replace swaps out every reaction; append adds after the existing ones.
			mode: z.enum(["replace", "append"]).default("replace"),
		}),
		result: z.object({ nodeId: z.string(), reactions: z.array(Reaction) }),
	},
	remove_reactions: {
		params: z.object({
			nodeId: z.string().min(1),
			// Without a match, every reaction is removed.
			match: ReactionMatch.optional(),
		}),
		result: z.object({
			nodeId: z.string(),
			removed: z.number().int(),
			reactions: z.array(Reaction),
		}),
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
