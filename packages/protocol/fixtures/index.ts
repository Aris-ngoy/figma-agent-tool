// Shared protocol fixtures. The fake plugin (MCP server tests) and the real
// plugin's command handler (plugin tests) replay these same messages, so the
// two can't drift apart.
import type {
	Action,
	AppliedAnimationStyle,
	AvailableAnimationStyle,
	DesignSystem,
	FlowNode,
	FlowStart,
	Handshake,
	KeyframeField,
	KeyframeTrack,
	NodeAction,
	Reaction,
	Request,
	Response,
	SerializedNode,
	Transition,
} from "../src";
import {
	animationStyleNotFoundError,
	keyframeFieldKey,
	layerError,
	notAGroupError,
	PROTOCOL_VERSION,
	parentError,
} from "../src";

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

/** A top-level screen on the Onboarding page, laid out left to right. */
function onboardingScreen(
	id: string,
	name: string,
	column: number,
	children: SerializedNode[],
	height = 852,
) {
	return {
		id,
		name,
		type: "FRAME",
		x: column * 493,
		y: 0,
		width: 393,
		height,
		fills: [{ type: "SOLID", color: "#ffffff" }],
		children,
	} satisfies SerializedNode;
}

/** A tappable layer inside an onboarding screen. */
function tappable(id: string, name: string, y: number): SerializedNode {
	return { id, name, type: "RECTANGLE", x: 24, y, width: 345, height: 48 };
}

/**
 * The Onboarding page: a multi-screen prototype with a cycle (Done restarts at
 * Welcome), an overlay that swaps to a second overlay, scroll-to, back, close
 * and URL actions, broken links, and an Orphan screen nothing leads to.
 */
const onboardingScreens = [
	onboardingScreen("4:1", "Welcome", 0, [
		tappable("4:2", "Get started", 700),
		{
			id: "4:3",
			name: "Headline",
			type: "TEXT",
			x: 24,
			y: 120,
			width: 345,
			height: 34,
			fills: [{ type: "SOLID", color: "#111111" }],
			text: {
				characters: "Hello",
				fontName: { family: "Inter", style: "Bold" },
				fontSize: 28,
			},
			styles: { fill: "S:text-primary,", text: "S:heading," },
		},
		{
			id: "4:4",
			name: "Step chip",
			type: "INSTANCE",
			x: 24,
			y: 180,
			width: 120,
			height: 32,
			cornerRadius: 16,
			fills: [{ type: "SOLID", color: "#3366ff", variable: "VariableID:1:1" }],
			instance: {
				mainComponent: { id: "3:3", name: "Size=Large" },
				properties: { Size: "Large" },
			},
			variables: { paddingLeft: "VariableID:2:4" },
		},
		{
			id: "4:5",
			name: "Hidden hint",
			type: "TEXT",
			visible: false,
			x: 24,
			y: 230,
			width: 345,
			height: 20,
			text: {
				characters: "Psst",
				fontName: { family: "Inter", style: "Regular" },
				fontSize: 16,
			},
			styles: { text: "S:body," },
		},
	]),
	onboardingScreen("4:10", "Permissions", 1, [
		tappable("4:11", "Allow", 640),
		tappable("4:12", "Learn more", 700),
		tappable("4:13", "Privacy policy", 760),
	]),
	onboardingScreen("4:20", "Done", 2, [
		tappable("4:21", "Start over", 640),
		tappable("4:22", "Broken", 700),
		tappable("4:23", "Unwired", 760),
	]),
	onboardingScreen(
		"4:30",
		"Info sheet",
		3,
		[
			tappable("4:31", "Close", 24),
			tappable("4:32", "Next tip", 96),
			tappable("4:33", "Jump to footer", 168),
			tappable("4:34", "Footer", 352),
		],
		400,
	),
	onboardingScreen(
		"4:40",
		"Second tip",
		4,
		[tappable("4:41", "Got it", 24)],
		400,
	),
	onboardingScreen("4:50", "Orphan", 5, [tappable("4:51", "Back home", 700)]),
];

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

