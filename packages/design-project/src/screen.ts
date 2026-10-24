// Screens: parsing a Screen file into its elements, and checking it against
// the Screen Subset with errors that name the file, element and rule.
import type { Tokens } from "./design-md";
import { type HtmlElement, parseHtml } from "./html";
import {
	type Kind,
	PROPS,
	type Prop,
	resolveValue,
	SHORTHANDS,
	TEXT_TAGS,
} from "./subset";

/** One element of a Screen: its kind, styles as written, text or image. */
export type Element = {
	kind: Kind;
	tag: string;
	/** The stable key Push writes into `data-key`. */
	key?: string;
	/** `data-name`: the layer name in Figma, when not the default. */
	name?: string;
	/** Longhand CSS properties as written (tokens unresolved). */
	props: Partial<Record<Prop, string>>;
	/** A text element's characters, `<br>` as a newline. */
	text?: string;
	/** An image's `src`, relative to the Screen file. */
	src?: string;
	children: Element[];
	/** Where it starts in the file; not part of the element's content. */
	line?: number;
	/** The Figma layer it was read from, when it comes from Pull. */
	nodeId?: string;
	/** Set by Pull's merge where Figma and the Design Project disagree. */
	conflict?: SyncConflict;
};

/**
 * A Sync Conflict on an element. `element`: one side deleted or replaced it
 * while the other changed it; `tag`: both changed the element's own styles,
 * text or name (its children merged normally).
 */
export type SyncConflict =
	| { kind: "element"; local: Element | null; figma: Element | null }
	| { kind: "tag"; local: Element; figma: Element };

export type CheckError = {
	/** Relative to the Design Project. */
	file: string;
	line: number;
	/** A CSS selector for the element, or "" for the whole file. */
	element: string;
	rule: string;
	message: string;
};

export type ScreenContext = {
	tokens: Tokens;
	/** Whether an image `src` (relative to the Screen file) exists. */
	imageExists: (src: string) => boolean;
};

const ATTRIBUTES = new Set(["data-key", "data-name", "style", "src"]);

const KEY = /^[A-Za-z0-9_-]+$/;

export function parseScreen(
	file: string,
	source: string,
	context: ScreenContext,
): { root?: Element; errors: CheckError[] } {
	const { nodes, errors: htmlErrors } = parseHtml(source);
	if (htmlErrors.length > 0) {
		return {
			errors: htmlErrors.map((error) => ({ file, element: "", ...error })),
		};
	}
	const errors: CheckError[] = [];
	const elements = nodes.filter((node) => node.type === "element");
	const stray = nodes.find((node) => node.type === "text" && node.text.trim());
	const [first] = elements;
	if (elements.length !== 1 || first?.tag !== "body" || stray) {
		errors.push({
			file,
			line: (elements[1] ?? stray ?? first)?.line ?? 1,
			element: "",
			rule: "single-root",
			message:
				"A Screen is a single <body> element: its frame in Figma. Put everything else inside it.",
		});
		return { errors };
	}
	const builder = new Builder(file, context, errors);
	const root = builder.element(first, "body", undefined);
	return { root, errors };
}

class Builder {
	private readonly keys = new Map<string, number>();

	constructor(
		private readonly file: string,
		private readonly context: ScreenContext,
		private readonly errors: CheckError[],
	) {}

	private error(
		html: HtmlElement,
		path: string,
		rule: string,
		message: string,
	) {
		this.errors.push({
			file: this.file,
			line: html.line,
			element: path,
			rule,
			message,
		});
	}

	element(
		html: HtmlElement,
		path: string,
		parent: Element | undefined,
	): Element {
		const before = this.errors.length;
		const kind = this.kind(html, path, parent);
		const element: Element = {
			kind,
			tag: html.tag,
			props: {},
			children: [],
			line: html.line,
		};
		this.attributes(html, path, element);
		// Sizes are only worth checking on an element that is otherwise valid.
		const valid = this.errors.length === before;
		if (kind === "text") element.text = this.text(html, path);
		const holdsItsContent =
			kind === "text" || this.children(html, path, element);
		if (holdsItsContent && valid) this.checkSizes(html, path, element, parent);
		return element;
	}

	private kind(
		html: HtmlElement,
		path: string,
		parent: Element | undefined,
	): Kind {
		const display = styleDeclarations(attribute(html, "style") ?? "").find(
			([name]) => name === "display",
		)?.[1];
		if (TEXT_TAGS.has(html.tag)) return "text";
		if (html.tag === "img") return "image";
		const isRoot = parent === undefined;
		if (html.tag === "div" || (isRoot && html.tag === "body")) {
			if (display === "flex") return "frame";
			if (display !== undefined) {
				this.error(
					html,
					path,
					"invalid-value",
					`\`display: ${display}\` isn't in the Screen Subset: frames are \`display: flex\` (auto layout in Figma).`,
				);
				return "frame";
			}
			if (isRoot) {
				this.error(
					html,
					path,
					"div-needs-flex",
					"<body> is the Screen's frame: give it `display: flex` (auto layout in Figma).",
				);
				return "frame";
			}
			return "rect";
		}
		this.error(
			html,
			path,
			"unknown-element",
			`<${html.tag}> isn't in the Screen Subset. Use <div style="display:flex"> for frames, <div> for rectangles, <p>, <span> or <h1>–<h6> for text, and <img> for images.`,
		);
		return "rect";
	}

