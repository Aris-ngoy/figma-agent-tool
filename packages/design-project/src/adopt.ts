// Adopt: starting a Design Project from a Figma file designers made. Its
// variables and text styles become DESIGN.md (and the Modes file), its
// frames Screens (see adoptFrame), the components its instances are of
// Linked Components. Only what Push would write back unchanged is adopted,
// so a Push straight after Adopt changes nothing in Figma.
import type {
	DesignSystemPush,
	SyncedDesignSystem,
	TextStyleInfo,
	VariableCollectionInfo,
	VariableValue,
} from "@figma-agent-tool/protocol";
import type { TokenFields } from "./design-md";
import { parseDesignMd } from "./design-md";
import {
	type DesignSystemBaseline,
	designSystemChanges,
	designSystemPush,
	figmaDesignSystem,
	VARIABLE_GROUPS,
	type VariableGroup,
} from "./design-system";
import { parseModes } from "./modes";
import { COMPONENT_SET_TAG, FIGMA_OWNED_TAG, isComponentTag } from "./subset";

/** `Task Details` → `task-details`: lower case, hyphens between words. */
export function slug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** `name`, or `name-2`, `name-3`, … : the first `taken` doesn't have yet, which it then has. */
function unique(name: string, taken: Set<string>): string {
	let found = name;
	for (let n = 2; taken.has(found); n++) found = `${name}-${n}`;
	taken.add(found);
	return found;
}

/** Each frame's Screen name, by frame ID: its name as a file name, unique. */
export function adoptedScreenNames(
	frames: { id: string; name: string }[],
): Map<string, string> {
	const taken = new Set<string>();
	return new Map(
		frames.map(({ id, name }) => [id, unique(slug(name) || "screen", taken)]),
	);
}

/**
 * Each component's Linked Component name, by component ID: a custom
 * element, so `Button` is `app-button` and `Nav Bar` is `nav-bar`.
 */
export function adoptedComponentNames(
	components: { componentId: string; name: string }[],
): Map<string, string> {
	const taken = new Set([FIGMA_OWNED_TAG, COMPONENT_SET_TAG]);
	return new Map(
		components.map(({ componentId, name }) => {
			const base = slug(name);
			const tag = isComponentTag(base) ? base : `app-${base || "component"}`;
			return [componentId, unique(tag, taken)];
		}),
	);
}

/** Words a variable's name may start with that say which DESIGN.md group it's in. */
const GROUP_WORDS: Record<string, VariableGroup> = {
	color: "colors",
	colors: "colors",
	colour: "colors",
	colours: "colors",
	space: "spacing",
	spacing: "spacing",
	spacer: "spacing",
	spacers: "spacing",
	radius: "rounded",
	radii: "rounded",
	rounded: "rounded",
	corner: "rounded",
	corners: "rounded",
	"corner-radius": "rounded",
};

/**
 * A variable's DESIGN.md token path: colors for colors; numbers are
 * rounded when their name or scopes say they're radii, spacing otherwise.
 * A leading word naming the group is dropped: `Color/Primary` is
 * `colors.primary`.
 */
function variableToken(variable: {
	name: string;
	type: "COLOR" | "FLOAT";
	scopes?: string[];
}): { group: VariableGroup; name: string } {
	const words = variable.name.split("/").map(slug).filter(Boolean);
	const named = GROUP_WORDS[words[0] ?? ""];
	const radius =
		(variable.scopes?.length === 1 && variable.scopes[0] === "CORNER_RADIUS") ||
		words.some((word) => /radius|radii|rounded|corner/.test(word));
	let group: VariableGroup = "spacing";
	if (variable.type === "COLOR") group = "colors";
	else if (named && VARIABLE_GROUPS[named] === "FLOAT") group = named;
	else if (radius) group = "rounded";
	const rest = named === group && words.length > 1 ? words.slice(1) : words;
	return { group, name: rest.join("-") || "token" };
}

/** What Adopt takes of a file's Design System, before reading its values. */
export type DesignSystemToAdopt = Omit<
	DesignSystemBaseline,
	"source" | "modesSource"
> & {
	/** Variables and text styles left in Figma, and why. */
	notAdopted: string[];
};

/**
 * The tokens a file's variables and text styles become: those of its
 * collection with the most color and number variables (its modes the
 * Modes), and every text style.
 */
