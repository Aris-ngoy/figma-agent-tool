// The Markdown visual QA report written next to a run's images, for PRs.
import {
	type ComparisonReport,
	describeMasks,
} from "@figma-agent-tool/visual-diff";

type NodeRef = { id: string; name: string; type: string };

export type QaReport = Omit<ComparisonReport, "diffPng" | "regions"> & {
	regions: (ComparisonReport["regions"][number] & { nodes: NodeRef[] })[];
	screen: { id: string; name: string; width: number; height: number };
	device: { deviceId: string; platform: string };
	navigation?: { completed: number; total: number };
};

/** Image file names, relative to the report, so the report embeds them. */
export const QA_FILES = {
	figma: "figma.png",
	device: "device.png",
	diff: "diff.png",
	report: "report.md",
} as const;

export function renderQaReport(report: QaReport): string {
	const { screen, device } = report;
	const { width, height } = report.dimensions;
	const ratio =
		report.scale.x === report.scale.y
			? `×${round(report.scale.x)}`
			: `×${round(report.scale.x)} wide, ×${round(report.scale.y)} high`;
	const lines = [
		`## Visual QA: ${screen.name} — ${report.pass ? "PASS" : "FAIL"}`,
		"",
		"| | |",
		"|---|---|",
		`| Screen | ${screen.name} (\`${screen.id}\`), ${screen.width}×${screen.height} pt |`,
		`| Device | ${device.platform} ${device.deviceId} |`,
		`| Mismatch | ${report.mismatchPercent}% (budget ${report.mismatchBudget}%) |`,
		`| Mismatched pixels | ${report.mismatchedPixels} of ${report.comparedPixels} compared |`,
		`| Aligned size | ${width}×${height} px (${ratio} device pixels per point) |`,
		`| Masks | ${describeMasks(report.masks)} |`,
	];
	if (report.navigation) {
		const { completed, total } = report.navigation;
		lines.push(`| Navigation | ${completed} of ${total} steps |`);
	}
	if (report.regions.length > 0) {
		lines.push(
			"",
			"### Mismatched regions",
			"",
			"Device pixels. Figma layers are the visible nodes drawn there; none means the app shows something the design doesn't.",
			"",
			"| # | x | y | width | height | mismatched pixels | Figma layers |",
			"|---|---|---|---|---|---|---|",
			...report.regions.map((region, index) => {
				const layers =
					region.nodes.length === 0
						? "—"
						: region.nodes
								.map((node) => `${node.name} (\`${node.id}\`)`)
								.join(", ");
				return `| ${index + 1} | ${region.x} | ${region.y} | ${region.width} | ${region.height} | ${region.mismatchedPixels} | ${layers} |`;
			}),
		);
	}
	lines.push(
		"",
		"### Images",
		"",
		"| Figma | Device | Diff |",
		"|---|---|---|",
		`| ![Figma](${QA_FILES.figma}) | ![Device](${QA_FILES.device}) | ![Diff](${QA_FILES.diff}) |`,
	);
	return `${lines.join("\n")}\n`;
}

const round = (value: number) => Math.round(value * 1000) / 1000;
