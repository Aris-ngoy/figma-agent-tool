// Check's DESIGN.md half: Google's own DESIGN.md linter (the rules
// `npx @google/design.md lint` runs, WCAG contrast included), with each
// finding placed on the line of the token it names.
import { lint } from "@google/design.md/linter";
import { isMap, isScalar, parseDocument } from "yaml";
import { FRONT_MATTER } from "./design-md";
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
	if (!match || !path) return 1;
	const text = match[1] as string;
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
	if (at === undefined) return 1;
	// The front matter starts on line 2.
	return text.slice(0, at).split("\n").length + 1;
}
