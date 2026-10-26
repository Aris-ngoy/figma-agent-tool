// Prototype Links: `href` names another Screen, `data-transition` how the
// prototype gets there, written like CSS (`push left 200ms ease-in-out`).
// Push sends them as on-click NAVIGATE reactions; Pull reads those back.
import {
	SCREEN_EASINGS,
	SCREEN_TRANSITION_TYPES,
	type Transition,
} from "@figma-agent-tool/protocol";
import type { Element } from "./screen";

const HREF = /^([^/\\?#]+)\.html$/;

/** The Screen an `href` goes to, or undefined when it isn't `<screen>.html`. */
export function linkedScreen(href: string): string | undefined {
	return HREF.exec(href.trim())?.[1];
}

/** The `href` that goes to a Screen. */
export function screenHref(screen: string): string {
	return `${screen}.html`;
}

type Easing = (typeof SCREEN_EASINGS)[number];

const kebab = (name: string) => name.toLowerCase().replaceAll("_", "-");

const TYPES = new Map<string, Transition["type"]>(
	SCREEN_TRANSITION_TYPES.map((type) => [kebab(type), type]),
);

const DIRECTIONAL = new Set([
	"MOVE_IN",
	"MOVE_OUT",
	"PUSH",
	"SLIDE_IN",
	"SLIDE_OUT",
]);

const DIRECTIONS = new Set(["left", "right", "top", "bottom"]);

/** CSS-style easing names: `ease-in-out` is Figma's EASE_IN_AND_OUT. */
const easingName = (easing: string) => kebab(easing).replace("-and-", "-");

const EASINGS = new Map<string, Easing>(
	SCREEN_EASINGS.map((easing) => [easingName(easing), easing]),
);

// Figma's defaults for a new animation.
const DEFAULT_DURATION_MS = 300;
const DEFAULT_EASING: Easing = "EASE_OUT";

const DURATION = /^(\d+(?:\.\d+)?)(ms|s)$/;

const SYNTAX =
	"Write `instant`, or a transition (dissolve, smart-animate, scroll-animate, move-in, move-out, push, slide-in, slide-out), a direction for move, push and slide (left, right, top, bottom), and optionally a duration (`300ms`, `0.3s`; 300ms by default) and an easing (ease-in, ease-out, ease-in-out, linear, ease-in-back, ease-out-back, ease-in-out-back, gentle, quick, bouncy, slow; ease-out by default), as in `push left 200ms ease-in-out`.";

/** A `data-transition` as Figma takes it (null is instant), or a problem. */
export function parseTransition(
	raw: string | undefined,
): { transition: Transition | null } | { problem: string } {
	const words = (raw ?? "instant").trim().toLowerCase().split(/\s+/);
	const [name = "", ...rest] = words;
	const invalid = (why: string) => ({
		problem: `\`data-transition="${raw}"\` ${why}. ${SYNTAX}`,
	});
	if (name === "instant") {
		return rest.length === 0
			? { transition: null }
			: invalid("is instant, which takes nothing else");
	}
	const type = TYPES.get(name);
	if (!type) return invalid(`doesn't start with a transition`);
	let direction: string | undefined;
	let duration: number | undefined;
	let easing: Easing | undefined;
	for (const word of rest) {
		const ms = DURATION.exec(word);
		if (DIRECTIONS.has(word) && !direction) {
			direction = word;
		} else if (ms && duration === undefined) {
			duration = Number(ms[1]) * (ms[2] === "s" ? 1000 : 1);
		} else if (EASINGS.has(word) && !easing) {
			easing = EASINGS.get(word);
		} else {
			return invalid(
				`has \`${word}\`, which isn't a direction, duration or easing (or is given twice)`,
			);
		}
	}
	const timing = {
		easing: { type: easing ?? DEFAULT_EASING },
		duration: (duration ?? DEFAULT_DURATION_MS) / 1000,
	};
	if (DIRECTIONAL.has(type)) {
		if (!direction) return invalid(`needs a direction for ${name}`);
		return {
			transition: {
				type,
				direction: direction.toUpperCase(),
				matchLayers: false,
				...timing,
			} as Transition,
		};
	}
	if (direction)
		return invalid(
			`gives ${name} a direction, which only move, push and slide take`,
		);
	return { transition: { type, ...timing } as Transition };
}

/** A transition's words; defaults left out unless `full`. */
function transitionWords(transition: Transition, full: boolean): string[] {
	const words = [kebab(transition.type)];
	if ("direction" in transition) words.push(transition.direction.toLowerCase());
	const ms = Math.round(transition.duration * 1000);
	if (full || ms !== DEFAULT_DURATION_MS) words.push(`${ms}ms`);
	const easing = transition.easing.type;
	if (full || easing !== DEFAULT_EASING) words.push(easingName(easing));
	return words;
}

/**
 * A transition as Pull writes it: undefined for instant, defaults left
 * out. Only transitions `prototypeLink` accepts are given to it.
 */
export function formatTransition(
	transition: Transition | null,
): string | undefined {
	return transition ? transitionWords(transition, false).join(" ") : undefined;
}

/** What a `data-transition` means, every default spelled out, for comparing. */
export function resolveTransition(raw: string | undefined): string {
	const parsed = parseTransition(raw);
	if ("problem" in parsed) return raw ?? "";
	const { transition } = parsed;
	return transition ? transitionWords(transition, true).join(" ") : "instant";
}

/** The Screens an element and everything in it link to. */
export function screenLinks(root: Element): string[] {
	const screens = new Set<string>();
	const walk = (element: Element) => {
		const screen = element.href && linkedScreen(element.href);
		if (screen) screens.add(screen);
		element.children.forEach(walk);
	};
	walk(root);
	return [...screens];
}
