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
	// ID of the COLOR variable the color is bound to.
	variable: z.string().optional(),
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

/**
 * The paints agents can write: the read shape, minus video/pattern/shader.
 * A solid bound to a `variable` takes its color from it, so needs no `color`.
 */
export const PaintInput = z.discriminatedUnion("type", [
	SolidPaint.extend({ color: HexColor.optional() }).refine(
		(paint) => paint.color !== undefined || paint.variable !== undefined,
		"A SOLID paint needs a `color` or a COLOR `variable`.",
	),
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

export const ComponentPropertyDefinition = z.object({
	type: z.enum(["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT", "SLOT"]),
	defaultValue: z.union([z.string(), z.boolean()]),
	variantOptions: z.array(z.string()).optional(),
});

export const ComponentInfo = z.object({
	key: z.string(),
	description: z.string().optional(),
	// Property definitions of a component set or a standalone component.
	properties: z.record(z.string(), ComponentPropertyDefinition).optional(),
	// A variant's values, for a component inside a component set.
	variantProperties: z.record(z.string(), z.string()).optional(),
});
export type ComponentInfo = z.infer<typeof ComponentInfo>;

export const InstanceInfo = z.object({
	mainComponent: z.object({ id: z.string(), name: z.string() }).nullable(),
	properties: z.record(z.string(), z.union([z.string(), z.boolean()])),
});

/**
 * Node fields that can be bound to a variable, named as in the Plugin API.
 * Paint colors are bound per paint instead, through a SOLID paint's
 * `variable`.
 */
export const BINDABLE_FIELDS = {
	width: "FLOAT",
	height: "FLOAT",
	itemSpacing: "FLOAT",
	counterAxisSpacing: "FLOAT",
	paddingTop: "FLOAT",
	paddingRight: "FLOAT",
	paddingBottom: "FLOAT",
	paddingLeft: "FLOAT",
	topLeftRadius: "FLOAT",
	topRightRadius: "FLOAT",
	bottomRightRadius: "FLOAT",
	bottomLeftRadius: "FLOAT",
	strokeWeight: "FLOAT",
	opacity: "FLOAT",
	visible: "BOOLEAN",
	characters: "STRING",
} as const;

/** Text fields that can be bound to a variable, on TEXT nodes only. */
export const BINDABLE_TEXT_FIELDS = {
	fontFamily: "STRING",
	fontStyle: "STRING",
	fontWeight: "FLOAT",
	fontSize: "FLOAT",
	lineHeight: "FLOAT",
	letterSpacing: "FLOAT",
	paragraphSpacing: "FLOAT",
	paragraphIndent: "FLOAT",
} as const;

/** The variable type each bindable field takes. */
export const BINDABLE_FIELD_TYPES = {
	...BINDABLE_FIELDS,
	...BINDABLE_TEXT_FIELDS,
};

export type BindableField = keyof typeof BINDABLE_FIELD_TYPES;

export const BindableField = z.enum(
	Object.keys(BINDABLE_FIELD_TYPES) as [BindableField, ...BindableField[]],
);

/** The style slots a node can use, and the style type each takes. */
export const STYLE_SLOTS = {
	fill: "PAINT",
	stroke: "PAINT",
	text: "TEXT",
	effect: "EFFECT",
} as const;
export type StyleSlot = keyof typeof STYLE_SLOTS;

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
	// Field → ID of the variable bound to it ("mixed" across text ranges).
	variables: z.partialRecord(BindableField, z.string()).optional(),
	// Slot → ID of the style applied ("mixed" across text ranges).
	styles: z
		.object({
			fill: z.string(),
			stroke: z.string(),
			text: z.string(),
			effect: z.string(),
		})
		.partial()
		.optional(),
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

/** A variable value: aliases point at another variable by ID. */
export const VariableValue = z.union([
	z.boolean(),
	z.number(),
	z.string(),
	z.object({ color: HexColor, opacity: z.number().optional() }),
	z.object({ alias: z.string() }),
]);
export type VariableValue = z.infer<typeof VariableValue>;

export const VariableInfo = z.object({
	id: z.string(),
	name: z.string(),
	type: z.enum(["BOOLEAN", "COLOR", "FLOAT", "STRING", "EASING", "TIMING"]),
	description: z.string().optional(),
	// Where Figma offers the variable; left out when it's ALL_SCOPES.
	scopes: z.array(z.string()).optional(),
	// Mode name → value; null for values this protocol can't represent.
	valuesByMode: z.record(z.string(), VariableValue.nullable()),
});
export type VariableInfo = z.infer<typeof VariableInfo>;

export const VariableCollectionInfo = z.object({
	id: z.string(),
	name: z.string(),
	modes: z.array(z.object({ id: z.string(), name: z.string() })),
	defaultMode: z.string(),
	variables: z.array(VariableInfo),
});
export type VariableCollectionInfo = z.infer<typeof VariableCollectionInfo>;

const styleBase = {
	id: z.string(),
	name: z.string(),
	description: z.string().optional(),
};

export const PaintStyleInfo = z.object({
	...styleBase,
	paints: z.array(Paint),
});
export type PaintStyleInfo = z.infer<typeof PaintStyleInfo>;

const TypeUnit = z.enum(["PIXELS", "PERCENT"]);

export const TextStyleInfo = z.object({
	...styleBase,
	fontName: FontName,
	fontSize: z.number(),
	// Left out when AUTO.
	lineHeight: z.object({ value: z.number(), unit: TypeUnit }).optional(),
	// Left out when 0.
	letterSpacing: z.object({ value: z.number(), unit: TypeUnit }).optional(),
});
export type TextStyleInfo = z.infer<typeof TextStyleInfo>;

const effectExtras = { visible: z.literal(false).optional() };

/** A compact Figma Effect: shadows with hex colors, blurs by radius. */
export const Effect = z.union([
	z.object({
		type: z.enum(["DROP_SHADOW", "INNER_SHADOW"]),
		color: HexColor,
		opacity: z.number().optional(),
		offset: z.object({ x: z.number(), y: z.number() }),
		radius: z.number(),
		spread: z.number().optional(),
		...effectExtras,
	}),
	z.object({
		type: z.enum(["LAYER_BLUR", "BACKGROUND_BLUR"]),
		radius: z.number(),
		...effectExtras,
	}),
	z.object({ type: z.string(), ...effectExtras }),
]);
export type Effect = z.infer<typeof Effect>;

export const EffectStyleInfo = z.object({
	...styleBase,
	effects: z.array(Effect),
});
export type EffectStyleInfo = z.infer<typeof EffectStyleInfo>;

/** A local component or component set, with its variants. */
export const DesignComponent = z.object({
	id: z.string(),
	name: z.string(),
	type: z.enum(["COMPONENT", "COMPONENT_SET"]),
	key: z.string(),
	description: z.string().optional(),
	page: PageRef,
	properties: z.record(z.string(), ComponentPropertyDefinition).optional(),
	variants: z
		.array(
			z.object({
				id: z.string(),
				name: z.string(),
				properties: z.record(z.string(), z.string()),
			}),
		)
		.optional(),
});
export type DesignComponent = z.infer<typeof DesignComponent>;

export const DesignSystem = z.object({
	components: z.array(DesignComponent),
	styles: z.object({
		paint: z.array(PaintStyleInfo),
		text: z.array(TextStyleInfo),
		effect: z.array(EffectStyleInfo),
	}),
	collections: z.array(VariableCollectionInfo),
});
export type DesignSystem = z.infer<typeof DesignSystem>;

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
	// Binds fields to variables by ID; null unbinds, keeping the value.
	variables: z.partialRecord(BindableField, z.string().nullable()).optional(),
	// Applies styles by ID; null detaches, keeping the look.
	styles: z
		.object({
			fill: z.string().nullable(),
			stroke: z.string().nullable(),
			text: z.string().nullable(),
			effect: z.string().nullable(),
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

/** Per-node outcome of `delete_nodes` and `reparent_nodes`, in input order. */
export const NodeOutcome = UpdatedNode;
export type NodeOutcome = UpdatedNode;

/** Per-group outcome of `ungroup_nodes`: the former children, now in the group's parent. */
export const UngroupedNode = z.discriminatedUnion("ok", [
	z.object({
		id: z.string(),
		ok: z.literal(true),
		children: z.array(z.string()),
	}),
	z.object({ id: z.string(), ok: z.literal(false), error: BridgeError }),
]);
export type UngroupedNode = z.infer<typeof UngroupedNode>;

const NodeRef = z.object({
	id: z.string(),
	name: z.string(),
	type: z.string(),
});

/**
 * Where moved or duplicated nodes go among the parent's children: 0 is the
 * bottom of the layer list (first in auto-layout), the child count the top.
 * It's the first node's position once placed; the others follow it in order.
 */
export const ChildIndex = z.number().int().min(0);

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

/** A variable value or expression, passed through as Figma reports it. */
const VariableData = z.object({
	type: z.string().optional(),
	resolvedType: z.string().optional(),
	value: z.unknown().optional(),
});

// Written out because Action is recursive (CONDITIONAL blocks hold actions),
// so zod can't infer it.
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

/** A prototype flow starting point, as Figma's prototype viewer lists it. */
export const FlowStart = z.object({
	nodeId: z.string(),
	name: z.string(),
	page: PageRef,
});
export type FlowStart = z.infer<typeof FlowStart>;

/**
 * Why `set_flow_start` can't start a flow at `node` (undefined when it can):
 * flows start at a top-level frame, like NAVIGATE destinations.
 */
export function flowStartError(
	nodeId: string,
	node: { type: string; topLevel: boolean } | undefined,
): BridgeError | undefined {
	if (node?.topLevel && (node.type === "FRAME" || node.type === "COMPONENT")) {
		return undefined;
	}
	return {
		code: "invalid_flow_start",
		message: node
			? `A flow starts at a top-level frame, but ${nodeId} is a ${node.topLevel ? "top-level" : "nested"} ${node.type}. Use a frame from list_frames.`
			: `No node with ID "${nodeId}" exists in this file. Use a frame from list_frames.`,
	};
}

/**
 * A node as `trace_flow` sees it, with the raw reactions of every layer in
 * its subtree (itself included) that has any.
 */
export const FlowNode = z.object({
	id: z.string(),
	name: z.string(),
	type: z.string(),
	// Null for the document itself.
	page: PageRef.nullable(),
	// A direct child of a page.
	topLevel: z.boolean(),
	width: z.number().optional(),
	height: z.number().optional(),
	reactions: z.array(
		z.object({
			nodeId: z.string(),
			nodeName: z.string(),
			reactions: z.array(Reaction),
		}),
	),
});
export type FlowNode = z.infer<typeof FlowNode>;

/** Interactions the prototype graph records, by NODE navigation or action type. */
export const EDGE_ACTIONS = [...NAVIGATIONS, "BACK", "CLOSE", "URL"] as const;

/** Navigations that present another screen, which the trace then walks. */
export const SCREEN_NAVIGATIONS = ["NAVIGATE", "OVERLAY", "SWAP"] as const;

/** A screen reached from the flow's start, `depth` interactions away. */
export const FlowScreen = z.object({
	id: z.string(),
	name: z.string(),
	type: z.string(),
	width: z.number().optional(),
	height: z.number().optional(),
	depth: z.number().int(),
});
export type FlowScreen = z.infer<typeof FlowScreen>;

/**
 * One interaction: on `trigger`, layer `nodeId` of screen `from` does `action`
 * to `to` (a screen, a layer for SCROLL_TO, a variant for CHANGE_TO; null for
 * BACK, CLOSE and URL).
 */
export const FlowEdge = z.object({
	from: z.string(),
	nodeId: z.string(),
	nodeName: z.string(),
	trigger: Trigger.nullable(),
	action: z.enum(EDGE_ACTIONS),
	to: z.string().nullable(),
	transition: Transition.nullable(),
	// Runs only when a conditional block's condition holds.
	conditional: z.literal(true).optional(),
	url: z.string().optional(),
	openInNewTab: z.boolean().optional(),
	preserveScrollPosition: z.boolean().optional(),
	overlayRelativePosition: Vector.optional(),
	resetVideoPosition: z.boolean().optional(),
	resetScrollPosition: z.boolean().optional(),
	resetInteractiveComponents: z.boolean().optional(),
});
export type FlowEdge = z.infer<typeof FlowEdge>;

/**
 * An interaction that goes nowhere: no destination set, a deleted one, one
 * the navigation can't use, or a screen on another page.
 */
export const DanglingEdge = FlowEdge.extend({
	reason: z.enum(["no_destination", "missing", "invalid", "other_page"]),
	message: z.string(),
});
export type DanglingEdge = z.infer<typeof DanglingEdge>;

/** Every screen reachable from `start`, and the interactions between them. */
export const PrototypeGraph = z.object({
	start: z.string(),
	page: PageRef,
	screens: z.array(FlowScreen),
	edges: z.array(FlowEdge),
	dangling: z.array(DanglingEdge),
	// Set when `maxDepth` stopped the walk before every screen was expanded.
	truncated: z.literal(true).optional(),
});
export type PrototypeGraph = z.infer<typeof PrototypeGraph>;

// Motion: Figma's beta keyframe animation API. Shapes mirror the Plugin API's
// (colors as 0–1 RGBA, times in seconds); it may change, so the Motion
// commands sit behind the `motion` capability.

/** Why Motion commands fail when the Figma version has no Motion API. */
export function motionUnsupportedError(): BridgeError {
	return {
		code: "motion_unsupported",
		message:
			"Motion animations are not supported in this Figma version: the " +
			"connected plugin found no Motion API. Update Figma, or animate with " +
			"prototype reactions instead: set_reactions with a transition " +
			"(SMART_ANIMATE, DISSOLVE, MOVE_IN, PUSH, SLIDE_IN, …), easing and duration.",
	};
}

const VariableAlias = z.object({
	type: z.literal("VARIABLE_ALIAS"),
	id: z.string().min(1),
});

const Seconds = z.number().min(0);

const RGBA = z.object({
	r: z.number().min(0).max(1),
	g: z.number().min(0).max(1),
	b: z.number().min(0).max(1),
	a: z.number().min(0).max(1),
});

/** A Motion easing: Transition's presets plus HOLD; springs take a 0–1 `bounce`. */
export const MotionEasing = z.object({
	type: z.enum([
		"EASE_IN",
		"EASE_OUT",
		"EASE_IN_AND_OUT",
		"LINEAR",
		"EASE_IN_BACK",
		"EASE_OUT_BACK",
		"EASE_IN_AND_OUT_BACK",
		"CUSTOM_CUBIC_BEZIER",
		"GENTLE",
		"QUICK",
		"BOUNCY",
		"SLOW",
		"CUSTOM_SPRING",
		"HOLD",
	]),
	easingFunctionCubicBezier: z
		.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() })
		.optional(),
	easingFunctionSpring: z
		.object({ bounce: z.number().min(0).max(1) })
		.optional(),
});
export type MotionEasing = z.infer<typeof MotionEasing>;

const Point = { x: z.number(), y: z.number() };

/** A keyframe's value, typed like the property it animates. */
export const KeyframeValue = z.discriminatedUnion("type", [
	z.object({ type: z.literal("FLOAT"), value: z.number() }),
	z.object({ type: z.literal("COLOR"), value: RGBA }),
	z.object({ type: z.literal("TEXT_DATA"), value: z.string() }),
	z.object({ type: z.literal("VECTOR"), value: z.object(Point) }),
	z.object({ type: z.literal("BOOL"), value: z.boolean() }),
	z.object({
		type: z.literal("CIRCLE"),
		value: z.object({ ...Point, radius: z.number() }),
	}),
	z.object({
		type: z.literal("LINE"),
		value: z.object({ ...Point, x2: z.number(), y2: z.number() }),
	}),
	z.object({
		type: z.literal("CIRCLE_POINT"),
		value: z.object({ ...Point, radius: z.number(), angle: z.number() }),
	}),
	z.object({
		type: z.literal("COLOR_POINT"),
		value: z.object({ ...Point, color: RGBA }),
	}),
]);
export type KeyframeValue = z.infer<typeof KeyframeValue>;

export const KEYFRAME_PROPERTIES = [
	"CORNER_RADIUS",
	"STROKE_WEIGHT",
	"STACK_SPACING",
	"STACK_PADDING_LEFT",
	"STACK_PADDING_TOP",
	"STACK_PADDING_RIGHT",
	"STACK_PADDING_BOTTOM",
	"WIDTH",
	"HEIGHT",
	"RECTANGLE_TOP_LEFT_CORNER_RADIUS",
	"RECTANGLE_TOP_RIGHT_CORNER_RADIUS",
	"RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS",
	"RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS",
	"BORDER_TOP_WEIGHT",
	"BORDER_BOTTOM_WEIGHT",
	"BORDER_LEFT_WEIGHT",
	"BORDER_RIGHT_WEIGHT",
	"STACK_COUNTER_SPACING",
	"OPACITY",
	"GRID_ROW_GAP",
	"GRID_COLUMN_GAP",
	"TRANSLATION_X",
	"TRANSLATION_Y",
	"TRANSLATION_XY",
	"ROTATION",
	"SCALE_X",
	"SCALE_Y",
	"SCALE_XY",
	"PATH_TRIM_START",
	"PATH_TRIM_END",
] as const;

export const EFFECT_KEYFRAME_FIELDS = [
	"OFFSET_X",
	"OFFSET_Y",
	"RADIUS",
	"SPREAD",
	"COLOR",
	"REFRACTION_RADIUS",
	"SPECULAR_ANGLE",
	"SPECULAR_INTENSITY",
	"CHROMATIC_ABERRATION",
	"SPLAY",
	"REFRACTION_INTENSITY",
	"START_RADIUS",
	"NOISE_SIZE_X",
	"NOISE_SIZE_Y",
	"DENSITY",
	"EFFECT_OPACITY",
	"SECONDARY_COLOR",
] as const;

/**
 * What a keyframe track animates: a node PROPERTY, or a paint (fills,
 * strokes) or effect by index. An effect track names its `field`; a
 * `propertyId` targets a shader or component property of the paint/effect.
 */
export const KeyframeField = z
	.discriminatedUnion("type", [
		z.object({
			type: z.literal("PROPERTY"),
			name: z.enum(KEYFRAME_PROPERTIES),
		}),
		z.object({
			type: z.literal("INDEXED_ITEM"),
			collection: z.enum(["fills", "strokes", "effects"]),
			index: z.number().int().min(0),
			field: z.enum(EFFECT_KEYFRAME_FIELDS).optional(),
			propertyId: z.string().min(1).optional(),
		}),
	])
	.refine(
		(field) =>
			field.type === "PROPERTY" ||
			(field.collection === "effects"
				? (field.field === undefined) !== (field.propertyId === undefined)
				: field.field === undefined),
		"An effects track needs exactly one of `field` or `propertyId`; fills and strokes tracks take no `field`.",
	);
export type KeyframeField = z.infer<typeof KeyframeField>;

/** A stable key for a field, e.g. `OPACITY`, `fills.0` or `effects.1.RADIUS`. */
export function keyframeFieldKey(field: KeyframeField): string {
	if (field.type === "PROPERTY") return field.name;
	const sub = field.field ?? field.propertyId;
	return [field.collection, field.index, ...(sub ? [sub] : [])].join(".");
}

const FIELD_ORDER = ["PROPERTY", "fills", "strokes", "effects"];

/**
 * Keyframe tracks in a fixed order (properties as listed in
 * KEYFRAME_PROPERTIES, then fills, strokes and effects by index), so reads
 * are deterministic.
 */
export function compareKeyframeTracks(
	{ field: a }: { field: KeyframeField },
	{ field: b }: { field: KeyframeField },
): number {
	const group = (field: KeyframeField) =>
		FIELD_ORDER.indexOf(
			field.type === "PROPERTY" ? field.type : field.collection,
		);
	if (group(a) !== group(b)) return group(a) - group(b);
	if (a.type === "PROPERTY" && b.type === "PROPERTY") {
		return (
			KEYFRAME_PROPERTIES.indexOf(a.name) - KEYFRAME_PROPERTIES.indexOf(b.name)
		);
	}
	if (a.type === "INDEXED_ITEM" && b.type === "INDEXED_ITEM") {
		if (a.index !== b.index) return a.index - b.index;
	}
	return keyframeFieldKey(a).localeCompare(keyframeFieldKey(b));
}

/** A keyframe; `easing` shapes the curve from the previous keyframe. */
export const Keyframe = z.object({
	id: z.string().min(1).optional(),
	timelinePosition: Seconds,
	easing: z.union([MotionEasing, VariableAlias]).optional(),
	value: KeyframeValue,
});
export type Keyframe = z.infer<typeof Keyframe>;

/**
 * A manual keyframe track on one field. `baseValue` is the value outside the
 * keyframes. Read tracks carry IDs; written ones may keep or omit them.
 */
export const KeyframeTrack = z.object({
	field: KeyframeField,
	id: z.string().min(1).optional(),
	baseValue: KeyframeValue.optional(),
	keyframes: z.array(Keyframe),
});
export type KeyframeTrack = z.infer<typeof KeyframeTrack>;

const AnimationStylePropValue = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	MotionEasing,
	VariableAlias,
]);