export function designSystemToAdopt({
	collections,
	textStyles,
}: {
	collections: VariableCollectionInfo[];
	textStyles: TextStyleInfo[];
}): DesignSystemToAdopt {
	const adoptable = (collection: VariableCollectionInfo) =>
		collection.variables.filter(
			(variable) => variable.type === "COLOR" || variable.type === "FLOAT",
		);
	const [collection] = [...collections].sort(
		(a, b) => adoptable(b).length - adoptable(a).length,
	);
	const notAdopted: string[] = [];
	const variables: Record<string, string> = {};
	const names: Record<string, string> = {};
	const taken = new Set<string>();
	for (const other of collections) {
		for (const variable of other.variables) {
			if (other !== collection) {
				notAdopted.push(
					`variable “${variable.name}”: it's in the collection “${other.name}”, and Push keeps the Design System in one collection (“${collection?.name}”)`,
				);
			} else if (variable.type !== "COLOR" && variable.type !== "FLOAT") {
				notAdopted.push(
					`variable “${variable.name}”: DESIGN.md has no ${variable.type.toLowerCase()} tokens`,
				);
			} else {
				const { group, name } = variableToken({
					...variable,
					type: variable.type,
				});
				const token = unique(`${group}.${name}`, taken);
				variables[token] = variable.id;
				names[token] = variable.name;
			}
		}
	}
	const styles: Record<string, string> = {};
	const styleNames = new Set<string>();
	for (const style of textStyles) {
		const token = `typography.${unique(slug(style.name) || "style", styleNames)}`;
		styles[token] = style.id;
		names[token] = style.name;
	}
	const modes =
		collection && collection.modes.length > 1 ? collection : undefined;
	return {
		collectionId: collection?.id ?? "",
		variables,
		textStyles: styles,
		...(modes && {
			// The default first, as Baselines list them.
			modes: Object.fromEntries(
				[...modes.modes]
					.sort(
						(a, b) =>
							Number(b.name === modes.defaultMode) -
							Number(a.name === modes.defaultMode),
					)
					.map(({ id, name }) => [name, id]),
			),
		}),
		names,
		notAdopted,
	};
}

export type AdoptedDesignSystem = {
	/** DESIGN.md, holding the default mode's values. */
	designMd: string;
	/** The Modes file; "" with one mode. */
	modesSource: string;
	baseline: DesignSystemBaseline;
	notAdopted: string[];
};

/**
 * DESIGN.md and the Modes file from the variables and text styles read,
 * with the Baseline that links their tokens to them. A token Push wouldn't
 * write back as Figma has it (a text style DESIGN.md can't describe, a
 * variable aliasing one that isn't adopted) stays in Figma.
 */
export function adoptDesignSystem(
	fileName: string,
	toAdopt: DesignSystemToAdopt,
	read: SyncedDesignSystem,
): AdoptedDesignSystem {
	const { notAdopted: skipped, ...base } = toAdopt;
	const notAdopted = [...skipped];
	let baseline: DesignSystemBaseline = { ...base, source: "" };
	// Leaving a token out can change those aliasing it, so until none differ.
	for (;;) {
		const written = writeDesignSystem(fileName, baseline, read);
		const differing = differingTokens(written, read);
		if (differing.length === 0) {
			return { ...written, notAdopted };
		}
		for (const token of differing) {
			notAdopted.push(
				`${token in baseline.variables ? "variable" : "text style"} “${baseline.names?.[token] ?? token}”: DESIGN.md can't hold it as Figma has it`,
			);
		}
		baseline = withoutTokens(baseline, differing);
	}
}

function withoutTokens(
	baseline: DesignSystemBaseline,
	tokens: string[],
): DesignSystemBaseline {
	const keep = <T>(record: Record<string, T>) =>
		Object.fromEntries(
			Object.entries(record).filter(([token]) => !tokens.includes(token)),
		);
	return {
		...baseline,
		variables: keep(baseline.variables),
		textStyles: keep(baseline.textStyles),
		names: keep(baseline.names ?? {}),
	};
}

function writeDesignSystem(
	fileName: string,
	baseline: DesignSystemBaseline,
	read: SyncedDesignSystem,
): Omit<AdoptedDesignSystem, "notAdopted"> {
	const figma = figmaDesignSystem(read, baseline);
	const designMd = printDesignMd(fileName, figma.fields);
	const fields = parseDesignMd(designMd).fields;
	const [defaultMode, ...otherModes] = Object.keys(baseline.modes ?? {});
	// The Modes' values that differ from the default's.
	const modeValues = designSystemChanges(fields, figma).flatMap((path) => {
		const match = /^modes\.([^.]+)\.(.+)$/.exec(path);
		if (!match) return [];
		const [, mode, token] = match as unknown as [string, string, string];
		return [{ mode, token, value: figma.modes.get(mode)?.get(token) ?? "" }];
	});
	const modesSource = defaultMode
		? printModes(defaultMode, otherModes, modeValues)
		: "";
	const kept = <T>(record: Record<string, T>) =>
		Object.fromEntries(
			Object.entries(record).filter(([token]) => figma.tokens.has(token)),
		);
	return {
		designMd,
		modesSource,
		baseline: {
			...baseline,
			source: designMd,
			...(modesSource && { modesSource }),
			variables: kept(baseline.variables),
			textStyles: kept(baseline.textStyles),
			names: kept(baseline.names ?? {}),
		},
	};
}

