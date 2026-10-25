// A strict parser for the markup Screens are written in: elements,
// attributes and text, with the source positions Check reports and Push
// needs to write keys into the file. Anything else (comments, doctypes,
// unclosed or misnested tags) is an error rather than guessed at, as a
// browser would.

export type HtmlAttribute = { name: string; value: string; line: number };

export type HtmlElement = {
	type: "element";
	tag: string;
	attributes: HtmlAttribute[];
	children: HtmlNode[];
	line: number;
	/** Offset just past the tag name, where Push inserts attributes. */
	afterTagName: number;
};

export type HtmlText = { type: "text"; text: string; line: number };

export type HtmlNode = HtmlElement | HtmlText;

export type HtmlError = { line: number; rule: string; message: string };

/** Elements with no content or closing tag. */
const VOID_ELEMENTS = new Set(["img", "br"]);

const CONFLICT_MARKER = /^(<{7}|={7}|>{7})(\s|$)/;

export function parseHtml(source: string): {
	nodes: HtmlNode[];
	errors: HtmlError[];
} {
	const conflicts = conflictMarkers(source);
	if (conflicts.length > 0) return { nodes: [], errors: conflicts };
	try {
		return { nodes: new Parser(source).parseDocument(), errors: [] };
	} catch (error) {
		if (error instanceof ParseError) {
			return {
				nodes: [],
				errors: [
					{ line: error.line, rule: "parse-error", message: error.message },
				],
			};
		}
		throw error;
	}
}

/** A sync-conflict error at the first Sync Conflict marker line, if any. */
export function conflictMarkers(source: string): HtmlError[] {
	const index = source
		.split("\n")
		.findIndex((line) => CONFLICT_MARKER.test(line.trimStart()));
	return index === -1 ? [] : [conflictError(index + 1)];
}

function conflictError(line: number): HtmlError {
	return {
		line,
		rule: "sync-conflict",
		message:
			"Unresolved Sync Conflict: between `<<<<<<< Design Project` and " +
			"`=======` is this file's version, between `=======` and `>>>>>>> " +
			"Figma` the designer's. Keep one (or combine them) and delete the " +
			"marker lines.",
	};
}

class ParseError extends Error {
	constructor(
		readonly line: number,
		message: string,
	) {
		super(message);
	}
}

class Parser {
	private at = 0;
	/** How many <svg> elements the parser is inside. */
	private svgDepth = 0;

	constructor(private readonly source: string) {}

	parseDocument(): HtmlNode[] {
		return this.parseChildren(undefined);
	}

	private line(offset = this.at): number {
		let line = 1;
		for (let i = 0; i < offset; i++) {
			if (this.source.charCodeAt(i) === 10) line++;
		}
		return line;
	}

	private fail(message: string, offset = this.at): never {
		throw new ParseError(this.line(offset), message);
	}

	/** Children up to the closing tag of `parent` (or the end of the file). */
	private parseChildren(parent: HtmlElement | undefined): HtmlNode[] {
		const nodes: HtmlNode[] = [];
		const { source } = this;
		while (this.at < source.length) {
			if (source.startsWith("</", this.at)) {
				const start = this.at;
				const match = /^<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>/.exec(
					source.slice(this.at),
				);
				if (!match) this.fail("Malformed closing tag.");
				const tag = (match[1] as string).toLowerCase();
				if (!parent || parent.tag !== tag) {
					this.fail(
						parent
							? `</${tag}> closes nothing open: <${parent.tag}> (line ${parent.line}) is still open.`
							: `</${tag}> closes nothing open.`,
						start,
					);
				}
				this.at += match[0].length;
				return nodes;
			}
			if (source.startsWith("<!--", this.at)) {
				this.fail(
					"Comments aren't part of the Screen Subset: Pull can't keep them. Put notes in DESIGN.md or next to the Design Project.",
				);
			}
			if (
				source.startsWith("<!", this.at) ||
				source.startsWith("<?", this.at)
			) {
				this.fail(
					"Doctypes and declarations aren't part of the Screen Subset: a Screen is one <body> element.",
				);
			}
			if (source[this.at] === "<") {
				nodes.push(this.parseElement());
				continue;
			}
			const end = source.indexOf("<", this.at);
			const raw = source.slice(this.at, end === -1 ? undefined : end);
			nodes.push({
				type: "text",
				text: decodeEntities(raw),
				line: this.line(this.at + (raw.length - raw.trimStart().length)),
			});
			this.at += raw.length;
		}
		if (parent) {
			this.fail(`<${parent.tag}> (line ${parent.line}) is never closed.`);
		}
		return nodes;
	}

	private parseElement(): HtmlElement {
		const start = this.at;
		const match = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(this.source.slice(this.at));
		if (!match) this.fail("A `<` that doesn't start a tag; write it as &lt;.");
		const tag = (match[1] as string).toLowerCase();
		this.at += match[0].length;
		const element: HtmlElement = {
			type: "element",
			tag,
			attributes: [],
			children: [],
			line: this.line(start),
			afterTagName: this.at,
		};
		for (;;) {
			this.skipSpace();
			if (this.source.startsWith("/>", this.at)) {
				this.at += 2;
				// Inside <svg>, as in XML, any element may close itself.
				if (!VOID_ELEMENTS.has(tag) && this.svgDepth === 0) {
					this.fail(
						`<${tag} /> can't be self-closing; close it with </${tag}>.`,
						start,
					);
				}
				return element;
			}
			if (this.source[this.at] === ">") {
				this.at++;
				break;
			}
			if (this.at >= this.source.length)
				this.fail(`<${tag}> is never closed.`, start);
			element.attributes.push(this.parseAttribute());
		}
		if (VOID_ELEMENTS.has(tag)) return element;
		if (tag === "svg") this.svgDepth++;
		element.children = this.parseChildren(element);
		if (tag === "svg") this.svgDepth--;
		return element;
	}

	private parseAttribute(): HtmlAttribute {
		const line = this.line();
		const match = /^([a-zA-Z_:][a-zA-Z0-9_.:-]*)/.exec(
			this.source.slice(this.at),
		);
		if (!match) this.fail("Malformed attribute.");
		const name = (match[1] as string).toLowerCase();
		this.at += match[0].length;
		this.skipSpace();
		if (this.source[this.at] !== "=") return { name, value: "", line };
		this.at++;
		this.skipSpace();
		const quote = this.source[this.at];
		if (quote !== '"' && quote !== "'") {
			this.fail(`Quote the value of ${name}, as in ${name}="…".`);
		}
		const end = this.source.indexOf(quote, this.at + 1);
		if (end === -1) this.fail(`The value of ${name} is never closed.`);
		const value = decodeEntities(this.source.slice(this.at + 1, end));
		this.at = end + 1;
		return { name, value, line };
	}

	private skipSpace() {
		while (/\s/.test(this.source[this.at] ?? "")) this.at++;
	}
}

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

function decodeEntities(text: string): string {
	return text.replace(
		/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
		(entity, name: string) => {
			if (name.startsWith("#x") || name.startsWith("#X")) {
				return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
			}
			if (name.startsWith("#"))
				return String.fromCodePoint(Number(name.slice(1)));
			return ENTITIES[name.toLowerCase()] ?? entity;
		},
	);
}

export function escapeText(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
