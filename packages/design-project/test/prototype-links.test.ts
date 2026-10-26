import { describe, expect, test } from "bun:test";
import type { Reaction } from "@figma-agent-tool/protocol";
import { applyPrototypeLinks, layerByKey, linkedScreens } from "../fixtures";
import {
	checkProject,
	type DesignProject,
	hasUnpulledChanges,
	type ScreenFile,
} from "../src";
import { fixtureProject } from "./fixture-project";
import { pull, push } from "./push-pull";

const linkedFiles = {
	"screens/login.html": null,
	"screens/home.html": linkedScreens.home as string,
	"screens/signup.html": linkedScreens.signup as string,
};

/** Home and Sign up pushed into frames, then linked, as one Push does. */
async function pushedLinked(project?: DesignProject) {
	project ??= await fixtureProject(linkedFiles);
	let id = 0;
	const nextId = () => `9:${++id}`;
	const pushes = new Map<string, Awaited<ReturnType<typeof push>>>();
	for (const screen of project.screens)
		pushes.set(screen.name, await push(project, screen, undefined, nextId));
	const frameOf = (name: string) => pushes.get(name)?.frame.id;
	const screenFrames = Object.fromEntries(
		[...pushes].map(([name, pushed]) => [pushed.frame.id, name]),
	);
	for (const pushed of pushes.values()) {
		applyPrototypeLinks(pushed.frame, pushed.tree, {
			frameOf,
			screenFrames: Object.keys(screenFrames),
		});
	}
	const home = pushes.get("home") as NonNullable<ReturnType<typeof pushes.get>>;
	const signup = pushes.get("signup") as typeof home;
	return { project, home, signup, screenFrames };
}

const navigate = (
	destinationId: string,
	transition: unknown = null,
): Reaction => ({
	trigger: { type: "ON_CLICK" },
	actions: [
		{
			type: "NODE",
			destinationId,
			navigation: "NAVIGATE",
			transition,
		} as never,
	],
});

const hover: Reaction = {
	trigger: { type: "ON_HOVER" },
	actions: [
		{
			type: "NODE",
			destinationId: "9:99",
			navigation: "OVERLAY",
			transition: null,
		},
	],
};

describe("Check", () => {
	async function errorsFor(body: string) {
		const project = await fixtureProject({
			...linkedFiles,
			"screens/test.html": `<body style="display:flex">\n  ${body}\n</body>\n`,
		});
		return (await checkProject(project)).errors.map(({ rule, message }) => ({
			rule,
			message,
		}));
	}

	test("accepts links between Screens", async () => {
		const project = await fixtureProject(linkedFiles);
		expect((await checkProject(project)).errors).toEqual([]);
	});

	test.each([
		[
			"a link to a Screen that doesn't exist",
			'<a href="settings.html">Settings</a>',
			"unknown-screen",
			"settings",
		],
		[
			"a link that isn't to a Screen",
			'<a href="https://example.com">Docs</a>',
			"invalid-link",
			"https://example.com",
		],
		[
			"an unknown transition",
			'<a href="home.html" data-transition="wipe">Home</a>',
			"invalid-transition",
			"wipe",
		],
		[
			"a directional transition without a direction",
			'<a href="home.html" data-transition="push 200ms">Home</a>',
			"invalid-transition",
			"needs a direction",
		],
		[
			"a direction on a transition that takes none",
			'<a href="home.html" data-transition="dissolve left">Home</a>',
			"invalid-transition",
			"direction",
		],
		[
			"an unknown easing",
			'<a href="home.html" data-transition="smart-animate springy">Home</a>',
			"invalid-transition",
			"springy",
		],
		[
			"a transition without a link",
			'<p data-transition="dissolve">Home</p>',
			"invalid-transition",
			"href",
		],
		["an <a> without a link", "<a>Home</a>", "missing-link", "href"],
	])("rejects %s", async (_, body, rule, mention) => {
		const errors = await errorsFor(body);
		expect(errors).toEqual([
			{ rule, message: expect.stringContaining(mention) },
		]);
	});

	test("rejects a link on <body> or on a Figma-owned Element", async () => {
		const project = await fixtureProject({
			...linkedFiles,
			"screens/test.html":
				'<body href="home.html" style="display:flex">\n  <figma-owned data-key="e9" href="home.html" style="width:4px; height:4px"></figma-owned>\n</body>\n',
		});
		const errors = (await checkProject(project)).errors;
		expect(errors.map(({ rule, line }) => [rule, line])).toEqual([
			["unknown-attribute", 1],
			["unknown-attribute", 2],
		]);
	});
});

