// How the Preview and Render draw a Screen's instances: as its Component's
// variant draws it, with the instance's text properties, place and size. A
// Linked Component's design is in Figma, so its instances show its name.
import { instanceProperties, variantOf } from "./components";
import { checkScreen, type DesignProject, definitionOf } from "./project";
import type { Element } from "./screen";
import type { Prop } from "./subset";

/** What an instance takes from its Screen: its place and size. */
const PLACEMENT: Prop[] = [
	"position",
	"left",
	"top",
	"width",
	"height",
	"flex",
	"align-self",
];

/** Whether an element or anything in it is an instance. */
export function hasInstances(element: Element): boolean {
	return element.kind === "instance" || element.children.some(hasInstances);
}

/** A copy of the element with every instance replaced by what it shows. */
export function expandInstances(
	project: DesignProject,
	element: Element,
): Element {
	if (element.kind === "instance") return expandInstance(project, element);
	return {
		...element,
		children: element.children.map((child) => expandInstances(project, child)),
	};
}

function expandInstance(project: DesignProject, instance: Element): Element {
	const placement = Object.fromEntries(
		PLACEMENT.flatMap((prop) =>
			instance.props[prop] !== undefined ? [[prop, instance.props[prop]]] : [],
		),
	);
	const shown = {
		key: instance.key,
		name: instance.name ?? instance.tag,
		href: instance.href,
		transition: instance.transition,
	};
	const variant = variantElement(project, instance);
	if (!variant) {
		return {
			kind: "frame",
			tag: "div",
			...shown,
			props: {
				"justify-content": "center",
				"align-items": "center",
				...placement,
				"background-color": "#eeeeee",
			},
			children: [
				{
					kind: "text",
					tag: "p",
					props: { color: "#666666", "font-size": "10px" },
					text: instance.tag,
					children: [],
				},
			],
		};
	}
	const properties = instanceProperties(
		definitionOf(project, instance.tag),
		instance.properties,
	);
	const strip = (element: Element): Element => {
		const { key: _, property, ...rest } = element;
		return {
			...rest,
			...(property !== undefined && { text: properties[property] ?? "" }),
			children: element.children.map(strip),
		};
	};
	const { props, ...expanded } = strip(variant);
	return {
		...expanded,
		...shown,
		tag: "div",
		props: { ...props, ...placement },
	};
}

/** The variant of its Defined Component an instance shows; undefined for a Linked one. */
function variantElement(
	project: DesignProject,
	instance: Element,
): Element | undefined {
	const component = project.components.find((c) => c.name === instance.tag);
	const definition = definitionOf(project, instance.tag);
	const root = component && checkScreen(project, component).root;
	if (!root || !definition) return undefined;
	if (!definition.variants) return root.children[0];
	const name = variantOf(definition, instance.properties ?? {});
	return root.children.find((variant) => variant.name === name);
}

/** A Defined Component's variants side by side, as a Screen to show it in. */
export function componentShowcase(
	project: DesignProject,
	component: { file: string; name: string; path: string; source: string },
): Element | undefined {
	const root = checkScreen(project, component).root;
	if (!root) return undefined;
	const strip = (element: Element): Element => {
		const { key: _, property: __, ...rest } = element;
		return { ...rest, children: element.children.map(strip) };
	};
	return {
		kind: "frame",
		tag: "body",
		props: {
			gap: "40px",
			"padding-top": "40px",
			"padding-right": "40px",
			"padding-bottom": "40px",
			"padding-left": "40px",
		},
		children: root.children.map((variant) => ({
			...strip(variant),
			tag: "div",
			name: variant.name ?? component.name,
		})),
	};
}