function onClick(action: Action): Reaction {
	return { trigger: { type: "ON_CLICK" }, actions: [action] };
}

function navigate(
	destinationId: string | null,
	navigation: NodeAction["navigation"],
	transition: Transition | null,
): NodeAction {
	return { type: "NODE", destinationId, navigation, transition };
}

const push = {
	type: "PUSH",
	direction: "LEFT",
	matchLayers: false,
	easing: { type: "EASE_IN_AND_OUT" },
	duration: 0.3,
} satisfies Transition;

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
	// Onboarding: Welcome pushes to Permissions.
	"4:2": [onClick(navigate("4:10", "NAVIGATE", push))],
	// Permissions: swipe back, allow, open the info sheet, read the policy.
	"4:10": [{ trigger: { type: "ON_DRAG" }, actions: [{ type: "BACK" }] }],
	"4:11": [
		onClick(
			navigate("4:20", "NAVIGATE", {
				type: "DISSOLVE",
				easing: { type: "EASE_OUT" },
				duration: 0.2,
			}),
		),
	],
	"4:12": [
		onClick({
			...navigate("4:30", "OVERLAY", {
				type: "MOVE_IN",
				direction: "BOTTOM",
				matchLayers: false,
				easing: { type: "EASE_OUT" },
				duration: 0.3,
			}),
			overlayRelativePosition: { x: 0, y: 452 },
		}),
	],
	"4:13": [onClick({ type: "URL", url: "https://example.com/privacy" })],
	// Done: start over (a cycle), a deleted destination, a screen on another
	// page, and a reaction whose destination was never set.
	"4:21": [onClick(navigate("4:1", "NAVIGATE", null))],
	"4:22": [
		onClick(navigate("4:99", "NAVIGATE", null)),
		{
			trigger: { type: "ON_HOVER" },
			actions: [navigate("1:1", "NAVIGATE", null)],
		},
	],
	"4:23": [onClick(navigate(null, "NAVIGATE", null))],
	// Info sheet: close, swap to the second tip, scroll to the footer, and a
	// NAVIGATE to a nested layer, which Figma can't follow.
	"4:31": [onClick({ type: "CLOSE" })],
	"4:32": [
		onClick(
			navigate("4:40", "SWAP", {
				type: "SMART_ANIMATE",
				easing: { type: "GENTLE" },
				duration: 0.5,
			}),
		),
	],
	"4:33": [
		onClick(navigate("4:34", "SCROLL_TO", null)),
		{
			trigger: { type: "ON_PRESS" },
			actions: [navigate("4:34", "NAVIGATE", null)],
		},
	],
	"4:41": [onClick({ type: "CLOSE" })],
	"4:51": [onClick(navigate("4:1", "NAVIGATE", null))],
};

/** ID Figma gives the `n`th animation style applied to a node (in the fakes). */
export function appliedStyleId(nodeId: string, n: number): string {
	return `${nodeId}/style-${n}`;
}

/** ID of a node's manual keyframe track on `field`, unless one is given. */
export function keyframeTrackId(nodeId: string, field: KeyframeField): string {
	return `${nodeId}/track-${keyframeFieldKey(field)}`;
}

/** ID of a track's `index`th keyframe, unless one is given. */
export function keyframeId(trackId: string, index: number): string {
	return `${trackId}/kf-${index}`;
}

/** ID of the Motion timeline of a top-level frame. */
export function timelineId(frameId: string): string {
	return `Timeline:${frameId}`;
}

const fadeIn = {
	type: "FIGMA",
	styleId: "motion:fade-in",
	name: "Fade in",
	description: "Fades the layer in from transparent.",
	props: { from: "number, 0–1 (default 0)" },
} satisfies AvailableAnimationStyle;

