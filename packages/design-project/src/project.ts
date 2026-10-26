// A Design Project on disk: project.json (the Screen Size and Screens Page),
// DESIGN.md and its Modes file, Screens in screens/ with their Directions in
// screens/<Screen>.directions/, Components in components/, images
// (anywhere, by convention assets/) and the committed sync state in sync/.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
	type ComponentDefinition,
	componentDefinition,
	type LinkedComponentFile,
	type LinkedComponentRecord,
	parseLinkedComponent,
} from "./components";
import { parseDesignMd, type TokenFields, type Tokens } from "./design-md";
import { designSystemPush } from "./design-system";
import { DesignProjectError } from "./errors";
import { checkModes, lineOf, lintDesignMd } from "./lint";
import { MODES_FILE, type Modes, parseModes } from "./modes";
import { resolveProp } from "./resolve";
import {
	type CheckError,
	type ComponentInfo,
	type Element,
	parseComponent,
	parseScreen,
} from "./screen";
import { COMPONENT_SET_TAG, FIGMA_OWNED_TAG, isComponentTag } from "./subset";

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
	/** Name of the Linked File's page that Directions are copied to. */
	explorationsPage: string;
};

export type ScreenFile = {
	/** The file name without `.html`; the frame's name in Figma. */
	name: string;
	/** Relative to the Design Project, with forward slashes. */
	file: string;
	path: string;
	source: string;
	/** For a Direction: the Screen it's a Direction of. */
	of?: string;
};

/** One of several alternative versions of a Screen, in screens/<Screen>.directions/. */
export type DirectionFile = ScreenFile & {
	of: string;
	/** The file name without `.html`. */
	direction: string;
};

export type DesignProject = {
	dir: string;
	config: ProjectConfig;
	/** DESIGN.md's source; "" when there is none. */
	designMd: string;
	tokens: Tokens;
	/** DESIGN.md's token fields as written. */
	fields: TokenFields;
	designMdErrors: CheckError[];
	/** The Modes file: the tokens' values in the other Modes. */
	modes: Modes;
	screens: ScreenFile[];
	/** Every Screen's Directions, by Screen and then by name. */
	directions: DirectionFile[];
	/** Defined Components' files, named after their custom element. */
	components: ScreenFile[];
	/** Linked Components' files. */
	linkedComponents: LinkedComponentFile[];
};

export { DesignProjectError };

const CONFIG_FILE = "project.json";
const DIRECTIONS = ".directions";

export function screenPath(project: { dir: string }, name: string): string {
	return join(project.dir, "screens", `${name}.html`);
}

/** Where Push keeps what it read of a Linked Component in Figma. */
export function linkedComponentPath(
	project: { dir: string },
	name: string,
): string {
	return join(project.dir, "sync", "linked", `${name}.json`);
}

/** Whether a file of the Design Project is a Defined Component's. */
export function isComponentFile(file: { file: string }): boolean {
	return file.file.startsWith("components/");
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
	const { tokens, fields, errors } = parseDesignMd(designMd);
	const modesPath = join(root, MODES_FILE);
	const modes = parseModes(
		existsSync(modesPath) ? await readFile(modesPath, "utf8") : "",
	);
	const screensDir = join(root, "screens");
	const entries = existsSync(screensDir)
		? (await readdir(screensDir, { withFileTypes: true })).sort((a, b) =>
				a.name.localeCompare(b.name),
			)
		: [];
	const screens = await readScreenFiles(
		root,
		entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
	);
	const directions = (
		await Promise.all(
			entries
				.filter(
					(entry) => entry.isDirectory() && entry.name.endsWith(DIRECTIONS),
				)
				.map(async (entry) => {
					const of = entry.name.slice(0, -DIRECTIONS.length);
					const files = await readScreenFiles(
						root,
						(await readdir(join(screensDir, entry.name))).sort(),
						entry.name,
					);
					return files.map(({ name, ...file }) => ({
						...file,
						name: directionName(of, name),
						of,
						direction: name,
					}));
				}),
		)
	).flat();
	const componentsDir = join(root, "components");
	const componentNames = existsSync(componentsDir)
		? (await readdir(componentsDir)).sort()
		: [];
	const components = await readFiles(root, "components", componentNames);
	const linkedComponents = await Promise.all(
		componentNames
			.filter((fileName) => fileName.endsWith(".json"))
			.map(async (fileName): Promise<LinkedComponentFile> => {
				const name = fileName.slice(0, -".json".length);
				const path = join(componentsDir, fileName);
				const source = await readFile(path, "utf8");
				const parsed = parseLinkedComponent(source);
				const recordPath = linkedComponentPath({ dir: root }, name);
				const record: LinkedComponentRecord | undefined = existsSync(recordPath)
					? JSON.parse(await readFile(recordPath, "utf8"))
					: undefined;
				return {
					name,
					file: `components/${fileName}`,
					path,
					source,
					...("problem" in parsed ? {} : parsed),
					...(record && { record }),
				};
			}),
	);
	return {
		dir: root,
		config,
		designMd,
		tokens,
		fields,
		designMdErrors: errors.map(({ line, rule, message }) => ({
			file: "DESIGN.md",
			line,
			element: "",
			rule,
			message,
		})),
		modes,
		screens,
		directions,
		components,
		linkedComponents,
	};
}