/**
 * An animation style applied to a node: a Figma preset (with its `duration`
 * and configured `props`) or a CUSTOM style made of presets. `id` identifies
 * this application; `styleId` the style.
 */
export const AppliedAnimationStyle = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("FIGMA"),
		id: z.string(),
		styleId: z.string(),
		name: z.string(),
		description: z.string().optional(),
		duration: Seconds.optional(),
		timelineOffset: Seconds.optional(),
		props: z.record(z.string(), AnimationStylePropValue).optional(),
	}),
	z.object({
		type: z.literal("CUSTOM"),
		id: z.string(),
		styleId: z.string(),
		name: z.string(),
		timelineOffset: Seconds.optional(),
	}),
]);
export type AppliedAnimationStyle = z.infer<typeof AppliedAnimationStyle>;

/** An animation style to apply; applied styles read back can be passed as-is. */
export const AnimationStyleInput = z
	.object({
		type: z.enum(["FIGMA", "CUSTOM"]).default("FIGMA"),
		styleId: z.string().min(1),
		duration: Seconds.optional(),
		timelineOffset: Seconds.optional(),
		props: z.record(z.string(), AnimationStylePropValue).optional(),
	})
	.refine(
		(style) =>
			style.type === "FIGMA" ||
			(style.duration === undefined && style.props === undefined),
		"A CUSTOM animation style takes only a `timelineOffset`.",
	);