const translationY = { type: "PROPERTY", name: "TRANSLATION_Y" } as const;
const firstFill = {
	type: "INDEXED_ITEM",
	collection: "fills",
	index: 0,
} as const;

/** Motion animations in the document: styles on offer, timelines, per node. */
const motion = {
	// Figma's presets, then the file's local custom animation styles.
	styles: [
		fadeIn,
		{
			type: "FIGMA",
			styleId: "motion:slide-in",
			name: "Slide in",
			props: {
				direction: "'left' | 'right' | 'up' | 'down' (default 'right')",
				distance: "number (default 100)",
			},
		},
		{
			type: "CUSTOM",
			styleId: "S:card-enter,",
			name: "Card enter",
			description: "Fade, then slide up.",
		},
	] as AvailableAnimationStyle[],
	// Timeline duration of each top-level frame that has a timeline.
	timelines: { "1:1": 2, "1:10": 1.5 } as Record<string, number>,
	nodes: {
		// Login's button fades in, rises and shifts color.
		"1:3": {
			animationStyles: [
				{
					type: "FIGMA",
					id: appliedStyleId("1:3", 1),
					styleId: fadeIn.styleId,
					name: fadeIn.name,
					description: fadeIn.description,
					duration: 0.3,
					timelineOffset: 0,
					props: { from: 0 },
				},
			],
			keyframeTracks: [
				{
					field: translationY,
					id: keyframeTrackId("1:3", translationY),
					baseValue: { type: "FLOAT", value: 0 },
					keyframes: [
						{
							id: keyframeId(keyframeTrackId("1:3", translationY), 0),
							timelinePosition: 0,
							easing: { type: "EASE_OUT" },
							value: { type: "FLOAT", value: 24 },
						},
						{
							id: keyframeId(keyframeTrackId("1:3", translationY), 1),
							timelinePosition: 0.4,
							easing: {
								type: "CUSTOM_SPRING",
								easingFunctionSpring: { bounce: 0.2 },
							},
							value: { type: "FLOAT", value: 0 },
						},
					],
				},
				{
					field: firstFill,
					id: keyframeTrackId("1:3", firstFill),
					baseValue: { type: "COLOR", value: { r: 0.2, g: 0.4, b: 1, a: 1 } },
					keyframes: [
						{
							id: keyframeId(keyframeTrackId("1:3", firstFill), 0),
							timelinePosition: 0.4,
							easing: { type: "HOLD" },
							value: { type: "COLOR", value: { r: 0, g: 0, b: 0, a: 1 } },
						},
						{
							id: keyframeId(keyframeTrackId("1:3", firstFill), 1),
							timelinePosition: 1,
							easing: {
								type: "CUSTOM_CUBIC_BEZIER",
								easingFunctionCubicBezier: { x1: 0.4, y1: 0, x2: 0.2, y2: 1 },
							},
							value: { type: "COLOR", value: { r: 0.2, g: 0.4, b: 1, a: 1 } },
						},
					],
				},
			],
		},
		// The title enters with the custom style, a little later.
		"1:2": {
			animationStyles: [
				{
					type: "CUSTOM",
					id: appliedStyleId("1:2", 1),
					styleId: "S:card-enter,",
					name: "Card enter",
					timelineOffset: 0.2,
				},
			],
			keyframeTracks: [],
		},
	} as Record<
		string,
		{
			animationStyles: AppliedAnimationStyle[];
			keyframeTracks: KeyframeTrack[];
		}
	>,
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
			// Prototype flow starting points, as Figma's prototype viewer lists them.
			flows: [{ nodeId: "1:1", name: "Sign in" }],
		},
		{
			id: "0:2",
			name: "Components",
			children: [buttonComponent, chipSet] as SerializedNode[],
			flows: [] as { nodeId: string; name: string }[],
		},
		{
			id: "0:3",
			name: "Onboarding",
			children: onboardingScreens as SerializedNode[],
			flows: [{ nodeId: "4:1", name: "Onboarding" }],
		},
	],
	reactions,
	motion,
	styles: styles as DesignSystem["styles"],
	collections: collections as DesignSystem["collections"],
};
export type DocumentFixture = typeof document;

