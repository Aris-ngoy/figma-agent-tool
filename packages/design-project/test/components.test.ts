import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import type { ScreenNode, SyncedNode } from "@figma-agent-tool/protocol";
import {
	avatarComponent,
	componentFiles,
	createFakeComponents,
	detachInstance,
	layerByKey,
} from "../fixtures";
import {
	assignKeys,
	type Baseline,
	baselineAfterPush,
	checkProject,
	checkScreen,
	definitionOf,
	type Element,
	figmaComponents,
	hasUnpulledChanges,
	loadProject,
	type ScreenFile,
	screenPush,
	writeLinkedComponentRecord,
} from "../src";
import { fixtureProject } from "./fixture-project";
import { pull, push } from "./push-pull";

const files = { "screens/login.html": null, ...componentFiles };

async function errorsFor(overrides: Record<string, string | null>) {
	const project = await fixtureProject({ ...files, ...overrides });
	return (await checkProject(project)).errors.map(
		({ file, rule, message }) => ({ file, rule, message }),
	);
}

const screen = (body: string) => ({
	"screens/test.html": `<body style="display:flex">\n  ${body}\n</body>\n`,
});

describe("Check", () => {
	test("accepts Defined and Linked Components and Screens using them", async () => {
		expect(await errorsFor({})).toEqual([]);
	});

	test("reads a Defined Component's variant and text properties", async () => {
		const project = await fixtureProject(files);
		expect(definitionOf(project, "app-button")).toEqual({
			properties: {
				kind: {
					type: "VARIANT",
					default: "primary",
					options: ["primary", "secondary"],
				},
				label: { type: "TEXT", default: "Sign in" },
			},
			variants: ["kind=primary", "kind=secondary"],
		});
		// A Linked Component's properties are known once Push has read them.
		expect(definitionOf(project, "app-avatar")).toBeUndefined();
	});

	test.each([
		[
			"an instance of a Component that doesn't exist",
			"<app-card></app-card>",
			"unknown-component",
			"components/app-card.html",
		],
		[
			"a property the Component doesn't have",
			'<app-button size="lg"></app-button>',
			"unknown-attribute",
			"`kind`, `label`",
		],
		[
			"a variant the Component doesn't have",
			'<app-button kind="ghost"></app-button>',
			"invalid-property",
			"`primary`, `secondary`",
		],
		[
			"content in an instance",
			"<app-button><p>Go</p></app-button>",
			"instance-content",
			"holds nothing",
		],
		[
			"styles other than its place and size",
			'<app-button style="background-color:#ff0000"></app-button>',
			"unknown-property",
			"background-color",
		],
	])("rejects %s", async (_, body, rule, mention) => {
		expect(await errorsFor(screen(body))).toEqual([
			{
				file: "screens/test.html",
				rule,
				message: expect.stringContaining(mention),
			},
		]);
	});

	test.each([
		[
			"a file that isn't all <component>s",
			'<div style="display:flex"></div>\n',
			"component-roots",
		],
		[
			"variants without data-variant",
			'<component style="display:flex"></component>\n<component style="display:flex"></component>\n',
			"missing-variant",
		],
		[
			"a malformed variant",
			'<component data-variant="primary" style="display:flex"></component>\n',
			"invalid-variant",
		],
		[
			"variants setting different properties",
			'<component data-variant="kind=a" style="display:flex"></component>\n<component data-variant="size=b" style="display:flex"></component>\n',
			"invalid-variant",
		],
		[
			"the same variant twice",
			'<component data-variant="kind=a" style="display:flex"></component>\n<component data-variant="kind=a" style="display:flex"></component>\n',
			"duplicate-variant",
		],
		[
			"a text property named like a variant property",
			'<component data-variant="kind=a" style="display:flex">\n  <p data-property="kind">A</p>\n</component>\n',
			"invalid-property",
		],
		[
			"a text property with different texts in two variants",
			'<component data-variant="kind=a" style="display:flex">\n  <p data-property="label">A</p>\n</component>\n<component data-variant="kind=b" style="display:flex">\n  <p data-property="label">B</p>\n</component>\n',
			"invalid-property",
		],
		[
			"a Prototype Link",
			'<component style="display:flex">\n  <p href="start.html">A</p>\n</component>\n',
			"unknown-attribute",
		],
		[
			"an instance inside a Component",
			'<component style="display:flex">\n  <app-button></app-button>\n</component>\n',
			"nested-component",
		],
		[
			"a <component> placed like an instance",
			'<component style="display:flex; flex:1"></component>\n',
			"unknown-property",
		],
	])("rejects a Defined Component with %s", async (_, source, rule) => {
		const errors = await errorsFor({ "components/app-tag.html": source });
		expect([...new Set(errors.map((e) => `${e.file} ${e.rule}`))]).toEqual([
			`components/app-tag.html ${rule}`,
		]);
	});

	test.each([
		["no key or ID", "{}"],
		["both", '{ "key": "a", "id": "1:2" }'],
		["invalid JSON", "{ key }"],
	])("rejects a Linked Component's file with %s", async (_, source) => {
		const errors = await errorsFor({ "components/app-avatar.json": source });
		expect(errors.map((e) => [e.file, e.rule])).toEqual([
			["components/app-avatar.json", "invalid-linked-component"],
		]);
	});

	test("rejects Component names that aren't custom elements, and names used twice", async () => {
		const errors = await errorsFor({
			"components/Button.html":
				'<component style="display:flex"></component>\n',
			"components/app-button.json": '{ "key": "b" }',
		});
		expect(errors.map((e) => [e.file, e.rule])).toEqual([
			["components/Button.html", "invalid-component-name"],
			["components/app-button.html", "duplicate-component"],
			["components/app-button.json", "duplicate-component"],
		]);
	});
});

