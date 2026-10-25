// Screens: parsing a Screen file into its elements, and checking it against
// the Screen Subset with errors that name the file, element and rule.
import {
	type ComponentDefinition,
	PROPERTY_NAME,
	parseVariant,
	variantOf,
} from "./components";
import type { Tokens } from "./design-md";
import { type HtmlElement, parseHtml } from "./html";
import { linkedScreen, parseTransition } from "./link";
import { parsePath } from "./path";
import {
	COMPONENT_SET_TAG,
	COMPONENT_TAG,
	FIGMA_OWNED_TAG,
	isComponentTag,
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
	/**
	 * `data-name`: the layer name in Figma, when not the default. On a
	 * Component's <component>, its `data-variant`, which is its name in Figma.
	 */
	name?: string;
	/** Longhand CSS properties as written (tokens unresolved). */
	props: Partial<Record<Prop, string>>;
	/** A text element's characters, `<br>` as a newline. */
	text?: string;
	/** An image's `src`, relative to the Screen file. */
	src?: string;
	/** A vector's `viewBox`, as written. */
	viewBox?: string;
	/** A vector's paths: `d` as written, and `fill-rule` when set. */
	paths?: VectorPath[];
	/** Its Prototype Link: `href` to another Screen, as written. */
	href?: string;
	/** `data-transition`: how the Prototype Link animates, as written. */
	transition?: string;
	/** An instance's Component properties, as written. */
	properties?: Record<string, string>;
	/** In a Component, the text property (`data-property`) a text element shows. */
	property?: string;
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

export type VectorPath = { d: string; fillRule?: "nonzero" | "evenodd" };

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
	/** Whether the Design Project has a Screen by this name, for links. */
	screenExists: (name: string) => boolean;
	/**
	 * The Component a custom element is an instance of, if the Design Project
	 * has one by that name: its properties, unless it's Linked and no Push
	 * has read them from Figma yet.
	 */
	component?: (name: string) => ComponentInfo | undefined;
};

export type ComponentInfo = {
	linked: boolean;
	definition?: ComponentDefinition;
};

const ATTRIBUTES = new Set(["data-key", "data-name", "style"]);

const LINK_ATTRIBUTES = ["href", "data-transition"];

/** Attributes only some kinds take. */
const KIND_ATTRIBUTES: Record<Kind, string[]> = {
	frame: LINK_ATTRIBUTES,
	text: LINK_ATTRIBUTES,
	rect: LINK_ATTRIBUTES,
	image: ["src", ...LINK_ATTRIBUTES],
	vector: ["viewbox", "xmlns", ...LINK_ATTRIBUTES],
	// And its Component's properties.
	instance: LINK_ATTRIBUTES,
	owned: [],
};

/** Names a Component property can't have: they're the attributes every instance takes. */
const RESERVED_PROPERTIES = new Set([
	"style",
	"href",
	"src",
	"viewbox",
	"xmlns",
]);

/** The tag of a Prototype Link that is a frame, text or rectangle. */
const LINK_TAG = "a";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

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

/**
 * Parses a Defined Component's file: one <component> frame per variant.
 * Its root is a stand-in for the component set holding them (see
 * componentSetRoot), whatever the number of variants.
 */
export function parseComponent(
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
	const other = elements.find((element) => element.tag !== COMPONENT_TAG);
	if (elements.length === 0 || other || stray) {
		errors.push({
			file,
			line: (other ?? stray)?.line ?? 1,
			element: "",
			rule: "component-roots",
			message:
				'A Component file holds one <component style="display:flex"> per variant (its component in Figma), and nothing else.',
		});
		return { errors };
	}
	const root = componentSetRoot([]);
	const builder = new Builder(file, context, errors, true);
	elements.forEach((html, index) => {
		const path = variantPath(index, elements.length);
		root.children.push(builder.element(html, path, root));
	});
	builder.checkVariants(elements, root.children);
	return { root, errors };
}

/** A <component>'s path in errors: `component`, or its place among several. */
function variantPath(index: number, count: number): string {
	return count > 1 ? `component:nth-of-type(${index + 1})` : "component";
}

/**
 * The stand-in root of a Component's variants: its component set in Figma,
 * laid out in a row. Only its children are the Component's.
 */
