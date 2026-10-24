// The Design System's DESIGN.md (Google Labs' open format): YAML front
// matter with the tokens, then Markdown rationale. Screens see every token as
// a CSS variable named after its path, so `colors.primary` is
// `--colors-primary` and `typography.body-md.fontSize` is
// `--typography-body-md-font-size`.
import { parse as parseYaml } from "yaml";

export type Tokens = {
	/** CSS variable name (with `--`) → CSS value, references resolved. */
	variables: Map<string, string>;
};

export type DesignMdError = { line: number; message: string };

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

const TOKEN_GROUPS = ["colors", "typography", "rounded", "spacing"] as const;

export function parseDesignMd(source: string): {
	tokens: Tokens;
	errors: DesignMdError[];
} {
	const tokens: Tokens = { variables: new Map() };
	const match = FRONT_MATTER.exec(source);
	if (!match) return { tokens, errors: [] };
	let data: unknown;
	try {
		data = parseYaml(match[1] as string);
	} catch (error) {
		const line = (error as { linePos?: { line: number }[] }).linePos?.[0]?.line;
		return {
			tokens,
			errors: [
				{
					// The front matter starts on line 2.
					line: (line ?? 0) + 1,
					message: `DESIGN.md's front matter isn't valid YAML: ${(error as Error).message}`,
				},
			],
		};
	}
	const groups = (data ?? {}) as Record<string, unknown>;
	const raw = new Map<string, string>();
	for (const group of TOKEN_GROUPS) {
		for (const [name, value] of Object.entries(objectOrEmpty(groups[group]))) {
			if (group === "typography") {
				for (const [field, fieldValue] of Object.entries(
					objectOrEmpty(value),
				)) {
					raw.set(`${group}.${name}.${field}`, String(fieldValue));
				}
			} else if (typeof value === "string" || typeof value === "number") {
				raw.set(`${group}.${name}`, String(value));
			}
		}
	}
	for (const path of raw.keys()) {
		const value = resolveReference(path, raw, new Set());
		if (value !== undefined) tokens.variables.set(cssVariable(path), value);
	}
	return { tokens, errors: [] };
}

/** `typography.body-md.fontSize` → `--typography-body-md-font-size`. */
export function cssVariable(path: string): string {
	const kebab = path.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
	return `--${kebab.replaceAll(".", "-")}`;
}

/** Follows `{group.name}` references; undefined for broken or cyclic ones. */
function resolveReference(
	path: string,
	raw: Map<string, string>,
	seen: Set<string>,
): string | undefined {
	const value = raw.get(path);
	if (value === undefined || seen.has(path)) return undefined;
	const reference = /^\{([^}]+)\}$/.exec(value.trim());
	if (!reference) return value;
	seen.add(path);
	return resolveReference(reference[1] as string, raw, seen);
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