/**
 * The fixture's Components and its start Screen pushed into a fake file, as
 * Push does: Linked Components found and recorded, then Defined Components,
 * then the Screen.
 */
async function pushedStart(overrides: Record<string, string | null> = {}) {
	let project = await fixtureProject({ ...files, ...overrides });
	let id = 0;
	const nextId = () => `9:${++id}`;
	const fake = createFakeComponents(nextId);
	fake.addLibraryComponent(avatarComponent);
	for (const linked of project.linkedComponents) {
		const { component, ...record } = fake.resolve({
			component: linked.name,
			key: linked.key,
			id: linked.id,
		}) as NonNullable<ReturnType<typeof fake.resolve>>;
		await writeLinkedComponentRecord(project, component, record);
	}
	project = await loadProject(project.dir);
	const baselines = new Map<string, Baseline>();
	const trees = new Map<string, ScreenNode>();
	for (const component of project.components) {
		const keyed = { ...component, source: assignKeys(component.source).source };
		await writeFile(keyed.path, keyed.source);
		const { root } = checkScreen(project, keyed);
		if (!root) throw new Error(`${component.file} doesn't check`);
		const { tree, remove } = await screenPush(project, keyed, root, undefined);
		const node = fake.apply(
			{ component: component.name, tree, remove },
			{ nextId, imageHash: (name) => name },
		);
		trees.set(component.name, tree);
		baselines.set(
			component.name,
			baselineAfterPush(project, keyed.source, node, {}),
		);
	}
	project = await loadProject(project.dir);
	const screen = project.screens.find((s) => s.name === "start") as ScreenFile;
	const pushed = await push(project, screen, undefined, nextId, fake);
	return {
		...pushed,
		project,
		fake,
		nextId,
		trees,
		baselines,
		figma: () => figmaComponents(project, baselines),
	};
}

