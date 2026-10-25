// A Figma file designers made without the tool, for Adopt: variables in a
// collection with two modes, text styles, a component set of the file's own
// and a library component, and frames using them, linked into a prototype,
// with layers the Screen Subset can't express. No layer carries a key.
import {
	linkReaction,
	type Reaction,
	type SyncedNode,
	type TextStyleInfo,
	type VariableValue,
} from "@figma-agent-tool/protocol";

/** A component the file's frames have instances of, as read_components finds it. */
export type DesignerComponent = {
	componentId: string;
	name: string;
	key?: string;
	/** A library's, not the file's own. */
	remote: boolean;
	properties: Record<
		string,
		| { type: "VARIANT"; default: string; options: string[] }
		| { type: "TEXT"; default: string }
		| { type: "BOOLEAN"; default: string }
	>;
	variants?: string[];
};

const LIGHT = "70:2";
const DARK = "70:3";

const variable = (
	id: string,
	name: string,
	type: "COLOR" | "FLOAT",
	light: VariableValue,
	dark: VariableValue = light,
) => ({ id, name, type, value: light, modes: { [DARK]: dark } });

const ids = {
	primary: "71:1",
	surface: "71:2",
	text: "71:3",
	heading: "71:4",
	spaceMd: "71:5",
	radiusMd: "71:6",
	headingStyle: "S:72,1",
	bodyStyle: "S:72,2",
};

const button: DesignerComponent = {
	componentId: "73:1",
	name: "Button",
	key: "button-key",
	remote: false,
	properties: {
		kind: {
			type: "VARIANT",
			default: "primary",
			options: ["primary", "secondary"],
		},
		label: { type: "TEXT", default: "Button" },
	},
	variants: ["kind=primary", "kind=secondary"],
};

const avatar: DesignerComponent = {
	componentId: "74:1",
	name: "Avatar",
	key: "avatar-library-key",
	remote: true,
	properties: { initials: { type: "TEXT", default: "AB" } },
};

/** A layer as Figma reads it, with what every layer has filled in. */
function layer(
	fields: Partial<SyncedNode> & Pick<SyncedNode, "id" | "type" | "name">,
): SyncedNode {
	return {
		key: null,
		visible: true,
		x: 0,
		y: 0,
		width: 100,
		height: 100,
		rotation: 0,
		opacity: 1,
		fills: [],
		strokes: 0,
		effects: 0,
		cornerRadius: 0,
		...fields,
	};
}

const hug = { horizontal: "HUG", vertical: "HUG" } as const;

function text(
	id: string,
	characters: string,
	style: TextStyleInfo,
	color: { color: string; variable?: string },
	extra: Partial<SyncedNode> = {},
): SyncedNode {
	return layer({
		id,
		type: "TEXT",
		name: characters,
		sizing: hug,
		fills: [{ type: "SOLID", ...color }],
		text: {
			characters,
			fontName: { ...style.fontName },
			fontSize: style.fontSize,
			textAlignHorizontal: "LEFT",
		},
		bindings: { textStyle: style.id },
		...extra,
	});
}

function instance(
	id: string,
	component: DesignerComponent,
	properties: Record<string, string>,
	extra: Partial<SyncedNode> = {},
): SyncedNode {
	const values = Object.fromEntries(
		Object.entries(component.properties).map(([name, property]) => [
			name,
			properties[name] ?? property.default,
		]),
	);
	const variant = Object.entries(component.properties)
		.filter(([, property]) => property.type === "VARIANT")
		.map(([name]) => `${name}=${values[name]}`)
		.join(", ");
	return layer({
		id,
		type: "INSTANCE",
		name: component.name,
		sizing: hug,
		instance: {
			mainId: variant
				? `${component.componentId}/${variant}`
				: component.componentId,
			mainKey: component.key ?? null,
			...(variant && {
				setId: component.componentId,
				setKey: component.key ?? null,
			}),
			properties: values,
		},
		...extra,
	});
}

const headingStyle: TextStyleInfo = {
	id: ids.headingStyle,
	name: "Heading/Large",
	fontName: { family: "Inter", style: "Bold" },
	fontSize: 28,
};

const bodyStyle: TextStyleInfo = {
	id: ids.bodyStyle,
	name: "Body",
	fontName: { family: "Inter", style: "Regular" },
	fontSize: 16,
	lineHeight: { value: 150, unit: "PERCENT" },
};

const HOME = "75:1";
const DETAILS = "76:1";

const hover: Reaction = {
	trigger: { type: "ON_HOVER" },
	actions: [
		{
			type: "NODE",
			destinationId: DETAILS,
			navigation: "OVERLAY",
			transition: null,
		},
	],
};

const surface = { color: "#ffffff", variable: ids.surface };