export function componentSetRoot(children: Element[]): Element {
	const space = "40px";
	return {
		kind: "frame",
		tag: COMPONENT_SET_TAG,
		key: COMPONENT_SET_TAG,
		props: {
			gap: space,
			"padding-top": space,
			"padding-right": space,
			"padding-bottom": space,
			"padding-left": space,
		},
		children,
	};
}

class Builder {
	private readonly keys = new Map<string, number>();

	constructor(
		private readonly file: string,
		private readonly context: ScreenContext,
		private readonly errors: CheckError[],
		/** Parsing a Component's file, rather than a Screen. */
		private readonly inComponent = false,
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
		this.attributes(html, path, element, parent === undefined);
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
		if (html.tag === "svg" && !isRoot) return "vector";
		if (html.tag === FIGMA_OWNED_TAG && !isRoot) return "owned";
		if (isComponentTag(html.tag) && !isRoot) return "instance";
		const isVariant = parent?.tag === COMPONENT_SET_TAG;
		const holdsText = html.children.some(
			(child) =>
				(child.type === "text" && child.text.trim()) ||
				(child.type === "element" && child.tag === "br"),
		);
		if (html.tag === LINK_TAG && !isRoot && display === undefined && holdsText)
			return "text";
		if (
			html.tag === "div" ||
			html.tag === LINK_TAG ||
			(isRoot && html.tag === "body") ||
			isVariant
		) {
			if (display === "flex") return "frame";
			if (isVariant) {
				this.error(
					html,
					path,
					"div-needs-flex",
					"A <component> is a variant's component in Figma, a frame: give it `display: flex` (auto layout in Figma).",
				);
				return "frame";
			}
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
			`<${html.tag}> isn't in the Screen Subset. Use <div style="display:flex"> for frames, <div> for rectangles, <p>, <span> or <h1>–<h6> for text, <img> for images, <svg> with <path>s for vectors, <a href> for links to other Screens, and a Component's name (<app-button>) for its instances.`,
		);
		return "rect";
	}

	private attributes(
		html: HtmlElement,
		path: string,
		element: Element,
		isRoot: boolean,
	) {
		const isVariant = this.inComponent && element.tag === COMPONENT_TAG;
		const instance =
			element.kind === "instance" ? this.instance(html, path) : undefined;
		for (const { name, value } of html.attributes) {
			if (isVariant && this.variantAttribute(html, path, element, name, value))
				continue;
			if (
				name === "data-property" &&
				this.inComponent &&
				element.kind === "text"
			) {
				this.property(html, path, element, value);
				continue;
			}
			if (this.inComponent && LINK_ATTRIBUTES.includes(name)) {
				this.error(
					html,
					path,
					"unknown-attribute",
					`\`${name}\` makes a Prototype Link, which Components can't have: link their instances in the Screens instead.`,
				);
				continue;
			}
			if (
				instance &&
				!ATTRIBUTES.has(name) &&
				!LINK_ATTRIBUTES.includes(name)
			) {
				this.instanceProperty(html, path, element, instance, name, value);
				continue;
			}
			const valid =
				ATTRIBUTES.has(name) ||
				(KIND_ATTRIBUTES[element.kind].includes(name) &&
					!(isRoot && LINK_ATTRIBUTES.includes(name)));
			if (!valid || (name === "xmlns" && value !== SVG_NAMESPACE)) {
				this.error(
					html,
					path,
					"unknown-attribute",
					`The \`${name}\` attribute isn't in the Screen Subset${isRoot || element.kind === "owned" ? ` on ${describeKind(element)}` : ""}. Elements take \`style\`, \`data-name\` (the layer name), \`data-key\` (written by Push), and \`href\` and \`data-transition\` (a Prototype Link; not <body> or Figma-owned Elements); <img> takes \`src\` and <svg> \`viewBox\`.`,
				);
				continue;
			}
			if (name === "data-key") this.key(html, path, element, value);
			if (name === "data-name") element.name = value;
			if (name === "src") element.src = value;
			if (name === "viewbox") this.viewBox(html, path, element, value);
			if (name === "style") this.style(html, path, element, value);
			if (name === "href") element.href = value;
			if (name === "data-transition") element.transition = value;
		}
		this.link(html, path, element);
		if (instance?.definition) this.checkProperties(html, path, element);
		if (element.kind === "image") this.image(html, path, element);
		if (element.kind === "owned" && !element.key) {
			this.error(
				html,
				path,
				"missing-key",
				"A Figma-owned Element refers to its layer in Figma by the `data-key` Pull gave it. Restore it, or delete the element (Push then deletes the layer).",
			);
		}
	}

