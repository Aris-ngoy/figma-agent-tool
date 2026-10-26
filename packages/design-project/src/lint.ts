// Check's Design System half: Google's own DESIGN.md linter (the rules
// `npx @google/design.md lint` runs, WCAG contrast included), with each
// finding placed on the line of the token it names, and the Modes file
// checked against DESIGN.md's tokens.
import { lint } from "@google/design.md/linter";
import { parseDocument } from "yaml";
import {
	FRONT_MATTER,
	referencePath,
	resolveField,
	type TokenFields,
} from "./design-md";
import {
	VARIABLE_GROUPS,
	type VariableGroup,
	variableValue,
} from "./design-system";
import { MODES_FILE, type Modes, modeFields, pathLine } from "./modes";
import type { CheckError } from "./screen";

export function lintDesignMd(source: string): {
	errors: CheckError[];
	warnings: CheckError[];
} {
	const errors: CheckError[] = [];
	const warnings: CheckError[] = [];
	let findings: ReturnType<typeof lint>["findings"];
	try {
		findings = lint(source).findings;
	} catch (error) {
		findings = [
			{
				severity: "error",
				message: `The DESIGN.md linter failed: ${(error as Error).message}`,
			},
		];
	}
	for (const finding of findings) {
		if (finding.severity === "info") continue;
		const error: CheckError = {
			file: "DESIGN.md",
			line: lineOf(source, finding.path),
			element: finding.path ?? "",
			rule: finding.rule ?? "design-md",
			message: finding.message,
		};
		(finding.severity === "error" ? errors : warnings).push(error);
	}
	return { errors, warnings };
}

/** The line of a token path like `components.button` in the front matter; 1 if it isn't there. */
export function lineOf(source: string, path: string | undefined): number {
	const match = FRONT_MATTER.exec(source);
	const line = match ? pathLine(match[1] as string, path) : undefined;
	// The front matter starts on line 2.
	return line === undefined ? 1 : line + 1;
}

/**
 * The Modes file against DESIGN.md: a Mode may only give other values to
 * DESIGN.md's variable tokens (colors, spacing, rounded), in values Figma
 * variables take. Contrast is linted in each Mode as in the default.
 */
export function checkModes(project: {
	designMd: string;
	fields: TokenFields;
	modes: Modes;
}): { errors: CheckError[]; warnings: CheckError[] } {
	const { modes, fields } = project;
	if (modes.errors.length > 0) return { errors: modes.errors, warnings: [] };
	const errors: CheckError[] = [];
	const error = (element: string, rule: string, message: string) =>
		errors.push({
			file: MODES_FILE,
			line: pathLine(modes.source, element) ?? 1,
			element,
			rule,
			message,
		});
	const warnings: CheckError[] = [];
	for (const [mode, overrides] of modes.overrides) {
		const at = `modes.${mode}`;
		if (mode === modes.default) {
			error(
				at,
				"duplicate-mode",
				`${mode} is the default Mode, whose values are DESIGN.md's: change them there, or rename the default with "default".`,
			);
			continue;
		}
		if (/[./]/.test(mode)) {
			error(at, "mode-name", `A Mode's name can't contain "." or "/".`);
			continue;
		}
		const merged = modeFields(fields, modes, mode);
		const badGroups = new Set<string>();
		for (const [path, value] of overrides) {
			const group = path.split(".")[0] as string;
			const element = `${at}.${path}`;
			if (!(group in VARIABLE_GROUPS)) {
				if (!badGroups.has(group)) {
					badGroups.add(group);
					error(
						`${at}.${group}`,
						"mode-group",
						`Modes hold colors, spacing and rounded tokens only: those are Figma variables, which have Modes. ${group} tokens keep DESIGN.md's values in every Mode.`,
					);
				}
				continue;
			}
			if (!fields.has(path)) {
				error(
					element,
					"unknown-token",
					`DESIGN.md has no token ${path}: a Mode only gives DESIGN.md's tokens other values. Add the token to DESIGN.md first, or fix the name.`,
				);
				continue;
			}
			const resolved = resolveField(path, merged);
			if (referencePath(value) !== undefined && resolved === undefined) {
				error(
					element,
					"broken-ref",
					`${value} doesn't lead to a token's value in Mode ${mode}.`,
				);
				continue;
			}
			const type = VARIABLE_GROUPS[group as VariableGroup];
			if (variableValue(type, resolved) === undefined) {
				error(
					element,
					"mode-value",
					`${path} (${value}) can't be a variable's value: ${type === "COLOR" ? "use a #rgb, #rrggbb or #rrggbbaa color" : "use a length in px or rem"}, or a reference to one.`,
				);
			}
		}
		warnings.push(...modeContrast(project.designMd, merged, mode));
	}
	return { errors, warnings };
}

/** DESIGN.md's contrast warnings with a Mode's values in place of the default's. */
function modeContrast(
	designMd: string,
	fields: TokenFields,
	mode: string,
): CheckError[] {
	const match = FRONT_MATTER.exec(designMd);
	if (!match) return [];
	const document = parseDocument(match[1] as string);
	for (const [path, value] of fields) {
		if (path.split(".")[0] === "colors") document.setIn(path.split("."), value);
	}
	const source = `---\n${document.toString()}---\n`;
	return lintDesignMd(source)
		.warnings.filter((warning) => warning.rule === "contrast-ratio")
		.map((warning) => ({
			...warning,
			line: lineOf(designMd, warning.element),
			message: `In Mode ${mode}: ${warning.message}`,
		}));
}
