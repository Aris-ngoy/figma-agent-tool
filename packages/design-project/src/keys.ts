// Stable element keys: Push writes `data-key="eN"` on every element that
// has none, so Pull and the next Push can match elements to layers even
// after they're reordered or edited.
import { type HtmlElement, type HtmlNode, parseHtml } from "./html";
import type { Element } from "./screen";

/** Hands out keys not used yet: e1, e2, … */
class KeyGenerator {
	private next: number;

	constructor(used: Iterable<string>) {
		let max = 0;
		for (const key of used) {
			const match = /^e(\d+)$/.exec(key);
			if (match) max = Math.max(max, Number(match[1]));
		}
		this.next = max + 1;
	}

	key(): string {
		return `e${this.next++}`;
	}
}

/**
 * Writes a key into every element of a Screen file that has none, keeping
 * the rest of the file as it is. The file must parse.
 */
export function assignKeys(source: string): { source: string; added: number } {
	const { nodes, errors } = parseHtml(source);
	if (errors.length > 0)
		throw new Error("assignKeys needs a Screen that parses.");
	const elements: HtmlElement[] = [];
	const walk = (list: HtmlNode[]) => {
		for (const node of list) {
			if (node.type !== "element" || node.tag === "br") continue;
			elements.push(node);
			// A vector's paths are part of it, not elements.
			if (node.tag !== "svg") walk(node.children);
		}
	};
	walk(nodes);
	const keyOf = (element: HtmlElement) =>
		element.attributes.find((attribute) => attribute.name === "data-key")
			?.value;
	const keys = new KeyGenerator(
		elements.flatMap((element) => keyOf(element) ?? []),
	);
	const insertions = elements
		.filter((element) => keyOf(element) === undefined)
		.map((element) => ({
			at: element.afterTagName,
			text: ` data-key="${keys.key()}"`,
		}));
	let result = source;
	for (const { at, text } of [...insertions].reverse()) {
		result = result.slice(0, at) + text + result.slice(at);
	}
	return { source: result, added: insertions.length };
}

/** Gives every element in the tree without a key a new one. */
export function assignElementKeys(
	root: Element,
	alsoUsed: Iterable<string> = [],
) {
	const all: Element[] = [];
	const walk = (element: Element) => {
		all.push(element);
		element.children.forEach(walk);
	};
	walk(root);
	const keys = new KeyGenerator([
		...alsoUsed,
		...all.flatMap((element) => element.key ?? []),
	]);
	for (const element of all) element.key ??= keys.key();
}

export function elementKeys(root: Element): string[] {
	return [root.key ?? [], ...root.children.flatMap(elementKeys)].flat();
}