export type AnimationStyleInput = z.infer<typeof AnimationStyleInput>;

/**
 * An animation style the file offers: a Figma preset, whose `props` describe
 * each configurable property's type and default, or a local CUSTOM style.
 */
export const AvailableAnimationStyle = z.object({
	type: z.enum(["FIGMA", "CUSTOM"]),
	styleId: z.string(),
	name: z.string(),
	description: z.string().optional(),
	props: z.record(z.string(), z.string()).optional(),
});
export type AvailableAnimationStyle = z.infer<typeof AvailableAnimationStyle>;

/** A Motion timeline; for now Figma gives each top-level frame one. */
export const MotionTimeline = z.object({
	id: z.string(),
	duration: z.number().positive(),
});

/** A node's Motion animations: applied styles and manual keyframe tracks. */
export const NodeMotion = z.object({
	nodeId: z.string(),
	// The timelines containing the node (its top-level frame's).
	timelines: z.array(MotionTimeline),
	animationStyles: z.array(AppliedAnimationStyle),
	keyframeTracks: z.array(KeyframeTrack),
});
export type NodeMotion = z.infer<typeof NodeMotion>;

/** The error for a node that can't carry Motion animations (pages). */
export function noMotionError(id: string, type: string): BridgeError {
	return {
		code: "no_motion",
		message: `Node ${id} is a ${type}, which can't be animated. Use a frame or another layer on the canvas.`,
	};
}

