// The Design System's DESIGN.md (Google Labs' open format): YAML front
// matter with the tokens, then Markdown rationale. Screens see every token as
// a CSS variable named after its path, so `colors.primary` is
// `--colors-primary` and `typography.body-md.fontSize` is
// `--typography-body-md-font-size`.
import { parse as parseYaml } from "yaml";
import { conflictMarkers } from "./html";

export type Tokens = {
	/** CSS variable name (with `--`) → CSS value, references resolved. */
	variables: Map<string, string>;
};

export type DesignMdError = { line: number; rule: string; message: string };

/**
 * Token fields as written, by path: `colors.primary` → `#3366ff`,
 * `typography.title.fontSize` → `28px`, `colors.heading` → `{colors.text}`.
 */
export type TokenFields = Map<string, string>;

export const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

export const TOKEN_GROUPS = [
	"colors",
	"typography",
	"rounded",
	"spacing",
] as const;

export function parseDesignMd(source: string): {
	tokens: Tokens;
	fields: TokenFields;
	errors: DesignMdError[];
} {
	const fields: TokenFields = new Map();
	const empty = { tokens: resolveTokens(fields), fields };
	const match = FRONT_MATTER.exec(source);
	if (!match) return { ...empty, errors: [] };
	// Only in the front matter: a Markdown heading may be underlined with =.
	const conflicts = conflictMarkers(match[1] as string).map((error) => ({
		...error,
		line: error.line + 1,
	}));
	if (conflicts.length > 0) return { ...empty, errors: conflicts };
	let data: unknown;
	try {
		data = parseYaml(match[1] as string);
	} catch (error) {
		const line = (error as { linePos?: { line: number }[] }).linePos?.[0]?.line;
		return {
			...empty,
			errors: [
				{
					// The front matter starts on line 2.
					line: (line ?? 0) + 1,
					rule: "design-md",
					message: `DESIGN.md's front matter isn't valid YAML: ${(error as Error).message}`,
				},
			],
		};
	}
	const groups = (data ?? {}) as Record<string, unknown>;
	for (const group of TOKEN_GROUPS) {
		for (const [name, value] of Object.entries(objectOrEmpty(groups[group]))) {
			if (group === "typography") {
				for (const [field, fieldValue] of Object.entries(
					objectOrEmpty(value),
				)) {
					fields.set(`${group}.${name}.${field}`, String(fieldValue));
				}
			} else if (typeof value === "string" || typeof value === "number") {
				fields.set(`${group}.${name}`, String(value));
			}
		}
	}
	return { tokens: resolveTokens(fields), fields, errors: [] };
}

/** Every token field as a CSS variable, references resolved. */
export function resolveTokens(fields: TokenFields): Tokens {
	const variables = new Map<string, string>();
	for (const path of fields.keys()) {
		const value = resolveField(path, fields);
		if (value !== undefined) variables.set(cssVariable(path), value);
	}
	return { variables };
}

/** `typography.body-md.fontSize` → `--typography-body-md-font-size`. */
export function cssVariable(path: string): string {
	const kebab = path.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
	return `--${kebab.replaceAll(".", "-")}`;
}

/** The path a `{group.name}` reference points at; undefined for other values. */
export function referencePath(value: string): string | undefined {
	return /^\{([^}]+)\}$/.exec(value.trim())?.[1];
}

/** A field's value with `{group.name}` references followed; undefined for broken or cyclic ones. */
export function resolveField(
	path: string,
	fields: TokenFields,
	seen = new Set<string>(),
): string | undefined {
	const value = fields.get(path);
	if (value === undefined || seen.has(path)) return undefined;
	const reference = referencePath(value);
	if (reference === undefined) return value;
	seen.add(path);
	return resolveField(reference, fields, seen);
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

/** The `:root` rule declaring every token as a CSS variable. */
export function tokensCss(tokens: Tokens): string {
	const declarations = [...tokens.variables].map(
		([name, value]) => `${name}: ${value};`,
	);
	return `:root { ${declarations.join(" ")} }`;
}
