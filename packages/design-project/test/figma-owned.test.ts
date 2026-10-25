import { describe, expect, test } from "bun:test";
import type { SyncedNode } from "@figma-agent-tool/protocol";
import { layerByKey } from "../fixtures";
import {
	type Baseline,
	checkProject,
	type DesignProject,
	hasUnpulledChanges,
	type ScreenFile,
} from "../src";
import { fixtureProject } from "./fixture-project";
import { pull, push, pushedLogin } from "./push-pull";

function layerById(frame: SyncedNode, id: string): SyncedNode {
	const found = frame.children?.find((layer) => layer.id === id);
	if (!found) throw new Error(`No layer ${id}`);
	return found;
}

/** A star a designer drew in the login frame, after the title. */
function drawStar(frame: SyncedNode): SyncedNode {
	const star: SyncedNode = {
		...structuredClone(layerByKey(frame, "e7")),
		id: "9:60",
		key: null,
		type: "STAR",
		name: "Star",
		width: 40,
		height: 38,
		sizing: { horizontal: "FIXED", vertical: "FIXED" },
		fills: [{ type: "SOLID", color: "#ffcc00" }],
	};
	frame.children?.splice(2, 0, star);
	return star;
}

/** Login, pushed, with a star drawn and pulled into the Screen. */
async function pulledStar() {
	const pushed = await pushedLogin();
	drawStar(pushed.frame);
	const result = pull(
		pushed.project,
		pushed.screen,
		pushed.baseline,
		pushed.frame,
	);
	const screen = { ...pushed.screen, source: result.source as string };
	return { ...pushed, result, screen, baseline: result.baseline };
}

/** Pushes an edited Screen over the frame and its Baseline. */
function pushAgain(
	project: DesignProject,
	screen: ScreenFile,
	frame: SyncedNode,
	baseline: Baseline,
	edit: (source: string) => string = (source) => source,
) {
	return push(
		project,
		{ ...screen, source: edit(screen.source) },
		{ frame, baseline },
	);
}

describe("Pull", () => {
	test("writes a layer outside the Screen Subset as a Figma-owned Element at its place and size", async () => {
		const { project, screen, result, frame } = await pulledStar();
		expect(result.changed).toBe(true);
		expect(result.source).toContain('  <h1 data-key="e3"');
		expect(result.source).toContain(
			'</h1>\n  <figma-owned data-key="e8" data-name="Star" style="width:40px; height:38px"></figma-owned>\n  <p data-key="e4"',
		);
		expect(result.figmaOwned).toEqual([
			{ key: "e8", nodeId: "9:60", name: "Star", reason: "is a STAR" },
		]);
		expect(result.baseline.nodes.e8).toBe("9:60");
		expect(
			(await checkProject({ ...project, screens: [screen] })).errors,
		).toEqual([]);
		expect(hasUnpulledChanges(project, screen, result.baseline, frame)).toBe(
			false,
		);
	});

	test("writes a pushed layer a designer took outside the subset as a Figma-owned Element", async () => {
		const { project, screen, baseline, frame } = await pushedLogin();
		const button = layerByKey(frame, "e5");
		button.effects = 1;
		const result = pull(project, screen, baseline, frame);
		expect(result.conflicts).toBe(0);
		expect(result.source).toContain(
			'  <figma-owned data-key="e5" data-name="Button" style="height:100px; align-self:stretch"></figma-owned>\n',
		);
		expect(result.source).not.toContain('data-key="e6"');
	});

	test("marks a Sync Conflict where Figma took an element out of the subset that the Design Project changed", async () => {
		const { project, screen, baseline, frame } = await pushedLogin();
		layerByKey(frame, "e5").effects = 1;
		const local = {
			...screen,
			source: screen.source.replace("Sign in</p>", "Log in</p>"),
		};
		const result = pull(project, local, baseline, frame);
		expect(result.conflicts).toBe(1);
		expect(result.source).toContain(
			'=======\n  <figma-owned data-key="e5" data-name="Button"',
		);
	});

	test("follows a Figma-owned Element a designer moved and resized", async () => {
		const { project, screen, baseline, frame } = await pulledStar();
		Object.assign(layerById(frame, "9:60"), {
			width: 80,
			absolute: { horizontal: "MIN", vertical: "MIN" },
			x: 10,
			y: 20,
		});
		const result = pull(project, screen, baseline, frame);
		expect(result.source).toContain(
			'<figma-owned data-key="e8" data-name="Star" style="position:absolute; left:10px; top:20px; width:80px; height:38px"></figma-owned>',
		);
	});
});

describe("Push", () => {
	test("leaves a Figma-owned Element's layer as the designers made it", async () => {
		const { project, screen, baseline, frame } = await pulledStar();
		const before = structuredClone(layerById(frame, "9:60"));
		const again = await pushAgain(project, screen, frame, baseline);
		const star = again.tree.children?.[2];
		expect(star).toMatchObject({ key: "e8", id: "9:60", type: "OWNED" });
		expect(star?.place).toBeUndefined();
		const after: SyncedNode = { ...layerByKey(again.frame, "e8"), key: null };
		expect(after).toEqual(before);
		expect(
			pull(project, again.screen, again.baseline, again.frame).changed,
		).toBe(false);
	});

	test("moves and resizes a Figma-owned Element's layer when the Screen did", async () => {
		const { project, screen, baseline, frame } = await pulledStar();
		const again = await pushAgain(project, screen, frame, baseline, (source) =>
			source.replace(
				'style="width:40px; height:38px"',
				'style="position:absolute; left:4px; top:8px; width:60px; height:38px"',
			),
		);
		expect(again.tree.children?.[2]).toMatchObject({
			type: "OWNED",
			place: true,
			width: 60,
			position: { x: 4, y: 8 },
		});
		expect(layerByKey(again.frame, "e8")).toMatchObject({
			type: "STAR",
			width: 60,
			x: 4,
			y: 8,
			fills: [{ type: "SOLID", color: "#ffcc00" }],
		});
	});

	test("deletes the layer of a Figma-owned Element the Screen deleted", async () => {
		const { project, screen, baseline, frame } = await pulledStar();
		const again = await pushAgain(project, screen, frame, baseline, (source) =>
			source.replace(/\n {2}<figma-owned[^\n]*/, ""),
		);
		expect(again.remove).toEqual(["9:60"]);
		expect(again.frame.children?.map((layer) => layer.id)).not.toContain(
			"9:60",
		);
	});
});

describe("Check", () => {
	test.each([
		[
			"without a data-key",
			'<figma-owned style="width:4px; height:4px"></figma-owned>',
			"missing-key",
		],
		[
			"with children",
			'<figma-owned data-key="e2" style="width:4px; height:4px"><p>Hi</p></figma-owned>',
			"figma-owned-content",
		],
		[
			"with a style beyond its place and size",
			'<figma-owned data-key="e2" style="width:4px; height:4px; opacity:0.5"></figma-owned>',
			"unknown-property",
		],
		[
			"without a size",
			'<figma-owned data-key="e2"></figma-owned>',
			"size-required",
		],
	])("rejects a Figma-owned Element %s", async (_, element, rule) => {
		const project = await fixtureProject({
			"screens/test.html": `<body style="display:flex">${element}</body>\n`,
		});
		const { errors } = await checkProject(project);
		expect(errors.map((error) => error.rule)).toEqual([rule]);
	});
});