export function animationStyleNotFoundError(
	type: "FIGMA" | "CUSTOM",
	styleId: string,
): BridgeError {
	return {
		code: "animation_style_not_found",
		message: `No ${type} animation style with ID "${styleId}" exists in this file. List them with get_motion and \`availableStyles: true\`.`,
	};
}

/**
 * Why a keyframe track can't animate `field` on a node with these many fills,
 * strokes and effects (undefined when it can).
 */
export function keyframeFieldError(
	nodeId: string,
	field: KeyframeField,
	counts: Record<"fills" | "strokes" | "effects", number>,
): BridgeError | undefined {
	if (field.type === "PROPERTY") return undefined;
	const count = counts[field.collection];
	if (field.index < count) return undefined;
	return {
		code: "invalid_keyframe_field",
		message: `Node ${nodeId} has ${count} ${field.collection}, so there's no ${field.collection}[${field.index}] to animate.`,
	};
}

export function noTimelineError(nodeId: string): BridgeError {
	return {
		code: "no_timeline",
		message: `Node ${nodeId} isn't in a frame with a Motion timeline, so there's no timeline duration to set. Animate the node first.`,
	};
}

/** A node and its ancestors, as the restructuring checks need them. */
export type TreeNode = {
	id: string;
	type: string;
	readonly parent: TreeNode | null;
};

