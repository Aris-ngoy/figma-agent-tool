import { describe, expect, test } from "bun:test";
import { layerByKey, widerScreens } from "../fixtures";
import { checkProject, hasUnpulledChanges, type ScreenFile } from "../src";
import { fixtureProject } from "./fixture-project";
import { pull, push } from "./push-pull";

async function pushedScreen(source: string) {
	const project = await fixtureProject({
		"screens/login.html": null,
		"screens/wide.html": source,
	});
	const screen = project.screens[0] as ScreenFile;
	return { project, ...(await push(project, screen)) };
}

describe.each(Object.entries(widerScreens))("%s", (_, source) => {
	test("Check accepts it", async () => {
		const project = await fixtureProject({ "screens/wide.html": source });
		expect((await checkProject(project)).errors).toEqual([]);
	});

	test("Push then Pull round-trips it byte for byte", async () => {
		const { project, screen, baseline, frame } = await pushedScreen(source);
		expect(hasUnpulledChanges(project, screen, baseline, frame)).toBe(false);
		const result = pull(project, screen, baseline, frame);
		expect(result.changed).toBe(false);
		expect(result.figmaOwned).toEqual([]);
	});
});

describe("absolute positioning", () => {
	test("pushes as an absolutely positioned layer at its offset", async () => {
		const { tree } = await pushedScreen(widerScreens.absolute as string);
		const [, dot, badge] = tree.children ?? [];
		expect(dot).toMatchObject({
			type: "RECTANGLE",
			position: { x: 40, y: -4 },
			sizing: { horizontal: "FIXED", vertical: "FIXED" },
		});
		expect(badge).toMatchObject({
			type: "FRAME",
			position: { x: 300, y: 12 },
			sizing: { horizontal: "HUG", vertical: "HUG" },
		});
		expect(tree.children?.[0]?.position).toBeUndefined();
	});

	test("Pull writes where a designer moved a layer, and takes one out of auto layout", async () => {
		const { project, screen, baseline, frame } = await pushedScreen(
			widerScreens.absolute as string,
		);
		Object.assign(layerByKey(frame, "e3"), { x: 12, y: 20 });
		const title = layerByKey(frame, "e2");
		Object.assign(title, {
			x: 100,
			y: 50,
			absolute: { horizontal: "MIN", vertical: "MIN" },
		});
		const result = pull(project, screen, baseline, frame);
		expect(result.conflicts).toBe(0);
		expect(result.source).toContain(
			'<p data-key="e2" style="position:absolute; left:100px; top:50px">Inbox</p>',
		);
		expect(result.source).toContain(
			'style="position:absolute; left:12px; top:20px; width:8px; height:8px;',
		);
	});

	test.each([
		[
			"left without position:absolute",
			'<div style="left:4px; width:4px; height:4px"></div>',
			"invalid-value",
		],
		[
			"position:absolute without top",
			'<div style="position:absolute; left:4px; width:4px; height:4px"></div>',
			"position-required",
		],
		[
			"an absolute element filling its parent",
			'<div style="position:absolute; left:0; top:0; flex:1; height:4px"></div>',
			"conflicting-size",
		],
		[
			"position:relative",
			'<div style="position:relative; width:4px; height:4px"></div>',
			"invalid-value",
		],
	])("Check rejects %s", async (_, element, rule) => {
		const project = await fixtureProject({
			"screens/test.html": `<body style="display:flex">${element}</body>\n`,
		});
		const { errors } = await checkProject(project);
		expect(errors.map((error) => error.rule)).toEqual([rule]);
	});
});