describe("Push", () => {
	test("sends a Defined Component as a component set of its variants, with its text property", async () => {
		const { trees } = await pushedStart();
		const tree = trees.get("app-button") as ScreenNode;
		expect(tree).toMatchObject({
			type: "COMPONENT_SET",
			key: "component-set",
			name: "app-button",
			sizing: { horizontal: "HUG", vertical: "HUG" },
		});
		expect(tree.children?.map(({ type, name }) => ({ type, name }))).toEqual([
			{ type: "COMPONENT", name: "kind=primary" },
			{ type: "COMPONENT", name: "kind=secondary" },
		]);
		expect(tree.children?.[0]?.children?.[0]).toMatchObject({
			type: "TEXT",
			property: "label",
			text: { characters: "Sign in" },
		});
	});

	test("sends a Component without variants as a lone component", async () => {
		const { trees } = await pushedStart({
			"components/app-chip.html":
				'<component style="display:flex; padding:4px">\n  <p data-property="text">Chip</p>\n</component>\n',
		});
		expect(trees.get("app-chip")).toMatchObject({
			type: "COMPONENT",
			name: "app-chip",
			children: [{ type: "TEXT", property: "text" }],
		});
	});

	test("sends instances with every property of a Defined Component, and those set of a Linked one", async () => {
		const { tree } = await pushedStart();
		const [, primary, secondary, linked] = tree.children ?? [];
		expect(primary).toMatchObject({
			type: "INSTANCE",
			component: "app-button",
			name: "app-button",
			properties: { kind: "primary", label: "Get started" },
			sizing: { horizontal: "FILL", vertical: "HUG" },
		});
		expect(secondary).toMatchObject({
			properties: { kind: "secondary", label: "Sign in" },
			sizing: { horizontal: "HUG", vertical: "HUG" },
		});
		expect(linked).toMatchObject({
			type: "INSTANCE",
			component: "app-avatar",
			properties: { size: "large", initials: "AB" },
			width: 40,
			sizing: { horizontal: "FIXED", vertical: "FIXED" },
		});
		expect(primary?.children).toBeUndefined();
	});
});

