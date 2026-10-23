// A compact, deterministic Markdown summary of a comparison, for PRs and agents.
import type { AppliedMask, ComparisonReport, Rect } from "./compare";

export type ImagePaths = { design?: string; actual?: string; diff?: string };

const MASK_LABELS = {
	"status-bar": "status bar",
	"home-indicator": "home indicator",
	"ignore-region": "ignore region",
} as const;

export function renderMarkdown(
	report: Omit<ComparisonReport, "diffPng">,
	images: ImagePaths = {},
): string {
	const { width, height } = report.dimensions;
	const scale =
		report.scale.x === report.scale.y
			? `×${round(report.scale.x)}`
			: `×${round(report.scale.x)} wide, ×${round(report.scale.y)} high`;
	const lines = [
		`## Visual comparison: ${report.pass ? "PASS" : "FAIL"}`,
		"",
		"| | |",
		"|---|---|",
		`| Mismatch | ${report.mismatchPercent}% (budget ${report.mismatchBudget}%) |`,
		`| Mismatched pixels | ${report.mismatchedPixels} of ${report.comparedPixels} compared |`,
		`| Aligned size | ${width}×${height} px (design scaled ${scale}) |`,
		`| Masks | ${describeMasks(report.masks)} |`,
	];
	if (report.regions.length > 0) {
		lines.push(
			"",
			"### Mismatched regions",
			"",
			"| # | x | y | width | height | mismatched pixels |",
			"|---|---|---|---|---|---|",
			...report.regions.map(
				(region, index) =>
					`| ${index + 1} | ${region.x} | ${region.y} | ${region.width} | ${region.height} | ${region.mismatchedPixels} |`,
			),
		);
	}
	const imageLines = (
		[
			["Design", images.design],
			["Actual", images.actual],
			["Diff", images.diff],
		] as const
	).flatMap(([label, path]) => (path ? [`- ${label}: \`${path}\``] : []));
	if (imageLines.length > 0) lines.push("", "### Images", "", ...imageLines);
	return `${lines.join("\n")}\n`;
}

/** "status bar (1179×177 at 0,0), ignore region (…)", or "none". */
export function describeMasks(masks: readonly AppliedMask[]): string {
	if (masks.length === 0) return "none";
	return masks
		.map((mask) => `${MASK_LABELS[mask.kind]} (${box(mask)})`)
		.join(", ");
}

const round = (value: number) => Math.round(value * 1000) / 1000;

const box = ({ x, y, width, height }: Rect) =>
	`${width}×${height} at ${x},${y}`;