describe("vectors", () => {
	test("push as vector layers, paths scaled from the viewBox to the element's size", async () => {
		const { tree } = await pushedScreen(widerScreens.vector as string);
		const [check, square] = tree.children ?? [];
		expect(check).toMatchObject({
			type: "VECTOR",
			name: "Check",
			width: 48,
			height: 48,
			fills: [],
			// A viewBox scales strokes too, as in a browser.
			stroke: {
				color: "#111111",
				weight: 4,
				align: "CENTER",
				cap: "ROUND",
				join: "ROUND",
			},
			vector: {
				paths: [{ data: "M 8 24 L 18 34 L 40 12", windingRule: "NONZERO" }],
			},
		});
		expect(square).toMatchObject({
			type: "VECTOR",
			name: "Vector",
			fills: [{ type: "SOLID", color: "#3366ff" }],
			vector: {
				paths: [
					{
						data: "M 0 0 L 20 0 L 20 20 L 0 20 Z M 5 5 L 5 15 L 15 15 L 15 5 Z",
						windingRule: "EVENODD",
					},
					{ data: "M 8 8 L 12 8 L 12 12 Z", windingRule: "NONZERO" },
				],
			},
		});
		expect(square?.stroke).toBeUndefined();
	});

	test("Pull writes a vector a designer edited as its paths at its size", async () => {
		const { project, screen, baseline, frame } = await pushedScreen(
			widerScreens.vector as string,
		);
		const check = layerByKey(frame, "e2");
		check.vector = {
			paths: [{ data: "M 8 24 L 18 34.5 L 40 12", windingRule: "NONE" }],
		};
		const result = pull(project, screen, baseline, frame);
		expect(result.source).toContain(
			[
				'  <svg data-key="e2" data-name="Check" style="width:48px; height:48px; fill:none; stroke:#111111; stroke-width:4px; stroke-linecap:round; stroke-linejoin:round">',
				'    <path d="M 8 24 L 18 34.5 L 40 12" />',
				"  </svg>",
			].join("\n"),
		);
	});

	test.each([
		["an arc", '<path d="M0 0A5 5 0 0 1 10 10" />', "invalid-path"],
		["a path without d", "<path />", "invalid-path"],
		["something other than a path", "<circle />", "unknown-element"],
		["no path", "", "invalid-path"],
	])("Check rejects %s in an <svg>", async (_, content, rule) => {
		const project = await fixtureProject({
			"screens/test.html": `<body style="display:flex"><svg style="width:10px; height:10px">${content}</svg></body>\n`,
		});
		const { errors } = await checkProject(project);
		expect(errors.map((error) => error.rule)).toEqual([rule]);
	});
});

describe("borders and clipping", () => {
	test("borders push as inside strokes, and overflow:hidden clips", async () => {
		const { tree } = await pushedScreen(widerScreens.border as string);
		const [card, logo, box] = tree.children ?? [];
		expect(card).toMatchObject({
			stroke: { color: "#dddddd", weight: 1, align: "INSIDE" },
			clips: false,
		});
		expect(logo?.stroke).toEqual({
			color: "#3366ff",
			weight: 2,
			align: "INSIDE",
		});
		expect(box?.stroke).toMatchObject({ color: "#000000", weight: 4 });
		const clipped = await pushedScreen(widerScreens.clipping as string);
		expect(clipped.tree.clips).toBe(true);
		expect(clipped.tree.children?.[0]?.clips).toBe(true);
	});

	test("Pull writes a stroke and clipping a designer added", async () => {
		const { project, screen, baseline, frame } = await pushedScreen(
			widerScreens.clipping as string,
		);
		const inner = layerByKey(frame, "e3");
		inner.strokes = 1;
		inner.stroke = {
			paint: { type: "SOLID", color: "#ff0000" },
			weight: 3,
			align: "INSIDE",
			cap: "NONE",
			join: "MITER",
			dashed: false,
		};
		layerByKey(frame, "e2").clips = false;
		const result = pull(project, screen, baseline, frame);
		expect(result.source).toContain(
			'<div data-key="e2" data-name="Window" style="display:flex; width:100px; height:60px">',
		);
		expect(result.source).toContain(
			'<div data-key="e3" style="width:200px; height:200px; background-color:#3366ff; border-width:3px; border-color:#ff0000"></div>',
		);
	});

	test.each([
		["a dashed border", "border:1px dashed #000", "invalid-value"],
		["a border without a color", "border-width:1px", "invalid-value"],
	])("Check rejects %s", async (_, style, rule) => {
		const project = await fixtureProject({
			"screens/test.html": `<body style="display:flex"><div style="width:4px; height:4px; ${style}"></div></body>\n`,
		});
		const { errors } = await checkProject(project);
		expect(errors.map((error) => error.rule)).toEqual([rule]);
	});
});