/** Tokens Push would send otherwise than Figma has them. */
function differingTokens(
	{ baseline, modesSource }: Omit<AdoptedDesignSystem, "notAdopted">,
	read: SyncedDesignSystem,
): string[] {
	const { push } = designSystemPush(
		parseDesignMd(baseline.source).fields,
		baseline,
		parseModes(modesSource),
	);
	const variables = new Map(read.variables.map((v) => [v.id, v]));
	const tokenOf = new Map(
		Object.entries(baseline.variables).map(([token, id]) => [id, token]),
	);
	const asPushed = (value: VariableValue | null | undefined) => {
		if (value && typeof value === "object" && "alias" in value)
			return { token: tokenOf.get(value.alias) };
		if (value && typeof value === "object" && "color" in value)
			return value.opacity === undefined || value.opacity === 1
				? { color: value.color.toLowerCase() }
				: { color: value.color.toLowerCase(), opacity: value.opacity };
		return value;
	};
	const same = (a: unknown, b: unknown) =>
		JSON.stringify(a) === JSON.stringify(b);
	const [, ...otherModes] = Object.entries(baseline.modes ?? {});
	const differing = push.variables.flatMap((pushed) => {
		const variable = variables.get(pushed.id ?? "");
		if (!variable || !same(pushed.value, asPushed(variable.value)))
			return [pushed.token];
		const inModes = otherModes.every(([mode, modeId]) =>
			same(
				pushed.modes?.[mode] ?? pushed.value,
				asPushed(variable.modes?.[modeId]?.value ?? variable.value),
			),
		);
		return inModes ? [] : [pushed.token];
	});
	const styles = new Map(read.textStyles.map((style) => [style.id, style]));
	for (const pushed of push.textStyles) {
		const style = styles.get(pushed.id ?? "");
		if (!style || !sameTextStyle(pushed, style)) differing.push(pushed.token);
	}
	return differing;
}

function sameTextStyle(
	pushed: DesignSystemPush["textStyles"][number],
	style: TextStyleInfo,
): boolean {
	const spacing = (value: TextStyleInfo["letterSpacing"]) =>
		value && value.value !== 0 ? value : undefined;
	return (
		pushed.fontName.family === style.fontName.family &&
		pushed.fontName.style === style.fontName.style &&
		pushed.fontSize === style.fontSize &&
		JSON.stringify(pushed.lineHeight) === JSON.stringify(style.lineHeight) &&
		JSON.stringify(spacing(pushed.letterSpacing)) ===
			JSON.stringify(spacing(style.letterSpacing))
	);
}

/** Group order in DESIGN.md's front matter. */
const GROUPS = ["colors", "typography", "rounded", "spacing"];

/** DESIGN.md with these token fields, and a heading for the Agent to describe the Design System under. */
export function printDesignMd(name: string, fields: TokenFields): string {
	const lines = ["---", "version: alpha", `name: ${scalar(name)}`];
	for (const group of GROUPS) {
		const paths = [...fields.keys()].filter((path) =>
			path.startsWith(`${group}.`),
		);
		if (paths.length === 0) continue;
		lines.push(`${group}:`);
		let token = "";
		for (const path of paths) {
			const [, name, field] = path.split(".") as [string, string, string?];
			const value = scalar(fields.get(path) as string, group === "colors");
			if (field === undefined) {
				lines.push(`  ${name}: ${value}`);
				continue;
			}
			if (name !== token) lines.push(`  ${name}:`);
			token = name;
			lines.push(`    ${field}: ${value}`);
		}
	}
	lines.push(
		"---",
		"",
		`# ${name}`,
		"",
		`Adopted from the Figma file “${name}”. Describe the Design System's intent`,
		"here: the brand, the mood, and how the tokens above are meant to be used.",
		"",
	);
	return lines.join("\n");
}

/** The Modes file: the default Mode's name, and each other Mode's values that differ from it. */
function printModes(
	defaultMode: string,
	others: string[],
	values: { mode: string; token: string; value: string }[],
): string {
	const lines = [`default: ${scalar(defaultMode)}`, "modes:"];
	for (const mode of others) {
		const inMode = values.filter((value) => value.mode === mode);
		if (inMode.length === 0) {
			lines.push(`  ${scalar(mode)}: {}`);
			continue;
		}
		lines.push(`  ${scalar(mode)}:`);
		let group = "";
		for (const { token, value } of inMode) {
			const [tokenGroup, name] = token.split(".") as [string, string];
			if (tokenGroup !== group) lines.push(`    ${tokenGroup}:`);
			group = tokenGroup;
			lines.push(`      ${name}: ${scalar(value, tokenGroup === "colors")}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

/** A YAML scalar: quoted where YAML would read it as something else. */
function scalar(value: string, quoted = false): string {
	return quoted || !/^[A-Za-z0-9][\w .%-]*$/.test(value)
		? JSON.stringify(value)
		: value;
}