/** The HTML files among `fileNames` in screens/ (or a folder in it), read. */
function readScreenFiles(
	root: string,
	fileNames: string[],
	folder?: string,
): Promise<ScreenFile[]> {
	return readFiles(root, folder ? `screens/${folder}` : "screens", fileNames);
}

/** The HTML files among `fileNames` in a folder of the Design Project, read. */
function readFiles(
	root: string,
	relativeDir: string,
	fileNames: string[],
): Promise<ScreenFile[]> {
	return Promise.all(
		fileNames
			.filter((fileName) => fileName.endsWith(".html"))
			.map(async (fileName) => {
				const path = join(root, relativeDir, fileName);
				return {
					name: fileName.slice(0, -".html".length),
					file: `${relativeDir}/${fileName}`,
					path,
					source: await readFile(path, "utf8"),
				};
			}),
	);
}

/** A Direction's name: its frame's name when it's copied to the Explorations Page. */
export function directionName(screen: string, direction: string): string {
	return `${screen} / ${direction}`;
}

/** The folder holding a Screen's Directions. */
export function directionsPath(project: { dir: string }, screen: string) {
	return join(project.dir, "screens", `${screen}${DIRECTIONS}`);
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
		explorationsPage: data.explorationsPage || "Explorations",
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
	{
		screenSize = DEFAULT_SCREEN_SIZE,
		screensPage = "Screens",
	}: { screenSize?: ScreenSize; screensPage?: string } = {},
): Promise<{ dir: string; created: string[] }> {
	const root = resolve(dir);
	if (existsSync(join(root, CONFIG_FILE))) {
		throw new DesignProjectError(`${root} already holds a Design Project.`);
	}
	const config: ProjectConfig = {
		screenSize,
		screensPage,
		explorationsPage: "Explorations",
	};
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

/**
 * Checks every Screen against the Screen Subset, DESIGN.md against the spec
 * and the Modes file against DESIGN.md. Warnings (low contrast, tokens Figma
 * can't hold) don't stop a Push.
 */
export async function checkProject(project: DesignProject): Promise<{
	errors: CheckError[];
	warnings: CheckError[];
	screens: ParsedScreen[];
}> {
	const screens = project.screens.map((screen) => checkScreen(project, screen));
	const directions = project.directions.map((direction) =>
		checkScreen(project, direction),
	);
	const components = checkComponents(project);
	const designMd = checkDesignMd(project);
	// Modes are checked against DESIGN.md's tokens, so it must read first.
	const modes =
		designMd.errors.length > 0
			? { errors: [], warnings: [] }
			: checkModes(project);
	return {
		errors: [
			...designMd.errors,
			...modes.errors,
			...components,
			...screens.flatMap((screen) => screen.errors),
			...directions.flatMap((direction) => direction.errors),
		],
		warnings: [...designMd.warnings, ...modes.warnings],
		screens,
	};
}

/** DESIGN.md's errors and warnings: it must parse before the spec's linter runs. */
export function checkDesignMd(project: DesignProject): {
	errors: CheckError[];
	warnings: CheckError[];
} {
	if (project.designMdErrors.length > 0 || !project.designMd) {
		return { errors: project.designMdErrors, warnings: [] };
	}
	const { errors, warnings } = lintDesignMd(project.designMd);
	// A token the spec already rejects needn't be reported twice.
	const invalid = new Set(errors.map((error) => error.element));
	const unpushable = designSystemPush(project.fields)
		.warnings.filter(({ path }) => !invalid.has(path))
		.map(({ path, message }) => ({
			file: "DESIGN.md",
			line: lineOf(project.designMd, path),
			element: path,
			rule: "figma-unsupported",
			message,
		}));
	return { errors, warnings: [...warnings, ...unpushable] };
}

/** Checks a Screen, Direction or Defined Component's file. */
export function checkScreen(
	project: DesignProject,
	screen: ScreenFile,
): ParsedScreen {
	const parse = isComponentFile(screen) ? parseComponent : parseScreen;
	const { root, errors } = parse(screen.file, screen.source, {
		tokens: project.tokens,
		imageExists: (src) => {
			const path = imagePath(project, screen, src);
			return path !== undefined && existsSync(path);
		},
		screenExists: (name) => project.screens.some((s) => s.name === name),
		component: (name) => componentInfos(project).get(name),
	});
	return { ...screen, root, errors };
}

const infos = new WeakMap<DesignProject, Map<string, ComponentInfo>>();

/** Every Component by name, with its properties when known. */
export function componentInfos(
	project: DesignProject,
): Map<string, ComponentInfo> {
	let found = infos.get(project);
	if (found) return found;
	found = new Map();
	for (const linked of project.linkedComponents) {
		const { record } = linked;
		found.set(linked.name, {
			linked: true,
			...(record && {
				definition: {
					properties: record.properties,
					...(record.variants && { variants: record.variants }),
				},
			}),
		});
	}
	for (const component of project.components) {
		const { root } = parseComponent(component.file, component.source, {
			tokens: project.tokens,
			imageExists: () => true,
			screenExists: () => true,
		});
		found.set(component.name, {
			linked: false,
			...(root && { definition: componentDefinition(root) }),
		});
	}
	infos.set(project, found);
	return found;
}

/** A Component's properties, when known. */
export function definitionOf(
	project: DesignProject,
	name: string,
): ComponentDefinition | undefined {
	return componentInfos(project).get(name)?.definition;
}

/** Errors of the files in components/: their names, Linked Components' JSON, Defined Components' markup. */
function checkComponents(project: DesignProject): CheckError[] {
	const error = (file: string, rule: string, message: string) => ({
		file,
		line: 1,
		element: "",
		rule,
		message,
	});
	const all = [...project.components, ...project.linkedComponents];
	return all.flatMap((component): CheckError[] => {
		if (
			!isComponentTag(component.name) ||
			component.name === COMPONENT_SET_TAG
		) {
			return [
				error(
					component.file,
					"invalid-component-name",
					`${component.file} isn't a Component name: Screens use a Component as a custom element named after its file, so it's lower case with a hyphen, as in components/app-button.html (not ${FIGMA_OWNED_TAG} or ${COMPONENT_SET_TAG}).`,
				),
			];
		}
		if (all.filter((c) => c.name === component.name).length > 1) {
			return [
				error(
					component.file,
					"duplicate-component",
					`${component.name} is both Defined (components/${component.name}.html) and Linked (components/${component.name}.json): keep one.`,
				),
			];
		}
		if (component.file.endsWith(".json")) {
			const parsed = parseLinkedComponent(component.source);
			return "problem" in parsed
				? [
						error(
							component.file,
							"invalid-linked-component",
							`${component.file} ${parsed.problem}.`,
						),
					]
				: [];
		}
		return checkScreen(project, component).errors;
	});
}

/**
 * The Screen Size a Screen or Direction is designed at: its <body> override,
 * else (for a Direction) its Screen's, else the project's.
 */
export function screenSizeOf(
	project: DesignProject,
	screen: ScreenFile,
): ScreenSize {
	const { root } = checkScreen(project, screen);
	const width = root && Number(resolveProp(root, "width", project.tokens));
	const height = root && Number(resolveProp(root, "height", project.tokens));
	return width && height
		? { width, height }
		: defaultScreenSize(project, screen);
}

/** The Screen Size a Screen or Direction has without a <body> override. */
export function defaultScreenSize(
	project: DesignProject,
	screen: { of?: string },
): ScreenSize {
	const of = screen.of && project.screens.find((s) => s.name === screen.of);
	return of ? screenSizeOf(project, of) : project.config.screenSize;
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