describe("Push", () => {
	test("sends each link with its Screen and transition, instant by default", async () => {
		const { home, signup } = await pushedLinked();
		const [, button, text, square] = home.tree.children ?? [];
		expect(button).toMatchObject({
			type: "FRAME",
			name: "Sign up",
			link: {
				screen: "signup",
				transition: {
					type: "PUSH",
					direction: "LEFT",
					matchLayers: false,
					easing: { type: "EASE_OUT" },
					duration: 0.3,
				},
			},
		});
		expect(text).toMatchObject({
			type: "TEXT",
			link: { screen: "signup", transition: null },
		});
		expect(square).toMatchObject({
			type: "RECTANGLE",
			link: {
				screen: "home",
				transition: {
					type: "DISSOLVE",
					easing: { type: "EASE_IN_AND_OUT" },
					duration: 0.2,
				},
			},
		});
		expect(home.tree.children?.[0]?.link).toBeUndefined();
		expect(signup.tree.children?.[0]).toMatchObject({
			link: {
				screen: "home",
				transition: { type: "SLIDE_OUT", direction: "RIGHT", duration: 0.25 },
			},
		});
	});

	test("the layers get on-click NAVIGATE reactions to the Screens' frames", async () => {
		const { home, signup } = await pushedLinked();
		expect(layerByKey(home.frame, "e3").reactions).toEqual([
			navigate(signup.frame.id, {
				type: "PUSH",
				direction: "LEFT",
				matchLayers: false,
				easing: { type: "EASE_OUT" },
				duration: 0.3,
			}),
		]);
		expect(layerByKey(home.frame, "e5").reactions).toEqual([
			navigate(signup.frame.id),
		]);
		expect(layerByKey(home.frame, "e2").reactions).toBeUndefined();
	});
});