	private attributes(html: HtmlElement, path: string, element: Element) {
		for (const { name, value } of html.attributes) {
			if (
				!ATTRIBUTES.has(name) ||
				(name === "src" && element.kind !== "image")
			) {
				this.error(
					html,
					path,
					"unknown-attribute",
					`The \`${name}\` attribute isn't in the Screen Subset. Elements take \`style\`, \`data-name\` (the layer name), \`data-key\` (written by Push) and, on <img>, \`src\`.`,
				);
				continue;
			}
			if (name === "data-key") this.key(html, path, element, value);
			if (name === "data-name") element.name = value;
			if (name === "src") element.src = value;
			if (name === "style") this.style(html, path, element, value);
		}
		if (element.kind === "image") this.image(html, path, element);
	}

	private key(html: HtmlElement, path: string, element: Element, key: string) {
		if (!KEY.test(key)) {
			this.error(
				html,
				path,
				"invalid-key",
				`data-key="${key}" isn't a valid key; delete it and Push writes a new one.`,
			);
			return;
		}
		const first = this.keys.get(key);
		if (first !== undefined) {
			this.error(
				html,
				path,
				"duplicate-key",
				`data-key="${key}" is already used on line ${first}. Keys link elements to Figma layers: delete this copy's data-key and Push gives it a new one.`,
			);
			return;
		}
		this.keys.set(key, html.line);
		element.key = key;
	}

	private style(
		html: HtmlElement,
		path: string,
		element: Element,
		style: string,
	) {
		for (const [name, value] of styleDeclarations(style)) {
			if (name === "display") continue;
			const longhands =
				SHORTHANDS[name] ?? (name in PROPS ? [name as Prop] : []);
			const allowed = longhands.every((prop) =>
				(PROPS[prop].kinds as Kind[]).includes(element.kind),
			);
			if (longhands.length === 0 || !allowed) {
				this.error(
					html,
					path,
					"unknown-property",
					`\`${name}\` isn't in the Screen Subset for ${describeKind(element)}.${name in PROPS || name in SHORTHANDS ? ` It applies to ${PROPS[(SHORTHANDS[name]?.[0] ?? name) as Prop].kinds.map(kindName).join(", ")}.` : ""}`,
				);
				continue;
			}
			const values = name === "padding" ? expandBox(value) : [value];
			if (!values) {
				this.error(
					html,
					path,
					"invalid-value",
					`\`padding: ${value}\` needs one to four lengths.`,
				);
				continue;
			}
			longhands.forEach((prop, index) => {
				const raw = values[index] ?? "";
				const resolved = resolveValue(prop, raw, this.context.tokens);
				if ("rule" in resolved) {
					this.error(html, path, resolved.rule, resolved.message);
					return;
				}
				element.props[prop] = raw;
			});
		}
	}

	private image(html: HtmlElement, path: string, element: Element) {
		if (!element.src) {
			this.error(
				html,
				path,
				"missing-image",
				"<img> needs a `src`: a PNG, JPEG or GIF in the Design Project.",
			);
			return;
		}
		if (
			!/\.(png|jpe?g|gif)$/i.test(element.src) ||
			/^[a-z]+:/i.test(element.src)
		) {
			this.error(
				html,
				path,
				"invalid-image",
				`\`src="${element.src}"\` must be a PNG, JPEG or GIF file in the Design Project, relative to the Screen.`,
			);
			return;
		}
		if (!this.context.imageExists(element.src)) {
			this.error(
				html,
				path,
				"missing-image",
				`\`src="${element.src}"\` doesn't exist (relative to ${this.file}).`,
			);
		}
	}

	private text(html: HtmlElement, path: string): string {
		let text = "";
		for (const child of html.children) {
			if (child.type === "text") text += child.text.replace(/\s+/g, " ");
			else if (child.tag === "br" && child.attributes.length === 0)
				text += "\n";
			else {
				this.error(
					html,
					path,
					"text-has-elements",
					`<${html.tag}> holds <${child.tag}>, but text elements hold only text and <br> in the Screen Subset. Use separate text elements in a frame.`,
				);
			}
		}
		return collapseWhitespace(text);
	}

