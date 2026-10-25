// The basic Screen Subset: which elements, attributes and CSS properties a
// Screen may use, how their values read, and their defaults. Every property
// has an exact Figma equivalent; see nodes.ts for the mapping.
import type { Tokens } from "./design-md";

/** What an element becomes in Figma: a frame, text, a rectangle or an image. */
export type Kind = "frame" | "text" | "rect" | "image";

export const TEXT_TAGS = new Set([
	"p",
	"span",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
]);

/** The tag Pull gives a new element of each kind. */
export const DEFAULT_TAGS: Record<Kind, string> = {
	frame: "div",
	text: "p",
	rect: "div",
	image: "img",
};

/** The layer name Figma gets for an element without `data-name`. */
export const DEFAULT_NAMES: Record<Exclude<Kind, "text">, string> = {
	frame: "Frame",
	rect: "Rectangle",
	image: "Image",
};

type ValueType =
	| "length"
	| "size"
	| "color"
	| "opacity"
	| "font-family"
	| "font-weight"
	| "radius"
	| { keywords: string[] };

type PropSpec = { kinds: Kind[]; type: ValueType; default?: string };

const LAYOUT: Kind[] = ["frame"];
const BOXES: Kind[] = ["frame", "rect", "image"];
const ALL: Kind[] = ["frame", "text", "rect", "image"];

/**
 * Longhand properties in the order Screens are printed. `display: flex` is
 * implied by the frame kind, so it isn't one of them.
 */
export const PROPS = {
	"flex-direction": {
		kinds: LAYOUT,
		type: { keywords: ["row", "column"] },
		default: "row",
	},
	"flex-wrap": {
		kinds: LAYOUT,
		type: { keywords: ["nowrap", "wrap"] },
		default: "nowrap",
	},
	"justify-content": {
		kinds: LAYOUT,
		type: { keywords: ["flex-start", "center", "flex-end", "space-between"] },
		default: "flex-start",
	},
	"align-items": {
		kinds: LAYOUT,
		type: { keywords: ["flex-start", "center", "flex-end"] },
		default: "flex-start",
	},
	gap: { kinds: LAYOUT, type: "length", default: "0" },
	"padding-top": { kinds: LAYOUT, type: "length", default: "0" },
	"padding-right": { kinds: LAYOUT, type: "length", default: "0" },
	"padding-bottom": { kinds: LAYOUT, type: "length", default: "0" },
	"padding-left": { kinds: LAYOUT, type: "length", default: "0" },
	width: { kinds: ALL, type: "size" },
	height: { kinds: BOXES, type: "size" },
	flex: { kinds: ALL, type: { keywords: ["1"] } },
	"align-self": { kinds: ALL, type: { keywords: ["stretch"] } },
	"background-color": {
		kinds: BOXES.filter((kind) => kind !== "image"),
		type: "color",
	},
	"border-radius": { kinds: BOXES, type: "radius", default: "0" },
	opacity: { kinds: ALL, type: "opacity", default: "1" },
	color: { kinds: ["text"], type: "color", default: "#000000" },
	"font-family": { kinds: ["text"], type: "font-family", default: "Inter" },
	"font-size": { kinds: ["text"], type: "size", default: "16" },
	"font-weight": { kinds: ["text"], type: "font-weight", default: "400" },
	"font-style": {
		kinds: ["text"],
		type: { keywords: ["normal", "italic"] },
		default: "normal",
	},
	"text-align": {
		kinds: ["text"],
		type: { keywords: ["left", "center", "right", "justify"] },
		default: "left",
	},
	"object-fit": {
		kinds: ["image"],
		type: { keywords: ["cover", "contain"] },
		default: "cover",
	},
} satisfies Record<string, PropSpec>;

export type Prop = keyof typeof PROPS;

export const PROP_NAMES = Object.keys(PROPS) as Prop[];

/** Shorthands Screens may write, and the longhands they set. */
export const SHORTHANDS: Record<string, Prop[]> = {
	padding: ["padding-top", "padding-right", "padding-bottom", "padding-left"],
	background: ["background-color"],
};

const VAR = /^var\((--[a-zA-Z0-9_-]+)\)$/;
const PX = /^(-?\d+(?:\.\d+)?)px$/;

export type ValueProblem = { rule: string; message: string };

/**
 * A property value with tokens resolved and units dropped, as Figma takes
 * it: lengths as numbers, colors as #rrggbb. A problem when it can't be.
 */
export function resolveValue(
	prop: Prop,
	raw: string,
	tokens: Tokens,
): { value: string } | ValueProblem {
	const value = resolveVariables(raw.trim(), tokens);
	if ("rule" in value) return value;
	const normalized = normalize(PROPS[prop].type, value.value);
	if (normalized === undefined) {
		return {
			rule: "invalid-value",
			message: `\`${prop}: ${raw}\` isn't in the Screen Subset: ${describe(PROPS[prop].type)}.`,
		};
	}
	return { value: normalized };
}