	/** A <component>'s own attributes: `data-variant`, `data-key` and `style`. */
	private variantAttribute(
		html: HtmlElement,
		path: string,
		element: Element,
		name: string,
		value: string,
	): boolean {
		if (name === "data-variant") {
			element.name = value;
			return true;
		}
		if (name === "data-key" || name === "style") return false;
		this.error(
			html,
			path,
			"unknown-attribute",
			`The \`${name}\` attribute isn't in the Screen Subset on a <component>: it takes \`style\`, \`data-key\` (written by Push) and \`data-variant\` (its variant, as in \`data-variant="kind=primary, size=lg"\`); its name is the Component file's.`,
		);
		return true;
	}

	/** `data-property` on a Component's text: the text property it shows. */
	private property(
		html: HtmlElement,
		path: string,
		element: Element,
		name: string,
	) {
		if (!PROPERTY_NAME.test(name) || RESERVED_PROPERTIES.has(name)) {
			this.error(
				html,
				path,
				"invalid-property",
				`\`data-property="${name}"\` isn't a property name: use lower-case letters, digits and hyphens (not ${[...RESERVED_PROPERTIES].join(", ")}), as instances set it as an attribute (\`<app-button ${PROPERTY_NAME.test(name) ? name : "label"}="…">\`).`,
			);
			return;
		}
		element.property = name;
	}

	/** The Component a custom element is an instance of; an error if there's none. */
	private instance(html: HtmlElement, path: string): ComponentInfo | undefined {
		if (this.inComponent) {
			this.error(
				html,
				path,
				"nested-component",
				`<${html.tag}> is an instance of a Component, but Components can't hold instances of other Components yet: write its elements here instead.`,
			);
			return undefined;
		}
		const info = this.context.component?.(html.tag);
		if (!info) {
			this.error(
				html,
				path,
				"unknown-component",
				`<${html.tag}> isn't a Component of the Design Project: Define it in components/${html.tag}.html, or Link it to a Figma component in components/${html.tag}.json (\`{ "key": "…" }\`).`,
			);
		}
		return info;
	}

