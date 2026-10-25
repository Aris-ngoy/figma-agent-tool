// The Design System in Figma: DESIGN.md's colors, spacing and rounded
// tokens as variables in one collection, its typography as text styles.
// Push sends them with the Screens, whose elements bind to them where they
// use a token's CSS variable; Pull reads them back and merges Figma's
// changes into DESIGN.md against its Baseline, editing only the values that
// changed so the file stays as written (and spec-pure).
import type {
	DesignSystemPush,
	ScreenBindings,
	SyncedDesignSystem,
} from "@figma-agent-tool/protocol";
import { isMap, isScalar, parseDocument, Scalar, type YAMLMap } from "yaml";
import {
	cssVariable,
	FRONT_MATTER,
	parseDesignMd,
	referencePath,
	resolveField,
	resolveTokens,
	type TokenFields,
	type Tokens,
} from "./design-md";
import { CONFLICT_END, CONFLICT_SEPARATOR, CONFLICT_START } from "./print";
import type { Element } from "./screen";
import { fontStyle, parseFontStyle, variableName } from "./subset";

/** DESIGN.md as of the last Push or Pull, and the variables and styles its tokens went to. */
export type DesignSystemBaseline = {
	source: string;
	collectionId: string;
	/** Token path → variable ID. */
	variables: Record<string, string>;
	/** Typography token path → text style ID. */
	textStyles: Record<string, string>;
};

/** The variable collection Push keeps the Design System's tokens in. */
export const DESIGN_SYSTEM_COLLECTION = "Design System";

/** Typography fields a text style holds; the others (fontFeature, …) stay in DESIGN.md. */
const TYPOGRAPHY_FIELDS = [
	"fontFamily",
	"fontSize",
	"fontWeight",
	"lineHeight",
	"letterSpacing",
] as const;

/** What a Screen gets for a typography field DESIGN.md leaves out, as in the Screen Subset. */
const TYPOGRAPHY_DEFAULTS: Record<string, string> = {
	fontFamily: "Inter",
	fontSize: "16px",
	fontWeight: "400",
};

const VARIABLE_GROUPS = {
	colors: "COLOR",
	spacing: "FLOAT",
	rounded: "FLOAT",
} as const;

type VariableGroup = keyof typeof VARIABLE_GROUPS;

/** A token DESIGN.md has that Figma can't hold, and why. */
export type DesignSystemWarning = { path: string; message: string };

/** What the token paths name: variables and text styles. */
function tokenPaths(fields: TokenFields) {
	const variables: string[] = [];
	const textStyles = new Set<string>();
	for (const path of fields.keys()) {
		const [group, name] = path.split(".") as [string, string];
		if (group in VARIABLE_GROUPS) variables.push(path);
		else if (group === "typography") textStyles.add(`${group}.${name}`);
	}
	return { variables, textStyles: [...textStyles] };
}

const groupOf = (path: string) => path.split(".")[0] as string;

/** The Design System as Push sends it, updating what the Baseline says it made. */
export function designSystemPush(
	fields: TokenFields,
	baseline?: DesignSystemBaseline,
): { push: DesignSystemPush; warnings: DesignSystemWarning[] } {
	const warnings: DesignSystemWarning[] = [];
	const paths = tokenPaths(fields);
	const variables: DesignSystemPush["variables"] = [];
	for (const path of paths.variables) {
		const type = VARIABLE_GROUPS[groupOf(path) as VariableGroup];
		const value = variableValue(type, resolveField(path, fields));
		if (value === undefined) {
			const expected =
				type === "COLOR"
					? "#rgb, #rrggbb or #rrggbbaa colors"
					: "px or rem lengths";
			warnings.push({
				path,
				message: `${path} (${fields.get(path)}) isn't pushed to Figma: variables take ${expected}, or a reference to one.`,
			});
			continue;
		}
		const reference = referencePath(fields.get(path) as string);
		const aliased =
			reference !== undefined &&
			groupOf(reference) in VARIABLE_GROUPS &&
			VARIABLE_GROUPS[groupOf(reference) as VariableGroup] === type;
		variables.push({
			token: path,
			...(baseline?.variables[path] && { id: baseline.variables[path] }),
			name: path.replace(".", "/"),
			type,
			value: aliased ? { token: reference } : value,
		});
	}
	const textStyles: DesignSystemPush["textStyles"] = [];
	for (const token of paths.textStyles) {
		const style = textStyle(token, fields, warnings);
		if (!style) continue;
		textStyles.push({
			token,
			...(baseline?.textStyles[token] && { id: baseline.textStyles[token] }),
			...style,
		});
	}
	const pushed = (list: { token: string }[]) =>
		new Set(list.map((entry) => entry.token));
	const [keptVariables, keptStyles] = [pushed(variables), pushed(textStyles)];
	return {
		push: {
			collection: {
				...(baseline?.collectionId && { id: baseline.collectionId }),
				name: DESIGN_SYSTEM_COLLECTION,
			},
			variables,
			textStyles,
			remove: {
				variables: Object.entries(baseline?.variables ?? {})
					.filter(([token]) => !keptVariables.has(token))
					.map(([, id]) => id),
				textStyles: Object.entries(baseline?.textStyles ?? {})
					.filter(([token]) => !keptStyles.has(token))
					.map(([, id]) => id),
			},
		},
		warnings,
	};
}