describe("Pull", () => {
	test("Push then Pull leaves the Screen and its Components as they are", async () => {
		const { project, screen, baseline, frame, fake, baselines, figma } =
			await pushedStart();
		expect(
			hasUnpulledChanges(project, screen, baseline, frame, {}, figma()),
		).toBe(false);
		expect(pull(project, screen, baseline, frame, {}, figma()).changed).toBe(
			false,
		);
		for (const component of project.components) {
			const node = fake.defined.get(component.name) as SyncedNode;
			const componentBaseline = baselines.get(component.name) as Baseline;
			expect(
				hasUnpulledChanges(project, component, componentBaseline, node),
			).toBe(false);
		}
	});

	test("a designer's instance overrides become attributes, and properties set back to their defaults go", async () => {
		const { project, screen, baseline, frame, figma } = await pushedStart();
		const primary = layerByKey(frame, "e3");
		const secondary = layerByKey(frame, "e4");
		const linked = layerByKey(frame, "e5");
		Object.assign(primary.instance ?? {}, {
			properties: { kind: "primary", label: "Sign in" },
		});
		Object.assign(secondary.instance ?? {}, {
			properties: { kind: "secondary", label: "Create account" },
		});
		Object.assign(linked.instance ?? {}, {
			properties: { size: "small", initials: "CD" },
		});
		linked.name = "Me";
		expect(
			hasUnpulledChanges(project, screen, baseline, frame, {}, figma()),
		).toBe(true);
		const result = pull(project, screen, baseline, frame, {}, figma());
		expect(result.conflicts).toBe(0);
		expect(
			result.source,
		).toBe(`<body data-key="e1" style="display:flex; flex-direction:column; gap:16px; padding:24px">
  <h1 data-key="e2">Start</h1>
  <app-button data-key="e3" style="align-self:stretch"></app-button>
  <app-button data-key="e4" kind="secondary" label="Create account"></app-button>
  <app-avatar data-key="e5" data-name="Me" initials="CD" style="width:40px; height:40px"></app-avatar>
</body>
`);
	});

	test("a detached instance becomes plain elements in the Screen, which Push then updates in place", async () => {
		const pushed = await pushedStart();
		const { project, screen, baseline, frame, fake, nextId, figma } = pushed;
		const button = fake.defined.get("app-button") as SyncedNode;
		const variant = button.children?.[1] as SyncedNode;
		detachInstance(frame, "e4", variant, nextId);
		const result = pull(project, screen, baseline, frame, {}, figma());
		expect(
			result.source,
		).toContain(`  <div data-key="e4" data-name="app-button" style="display:flex; justify-content:center; padding:12px 16px; border-radius:12px; border-width:1px; border-color:#3366ff">
    <p data-key="e6" style="color:#3366ff; font-weight:600">Sign in</p>
  </div>
`);
		const pulled = { ...screen, source: result.source as string };
		const detachedText = layerByKey(frame, "e4").children?.[0]?.id;
		expect(result.baseline.nodes.e6).toBe(detachedText as string);
		const again = await push(
			project,
			pulled,
			{ frame, baseline: result.baseline },
			nextId,
			fake,
		);
		expect(layerByKey(again.frame, "e6").id).toBe(detachedText as string);
	});

	test("an instance of a component that isn't the Design Project's becomes a Figma-owned Element", async () => {
		const { project, screen, baseline, frame, figma } = await pushedStart();
		const stranger = structuredClone(layerByKey(frame, "e5"));
		Object.assign(stranger, {
			id: "7:7",
			key: null,
			name: "Badge",
			instance: { mainId: "8:8", mainKey: "other", properties: {} },
		});
		frame.children?.push(stranger);
		const result = pull(project, screen, baseline, frame, {}, figma());
		expect(result.source).toContain(
			'<figma-owned data-key="e6" data-name="Badge" style="width:40px; height:40px"></figma-owned>',
		);
		expect(result.figmaOwned).toEqual([
			expect.objectContaining({
				name: "Badge",
				reason: expect.stringContaining(
					"isn't one of the Design Project's Components",
				),
			}),
		]);
	});

	test("a designer's edits to a Defined Component's main component merge into its file", async () => {
		const { project, fake, baselines } = await pushedStart();
		const component = project.components.find(
			(c) => c.name === "app-button",
		) as ScreenFile;
		const node = fake.defined.get("app-button") as SyncedNode;
		const baseline = baselines.get("app-button") as Baseline;
		const primary = node.children?.[0] as SyncedNode;
		(primary.layout as NonNullable<SyncedNode["layout"]>).padding.top = 14;
		(primary.layout as NonNullable<SyncedNode["layout"]>).padding.bottom = 14;
		const label = primary.children?.[0] as SyncedNode;
		(label.text as { characters: string }).characters = "Log in";
		label.name = "Log in";
		expect(hasUnpulledChanges(project, component, baseline, node)).toBe(true);
		const result = pull(project, component, baseline, node);
		expect(
			result.source,
		).toBe(`<component data-key="e1" data-variant="kind=primary" style="display:flex; justify-content:center; padding:14px 16px; background-color:var(--colors-primary); border-radius:12px">
  <p data-key="e2" data-property="label" style="color:#ffffff; font-weight:600">Log in</p>
</component>
<component data-key="e3" data-variant="kind=secondary" style="display:flex; justify-content:center; padding:12px 16px; border-radius:12px; border-width:1px; border-color:var(--colors-primary)">
  <p data-key="e4" data-property="label" style="color:var(--colors-primary); font-weight:600">Sign in</p>
</component>
`);
	});

	test("Pushing a Component again keeps its node IDs", async () => {
		const { project, fake, baselines, nextId } = await pushedStart();
		const before = structuredClone(
			fake.defined.get("app-button") as SyncedNode,
		);
		const component = project.components.find(
			(c) => c.name === "app-button",
		) as ScreenFile;
		const { root } = checkScreen(project, component);
		const { tree, remove } = await screenPush(
			project,
			component,
			root as Element,
			baselines.get("app-button"),
		);
		const after = fake.apply(
			{ component: "app-button", nodeId: before.id, tree, remove },
			{ nextId, imageHash: (name) => name },
		);
		const ids = (node: SyncedNode): string[] => [
			node.id,
			...(node.children ?? []).flatMap(ids),
		];
		expect(ids(after)).toEqual(ids(before));
	});
});