/** The resolved value of a property an element doesn't set. */
export function defaultValue(prop: Prop): string {
	return (PROPS[prop] as PropSpec).default ?? "";
}

function resolveVariables(
	raw: string,
	tokens: Tokens,
): { value: string } | ValueProblem {
	let unknown: string | undefined;
	const value = raw.replace(/var\((--[a-zA-Z0-9_-]+)\)/g, (_, name: string) => {
		const token = tokens.variables.get(name);
		if (token === undefined) unknown ??= name;
		return token ?? "";
	});
	if (unknown) {
		return {
			rule: "unknown-token",
			message: `\`var(${unknown})\` isn't a token in DESIGN.md. Tokens are named after their path, like --colors-primary, --spacing-md or --typography-body-md-font-size.`,
		};
	}
	return { value };
}

function normalize(type: ValueType, value: string): string | undefined {
	if (typeof type === "object") {
		return type.keywords.includes(value) ? value : undefined;
	}
	switch (type) {
		case "length": {
			const px = length(value);
			return px !== undefined && px >= 0 ? String(px) : undefined;
		}
		case "size": {
			const px = length(value);
			return px !== undefined && px > 0 ? String(px) : undefined;
		}
		case "radius": {
			const parts = value.split(/\s+/).map(length);
			if (parts.length > 4 || parts.some((p) => p === undefined || p < 0)) {
				return undefined;
			}
			const [a, b = a, c = a, d = b] = parts as number[];
			const corners = [a, b, c, d];
			return new Set(corners).size === 1 ? String(a) : corners.join(" ");
		}
		case "color":
			return hexColor(value);
		case "opacity": {
			const number = Number(value);
			return value !== "" && number >= 0 && number <= 1
				? String(number)
				: undefined;
		}
		case "font-family": {
			const first = value
				.split(",")[0]
				?.trim()
				.replace(/^(["'])(.*)\1$/, "$2");
			return first || undefined;
		}
		case "font-weight":
			return /^[1-9]00$/.test(value) ? value : undefined;
	}
}

/** Pixels from `12px` or `0`; rem counts as 16px, as browsers default. */
function length(value: string): number | undefined {
	if (value === "0") return 0;
	const px = PX.exec(value);
	if (px) return Number(px[1]);
	const rem = /^(-?\d+(?:\.\d+)?)rem$/.exec(value);
	if (rem) return Number(rem[1]) * 16;
	return undefined;
}

function hexColor(value: string): string | undefined {
	const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
	if (short) {
		const [, r, g, b] = short as unknown as string[];
		return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
	}
	return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : undefined;
}

function describe(type: ValueType): string {
	if (typeof type === "object") {
		return `use ${type.keywords.map((k) => `\`${k}\``).join(", ")}`;
	}
	return {
		length: "use a length in px (or 0), or a spacing token",
		size: "use a positive length in px, or a token",
		radius: "use one to four lengths in px, or a rounded token",
		color: "use a #rrggbb or #rgb color, or a colors token",
		opacity: "use a number from 0 to 1",
		"font-family": "use a font family name, or a typography token",
		"font-weight": "use 100, 200, … 900, or a typography token",
	}[type];
}

export function isVariable(raw: string): boolean {
	return VAR.test(raw.trim());
}

/** `--colors-primary` from a value that is just `var(--colors-primary)`. */
export function variableName(raw: string | undefined): string | undefined {
	return raw === undefined ? undefined : VAR.exec(raw.trim())?.[1];
}

/** Figma font style names by CSS weight. */
export const FONT_STYLES: Record<string, string> = {
	"100": "Thin",
	"200": "Extra Light",
	"300": "Light",
	"400": "Regular",
	"500": "Medium",
	"600": "Semi Bold",
	"700": "Bold",
	"800": "Extra Bold",
	"900": "Black",
};

/** `Bold Italic` from weight 700 and italic; `Italic` for 400 italic. */
export function fontStyle(weight: string, italic: boolean): string {
	const style = FONT_STYLES[weight] ?? "Regular";
	if (!italic) return style;
	return style === "Regular" ? "Italic" : `${style} Italic`;
}

/** Weight and italic from a Figma style name; undefined for others. */
export function parseFontStyle(
	style: string,
): { weight: string; italic: boolean } | undefined {
	if (style === "Italic") return { weight: "400", italic: true };
	const italic = style.endsWith(" Italic");
	const name = italic ? style.slice(0, -" Italic".length) : style;
	const weight = Object.entries(FONT_STYLES).find(([, n]) => n === name)?.[0];
	return weight ? { weight, italic } : undefined;
}