function insideInstance(node: TreeNode): boolean {
	for (let up = node.parent; up; up = up.parent) {
		if (up.type === "INSTANCE") return true;
	}
	return false;
}

const RESTRUCTURE_ACTIONS = {
	delete: { code: "cannot_delete", done: "deleted" },
	duplicate: { code: "cannot_duplicate", done: "duplicated" },
	move: { code: "cannot_move", done: "moved" },
	group: { code: "cannot_group", done: "grouped" },
} as const;

/** Why `node` can't be deleted, duplicated, moved or grouped, if it can't. */
export function layerError(
	node: TreeNode,
	action: keyof typeof RESTRUCTURE_ACTIONS,
): BridgeError | undefined {
	const { code, done } = RESTRUCTURE_ACTIONS[action];
	if (node.type === "PAGE" || node.type === "DOCUMENT") {
		return {
			code,
			message: `Node ${node.id} is a ${node.type}; only layers on a page can be ${done}. Use a frame, group or other layer.`,
		};
	}
	if (insideInstance(node)) {
		return {
			code,
			message: `Node ${node.id} is inside an instance, whose layers can't be ${done}. Change the main component instead.`,
		};
	}
	return undefined;
}

/** Why `parent` can't take new children (undefined when it can). */
export function parentError(
	parent: TreeNode,
	holdsChildren: boolean,
): BridgeError | undefined {
	if (!holdsChildren || parent.type === "DOCUMENT") {
		return {
			code: "invalid_parent",
			message: `Node ${parent.id} is a ${parent.type}, which can't hold children. Use a page, frame, group, section or component.`,
		};
	}
	if (parent.type === "INSTANCE" || insideInstance(parent)) {
		return {
			code: "invalid_parent",
			message: `Node ${parent.id} is ${parent.type === "INSTANCE" ? "an instance" : "inside an instance"}, whose layers can't change. Use a frame, or the main component.`,
		};
	}
	return undefined;
}