	/** An attribute of an instance that sets one of its Component's properties. */
	private instanceProperty(
		html: HtmlElement,
		path: string,
		element: Element,
		{ definition }: ComponentInfo,
		name: string,
		value: string,
	) {
		const property = definition?.properties[name];
		const known = definition
			? property !== undefined
			: PROPERTY_NAME.test(name) && !RESERVED_PROPERTIES.has(name);
		if (!known) {
			const names = Object.keys(definition?.properties ?? {});
			this.error(
				html,
				path,
				"unknown-attribute",
				`The \`${name}\` attribute isn't a property of <${html.tag}>${names.length > 0 ? `, which has ${names.map((n) => `\`${n}\``).join(", ")}` : ", which has no properties"}. Instances also take \`style\` (their place and size), \`data-name\`, \`data-key\`, \`href\` and \`data-transition\`.`,
			);
			return;
		}
		if (property?.type === "VARIANT" && !property.options.includes(value)) {
			this.error(
				html,
				path,
				"invalid-property",
				`\`${name}="${value}"\` isn't a variant of <${html.tag}>: ${name} is one of ${property.options.map((o) => `\`${o}\``).join(", ")}.`,
			);
			return;
		}
		if (property?.type === "BOOLEAN" && value !== "true" && value !== "false") {
			this.error(
				html,
				path,
				"invalid-property",
				`\`${name}="${value}"\` must be \`true\` or \`false\`: it's a boolean property of <${html.tag}>.`,
			);
			return;
		}
		element.properties = { ...element.properties, [name]: value };
	}

	/** An instance's variant properties name one of its Component's variants. */
	private checkProperties(html: HtmlElement, path: string, element: Element) {
		const definition = this.context.component?.(element.tag)?.definition;
		if (!definition?.variants) return;
		const chosen = variantOf(definition, element.properties ?? {});
		if (!definition.variants.includes(chosen)) {
			this.error(
				html,
				path,
				"invalid-property",
				`<${element.tag}> has no variant ${chosen}: its variants are ${definition.variants.map((v) => `\`${v}\``).join(", ")}.`,
			);
		}
	}

	/** Every variant of a Component is named, alike and different. */
	checkVariants(htmls: HtmlElement[], variants: Element[]) {
		const seen = new Map<string, number>();
		/** Each text property's text, as the first variant showing it has it. */
		const defaults = new Map<string, string>();
		let names: string | undefined;
		variants.forEach((variant, index) => {
			const html = htmls[index] as HtmlElement;
			const path = variantPath(index, variants.length);
			const { props } = variant;
			const placed = (["flex", "align-self", "position"] as const).filter(
				(prop) => props[prop] !== undefined,
			);
			if (placed.length > 0) {
				this.error(
					html,
					path,
					"unknown-property",
					`A <component> is a top-level component in Figma, so \`${placed.join("`, `")}\` don't apply to it: its instances are placed in their Screens.`,
				);
			}
			if (variant.name === undefined) {
				if (variants.length > 1) {
					this.error(
						html,
						path,
						"missing-variant",
						'A Component with several <component>s has a variant in each: name it with `data-variant`, as in `data-variant="kind=primary"` (its variant properties in Figma).',
					);
				}
				return;
			}
			const pairs = parseVariant(variant.name);
			if (!pairs) {
				this.error(
					html,
					path,
					"invalid-variant",
					`\`data-variant="${variant.name}"\` isn't a variant: write each property as \`name=value\`, separated by commas (\`kind=primary, size=lg\`), with lower-case names given once.`,
				);
				return;
			}
			variant.name = pairs
				.map(([name, value]) => `${name}=${value}`)
				.join(", ");
			const theseNames = pairs.map(([name]) => name).join(", ");
			names ??= theseNames;
			if (theseNames !== names) {
				this.error(
					html,
					path,
					"invalid-variant",
					`Every variant of a Component sets the same properties in the same order: this one sets ${theseNames}, the first ${names}.`,
				);
			}
			const first = seen.get(variant.name);
			if (first !== undefined) {
				this.error(
					html,
					path,
					"duplicate-variant",
					`The variant ${variant.name} is already on line ${first}.`,
				);
			}
			seen.set(variant.name, html.line);
			const variantNames = new Set(pairs.map(([name]) => name));
			const texts = new Set<string>();
			const walk = (element: Element) => {
				const { property } = element;
				if (property && (variantNames.has(property) || texts.has(property))) {
					this.errors.push({
						file: this.file,
						line: element.line ?? html.line,
						element: path,
						rule: "invalid-property",
						message: `\`data-property="${property}"\` is already ${variantNames.has(property) ? "a variant property" : "another text's property in this variant"}: give each text property its own name.`,
					});
				}
				if (property) texts.add(property);
				const text = element.text ?? "";
				const first = property && defaults.get(property);
				if (property && first !== undefined && first !== text) {
					this.errors.push({
						file: this.file,
						line: element.line ?? html.line,
						element: path,
						rule: "invalid-property",
						message: `\`data-property="${property}"\` shows "${text}" here but "${first}" in an earlier variant: a text property has one default text in Figma, so give its texts the same one.`,
					});
				}
				if (property && first === undefined) defaults.set(property, text);
				element.children.forEach(walk);
			};
			variant.children.forEach(walk);
		});
	}

	/** A Prototype Link goes to a Screen of the Design Project, with a transition Figma has. */
	private link(html: HtmlElement, path: string, element: Element) {
		const { href, transition } = element;
		if (href === undefined) {
			if (transition !== undefined) {
				this.error(
					html,
					path,
					"invalid-transition",
					"`data-transition` is how a Prototype Link animates: add an `href` to the Screen it goes to, or remove it.",
				);
			}
			if (html.tag === LINK_TAG) {
				this.error(
					html,
					path,
					"missing-link",
					'An <a> is a Prototype Link: give it an `href` to another Screen (`href="signup.html"`), or use a <div> or <p>.',
				);
			}
			return;
		}
		const screen = linkedScreen(href);
		if (screen === undefined) {
			this.error(
				html,
				path,
				"invalid-link",
				`\`href="${href}"\` isn't a Screen: Prototype Links go to another Screen of the Design Project by its file name, as in \`href="signup.html"\`.`,
			);
		} else if (!this.context.screenExists(screen)) {
			this.error(
				html,
				path,
				"unknown-screen",
				`\`href="${href}"\` links to the Screen ${screen}, which the Design Project doesn't have (no screens/${screen}.html).`,
			);
		}
		const parsed = parseTransition(transition);
		if ("problem" in parsed)
			this.error(html, path, "invalid-transition", parsed.problem);
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
			const values = expandShorthand(name, value, this.context.tokens);
			if ("problem" in values) {
				this.error(html, path, "invalid-value", values.problem);
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

	private viewBox(
		html: HtmlElement,
		path: string,
		element: Element,
		value: string,
	) {
		const numbers = value
			.trim()
			.split(/[\s,]+/)
			.map(Number);
		const [, , width = 0, height = 0] = numbers;
		if (
			numbers.length !== 4 ||
			numbers.some(Number.isNaN) ||
			width <= 0 ||
			height <= 0
		) {
			this.error(
				html,
				path,
				"invalid-value",
				`\`viewBox="${value}"\` needs four numbers: min-x, min-y, and a positive width and height.`,
			);
			return;
		}
		element.viewBox = value;
	}

	/** A vector's <path>s: `d` and `fill-rule` only. */
	private paths(html: HtmlElement, path: string, element: Element) {
		const before = this.errors.length;
		const paths: VectorPath[] = [];
		for (const child of html.children) {
			if (child.type === "text") {
				if (child.text.trim()) {
					this.error(
						html,
						path,
						"text-outside-text-element",
						"An <svg> holds only <path>s: text isn't part of a vector.",
					);
				}
				continue;
			}
			const childPath = `${path} > ${child.tag}`;
			if (child.tag !== "path") {
				this.error(
					child,
					childPath,
					"unknown-element",
					`<${child.tag}> isn't in the Screen Subset: an <svg> holds only <path>s (Figma's vector paths).`,
				);
				continue;
			}
			const vectorPath = this.path(child, childPath);
			if (vectorPath) paths.push(vectorPath);
		}
		if (paths.length === 0 && this.errors.length === before) {
			this.error(
				html,
				path,
				"invalid-path",
				"An <svg> needs at least one <path> with a `d`.",
			);
		}
		element.paths = paths;
	}

	private path(html: HtmlElement, path: string): VectorPath | undefined {
		let d: string | undefined;
		let fillRule: VectorPath["fillRule"];
		for (const { name, value } of html.attributes) {
			if (name === "d") {
				d = value;
			} else if (name !== "fill-rule") {
				this.error(
					html,
					path,
					"unknown-attribute",
					`The \`${name}\` attribute isn't in the Screen Subset: a <path> takes \`d\` and \`fill-rule\`; colors and strokes go in the <svg>'s style.`,
				);
			} else if (value === "nonzero" || value === "evenodd") {
				fillRule = value;
			} else {
				this.error(
					html,
					path,
					"invalid-value",
					`\`fill-rule="${value}"\` isn't in the Screen Subset: use \`nonzero\` or \`evenodd\`.`,
				);
			}
		}
		if (html.children.length > 0) {
			this.error(html, path, "invalid-path", "A <path> holds nothing.");
		}
		if (d === undefined) {
			this.error(html, path, "invalid-path", "A <path> needs a `d`.");
			return undefined;
		}
		const parsed = parsePath(d);
		if ("problem" in parsed) {
			this.error(html, path, "invalid-path", parsed.problem);
			return undefined;
		}
		return fillRule ? { d, fillRule } : { d };
	}

	/** Builds the children; false when the element can't hold them. */
	private children(html: HtmlElement, path: string, element: Element): boolean {
		if (element.kind === "vector") {
			this.paths(html, path, element);
			return true;
		}
		if (element.kind === "owned" || element.kind === "instance") {
			const content = html.children.some(
				(child) => child.type === "element" || child.text.trim(),
			);
			if (content && element.kind === "owned") {
				this.error(
					html,
					path,
					"figma-owned-content",
					"A Figma-owned Element stands for a layer only designers edit in Figma, so it holds nothing. Place and size it with `style`.",
				);
			} else if (content) {
				this.error(
					html,
					path,
					"instance-content",
					`<${element.tag}> is an instance of a Component, whose content is the Component's, so it holds nothing: set its properties as attributes, and place and size it with \`style\`.`,
				);
			}
			return !content;
		}
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
			if (
				props.flex ||
				props["align-self"] ||
				props.position ||
				props.overflow
			) {
				this.error(
					html,
					path,
					"unknown-property",
					"<body> is the Screen's top-level frame, so `flex`, `align-self`, `position` and `overflow` don't apply to it (it always clips its content).",
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
		if (!this.checkPosition(html, path, element)) return;
		const row = (parent.props["flex-direction"] ?? "row") !== "column";
		const fills = {
			width: row ? props.flex === "1" : props["align-self"] === "stretch",
			height: row ? props["align-self"] === "stretch" : props.flex === "1",
		};
		for (const axis of ["width", "height"] as const) {
			if (fills[axis] && props.position) {
				this.error(
					html,
					path,
					"conflicting-size",
					"An element with `position: absolute` is out of auto layout, so it can't fill its parent (`flex: 1` / `align-self: stretch`). Give it a size, or none to hug its content.",
				);
				return;
			}
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
		if (
			(props["border-width"] !== undefined) !==
			(props["border-color"] !== undefined)
		) {
			this.error(
				html,
				path,
				"invalid-value",
				"A border needs both a width and a color: `border: 1px solid #dddddd`, or `border-width` with `border-color`.",
			);
		}
		if (
			element.kind !== "frame" &&
			element.kind !== "text" &&
			element.kind !== "instance"
		) {
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

	/** `left` and `top` place an absolutely positioned element, and it needs both. */
	private checkPosition(
		html: HtmlElement,
		path: string,
		element: Element,
	): boolean {
		const { props } = element;
		const offsets = (["left", "top"] as const).filter(
			(prop) => props[prop] !== undefined,
		);
		if (!props.position && offsets.length > 0) {
			this.error(
				html,
				path,
				"invalid-value",
				`\`${offsets.join("` and `")}\` place an element with \`position: absolute\` (absolute position in Figma), so add it or remove them.`,
			);
			return false;
		}
		if (props.position && offsets.length < 2) {
			this.error(
				html,
				path,
				"position-required",
				"An element with `position: absolute` needs both `left` and `top`: its offset from its parent's top-left corner.",
			);
			return false;
		}
		return true;
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

/** The longhand values of a property as written, or a problem. */
function expandShorthand(
	name: string,
	value: string,
	tokens: Tokens,
): string[] | { problem: string } {
	if (name === "padding") {
		return (
			expandBox(value) ?? {
				problem: `\`padding: ${value}\` needs one to four lengths.`,
			}
		);
	}
	if (name === "border") {
		const parts = splitValues(value);
		const problem = {
			problem: `\`border: ${value}\` isn't in the Screen Subset: write a width, \`solid\` and a color, as in \`border: 1px solid #dddddd\` (an inside stroke in Figma).`,
		};
		const [solid, ...rest] = [
			...parts.filter((part) => part === "solid"),
			...parts.filter((part) => part !== "solid"),
		];
		if (solid !== "solid" || rest.length !== 2) return problem;
		const width = rest.find(
			(part) => "value" in resolveValue("border-width", part, tokens),
		);
		const color = rest.find((part) => part !== width);
		return width && color ? [width, color] : problem;
	}
	return [value];
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
	return {
		frame: "frames",
		text: "text",
		rect: "rectangles",
		image: "images",
		vector: "vectors",
		instance: "instances",
		owned: "Figma-owned Elements",
	}[kind];
}

function describeKind(element: Element): string {
	return {
		frame: `a frame (<${element.tag} style="display:flex">)`,
		text: `text (<${element.tag}>)`,
		rect: "a rectangle (<div> without display:flex)",
		image: "an image (<img>)",
		vector: "a vector (<svg>)",
		instance: `an instance of a Component (<${element.tag}>, which only takes its place and size)`,
		owned: "a Figma-owned Element (which only takes its place and size)",
	}[element.kind];
}
