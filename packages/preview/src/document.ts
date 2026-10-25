// The one renderer: the HTML document a Screen is shown in, both by the
// Preview and by Render. It wraps the Screen's <body> with the Design
// System's tokens as CSS variables (in the Mode asked for), the Screen Size, and a reset that makes
// CSS behave like Figma's auto layout (no margins or inheritance, children
// don't shrink, counter-axis alignment starts at flex-start, absolute
// offsets are from the parent, vectors don't clip their strokes, links
// aren't underlined). Figma-owned
// Elements show the export Pull cached of their layer.
import {
	checkScreen,
	type DesignProject,
	type FigmaOwnedPreview,
	figmaOwnedPreviews,
	modeTokens,
	readBaseline,
	resolveProp,
	type ScreenFile,
	type ScreenSize,
	tokensCss,
} from "@figma-agent-tool/design-project";

const RESET = `*, *::before, *::after {
  box-sizing: border-box; margin: 0; padding: 0; border: 0 solid;
  flex-shrink: 0; min-width: 0; min-height: 0; align-items: flex-start;
  font-family: Inter, sans-serif; font-size: 16px; font-weight: 400;
  font-style: normal; line-height: normal; color: #000000; text-align: left;
}
* { position: relative; }
html { background: transparent; }
body { overflow: hidden; }
a { text-decoration: none; }
[href] { cursor: pointer; }
img { display: block; object-fit: cover; }
svg { display: block; overflow: visible; }
figma-owned { display: block; }`;

/** How the Preview marks a Figma-owned Element whose export isn't current. */
const NOTED = "outline: 2px dashed #f5a623; outline-offset: -2px;";
const NOTE_LABEL = `position: absolute; left: 0; top: 0; padding: 2px 4px;
  background: #f5a623; color: #000000; font: 10px/1.2 system-ui, sans-serif;
  white-space: nowrap;`;

export type DocumentOptions = {
	/** The URL the Screen's relative `src`s resolve against: its folder. */
	baseUrl: string;
	/** Extra markup for <head>, such as the Preview's live-reload script. */
	head?: string;
	/** How to show the Screen's Figma-owned Elements; see figmaOwnedOf. */
	figmaOwned?: FigmaOwnedPreview[];
	/** The Mode whose token values to show; the default Mode when absent. */
	mode?: string;
};

/** A Screen's Figma-owned Elements, with the state of their exports. */
export async function figmaOwnedOf(
	project: DesignProject,
	screen: ScreenFile,
): Promise<FigmaOwnedPreview[]> {
	const { root } = checkScreen(project, screen);
	const baseline = await readBaseline(project, screen.name);
	return figmaOwnedPreviews(project, screen, root, baseline);
}

/** What the Preview says about an export that isn't current. */
export function exportNote(owned: FigmaOwnedPreview): string | undefined {
	const name = owned.name ? `“${owned.name}”` : owned.key;
	if (owned.export === "stale")
		return `Figma-owned ${name}: its export is stale (from before the Screen resized it); Pull to refresh it`;
	if (owned.export === "missing")
		return `Figma-owned ${name}: no export; Pull to fetch it`;
	return undefined;
}

function figmaOwnedCss(owned: FigmaOwnedPreview[]): string {
	return owned
		.flatMap((element) => {
			const selector = `figma-owned[data-key="${element.key}"]`;
			const image = element.src
				? `background: url("${element.src}") center / 100% 100% no-repeat;`
				: "background: repeating-linear-gradient(45deg, #eeeeee 0 6px, #dddddd 6px 12px);";
			const note = exportNote(element);
			if (!note) return [`${selector} { ${image} }`];
			return [
				`${selector} { ${image} ${NOTED} }`,
				`${selector}::after { ${NOTE_LABEL} content: "${cssString(note)}"; }`,
			];
		})
		.join("\n");
}

/** Text safe inside a CSS string in a <style>. */
function cssString(text: string): string {
	return text.replace(
		/[\\"<]/g,
		(char) => `\\${char.charCodeAt(0).toString(16)} `,
	);
}

/** The Screen Size a Screen renders at: its <body> override, else the project's. */
export function screenSize(
	project: DesignProject,
	screen: ScreenFile,
): ScreenSize {
	const { root } = checkScreen(project, screen);
	const width = root && Number(resolveProp(root, "width", project.tokens));
	const height = root && Number(resolveProp(root, "height", project.tokens));
	return width && height ? { width, height } : project.config.screenSize;
}

export function screenDocument(
	project: DesignProject,
	screen: ScreenFile,
	{ baseUrl, head = "", figmaOwned = [], mode }: DocumentOptions,
): string {
	const tokens = modeTokens(project, mode);
	const { width, height } = screenSize(project, screen);
	return [
		"<!doctype html>",
		"<html>",
		"<head>",
		'<meta charset="utf-8">',
		`<base href="${baseUrl}">`,
		`<title>${screen.name}</title>`,
		"<style>",
		RESET,
		tokensCss(tokens),
		`body { width: ${width}px; height: ${height}px; }`,
		...(figmaOwned.length > 0 ? [figmaOwnedCss(figmaOwned)] : []),
		"</style>",
		head,
		"</head>",
		screen.source.trim(),
		"</html>",
		"",
	].join("\n");
}
