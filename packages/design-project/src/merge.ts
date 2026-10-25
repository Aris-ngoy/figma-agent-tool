// Pull's three-way merge: Figma's version of a Screen and the Design
// Project's, each against the Baseline. Elements match by key; each side's
// changes to an element's own styles, text and name merge field by field,
// children merge as lists. Where both sides changed the same thing
// differently, the result holds a Sync Conflict for the Agent to resolve.
import {
	type ResolveContext,
	resolveElement,
	sameElement,
	withoutViewBox,
} from "./resolve";
import type { Element } from "./screen";

export type MergeResult = { root: Element; conflicts: number };

/** How to resolve each version: the Baseline keeps the tokens it was made with. */
export type MergeContexts = {
	base: ResolveContext;
	local: ResolveContext;
	figma: ResolveContext;
};

export function mergeScreen(
	base: Element,
	local: Element,
	figma: Element,
	contexts: MergeContexts,
): MergeResult {
	const merger = new Merger(contexts);
	const root = merger.element(base, local, figma, true);
	return { root, conflicts: merger.conflicts };
}

class Merger {
	conflicts = 0;

	constructor(private readonly contexts: MergeContexts) {}

	element(
		base: Element,
		local: Element,
		figma: Element,
		isRoot = false,
	): Element {
		const { contexts } = this;
		const [b, l, f] = [
			resolveElement(base, contexts.base, isRoot),
			resolveElement(local, contexts.local, isRoot),
			resolveElement(figma, contexts.figma, isRoot),
		];
		if (l["@kind"] !== f["@kind"]) {
			// One side replaced the element: fine unless the other changed it.
			if (
				f["@kind"] === b["@kind"] &&
				!this.changed(base, figma, contexts.figma)
			)
				return local;
			if (
				l["@kind"] === b["@kind"] &&
				!this.changed(base, local, contexts.local)
			)
				return figma;
			return this.conflict(local, figma);
		}
		const fields = [...new Set([...Object.keys(l), ...Object.keys(f)])];
		const taken = fields.filter((field) => {
			const [fromBase, fromLocal, fromFigma] = [b[field], l[field], f[field]];
			return fromFigma !== fromBase && fromLocal !== fromFigma;
		});
		const conflicting = taken.some((field) => l[field] !== b[field]);
		// Figma's paths are in the vector's own pixels, as Pull writes them.
		const geometry = taken.some(
			(field) => field === "@paths" || field === "stroke-width",
		);
		const mine = geometry ? withoutViewBox(local, contexts.local) : local;
		const merged: Element = { ...mine, props: { ...mine.props }, children: [] };
		if (!conflicting) {
			for (const field of taken) takeField(merged, figma, field);
		}
		if (merged.kind === "frame") {
			merged.children = this.children(
				base.children,
				local.children,
				figma.children,
			);
		}
		if (conflicting) {
			this.conflicts++;
			merged.conflict = {
				kind: "tag",
				local: { ...local, children: [] },
				figma: { ...figma, children: [] },
			};
		}
		return merged;
	}

	private conflict(local: Element | null, figma: Element | null): Element {
		this.conflicts++;
		const placeholder = local ?? (figma as Element);
		return { ...placeholder, conflict: { kind: "element", local, figma } };
	}

	/** Whether a side changed an element (or anything in it) since the Baseline. */
	private changed(
		base: Element,
		side: Element,
		sideContext: ResolveContext,
	): boolean {
		return !sameElement(base, side, { a: this.contexts.base, b: sideContext });
	}

	children(base: Element[], local: Element[], figma: Element[]): Element[] {
		const byKey = (elements: Element[]) =>
			new Map(
				elements.flatMap((element) =>
					element.key ? [[element.key, element]] : [],
				),
			);
		const [b, l, f] = [byKey(base), byKey(local), byKey(figma)];
		const common = (elements: Element[]) =>
			elements.flatMap((element) =>
				element.key &&
				b.has(element.key) &&
				l.has(element.key) &&
				f.has(element.key)
					? [element.key]
					: [],
			);
		// Keep the Design Project's order unless only Figma reordered.
		const figmaReordered =
			common(figma).join() !== common(base).join() &&
			common(local).join() === common(base).join();
		const [skeleton, other] = figmaReordered ? [figma, local] : [local, figma];

		/** An element's version in one list: by key, or itself when unkeyed. */
		const versionIn = (
			list: Element[],
			byKeyInList: Map<string, Element>,
			element: Element,
		): Element | undefined => {
			if (element.key) return byKeyInList.get(element.key);
			return list.includes(element) ? element : undefined;
		};

		/** The merged version of an element in either list, or null to drop it. */
		const merge = (element: Element): Element | null => {
			const inLocal = versionIn(local, l, element);
			const inFigma = versionIn(figma, f, element);
			const inBase = element.key ? b.get(element.key) : undefined;
			if (inLocal && inFigma && inBase)
				return this.element(inBase, inLocal, inFigma);
			if (inLocal && inFigma) return inLocal;
			const side = (inLocal ?? inFigma) as Element;
			// Added on one side.
			if (!inBase) return side;
			// Deleted on the other side: fine unless this side changed it.
			const context = inLocal ? this.contexts.local : this.contexts.figma;
			if (!this.changed(inBase, side, context)) return null;
			return inLocal ? this.conflict(side, null) : this.conflict(null, side);
		};

		const same = (first: Element, second: Element) =>
			first === second || (first.key !== undefined && first.key === second.key);
		const result = skeleton.map((element) => ({
			source: element,
			merged: merge(element),
		}));
		other.forEach((element, index) => {
			if (skeleton.some((s) => same(s, element))) return;
			const merged = merge(element);
			if (!merged) return;
			// After the nearest earlier sibling that's already placed.
			const previous = other
				.slice(0, index)
				.reverse()
				.map((sibling) =>
					result.findIndex((entry) => same(entry.source, sibling)),
				)
				.find((position) => position !== -1);
			result.splice((previous ?? -1) + 1, 0, { source: element, merged });
		});
		return result.flatMap(({ merged }) => (merged ? [merged] : []));
	}
}

function takeField(merged: Element, figma: Element, field: string) {
	switch (field) {
		case "@name":
			merged.name = figma.name;
			return;
		case "@text":
			merged.text = figma.text;
			return;
		case "@src":
			merged.src = figma.src;
			return;
		case "@paths":
			merged.paths = figma.paths;
			return;
		case "@href":
			merged.href = figma.href;
			if (merged.href === undefined) merged.tag = figma.tag;
			return;
		case "@transition":
			merged.transition = figma.transition;
			return;
		default: {
			const prop = field as keyof Element["props"];
			const value = figma.props[prop];
			if (value === undefined) delete merged.props[prop];
			else merged.props[prop] = value;
		}
	}
}