/** A token's resolved value as a variable of this type takes it; undefined if it can't. */
function variableValue(
	type: "COLOR" | "FLOAT",
	literal: string | undefined,
): { color: string; opacity?: number } | number | undefined {
	if (literal === undefined) return undefined;
	return type === "COLOR" ? colorValue(literal) : pixels(literal);
}

function textStyle(
	token: string,
	fields: TokenFields,
	warnings: DesignSystemWarning[],
): Omit<DesignSystemPush["textStyles"][number], "token" | "id"> | undefined {
	const field = (name: string) =>
		resolveField(`${token}.${name}`, fields) ?? TYPOGRAPHY_DEFAULTS[name];
	const warn = (name: string, expected: string) =>
		warnings.push({
			path: `${token}.${name}`,
			message: `${token}.${name} (${fields.get(`${token}.${name}`)}) isn't pushed to Figma: text styles take ${expected}.`,
		});
	const fontSize = pixels(field("fontSize") as string);
	const weight = String(Number(field("fontWeight")));
	if (fontSize === undefined || !(fontSize > 0)) {
		warn("fontSize", "a positive size in px or rem");
		return undefined;
	}
	if (!/^[1-9]00$/.test(weight)) {
		warn("fontWeight", "a weight of 100, 200, … 900");
		return undefined;
	}
	const style: ReturnType<typeof textStyle> = {
		name: token.slice("typography.".length),
		fontName: {
			family: field("fontFamily") as string,
			style: fontStyle(weight, false),
		},
		fontSize,
	};
	const lineHeight = field("lineHeight");
	if (lineHeight !== undefined) {
		const value = typeValue(lineHeight, "multiplier");
		if (value) style.lineHeight = value;
		else warn("lineHeight", "a length in px or rem, or a multiplier");
	}
	const letterSpacing = field("letterSpacing");
	if (letterSpacing !== undefined) {
		const value = typeValue(letterSpacing, "em");
		if (value) style.letterSpacing = value;
		else warn("letterSpacing", "a length in px, rem or em");
	}
	return style;
}

/** A line height or letter spacing as Figma takes it: px, or a percentage of the font size. */
function typeValue(
	raw: string,
	relative: "multiplier" | "em",
): { value: number; unit: "PIXELS" | "PERCENT" } | undefined {
	const px = pixels(raw);
	if (px !== undefined) return { value: px, unit: "PIXELS" };
	const pattern = relative === "em" ? /^(-?\d*\.?\d+)em$/ : /^(\d*\.?\d+)$/;
	const match = pattern.exec(raw.trim());
	return match
		? { value: round(Number(match[1]) * 100), unit: "PERCENT" }
		: undefined;
}

/** Pixels from `12px`, `1.5rem` (16px each) or `0`. */
function pixels(raw: string): number | undefined {
	const value = raw.trim();
	if (value === "0") return 0;
	const match = /^(-?\d*\.?\d+)(px|rem)$/.exec(value);
	if (!match) return undefined;
	return round(Number(match[1]) * (match[2] === "rem" ? 16 : 1));
}

function colorValue(
	raw: string,
): { color: string; opacity?: number } | undefined {
	const hex = normalizeHex(raw);
	if (!hex) return undefined;
	const alpha = hex.length === 9 ? Number.parseInt(hex.slice(7), 16) / 255 : 1;
	return alpha === 1
		? { color: hex.slice(0, 7) }
		: { color: hex.slice(0, 7), opacity: round(alpha) };
}

