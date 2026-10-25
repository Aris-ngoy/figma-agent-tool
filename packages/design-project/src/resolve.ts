// What an element means, independent of how it's written: tokens resolved,
// units dropped, defaults filled in. Pull compares elements this way, so
// `var(--colors-primary)` in the file and `#3366ff` read from Figma match.
import { type ComponentDefinition, instanceProperties } from "./components";
import type { Tokens } from "./design-md";
import { linkedScreen, resolveTransition } from "./link";
import { formatPath, parsePath, transformPath } from "./path";
import type { ScreenSize } from "./project";
import type { Element, VectorPath } from "./screen";
import {
	COMPONENT_TAG,
	DEFAULT_NAMES,
	defaultValue,
	PROP_NAMES,
	PROPS,
	type Prop,
	resolveValue,
} from "./subset";

export type ResolveContext = {
	tokens: Tokens;
	/** The Screen's name; a Component's, for its file. */
	screenName: string;
	screenSize: ScreenSize;
	/** Components' properties, for the defaults of those an instance doesn't set. */
	components?: (name: string) => ComponentDefinition | undefined;
};

/**
 * Own fields (not children): `@kind`, `@name`, `@text`, `@src`, a link's
 * `@href` and `@transition`, an instance's `@component` and `@prop:<name>`
 * per property, a Component's text's `@property`, and props.
 */
export type ResolvedElement = Record<string, string>;

export function resolveElement(
	element: Element,
	context: ResolveContext,
	isRoot: boolean,
): ResolvedElement {
	const resolved: ResolvedElement = {
		"@kind": element.kind,
		"@name": element.name ?? defaultName(element, context, isRoot),
	};
	if (element.kind === "text") resolved["@text"] = element.text ?? "";
	if (element.kind === "image") resolved["@src"] = element.src ?? "";
	if (element.kind === "instance") {
		resolved["@component"] = element.tag;
		const properties = instanceProperties(
			context.components?.(element.tag),
			element.properties,
		);
		for (const [name, value] of Object.entries(properties))
			resolved[`@prop:${name}`] = value;
	}
	if (element.property !== undefined) resolved["@property"] = element.property;
	if (element.href !== undefined) {
		resolved["@href"] = linkedScreen(element.href) ?? element.href;
		resolved["@transition"] = resolveTransition(element.transition);
	}
	for (const prop of PROP_NAMES) {
		if (!(PROPS[prop].kinds as string[]).includes(element.kind)) continue;
		resolved[prop] = resolveProp(element, prop, context.tokens);
	}
	if (isRoot) {
		resolved.width ||= String(context.screenSize.width);
		resolved.height ||= String(context.screenSize.height);
	}
	if (element.kind === "vector") {
		const { paths, scale } = vectorGeometry(element, resolved);
		resolved["@paths"] = paths
			.map((path) => `${path.windingRule} ${path.data}`)
			.join(" | ");
		resolved["stroke-width"] = String(
			round(Number(resolved["stroke-width"]) * scale),
		);
	}
	return resolved;
}

export type VectorPathData = {
	data: string;
	windingRule: "NONZERO" | "EVENODD";
};

/**
 * A vector's paths in its own pixels, as Figma holds them: its viewBox
 * scales and centers them in its size, as a browser does, and scales its
 * stroke by `scale`.
 */
export function vectorGeometry(
	element: Element,
	resolved: { width?: string; height?: string },
): { paths: VectorPathData[]; scale: number } {
	const [width, height] = [Number(resolved.width), Number(resolved.height)];
	const [minX = 0, minY = 0, boxWidth = width, boxHeight = height] =
		element.viewBox
			?.trim()
			.split(/[\s,]+/)
			.map(Number) ?? [];
	const scale = Math.min(width / boxWidth, height / boxHeight);
	const dx = (width - boxWidth * scale) / 2 - minX * scale;
	const dy = (height - boxHeight * scale) / 2 - minY * scale;
	const paths = (element.paths ?? []).flatMap((path) => {
		const commands = parsePath(path.d);
		if ("problem" in commands) return [];
		return [
			{
				data: formatPath(transformPath(commands, scale, dx, dy)),
				windingRule:
					path.fillRule === "evenodd"
						? ("EVENODD" as const)
						: ("NONZERO" as const),
			},
		];
	});
	return { paths, scale };
}

/**
 * The same vector without a viewBox: paths in its own pixels and its stroke
 * width scaled, as Pull writes vectors.
 */
export function withoutViewBox(
	element: Element,
	context: ResolveContext,
): Element {
	if (element.viewBox === undefined) return element;
	const resolved = resolveElement(element, context, false);
	const { paths } = vectorGeometry(element, resolved);
	const props = { ...element.props };
	if (props["stroke-width"] !== undefined)
		props["stroke-width"] = `${resolved["stroke-width"]}px`;
	return {
		...element,
		viewBox: undefined,
		props,
		paths: paths.map(({ data, windingRule }) => vectorPath(data, windingRule)),
	};
}

/** A path as a Screen writes it: `fill-rule` only when it's evenodd. */
export function vectorPath(d: string, windingRule: string): VectorPath {
	return windingRule === "EVENODD" ? { d, fillRule: "evenodd" } : { d };
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

export function resolveProp(
	element: Element,
	prop: Prop,
	tokens: Tokens,
): string {
	const raw = element.props[prop];
	if (raw === undefined) return defaultValue(prop);
	const resolved = resolveValue(prop, raw, tokens);
	// Checked Screens always resolve; anything else counts as the raw text.
	return "value" in resolved ? resolved.value : raw;
}

/** The layer name Figma shows for an element without `data-name`. */
export function defaultName(
	element: Element,
	context: { screenName: string },
	isRoot: boolean,
): string {
	if (isRoot || element.tag === COMPONENT_TAG) return context.screenName;
	if (element.kind === "text") return element.text ?? "";
	if (element.kind === "instance") return element.tag;
	return DEFAULT_NAMES[element.kind];
}

/** Resolve contexts for two versions of an element, which may differ in tokens. */
export type ContextPair = { a: ResolveContext; b: ResolveContext };

/** Whether two elements mean the same, children included. */
export function sameElement(
	a: Element,
	b: Element,
	contexts: ContextPair,
	isRoot = false,
): boolean {
	if (!sameOwn(a, b, contexts, isRoot)) return false;
	if (a.children.length !== b.children.length) return false;
	return a.children.every((child, index) =>
		sameElement(child, b.children[index] as Element, contexts),
	);
}

export function sameOwn(
	a: Element,
	b: Element,
	contexts: ContextPair,
	isRoot: boolean,
): boolean {
	if ((a.key ?? "") !== (b.key ?? "")) return false;
	const resolvedA = resolveElement(a, contexts.a, isRoot);
	const resolvedB = resolveElement(b, contexts.b, isRoot);
	const fields = new Set([
		...Object.keys(resolvedA),
		...Object.keys(resolvedB),
	]);
	return [...fields].every((field) => resolvedA[field] === resolvedB[field]);
}
