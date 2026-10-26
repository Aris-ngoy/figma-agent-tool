// Components: reusable parts Screens use as custom elements. A Defined
// Component is a file in components/ with one <component> per variant; a
// Linked Component names an existing component in the Linked File or a
// library, in a JSON file. Either way, Screens set its properties as the
// instance's attributes.
import type { Element } from "./screen";

/** A Component property's name: an attribute name, lower case. */
export const PROPERTY_NAME = /^[a-z][a-z0-9-]*$/;

/** A Component property, as Figma has it; values are strings, as attributes are. */
export type ComponentProperty =
	| { type: "VARIANT"; default: string; options: string[] }
	| { type: "TEXT"; default: string }
	| { type: "BOOLEAN"; default: string };

export type ComponentDefinition = {
	/** By name: variant properties first, in order, then the others. */
	properties: Record<string, ComponentProperty>;
	/** Its variants' names (`kind=primary, size=lg`), when it's a component set. */
	variants?: string[];
};

/** A Linked Component's file: the Figma component it uses, by key or node ID. */
export type LinkedComponentFile = {
	/** The file name without `.json`: the custom element Screens use. */
	name: string;
	/** Relative to the Design Project. */
	file: string;
	path: string;
	source: string;
	/** A published component's (or component set's) key, for a library's. */
	key?: string;
	/** A component's (or component set's) node ID, for one in the Linked File. */
	id?: string;
	/** What Push last read of it from Figma; undefined before its first Push. */
	record?: LinkedComponentRecord;
};

/** What Push read of a Linked Component in Figma, kept in sync/linked/. */
export type LinkedComponentRecord = {
	/** The component or component set its instances come from, in the Linked File. */
	componentId: string;
	/** Its key, when it's published. */
	key?: string;
	properties: Record<string, ComponentProperty>;
	variants?: string[];
};

/** A variant's properties from its `data-variant` (`kind=primary, size=lg`), or undefined if it isn't one. */
export function parseVariant(variant: string): [string, string][] | undefined {
	const pairs = variant.split(",").map((pair) => {
		const [name = "", value, ...more] = pair.split("=").map((s) => s.trim());
		return more.length === 0 && PROPERTY_NAME.test(name) && value
			? ([name, value] as [string, string])
			: undefined;
	});
	if (pairs.some((pair) => pair === undefined)) return undefined;
	const names = pairs.map((pair) => (pair as [string, string])[0]);
	if (new Set(names).size !== names.length) return undefined;
	return pairs as [string, string][];
}

/** A Defined Component's properties, from its parsed variants. */
export function componentDefinition(root: Element): ComponentDefinition {
	const properties: Record<string, ComponentProperty> = {};
	const variants = root.children.flatMap((variant) =>
		variant.name ? [variant.name] : [],
	);
	for (const variant of root.children) {
		for (const [name, value] of parseVariant(variant.name ?? "") ?? []) {
			const property = properties[name] ?? {
				type: "VARIANT",
				default: value,
				options: [],
			};
			properties[name] = property;
			if (property.type === "VARIANT" && !property.options.includes(value))
				property.options.push(value);
		}
	}
	const walk = (element: Element) => {
		if (element.property && !(element.property in properties)) {
			properties[element.property] = {
				type: "TEXT",
				default: element.text ?? "",
			};
		}
		element.children.forEach(walk);
	};
	root.children.forEach(walk);
	return variants.length > 0 ? { properties, variants } : { properties };
}

/**
 * Every property's value on an instance: as written, else its default.
 * Without a definition, only those written.
 */
export function instanceProperties(
	definition: ComponentDefinition | undefined,
	written: Record<string, string> = {},
): Record<string, string> {
	if (!definition) return { ...written };
	return Object.fromEntries(
		Object.entries(definition.properties).map(([name, property]) => [
			name,
			written[name] ?? property.default,
		]),
	);
}

/** The variant an instance shows, by name (`kind=primary`). */
export function variantOf(
	definition: ComponentDefinition,
	written: Record<string, string>,
): string {
	return Object.entries(definition.properties)
		.filter(([, property]) => property.type === "VARIANT")
		.map(([name, property]) => `${name}=${written[name] ?? property.default}`)
		.join(", ");
}

/** A Linked Component's file read: its key or ID, or a problem with it. */
export function parseLinkedComponent(
	source: string,
): { key?: string; id?: string } | { problem: string } {
	let data: unknown;
	try {
		data = JSON.parse(source);
	} catch (error) {
		return { problem: `isn't valid JSON: ${(error as Error).message}` };
	}
	const { key, id, ...rest } = (data ?? {}) as Record<string, unknown>;
	const valid = (value: unknown) =>
		value === undefined || (typeof value === "string" && value.length > 0);
	if (
		typeof data !== "object" ||
		Array.isArray(data) ||
		!valid(key) ||
		!valid(id) ||
		(key === undefined) === (id === undefined) ||
		Object.keys(rest).length > 0
	) {
		return {
			problem:
				'needs exactly one of "key" (a published component\'s or component set\'s key, for a library\'s) or "id" (its node ID, for one in the Linked File), as in { "key": "…" }',
		};
	}
	return key !== undefined ? { key: key as string } : { id: id as string };
}