/** `#rgb`, `#rrggbb` or `#rrggbbaa` as lowercase `#rrggbb[aa]`, opaque alpha dropped. */
function normalizeHex(raw: string): string | undefined {
	const value = raw.trim().toLowerCase();
	const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value);
	if (short) {
		const [, r, g, b] = short as unknown as string[];
		return `#${r}${r}${g}${g}${b}${b}`;
	}
	if (/^#[0-9a-f]{6}$/.test(value)) return value;
	if (/^#[0-9a-f]{8}$/.test(value))
		return value.endsWith("ff") ? value.slice(0, 7) : value;
	return undefined;
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

/** Which CSS variables Screens bind with: those of pushed variables and text styles. */
export type TokenBindings = {
	/** CSS variable → token path of a pushed variable. */
	variables: Map<string, string>;
	/** CSS variable of a text style's font size → the style. */
	textStyles: Map<string, { token: string; family: string; weight: string }>;
};

export function tokenBindings(push: DesignSystemPush): TokenBindings {
	return {
		variables: new Map(
			push.variables.map(({ token }) => [cssVariable(token), token]),
		),
		textStyles: new Map(
			push.textStyles.map(({ token, fontName }) => [
				cssVariable(`${token}.fontSize`),
				{
					token,
					family: fontName.family,
					weight: parseFontStyle(fontName.style)?.weight ?? "400",
				},
			]),
		),
	};
}

/**
 * The fields of an element Push binds: fills, spacing and radius written as
 * a variable's token, and text whose font size is a text style's and whose
 * family and weight match it (so applying the style changes nothing else).
 */
export function elementBindings(
	element: Element,
	resolved: Record<string, string>,
	bindings: TokenBindings,
): ScreenBindings | undefined {
	const bound: ScreenBindings = {};
	const token = (prop: keyof Element["props"]) => {
		const name = variableName(element.props[prop]);
		return name ? bindings.variables.get(name) : undefined;
	};
	const set = (field: keyof ScreenBindings, value: string | undefined) => {
		if (value !== undefined) bound[field] = value;
	};
	if (element.kind === "text") {
		set("fill", token("color"));
		const style = bindings.textStyles.get(
			variableName(element.props["font-size"]) ?? "",
		);
		if (
			style &&
			resolved["font-family"] === style.family &&
			resolved["font-weight"] === style.weight
		) {
			set("textStyle", style.token);
		}
	} else if (element.kind === "vector") {
		set("fill", token("fill"));
	} else {
		if (element.kind !== "image") set("fill", token("background-color"));
		set("cornerRadius", token("border-radius"));
	}
	if (element.kind === "frame") {
		set("itemSpacing", token("gap"));
		set("paddingTop", token("padding-top"));
		set("paddingRight", token("padding-right"));
		set("paddingBottom", token("padding-bottom"));
		set("paddingLeft", token("padding-left"));
	}
	return Object.keys(bound).length > 0 ? bound : undefined;
}

/** The Design System as Figma has it: the tokens found, as DESIGN.md would write them. */
export type FigmaDesignSystem = {
	/** Token paths whose variable or text style still exists. */
	tokens: Set<string>;
	fields: TokenFields;
};

/** Reads the variables and text styles the Baseline names as DESIGN.md token fields. */
export function figmaDesignSystem(
	read: SyncedDesignSystem,
	baseline: DesignSystemBaseline,
): FigmaDesignSystem {
	const base = parseDesignMd(baseline.source).fields;
	const tokens = new Set<string>();
	const fields: TokenFields = new Map();
	const tokenOf = (ids: Record<string, string>) =>
		new Map(Object.entries(ids).map(([token, id]) => [id, token]));
	const variableTokens = tokenOf(baseline.variables);
	for (const variable of read.variables) {
		const token = variableTokens.get(variable.id);
		if (!token) continue;
		const value =
			writtenValue(variable.value, variableTokens) ??
			writtenValue(variable.resolved, variableTokens);
		if (value === undefined) continue;
		tokens.add(token);
		fields.set(token, value);
	}
	const styleTokens = tokenOf(baseline.textStyles);
	for (const style of read.textStyles) {
		const token = styleTokens.get(style.id);
		if (!token) continue;
		tokens.add(token);
		fields.set(`${token}.fontFamily`, style.fontName.family);
		fields.set(`${token}.fontSize`, `${round(style.fontSize)}px`);
		// A style DESIGN.md can't express (italic, condensed) keeps its weight.
		const weight = parseFontStyle(style.fontName.style);
		const baseWeight = base.get(`${token}.fontWeight`);
		if (weight && !weight.italic)
			fields.set(`${token}.fontWeight`, weight.weight);
		else if (baseWeight !== undefined)
			fields.set(`${token}.fontWeight`, baseWeight);
		if (style.lineHeight) {
			const { value, unit } = style.lineHeight;
			fields.set(
				`${token}.lineHeight`,
				unit === "PIXELS" ? `${round(value)}px` : String(round(value / 100)),
			);
		}
		if (style.letterSpacing) {
			const { value, unit } = style.letterSpacing;
			fields.set(
				`${token}.letterSpacing`,
				unit === "PIXELS" ? `${round(value)}px` : `${round(value / 100)}em`,
			);
		}
	}
	return { tokens, fields };
}

function writtenValue(
	value: SyncedDesignSystem["variables"][number]["value"],
	tokens: Map<string, string>,
): string | undefined {
	if (value === null || typeof value === "boolean") return undefined;
	if (typeof value === "number") return `${round(value)}px`;
	if (typeof value === "string") return undefined;
	if ("alias" in value) {
		const token = tokens.get(value.alias);
		return token ? `{${token}}` : undefined;
	}
	if (value.opacity === undefined || value.opacity === 1) return value.color;
	const alpha = Math.round(value.opacity * 255)
		.toString(16)
		.padStart(2, "0");
	return `${value.color}${alpha}`;
}

/** The fields Figma holds for a token, in DESIGN.md's paths. */
function syncedFields(token: string): string[] {
	return groupOf(token) === "typography"
		? TYPOGRAPHY_FIELDS.map((field) => `${token}.${field}`)
		: [token];
}

/**
 * A field's meaning, for comparing versions: colors as lowercase hex,
 * lengths in px, typography references followed and defaults filled in.
 */
function fieldMeaning(path: string, fields: TokenFields): string {
	const [group, , field] = path.split(".") as [string, string, string?];
	let raw = fields.get(path);
	if (group === "typography") {
		raw = resolveField(path, fields) ?? TYPOGRAPHY_DEFAULTS[field as string];
	}
	if (raw === undefined) return "";
	const value = raw.trim();
	if (referencePath(value) !== undefined) return value;
	if (group === "colors") return normalizeHex(value) ?? value;
	if (field === "fontWeight") return String(Number(value));
	if (field === "lineHeight" || field === "letterSpacing") {
		const typed = typeValue(
			value,
			field === "lineHeight" ? "multiplier" : "em",
		);
		if (!typed) return value;
		return typed.value === 0 ? "" : `${typed.value} ${typed.unit}`;
	}
	if (field === "fontFamily") return value;
	const px = pixels(value);
	return px === undefined ? value : `${px}px`;
}

/** Token fields Figma changed since the Baseline. Deleted variables and styles aren't changes: Push makes them again. */
export function designSystemChanges(
	base: TokenFields,
	figma: FigmaDesignSystem,
): string[] {
	return [...figma.tokens].flatMap((token) =>
		syncedFields(token).filter(
			(path) => fieldMeaning(path, base) !== fieldMeaning(path, figma.fields),
		),
	);
}

/**
 * The tokens as the Linked File shows them: the Baseline's, with Figma's
 * changes. Screens' layers bound to a variable or style take its value, so
 * their Baselines resolve against these.
 */
export function figmaTokens(
	base: TokenFields,
	figma: FigmaDesignSystem,
): Tokens {
	const fields = new Map(base);
	for (const path of designSystemChanges(base, figma)) {
		const value = figma.fields.get(path);
		if (value === undefined) fields.delete(path);
		else fields.set(path, value);
	}
	return resolveTokens(fields);
}

export type DesignSystemPull = {
	/** Token fields Figma changed since the Baseline. */
	changed: string[];
	/** The merged DESIGN.md, when Figma changed something. */
	source?: string;
	conflicts: number;
	/** DESIGN.md as Figma has it now, for the Baseline. */
	baselineSource: string;
};

/**
 * Merges Figma's token changes into DESIGN.md against the Baseline, field by
 * field. Where both changed a field differently, it gets Sync Conflict
 * markers. Everything else in the file stays as written.
 */
export function pullDesignSystem(
	local: string,
	baseline: DesignSystemBaseline,
	figma: FigmaDesignSystem,
): DesignSystemPull {
	const base = parseDesignMd(baseline.source).fields;
	const localFields = parseDesignMd(local).fields;
	const changed = designSystemChanges(base, figma);
	if (changed.length === 0) {
		return { changed, conflicts: 0, baselineSource: baseline.source };
	}
	const edits: FieldEdit[] = [];
	for (const path of changed) {
		const [fromBase, fromLocal, fromFigma] = [
			base,
			localFields,
			figma.fields,
		].map((fields) => fieldMeaning(path, fields));
		if (fromLocal === fromFigma) continue;
		edits.push({
			path,
			value: figma.fields.get(path),
			conflict: fromLocal !== fromBase,
		});
	}
	const merged = editFrontMatter(local, edits);
	return {
		changed,
		source: merged.source,
		conflicts: merged.conflicts,
		baselineSource: editFrontMatter(
			baseline.source,
			changed.map((path) => ({ path, value: figma.fields.get(path) })),
		).source,
	};
}

type FieldEdit = {
	path: string;
	/** The new value as DESIGN.md writes it; undefined removes the field. */
	value: string | undefined;
	/** Keep the current line too, between Sync Conflict markers. */
	conflict?: boolean;
};

/**
 * Edits token fields in DESIGN.md's front matter in place: a changed value
 * replaces just the old one (keeping its quotes and comments), a new field
 * goes after its siblings. Fields whose token the file no longer has are
 * left out.
 */
function editFrontMatter(
	source: string,
	edits: FieldEdit[],
): { source: string; conflicts: number } {
	const match = FRONT_MATTER.exec(source);
	if (!match) return { source, conflicts: 0 };
	// Every line ends in a newline, so lines can be swapped whole.
	const text = `${match[1]}\n`;
	const offset = match.index + match[0].indexOf(match[1] as string);
	const document = parseDocument(text);
	const replacements: { start: number; end: number; text: string }[] = [];
	let conflicts = 0;
	for (const edit of edits) {
		const segments = edit.path.split(".");
		const key = segments.pop() as string;
		const parent = document.getIn(segments, true);
		if (!isMap(parent)) continue;
		const region = fieldRegion(text, parent, key);
		if (!region) continue;
		const lines =
			edit.value === undefined ? "" : region.line(edit.value, edit.path);
		const current = text.slice(region.start, region.end);
		if (edit.conflict) conflicts++;
		replacements.push({
			start: region.start,
			end: region.end,
			text: edit.conflict
				? `${CONFLICT_START}\n${current}${CONFLICT_SEPARATOR}\n${lines}${CONFLICT_END}\n`
				: lines,
		});
	}
	let edited = text;
	for (const { start, end, text: replacement } of replacements.sort(
		(a, b) => b.start - a.start,
	)) {
		edited = edited.slice(0, start) + replacement + edited.slice(end);
	}
	return {
		source:
			source.slice(0, offset) + edited + source.slice(offset + text.length),
		conflicts,
	};
}

/** Where a field's line is (or would go) in the front matter, and how to write it. */
function fieldRegion(
	text: string,
	parent: YAMLMap,
	key: string,
):
	| {
			start: number;
			end: number;
			line: (value: string, path: string) => string;
	  }
	| undefined {
	const lineStart = (at: number) => text.lastIndexOf("\n", at - 1) + 1;
	const lineEnd = (at: number) => text.indexOf("\n", at) + 1;
	const pair = parent.items.find(
		(item) => isScalar(item.key) && String(item.key.value) === key,
	);
	if (pair && isScalar(pair.value) && isScalar(pair.key)) {
		const value = pair.value;
		const [valueStart, valueEnd] = value.range as [number, number, number];
		const start = lineStart((pair.key.range as number[])[0] as number);
		const end = lineEnd(valueEnd);
		return {
			start,
			end,
			line: (written, path) =>
				text.slice(start, valueStart) +
				yamlScalar(written, path, value.type) +
				text.slice(valueEnd, end),
		};
	}
	if (pair) return undefined;
	// A new field: after the last one, indented like it.
	const last = parent.items.at(-1);
	if (!last || !isScalar(last.key)) return undefined;
	const keyStart = (last.key.range as number[])[0] as number;
	const indent = text.slice(lineStart(keyStart), keyStart);
	const lastEnd = (
		(isScalar(last.value) ? last.value.range : last.key.range) as number[]
	)[1] as number;
	const at = lineEnd(lastEnd);
	return {
		start: at,
		end: at,
		line: (written, path) => `${indent}${key}: ${yamlScalar(written, path)}\n`,
	};
}

/** A value as YAML, quoted as the value it replaces was, or as it needs. */
function yamlScalar(value: string, path: string, type?: Scalar.Type): string {
	if (type === Scalar.QUOTE_SINGLE) return `'${value.replaceAll("'", "''")}'`;
	if (type === Scalar.QUOTE_DOUBLE) return JSON.stringify(value);
	const plain = /^-?[A-Za-z0-9][\w .-]*$/.test(value) && !/\s$/.test(value);
	// Colors are strings even when they'd read as something else.
	return plain && groupOf(path) !== "colors" ? value : JSON.stringify(value);
}
