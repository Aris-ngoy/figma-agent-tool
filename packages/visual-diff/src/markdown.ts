// A compact, deterministic Markdown summary of a comparison, for PRs and agents.
import type { ComparisonReport } from "./compare";

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
	const masks =
		report.masks.length === 0
			? "none"
			: report.masks
					.map((mask) => `${MASK_LABELS[mask.kind]} (${box(mask)})`)
					.join(", ");
	const lines = [
		`## Visual comparison: ${report.pass ? "PASS" : "FAIL"}`,
		"",
		"| | |",
		"|---|---|",
		`| Mismatch | ${report.mismatchPercent}% (budget ${report.mismatchBudget}%) |`,
		`| Mismatched pixels | ${report.mismatchedPixels} of ${report.comparedPixels} compared |`,
		`| Aligned size | ${width}×${height} px (design scaled ${scale}) |`,
		`| Masks | ${masks} |`,
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

const round = (value: number) => Math.round(value * 1000) / 1000;

const box = ({
	x,
	y,
	width,
	height,
}: {
	x: number;
	y: number;
	width: number;
	height: number;
}) => `${width}×${height} at ${x},${y}`;