describe("Pull", () => {
	test("Push then Pull round-trips linked Screens byte for byte", async () => {
		const { project, home, signup, screenFrames } = await pushedLinked();
		for (const pushed of [home, signup]) {
			const { screen, baseline, frame } = pushed;
			expect(
				hasUnpulledChanges(project, screen, baseline, frame, screenFrames),
			).toBe(false);
			const result = pull(project, screen, baseline, frame, screenFrames);
			expect(result.changed).toBe(false);
		}
	});

	test("writes a transition a designer changed, and a link a designer added", async () => {
		const { project, home, signup, screenFrames } = await pushedLinked();
		const { screen, baseline, frame } = home;
		const button = layerByKey(frame, "e3");
		button.reactions = [
			navigate(signup.frame.id, {
				type: "SMART_ANIMATE",
				easing: { type: "GENTLE" },
				duration: 0.6000000238418579,
			}),
		];
		layerByKey(frame, "e2").reactions = [navigate(frame.id)];
		const result = pull(project, screen, baseline, frame, screenFrames);
		expect(result.conflicts).toBe(0);
		expect(result.source).toContain(
			'<a data-key="e3" data-name="Sign up" href="signup.html" data-transition="smart-animate 600ms gentle" style=',
		);
		expect(result.source).toContain(
			'<h1 data-key="e2" href="home.html">Home</h1>',
		);
	});

	test("a link a designer removed leaves an <a> as the element it is", async () => {
		const { project, home, screenFrames } = await pushedLinked();
		const { screen, baseline, frame } = home;
		delete layerByKey(frame, "e5").reactions;
		delete layerByKey(frame, "e3").reactions;
		const result = pull(project, screen, baseline, frame, screenFrames);
		expect(result.source).toContain('<p data-key="e5">I have an account</p>');
		expect(result.source).toContain(
			'<div data-key="e3" data-name="Sign up" style="display:flex; padding:12px; background-color:#3366ff">',
		);
		const { errors } = await checkProject({
			...project,
			screens: [{ ...screen, source: result.source as string }],
		});
		expect(errors).toEqual([]);
	});

	test("merges a designer's transition with the Agent's edit elsewhere in the element", async () => {
		const { project, home, signup, screenFrames } = await pushedLinked();
		const { baseline, frame } = home;
		layerByKey(frame, "e3").reactions = [
			navigate(signup.frame.id, {
				type: "PUSH",
				direction: "LEFT",
				matchLayers: false,
				easing: { type: "EASE_OUT" },
				duration: 0.5,
			}),
		];
		const screen: ScreenFile = {
			...home.screen,
			source: home.screen.source.replace("padding:12px", "padding:16px"),
		};
		const result = pull(project, screen, baseline, frame, screenFrames);
		expect(result.conflicts).toBe(0);
		expect(result.source).toContain(
			'href="signup.html" data-transition="push left 500ms" style="display:flex; padding:16px;',
		);
	});

	test("marks a Sync Conflict where both sides changed a link", async () => {
		const { project, home, signup, screenFrames } = await pushedLinked();
		const { baseline, frame } = home;
		layerByKey(frame, "e5").reactions = [
			navigate(signup.frame.id, {
				type: "SMART_ANIMATE",
				easing: { type: "EASE_OUT" },
				duration: 0.3,
			}),
		];
		const screen: ScreenFile = {
			...home.screen,
			source: home.screen.source.replace(
				'<a data-key="e5" href="signup.html">',
				'<a data-key="e5" href="signup.html" data-transition="dissolve">',
			),
		};
		const result = pull(project, screen, baseline, frame, screenFrames);
		expect(result.conflicts).toBe(1);
		expect(result.source).toContain(
			'<a data-key="e5" href="signup.html" data-transition="dissolve">I have an account</a>\n=======\n  <a data-key="e5" href="signup.html" data-transition="smart-animate">',
		);
	});

	test("Figma-only reactions aren't Prototype Links: the Screen doesn't change", async () => {
		const { project, home, signup, screenFrames } = await pushedLinked();
		const { screen, baseline, frame } = home;
		layerByKey(frame, "e2").reactions = [
			hover,
			// Overlays, other triggers and custom curves stay Figma's.
			{ ...navigate(signup.frame.id), trigger: { type: "ON_DRAG" } },
			navigate(signup.frame.id, {
				type: "DISSOLVE",
				easing: {
					type: "CUSTOM_SPRING",
					easingFunctionSpring: {
						mass: 1,
						stiffness: 100,
						damping: 15,
						initialVelocity: 0,
					},
				},
				duration: 0.3,
			}),
		];
		// A designer's frame that isn't a Screen's.
		layerByKey(frame, "e4").reactions = [navigate("7:1")];
		expect(
			hasUnpulledChanges(project, screen, baseline, frame, screenFrames),
		).toBe(false);
	});

	test("a link to a Screen's frame that was replaced still reads as that Screen", async () => {
		const { project, home, signup, screenFrames } = await pushedLinked();
		// Sign up's frame was deleted and pushed anew: Home still points at the old one.
		const frames = { ...screenFrames, "9:500": "signup" };
		const moved = structuredClone(home.frame);
		expect(
			hasUnpulledChanges(project, home.screen, home.baseline, moved, frames),
		).toBe(false);
		expect(signup.frame.id).not.toBe("9:500");
	});
});

describe("Push again", () => {
	test("keeps Figma-only reactions and replaces only the Prototype Link", async () => {
		const { project, home, signup, screenFrames } = await pushedLinked();
		const button = layerByKey(home.frame, "e3");
		button.reactions = [hover, ...(button.reactions ?? [])];
		const edited = {
			...home.screen,
			source: home.screen.source.replace(
				'data-transition="push left"',
				'data-transition="slide-in bottom 100ms linear"',
			),
		};
		const again = await push(project, edited, home);
		applyPrototypeLinks(again.frame, again.tree, {
			frameOf: () => signup.frame.id,
			screenFrames: Object.keys(screenFrames),
		});
		expect(layerByKey(again.frame, "e3").reactions).toEqual([
			hover,
			navigate(signup.frame.id, {
				type: "SLIDE_IN",
				direction: "BOTTOM",
				matchLayers: false,
				easing: { type: "LINEAR" },
				duration: 0.1,
			}),
		]);
	});

	test("removes a link the Screen dropped, keeping the rest", async () => {
		const { project, home, signup, screenFrames } = await pushedLinked();
		const text = layerByKey(home.frame, "e5");
		text.reactions = [...(text.reactions ?? []), hover];
		const edited = {
			...home.screen,
			source: home.screen.source.replace(
				'<a data-key="e5" href="signup.html">I have an account</a>',
				'<p data-key="e5">I have an account</p>',
			),
		};
		const again = await push(project, edited, home);
		applyPrototypeLinks(again.frame, again.tree, {
			frameOf: () => signup.frame.id,
			screenFrames: Object.keys(screenFrames),
		});
		expect(layerByKey(again.frame, "e5").reactions).toEqual([hover]);
	});
});