const home = layer({
	id: HOME,
	type: "FRAME",
	name: "Home",
	width: 393,
	height: 852,
	sizing: { horizontal: "FIXED", vertical: "FIXED" },
	clips: true,
	fills: [{ type: "SOLID", ...surface }],
	layout: {
		mode: "VERTICAL",
		itemSpacing: 16,
		padding: { top: 24, right: 16, bottom: 24, left: 16 },
		primaryAxisAlignItems: "MIN",
		counterAxisAlignItems: "MIN",
		wrap: false,
	},
	bindings: {
		itemSpacing: ids.spaceMd,
		paddingRight: ids.spaceMd,
		paddingLeft: ids.spaceMd,
	},
	children: [
		layer({
			id: "75:2",
			type: "RECTANGLE",
			name: "Logo",
			width: 48,
			height: 48,
			sizing: { horizontal: "FIXED", vertical: "FIXED" },
			fills: [{ type: "IMAGE", imageHash: "designer-logo", scaleMode: "FILL" }],
		}),
		text("75:3", "Good morning", headingStyle, {
			color: "#3366ff",
			variable: ids.heading,
		}),
		text("75:4", "Three things are due today.", bodyStyle, {
			color: "#111111",
			variable: ids.text,
		}),
		layer({
			id: "75:5",
			type: "FRAME",
			name: "Card",
			height: 120,
			sizing: { horizontal: "FILL", vertical: "FIXED" },
			clips: false,
			cornerRadius: 8,
			effects: 1,
			fills: [{ type: "SOLID", color: "#ffffff" }],
			layout: {
				mode: "VERTICAL",
				itemSpacing: 0,
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				primaryAxisAlignItems: "MIN",
				counterAxisAlignItems: "MIN",
				wrap: false,
			},
			children: [],
		}),
		layer({
			id: "75:6",
			type: "FRAME",
			name: "Actions",
			sizing: { horizontal: "FILL", vertical: "HUG" },
			clips: false,
			fills: [],
			layout: {
				mode: "HORIZONTAL",
				itemSpacing: 16,
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				primaryAxisAlignItems: "SPACE_BETWEEN",
				counterAxisAlignItems: "CENTER",
				wrap: false,
			},
			bindings: { itemSpacing: ids.spaceMd },
			children: [
				instance(
					"75:7",
					button,
					{ label: "See all" },
					{ reactions: [linkReaction(DETAILS, null), hover] },
				),
				instance("75:8", avatar, { initials: "JD" }),
			],
		}),
	],
});

const details = layer({
	id: DETAILS,
	type: "FRAME",
	name: "Task Details",
	width: 393,
	height: 852,
	sizing: { horizontal: "FIXED", vertical: "FIXED" },
	clips: true,
	fills: [{ type: "SOLID", ...surface }],
	layout: {
		mode: "VERTICAL",
		itemSpacing: 8,
		padding: { top: 24, right: 24, bottom: 24, left: 24 },
		primaryAxisAlignItems: "MIN",
		counterAxisAlignItems: "MIN",
		wrap: false,
	},
	children: [
		layer({
			id: "76:2",
			type: "RECTANGLE",
			name: "Back",
			width: 24,
			height: 24,
			sizing: { horizontal: "FIXED", vertical: "FIXED" },
			cornerRadius: 8,
			fills: [{ type: "SOLID", color: "#3366ff", variable: ids.primary }],
			bindings: { cornerRadius: ids.radiusMd },
			reactions: [
				linkReaction(HOME, {
					type: "DISSOLVE",
					duration: 0.2,
					easing: { type: "EASE_IN_AND_OUT" },
				}),
			],
		}),
		instance("76:3", button, { kind: "secondary" }),
	],
});

/** A frame without auto layout: no Screen can be it. */
const sketch = layer({
	id: "77:1",
	type: "FRAME",
	name: "Sketch",
	width: 800,
	height: 600,
	sizing: { horizontal: "FIXED", vertical: "FIXED" },
	clips: true,
	fills: [{ type: "SOLID", color: "#ffffff" }],
	layout: {
		mode: "NONE",
		itemSpacing: 0,
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		primaryAxisAlignItems: "MIN",
		counterAxisAlignItems: "MIN",
		wrap: false,
	},
	children: [],
});

export const designerFile = {
	page: { id: "70:9", name: "Designs" },
	frames: [home, details, sketch],
	/** Bytes (base64) of the images the frames use, by hash. */
	images: {
		"designer-logo":
			"iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAEklEQVR4nGMwTvv/HxkzoAsAAFR1FLllEk5AAAAAAElFTkSuQmCC",
	},
	collection: {
		id: "70:1",
		name: "Brand",
		modes: [
			{ id: LIGHT, name: "Light" },
			{ id: DARK, name: "Dark" },
		],
	},
	variables: [
		variable(
			ids.primary,
			"Color/Primary",
			"COLOR",
			{ color: "#3366ff" },
			{ color: "#6699ff" },
		),
		variable(
			ids.surface,
			"Color/Surface",
			"COLOR",
			{ color: "#ffffff" },
			{ color: "#111111" },
		),
		variable(
			ids.text,
			"Color/Text",
			"COLOR",
			{ color: "#111111" },
			{ color: "#eeeeee" },
		),
		variable(
			ids.heading,
			"Color/Heading",
			"COLOR",
			{ alias: ids.primary },
			{ alias: ids.primary },
		),
		variable(ids.spaceMd, "Space/MD", "FLOAT", 16),
		variable(ids.radiusMd, "Radius/MD", "FLOAT", 8),
	],
	textStyles: [headingStyle, bodyStyle],
	components: [button, avatar],
};

export type DesignerFile = typeof designerFile;
