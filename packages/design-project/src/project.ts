// A Design Project on disk: project.json (the Screen Size and Screens Page),
// DESIGN.md, Screens in screens/, images (anywhere, by convention assets/)
// and the committed sync state in sync/.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseDesignMd, type Tokens } from "./design-md";
import { type CheckError, type Element, parseScreen } from "./screen";

/** Relative to the working directory. */
export const DEFAULT_DESIGN_DIR = "design";

export type ScreenSize = { width: number; height: number };

/** iPhone 15/16: a common default device. */
export const DEFAULT_SCREEN_SIZE: ScreenSize = { width: 393, height: 852 };

export type ProjectConfig = {
	/** The default Screen Size; a Screen overrides it with <body> width and height. */
	screenSize: ScreenSize;
	/** Name of the Linked File's page holding the Screens' frames. */
	screensPage: string;
};

export type ScreenFile = {
	/** The file name without `.html`; the frame's name in Figma. */
	name: string;
	/** Relative to the Design Project, with forward slashes. */
	file: string;
	path: string;
	source: string;
};

export type DesignProject = {
	dir: string;
	config: ProjectConfig;
	tokens: Tokens;
	designMdErrors: CheckError[];
	screens: ScreenFile[];
};

export class DesignProjectError extends Error {}

const CONFIG_FILE = "project.json";

export function screenPath(project: { dir: string }, name: string): string {
	return join(project.dir, "screens", `${name}.html`);
}

export async function loadProject(dir: string): Promise<DesignProject> {
	const root = resolve(dir);
	const configPath = join(root, CONFIG_FILE);
	if (!existsSync(configPath)) {
		throw new DesignProjectError(
			`No Design Project in ${root}: ${CONFIG_FILE} is missing. Create one with init.`,
		);
	}
	const config = parseConfig(await readFile(configPath, "utf8"), configPath);
	const designMdPath = join(root, "DESIGN.md");
	const designMd = existsSync(designMdPath)
		? await readFile(designMdPath, "utf8")
		: "";
	const { tokens, errors } = parseDesignMd(designMd);
	const screensDir = join(root, "screens");
	const names = existsSync(screensDir)
		? (await readdir(screensDir))
				.filter((file) => file.endsWith(".html"))
				.sort()
		: [];
	const screens = await Promise.all(
		names.map(async (fileName) => {
			const path = join(screensDir, fileName);
			return {
				name: fileName.slice(0, -".html".length),
				file: `screens/${fileName}`,
				path,
				source: await readFile(path, "utf8"),
			};
		}),
	);
	return {
		dir: root,
		config,
		tokens,
		designMdErrors: errors.map(({ line, message }) => ({
			file: "DESIGN.md",
			line,
			element: "",
			rule: "design-md",
			message,
		})),
		screens,
	};
}

function parseConfig(text: string, path: string): ProjectConfig {
	let data: Partial<ProjectConfig>;
	try {
		data = JSON.parse(text);
	} catch (error) {
		throw new DesignProjectError(
			`${path} isn't valid JSON: ${(error as Error).message}`,
		);
	}
	const size = data.screenSize;
	if (!size || !(Number(size.width) > 0) || !(Number(size.height) > 0)) {
		throw new DesignProjectError(
			`${path} needs a "screenSize" with a positive "width" and "height" in px.`,
		);
	}
	return {
		screenSize: { width: Number(size.width), height: Number(size.height) },
		screensPage: data.screensPage || "Screens",
	};
}

const DESIGN_MD_TEMPLATE = `---
version: alpha
name: My App
colors:
  primary: "#3366ff"
  on-primary: "#ffffff"
  surface: "#ffffff"
  text: "#111111"
typography:
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 400
rounded:
  md: 8px
spacing:
  sm: 8px
  md: 16px
  lg: 24px
---

# My App

Describe the Design System's intent here: the brand, the mood, and how the
tokens above are meant to be used. Screens use the tokens as CSS variables,
named after their path: \`var(--colors-primary)\`, \`var(--spacing-md)\`,
\`var(--typography-body-md-font-size)\`.
`;

/** Creates a Design Project in `dir`; refuses if one is already there. */
export async function initProject(
	dir: string,
	{ screenSize = DEFAULT_SCREEN_SIZE }: { screenSize?: ScreenSize } = {},
): Promise<{ dir: string; created: string[] }> {
	const root = resolve(dir);
	if (existsSync(join(root, CONFIG_FILE))) {
		throw new DesignProjectError(`${root} already holds a Design Project.`);
	}
	const config: ProjectConfig = { screenSize, screensPage: "Screens" };
	const files: [string, string][] = [
		[CONFIG_FILE, `${JSON.stringify(config, null, "\t")}\n`],
	];
	if (!existsSync(join(root, "DESIGN.md")))
		files.push(["DESIGN.md", DESIGN_MD_TEMPLATE]);
	await mkdir(join(root, "screens"), { recursive: true });
	await mkdir(join(root, "assets"), { recursive: true });
	for (const [name, content] of files)
		await writeFile(join(root, name), content);
	return {
		dir: root,
		created: [...files.map(([name]) => name), "screens/", "assets/"],
	};
}

export type ParsedScreen = ScreenFile & {
	root?: Element;
	errors: CheckError[];
};

/** Checks DESIGN.md and every Screen against the Screen Subset. */
export async function checkProject(
	project: DesignProject,
): Promise<{ errors: CheckError[]; screens: ParsedScreen[] }> {
	const screens = project.screens.map((screen) => checkScreen(project, screen));
	return {
		errors: [
			...project.designMdErrors,
			...screens.flatMap((screen) => screen.errors),
		],
		screens,
	};
}

export function checkScreen(
	project: DesignProject,
	screen: ScreenFile,
): ParsedScreen {
	const { root, errors } = parseScreen(screen.file, screen.source, {
		tokens: project.tokens,
		imageExists: (src) => {
			const path = imagePath(project, screen, src);
			return path !== undefined && existsSync(path);
		},
	});
	return { ...screen, root, errors };
}

/** An image's path from its `src`; undefined if it points outside the project. */
export function imagePath(
	project: { dir: string },
	screen: { path: string },
	src: string,
): string | undefined {
	const path = resolve(dirname(screen.path), src);
	const inside = relative(project.dir, path);
	return inside.startsWith("..") || inside.startsWith(sep) ? undefined : path;
}
