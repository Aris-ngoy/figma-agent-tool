// What an element means, independent of how it's written: tokens resolved,
// units dropped, defaults filled in. Pull compares elements this way, so
// `var(--colors-primary)` in the file and `#3366ff` read from Figma match.
import type { Tokens } from "./design-md";
import type { ScreenSize } from "./project";
import type { Element } from "./screen";
import {
	DEFAULT_NAMES,
	defaultValue,
	PROP_NAMES,
	PROPS,
	type Prop,
	resolveValue,
} from "./subset";

export type ResolveContext = {
	tokens: Tokens;
	screenName: string;
	screenSize: ScreenSize;
};

/** Own fields (not children): `@kind`, `@name`, `@text`, `@src` and props. */
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
	for (const prop of PROP_NAMES) {
		if (!(PROPS[prop].kinds as string[]).includes(element.kind)) continue;
		resolved[prop] = resolveProp(element, prop, context.tokens);
	}
	if (isRoot) {
		resolved.width ||= String(context.screenSize.width);
		resolved.height ||= String(context.screenSize.height);
	}
	return resolved;
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
	if (isRoot) return context.screenName;
	if (element.kind === "text") return element.text ?? "";
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