	/** Builds the children; false when the element can't hold them. */
	private children(html: HtmlElement, path: string, element: Element): boolean {
		const elements = html.children.filter((child) => child.type === "element");
		const textChild = html.children.find(
			(child) => child.type === "text" && child.text.trim(),
		);
		if (textChild) {
			this.error(
				html,
				path,
				"text-outside-text-element",
				`Text directly inside <${html.tag}> isn't in the Screen Subset: wrap it in <p>, <span> or <h1>–<h6>.`,
			);
		}
		if (element.kind !== "frame" && elements.length > 0) {
			this.error(
				html,
				path,
				"div-needs-flex",
				"A <div> with children is a frame: give it `display: flex` (auto layout in Figma). A <div> without one is a rectangle.",
			);
			return false;
		}
		elements.forEach((child, index) => {
			const childPath = `${path} > ${child.tag}${elements.length > 1 ? `:nth-child(${index + 1})` : ""}`;
			element.children.push(this.element(child, childPath, element));
		});
		return !textChild;
	}

	/** Each axis needs a size from somewhere, and only one. */
	private checkSizes(
		html: HtmlElement,
		path: string,
		element: Element,
		parent: Element | undefined,
	) {
		const { props } = element;
		if (!parent) {
			if (props.flex || props["align-self"]) {
				this.error(
					html,
					path,
					"unknown-property",
					"<body> is the Screen's top-level frame, so `flex` and `align-self` don't apply to it.",
				);
			}
			if ((props.width === undefined) !== (props.height === undefined)) {
				this.error(
					html,
					path,
					"size-required",
					"Set both `width` and `height` on <body> to override the Screen Size, or neither.",
				);
			}
			return;
		}
		const row = (parent.props["flex-direction"] ?? "row") !== "column";
		const fills = {
			width: row ? props.flex === "1" : props["align-self"] === "stretch",
			height: row ? props["align-self"] === "stretch" : props.flex === "1",
		};
		for (const axis of ["width", "height"] as const) {
			if (fills[axis] && props[axis] !== undefined) {
				this.error(
					html,
					path,
					"conflicting-size",
					`This element fills its parent's ${axis} (${(axis === "width") === row ? "`flex: 1`" : "`align-self: stretch`"}), so it can't also have a fixed \`${axis}\`. Keep one.`,
				);
				return;
			}
		}
		if (element.kind === "rect" || element.kind === "image") {
			const missing = (["width", "height"] as const).filter(
				(axis) => props[axis] === undefined && !fills[axis],
			);
			if (missing.length > 0) {
				this.error(
					html,
					path,
					"size-required",
					`${describeKind(element)} needs a ${missing.join(" and ")}: a length, or \`flex: 1\` / \`align-self: stretch\` to fill its parent.`,
				);
			}
		}
		if (props["flex-wrap"] === "wrap" && props["flex-direction"] === "column") {
			this.error(
				html,
				path,
				"invalid-value",
				"Only rows wrap in auto layout: `flex-wrap: wrap` needs `flex-direction: row`.",
			);
		}
	}
}

function attribute(html: HtmlElement, name: string): string | undefined {
	return html.attributes.find((a) => a.name === name)?.value;
}

/** `a: b; c: d` → [["a", "b"], ["c", "d"]], names lowercased. */
export function styleDeclarations(style: string): [string, string][] {
	return style
		.split(";")
		.map((declaration) => declaration.trim())
		.filter(Boolean)
		.map((declaration) => {
			const colon = declaration.indexOf(":");
			if (colon === -1) return [declaration.toLowerCase(), ""];
			return [
				declaration.slice(0, colon).trim().toLowerCase(),
				declaration.slice(colon + 1).trim(),
			];
		});
}

/** CSS box shorthand values as top, right, bottom, left. */
function expandBox(value: string): string[] | undefined {
	const parts = splitValues(value);
	if (parts.length < 1 || parts.length > 4) return undefined;
	const [top, right = top, bottom = top, left = right] = parts as string[];
	return [top, right, bottom, left] as string[];
}

/** Space-separated values, keeping `var(...)` whole. */
function splitValues(value: string): string[] {
	return value.match(/var\([^)]*\)|[^\s]+/g) ?? [];
}

/** HTML whitespace: runs collapse to one space, none at line edges. */
function collapseWhitespace(text: string): string {
	return text
		.replace(/ +/g, " ")
		.replace(/ ?\n ?/g, "\n")
		.replace(/^ | $/g, "");
}

function kindName(kind: Kind): string {
	return { frame: "frames", text: "text", rect: "rectangles", image: "images" }[
		kind
	];
}

function describeKind(element: Element): string {
	return {
		frame: `a frame (<${element.tag} style="display:flex">)`,
		text: `text (<${element.tag}>)`,
		rect: "a rectangle (<div> without display:flex)",
		image: "an image (<img>)",
	}[element.kind];
}