/**
 * Nodes whose reactions go to a deleted node or a nested layer. set_reactions
 * rejects those, so they can't be written back as they are.
 */
export const brokenReactionNodeIds = ["4:22", "4:33"];

/** Every node in the document, pages included, keyed by ID. */
export function findNode(
	id: string,
	doc: DocumentFixture = document,
): SerializedNode | undefined {
	const pages = doc.pages.map(({ flows: _, ...page }) => ({
		...page,
		type: "PAGE",
	}));
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
	capabilities: { motion: true },
} satisfies Handshake;

/** A plugin in a Figma version without the Motion API. */
export const noMotionHandshake = {
	...handshake,
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
			{ id: "0:3", name: "Onboarding", current: false },
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

/**
 * Copies a subtree with fresh IDs, in pre-order, as the fakes duplicate
 * nodes: `nextId` gives each copied node its ID.
 */
export function renumber(
	node: SerializedNode,
	nextId: () => string,
): SerializedNode {
	const id = nextId();
	return {
		...structuredClone(node),
		id,
		children: node.children?.map((child) => renumber(child, nextId)),
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
	id: "req-15",
	command: "get_design_system",
	params: {},
} satisfies Request;

export const getDesignSystemResponse = {
	type: "response",
	id: "req-15",
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
	id: "req-16",
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
	id: "req-16",
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

export const listFlowsRequest = {
	type: "request",
	id: "req-17",
	command: "list_flows",
	params: {},
} satisfies Request;

const screensPage = { id: "0:1", name: "Screens" };
const onboardingPage = { id: "0:3", name: "Onboarding" };

export const listFlowsResponse = {
	type: "response",
	id: "req-17",
	ok: true,
	result: {
		flows: [
			{ nodeId: "1:1", name: "Sign in", page: screensPage },
			{ nodeId: "4:1", name: "Onboarding", page: onboardingPage },
		] satisfies FlowStart[],
	},
} satisfies Response;

/** Starts a new flow at Home, after the page's existing Sign in flow. */
export const setFlowStartRequest = {
	type: "request",
	id: "req-18",
	command: "set_flow_start",
	params: { nodeId: "1:10", name: "Returning user" },
} satisfies Request;

export const setFlowStartResponse = {
	type: "response",
	id: "req-18",
	ok: true,
	result: {
		flow: { nodeId: "1:10", name: "Returning user", page: screensPage },
		created: true,
	},
} satisfies Response;

/** Flows start at top-level frames; a nested layer fails. */
export const setNestedFlowStartRequest = {
	type: "request",
	id: "req-19",
	command: "set_flow_start",
	params: { nodeId: "1:3", name: "Button flow" },
} satisfies Request;

export const setNestedFlowStartResponse = {
	type: "response",
	id: "req-19",
	ok: false,
	error: {
		code: "invalid_flow_start",
		message:
			"A flow starts at a top-level frame, but 1:3 is a nested INSTANCE. Use a frame from list_frames.",
	},
} satisfies Response;

const reactionsOn = (nodeId: string, nodeName: string) => ({
	nodeId,
	nodeName,
	reactions: reactions[nodeId] as Reaction[],
});

/** A screen with its layers' reactions, a nested layer, and a missing node. */
export const getFlowNodesRequest = {
	type: "request",
	id: "req-20",
	command: "get_flow_nodes",
	params: { nodeIds: ["4:10", "4:34", "9:99"] },
} satisfies Request;

export const getFlowNodesResponse = {
	type: "response",
	id: "req-20",
	ok: true,
	result: {
		nodes: [
			{
				id: "4:10",
				name: "Permissions",
				type: "FRAME",
				page: onboardingPage,
				topLevel: true,
				width: 393,
				height: 852,
				reactions: [
					reactionsOn("4:10", "Permissions"),
					reactionsOn("4:11", "Allow"),
					reactionsOn("4:12", "Learn more"),
					reactionsOn("4:13", "Privacy policy"),
				],
			},
			{
				id: "4:34",
				name: "Footer",
				type: "RECTANGLE",
				page: onboardingPage,
				topLevel: false,
				width: 345,
				height: 48,
				reactions: [],
			},
		] satisfies FlowNode[],
		missing: ["9:99"],
	},
} satisfies Response;

/** Deletes the divider; a missing node and a page fail alone. */
export const deleteNodesRequest = {
	type: "request",
	id: "req-21",
	command: "delete_nodes",
	params: { ids: ["1:5", "9:99", "0:2"] },
} satisfies Request;

export const deleteNodesResponse = {
	type: "response",
	id: "req-21",
	ok: true,
	result: {
		nodes: [
			{ id: "1:5", ok: true },
			{ id: "9:99", ok: false, error: nodeNotFoundResponse("", "9:99").error },
			{
				id: "0:2",
				ok: false,
				error: layerError({ id: "0:2", type: "PAGE", parent: null }, "delete"),
			},
		],
	},
} satisfies Response;

/** Two more sign-in buttons, right after the first. */
export const duplicateNodeRequest = {
	type: "request",
	id: "req-22",
	command: "duplicate_node",
	params: { id: "1:3", count: 2 },
} satisfies Request;

export const duplicateNodeResponse = {
	type: "response",
	id: "req-22",
	ok: true,
	result: {
		// Each copy's label takes the ID after the copy's own.
		nodes: [
			{ id: createdNodeId(1), name: "Button", type: "INSTANCE" },
			{ id: createdNodeId(3), name: "Button", type: "INSTANCE" },
		],
	},
} satisfies Response;

/** Moves the note and the Home frame into Login's auto-layout, below the title. */
export const reparentNodesRequest = {
	type: "request",
	id: "req-23",
	command: "reparent_nodes",
	params: { parentId: "1:1", ids: ["1:20", "1:10"], index: 1 },
} satisfies Request;

export const reparentNodesResponse = {
	type: "response",
	id: "req-23",
	ok: true,
	result: {
		nodes: [
			{ id: "1:20", ok: true },
			{ id: "1:10", ok: true },
		],
	},
} satisfies Response;

/** A text node can't hold children, so nothing moves. */
export const reparentIntoTextRequest = {
	type: "request",
	id: "req-24",
	command: "reparent_nodes",
	params: { parentId: "1:2", ids: ["1:5"] },
} satisfies Request;

export const reparentIntoTextResponse = {
	type: "response",
	id: "req-24",
	ok: false,
	error: parentError({ id: "1:2", type: "TEXT", parent: null }, false) as {
		code: string;
		message: string;
	},
} satisfies Response;

/** Groups the divider and the title; the group takes the divider's place. */
export const groupNodesRequest = {
	type: "request",
	id: "req-25",
	command: "group_nodes",
	params: { ids: ["1:5", "1:2"], name: "Header" },
} satisfies Request;

export const groupNodesResponse = {
	type: "response",
	id: "req-25",
	ok: true,
	result: { node: { id: createdNodeId(1), name: "Header", type: "GROUP" } },
} satisfies Response;

/** Only groups ungroup; a frame fails alone. */
export const ungroupFrameRequest = {
	type: "request",
	id: "req-26",
	command: "ungroup_nodes",
	params: { ids: ["1:1"] },
} satisfies Request;

export const ungroupFrameResponse = {
	type: "response",
	id: "req-26",
	ok: true,
	result: {
		nodes: [
			{
				id: "1:1",
				ok: false,
				error: notAGroupError({ id: "1:1", type: "FRAME", parent: null }),
			},
		],
	},
} satisfies Response;

export const getMotionRequest = {
	type: "request",
	id: "req-27",
	command: "get_motion",
	params: { nodeId: "1:3", availableStyles: true },
} satisfies Request;

export const getMotionResponse = {
	type: "response",
	id: "req-27",
	ok: true,
	result: {
		nodeId: "1:3",
		timelines: [{ id: timelineId("1:1"), duration: 2 }],
		...motion.nodes["1:3"],
		availableStyles: motion.styles,
	},
} satisfies Response;

const opacity = { type: "PROPERTY", name: "OPACITY" } as const;
const fadeInKeyframes = [
	{
		timelinePosition: 0,
		easing: { type: "EASE_IN_AND_OUT" },
		value: { type: "FLOAT", value: 0 },
	},
	{
		timelinePosition: 0.4,
		easing: { type: "EASE_IN_AND_OUT" },
		value: { type: "FLOAT", value: 1 },
	},
] as const;

/** Home's tab bar slides up and fades in over a shorter timeline. */
export const setMotionRequest = {
	type: "request",
	id: "req-28",
	command: "set_motion",
	params: {
		nodeId: "1:10",
		mode: "replace",
		animationStyles: [
			{
				type: "FIGMA",
				styleId: "motion:slide-in",
				duration: 0.4,
				props: { direction: "up", distance: 40 },
			},
		],
		keyframeTracks: [
			{
				field: opacity,
				keyframes: fadeInKeyframes,
			},
		],
		timelineDuration: 1.2,
	},
} satisfies Request;

export const setMotionResponse = {
	type: "response",
	id: "req-28",
	ok: true,
	result: {
		nodeId: "1:10",
		timelines: [{ id: timelineId("1:10"), duration: 1.2 }],
		animationStyles: [
			{
				type: "FIGMA",
				id: appliedStyleId("1:10", 1),
				styleId: "motion:slide-in",
				name: "Slide in",
				duration: 0.4,
				props: { direction: "up", distance: 40 },
			},
		],
		keyframeTracks: [
			{
				field: opacity,
				id: keyframeTrackId("1:10", opacity),
				keyframes: fadeInKeyframes.map((keyframe, index) => ({
					id: keyframeId(keyframeTrackId("1:10", opacity), index),
					...keyframe,
				})),
			},
		],
	},
} satisfies Response;

/** An unknown animation style fails the call, and nothing is written. */
export const setUnknownMotionStyleRequest = {
	type: "request",
	id: "req-29",
	command: "set_motion",
	params: {
		nodeId: "1:3",
		mode: "replace",
		animationStyles: [{ type: "FIGMA", styleId: "motion:wobble" }],
	},
} satisfies Request;

export const setUnknownMotionStyleResponse = {
	type: "response",
	id: "req-29",
	ok: false,
	error: animationStyleNotFoundError("FIGMA", "motion:wobble"),
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
	[getDesignSystemRequest, getDesignSystemResponse],
	[bindNodesRequest, bindNodesResponse],
	[listFlowsRequest, listFlowsResponse],
	[setFlowStartRequest, setFlowStartResponse],
	[setNestedFlowStartRequest, setNestedFlowStartResponse],
	[getFlowNodesRequest, getFlowNodesResponse],
	[deleteNodesRequest, deleteNodesResponse],
	[duplicateNodeRequest, duplicateNodeResponse],
	[reparentNodesRequest, reparentNodesResponse],
	[reparentIntoTextRequest, reparentIntoTextResponse],
	[groupNodesRequest, groupNodesResponse],
	[ungroupFrameRequest, ungroupFrameResponse],
	[getMotionRequest, getMotionResponse],
	[setMotionRequest, setMotionResponse],
	[setUnknownMotionStyleRequest, setUnknownMotionStyleResponse],
];
