// Writes elements back as Screen markup in one canonical form: two-space
// indents, one element per line, attributes and CSS properties in a fixed
// order. Pull writes merged Screens this way; Sync Conflicts get git-style
// markers the Agent resolves by keeping one side.
import { escapeAttribute, escapeText } from "./html";
import type { Element } from "./screen";
import { PROP_NAMES, type Prop } from "./subset";

export const CONFLICT_START = "<<<<<<< Design Project";
export const CONFLICT_SEPARATOR = "=======";
export const CONFLICT_END = ">>>>>>> Figma";

const PADDING: Prop[] = [
	"padding-top",
	"padding-right",
	"padding-bottom",
	"padding-left",
];

export function printScreen(root: Element): string {
	return `${printElement(root, 0).join("\n")}\n`;
}

function printElement(element: Element, depth: number): string[] {
	const indent = "  ".repeat(depth);
	const { conflict } = element;
	if (conflict?.kind === "element") {
		return markers(
			conflict.local ? printElement(conflict.local, depth) : [],
			conflict.figma ? printElement(conflict.figma, depth) : [],
		);
	}
	const hasChildren = element.kind === "frame" && element.children.length > 0;
	if (conflict?.kind === "tag") {
		const sides = [conflict.local, conflict.figma].map((side) =>
			hasChildren
				? [`${indent}${openTag(side)}`]
				: printElement({ ...side, conflict: undefined }, depth),
		) as [string[], string[]];
		const tags = markers(...sides);
		if (!hasChildren) return tags;
		return [
			...tags,
			...printChildren(element, depth),
			`${indent}</${element.tag}>`,
		];
	}
	const open = `${indent}${openTag(element)}`;
	switch (element.kind) {
		case "text":
			return [
				`${open}${escapeText(element.text ?? "").replaceAll("\n", "<br>")}</${element.tag}>`,
			];
		case "image":
			return [open];
		case "vector":
			return [
				open,
				...(element.paths ?? []).map((path) => {
					const rule = path.fillRule
						? ` fill-rule="${escapeAttribute(path.fillRule)}"`
						: "";
					return `${indent}  <path d="${escapeAttribute(path.d)}"${rule} />`;
				}),
				`${indent}</${element.tag}>`,
			];
		default:
			if (!hasChildren) return [`${open}</${element.tag}>`];
			return [
				open,
				...printChildren(element, depth),
				`${indent}</${element.tag}>`,
			];
	}
}

function printChildren(element: Element, depth: number): string[] {
	return element.children.flatMap((child) => printElement(child, depth + 1));
}

function markers(local: string[], figma: string[]): string[] {
	return [CONFLICT_START, ...local, CONFLICT_SEPARATOR, ...figma, CONFLICT_END];
}

function openTag(element: Element): string {
	const attributes: [string, string][] = [];
	if (element.key) attributes.push(["data-key", element.key]);
	if (element.name !== undefined) attributes.push(["data-name", element.name]);
	if (element.src !== undefined) attributes.push(["src", element.src]);
	if (element.viewBox !== undefined)
		attributes.push(["viewBox", element.viewBox]);
	const style = printStyle(element);
	if (style) attributes.push(["style", style]);
	const printed = attributes.map(
		([name, value]) => ` ${name}="${escapeAttribute(value)}"`,
	);
	return `<${element.tag}${printed.join("")}>`;
}

function printStyle(element: Element): string {
	const declarations: string[] =
		element.kind === "frame" ? ["display:flex"] : [];
	const { props } = element;
	const padding = PADDING.map((prop) => props[prop]);
	const allPadding = padding.every((side) => side !== undefined);
	for (const prop of PROP_NAMES) {
		if (allPadding && PADDING.includes(prop)) {
			// The four sides print as one shorthand, where padding-top goes.
			if (prop === "padding-top") {
				declarations.push(`padding:${paddingShorthand(padding as string[])}`);
			}
			continue;
		}
		const value = props[prop];
		if (value !== undefined) declarations.push(`${prop}:${value}`);
	}
	return declarations.join("; ");
}

/** The shortest `padding` shorthand for top, right, bottom and left. */
function paddingShorthand([top, right, bottom, left]: string[]): string {
	if (right === left) {
		if (top === bottom) return top === right ? `${top}` : `${top} ${right}`;
		return `${top} ${right} ${bottom}`;
	}
	return `${top} ${right} ${bottom} ${left}`;
}