/** Why `node` can't move into `parent`, checked with `parentError` first. */
export function moveError(
	node: TreeNode,
	parent: TreeNode,
): BridgeError | undefined {
	const error = layerError(node, "move");
	if (error) return error;
	for (let up: TreeNode | null = parent; up; up = up.parent) {
		if (up.id === node.id) {
			return {
				code: "cannot_move",
				message:
					up === parent
						? `Node ${node.id} can't move into itself.`
						: `Node ${node.id} contains ${parent.id}, so it can't move into it.`,
			};
		}
	}
	return undefined;
}

/** Why `index` doesn't fit a parent with `count` children. */
export function indexError(
	index: number | undefined,
	parent: TreeNode,
	count: number,
): BridgeError | undefined {
	if (index === undefined || index <= count) return undefined;
	return {
		code: "invalid_index",
		message: `Index ${index} is out of range: ${parent.id} has ${count} children, so use 0 to ${count}.`,
	};
}

export function notAGroupError(node: TreeNode): BridgeError {
	return {
		code: "not_a_group",
		message: `Node ${node.id} is a ${node.type}, not a GROUP; only groups can be ungrouped.`,
	};
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
	delete_nodes: {
		params: z.object({ ids: z.array(z.string().min(1)).min(1) }),
		result: z.object({ nodes: z.array(NodeOutcome) }),
	},
	duplicate_node: {
		params: z.object({
			id: z.string().min(1),
			count: z.number().int().min(1).max(100).default(1),
			// Defaults to the original's parent, right after the original.
			parentId: z.string().min(1).optional(),
			index: ChildIndex.optional(),
		}),
		result: z.object({ nodes: z.array(NodeRef) }),
	},
	reparent_nodes: {
		params: z.object({
			parentId: z.string().min(1),
			ids: z.array(z.string().min(1)).min(1),
			// Defaults to the top (the end, in auto-layout).
			index: ChildIndex.optional(),
		}),
		result: z.object({ nodes: z.array(NodeOutcome) }),
	},
	group_nodes: {
		params: z.object({
			ids: z.array(z.string().min(1)).min(1),
			name: z.string().optional(),
		}),
		result: z.object({ node: NodeRef }),
	},
	ungroup_nodes: {
		params: z.object({ ids: z.array(z.string().min(1)).min(1) }),
		result: z.object({ nodes: z.array(UngroupedNode) }),
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
	get_design_system: {
		params: z.object({}),
		result: DesignSystem,
	},
	list_flows: {
		// Every page's flows when no page is given.
		params: z.object({ pageId: z.string().min(1).optional() }),
		result: z.object({ flows: z.array(FlowStart) }),
	},
	set_flow_start: {
		params: z.object({
			nodeId: z.string().min(1),
			name: z.string().min(1),
		}),
		// `created` is false when the frame already started a flow (renamed).
		result: z.object({ flow: FlowStart, created: z.boolean() }),
	},
	get_flow_nodes: {
		params: z.object({ nodeIds: z.array(z.string().min(1)).min(1) }),
		// Requested IDs with no node are listed in `missing`.
		result: z.object({
			nodes: z.array(FlowNode),
			missing: z.array(z.string()),
		}),
	},
	// Motion commands need the `motion` capability.
	get_motion: {
		params: z.object({
			nodeId: z.string().min(1),
			// Also list the animation styles the file offers.
			availableStyles: z.boolean().default(false),
		}),
		result: NodeMotion.extend({
			availableStyles: z.array(AvailableAnimationStyle).optional(),
		}),
	},
	set_motion: {
		params: z.object({
			nodeId: z.string().min(1),
			// replace: the given lists replace the node's styles / manual tracks;
			// append: styles are added, tracks replace only their own field's.
			// An omitted list leaves that part untouched.
			mode: z.enum(["replace", "append"]).default("replace"),
			animationStyles: z.array(AnimationStyleInput).optional(),
			keyframeTracks: z
				.array(KeyframeTrack)
				.refine(
					(tracks) =>
						new Set(tracks.map((t) => keyframeFieldKey(t.field))).size ===
						tracks.length,
					"Give each field at most one keyframe track.",
				)
				.optional(),
			// Duration of the timeline containing the node (its top-level frame's).
			timelineDuration: z.number().positive().optional(),
		}),
		result: NodeMotion,
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
