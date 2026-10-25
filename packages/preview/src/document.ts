// The one renderer: the HTML document a Screen is shown in, both by the
// Preview and by Render. It wraps the Screen's <body> with the Design
// System's tokens as CSS variables (in the Mode asked for), the Screen Size, and a reset that makes
// CSS behave like Figma's auto layout (no margins or inheritance, children
// don't shrink, counter-axis alignment starts at flex-start).
import {
	checkScreen,
	type DesignProject,
	modeTokens,
	resolveProp,
	type ScreenFile,
	type ScreenSize,
	tokensCss,
} from "@figma-agent-tool/design-project";

const RESET = `*, *::before, *::after {
  box-sizing: border-box; margin: 0; padding: 0; border: 0;
  flex-shrink: 0; min-width: 0; min-height: 0; align-items: flex-start;
  font-family: Inter, sans-serif; font-size: 16px; font-weight: 400;
  font-style: normal; line-height: normal; color: #000000; text-align: left;
}
html { background: transparent; }
body { overflow: hidden; }
img { display: block; object-fit: cover; }`;

export type DocumentOptions = {
	/** The URL the Screen's relative `src`s resolve against: its folder. */
	baseUrl: string;
	/** Extra markup for <head>, such as the Preview's live-reload script. */
	head?: string;
	/** The Mode whose token values to show; the default Mode when absent. */
	mode?: string;
};

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
	{ baseUrl, head = "", mode }: DocumentOptions,
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
		"</style>",
		head,
		"</head>",
		screen.source.trim(),
		"</html>",
		"",
	].join("\n");
}
