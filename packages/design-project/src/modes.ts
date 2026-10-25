// The Modes file: the values the Design System's tokens take in Modes other
// than DESIGN.md's (dark, high contrast, a brand variant). DESIGN.md stays
// spec-pure and holds the default Mode; this file, which the tool owns, sits
// next to it until the spec can express Modes (ADR-0004):
//
//   default: Light          # the default Mode's name (Default if left out)
//   modes:
//     Dark:
//       colors:
//         surface: "#111111"
//         text: "{colors.surface-inverse}"
//
// A Mode gives other values to DESIGN.md's colors, spacing and rounded
// tokens (the ones that become variables); every token it leaves out keeps
// the default's value, and references follow the Mode's values.
import { isMap, isScalar, parseDocument, parse as parseYaml } from "yaml";
import { resolveTokens, type TokenFields, type Tokens } from "./design-md";
import { DesignProjectError } from "./errors";
import { conflictMarkers } from "./html";
import type { CheckError } from "./screen";

export const MODES_FILE = "modes.yaml";

/** The default Mode's name when the Modes file doesn't give one. */
export const DEFAULT_MODE = "Default";

export type Modes = {
	/** The Modes file's source; "" when there is none. */
	source: string;
	/** The default Mode's name: the one DESIGN.md holds. */
	default: string;
	/** Every Mode's name, the default first. */
	names: string[];
	/** The other Modes' token fields as written, by path (`colors.surface`). */
	overrides: Map<string, TokenFields>;
	/** Why the file can't be read; its Modes are left out then. */
	errors: CheckError[];
};

export function parseModes(source: string): Modes {
	const none = (errors: CheckError[]): Modes => ({
		source,
		default: DEFAULT_MODE,
		names: [DEFAULT_MODE],
		overrides: new Map(),
		errors,
	});
	if (!source.trim()) return none([]);
	const conflicts = conflictMarkers(source);
	if (conflicts.length > 0) {
		return none(conflicts.map((error) => ({ ...modesError(error), ...error })));
	}
	let data: unknown;
	try {
		data = parseYaml(source);
	} catch (error) {
		const line = (error as { linePos?: { line: number }[] }).linePos?.[0]?.line;
		return none([
			modesError({
				line: line ?? 1,
				message: `${MODES_FILE} isn't valid YAML: ${(error as Error).message}`,
			}),
		]);
	}
	const root = (data ?? {}) as Record<string, unknown>;
	const shape = (message: string, path?: string) =>
		none([modesError({ line: pathLine(source, path) ?? 1, message })]);
	if (!isObject(root))
		return shape(`${MODES_FILE} must be a mapping with "default" and "modes".`);
	if (root.default !== undefined && typeof root.default !== "string")
		return shape(`"default" names the default Mode, as text.`, "default");
	if (root.modes !== undefined && !isObject(root.modes))
		return shape(`"modes" maps each Mode's name to its token values.`, "modes");
	const overrides = new Map<string, TokenFields>();
	for (const [mode, groups] of Object.entries(root.modes ?? {})) {
		const fields: TokenFields = new Map();
		if (groups !== null && !isObject(groups))
			return shape(
				`A Mode maps token groups (colors, spacing, rounded) to values.`,
				`modes.${mode}`,
			);
		flatten(groups ?? {}, [], fields);
		overrides.set(mode, fields);
	}
	const defaultName = (root.default as string | undefined) || DEFAULT_MODE;
	return {
		source,
		default: defaultName,
		names: [
			defaultName,
			...[...overrides.keys()].filter((m) => m !== defaultName),
		],
		overrides,
		errors: [],
	};
}

function modesError({
	line,
	message,
}: {
	line: number;
	message: string;
}): CheckError {
	return { file: MODES_FILE, line, element: "", rule: "modes-file", message };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flatten(value: unknown, path: string[], fields: TokenFields) {
	if (isObject(value)) {
		for (const [key, child] of Object.entries(value))
			flatten(child, [...path, key], fields);
	} else if (value !== null && value !== undefined) {
		fields.set(path.join("."), String(value));
	}
}

/** DESIGN.md's token fields as a Mode has them: the Mode's own values on top. */
export function modeFields(
	fields: TokenFields,
	modes: Modes,
	mode: string,
): TokenFields {
	const overrides = modes.overrides.get(mode);
	if (!overrides) return fields;
	const merged = new Map(fields);
	for (const [path, value] of overrides) {
		if (fields.has(path)) merged.set(path, value);
	}
	return merged;
}

/** The tokens a Screen shows in a Mode (the default Mode when none is given). */
export function modeTokens(
	project: { tokens: Tokens; fields: TokenFields; modes: Modes },
	mode?: string,
): Tokens {
	const { modes } = project;
	if (mode === undefined || mode === modes.default) return project.tokens;
	if (!modes.overrides.has(mode)) {
		throw new DesignProjectError(
			`No Mode named “${mode}”: the Design System has ${modes.names.join(", ")}.`,
		);
	}
	return resolveTokens(modeFields(project.fields, modes, mode));
}

/** The 1-based line of a key path like `modes.Dark.colors` in a YAML text; undefined if it isn't there. */
export function pathLine(
	text: string,
	path: string | undefined,
): number | undefined {
	if (!path) return undefined;
	let node: unknown = parseDocument(text).contents;
	let at: number | undefined;
	for (const segment of path.split(".")) {
		if (!isMap(node)) break;
		const pair = node.items.find(
			(item) => isScalar(item.key) && String(item.key.value) === segment,
		);
		if (!pair || !isScalar(pair.key)) break;
		at = pair.key.range?.[0];
		node = pair.value;
	}
	return at === undefined ? undefined : text.slice(0, at).split("\n").length;
}
