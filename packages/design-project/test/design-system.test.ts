import { describe, expect, test } from "bun:test";
import { lint } from "@google/design.md/linter";
import { createFakeDesignSystem, designMd } from "../fixtures";
import {
	assignKeys,
	checkDesignMd,
	checkScreen,
	type DesignSystemBaseline,
	designSystemChanges,
	designSystemPush,
	figmaDesignSystem,
	parseDesignMd,
	pullDesignSystem,
	type ScreenFile,
	screenPush,
	tokenBindings,
} from "../src";
import { fixtureProject } from "./fixture-project";

/** Pushes DESIGN.md into a fake file, as Push does with the Screens. */
function pushDesignMd(source = designMd) {
	let id = 0;
	const figma = createFakeDesignSystem(() => `5:${++id}`);
	const { push } = designSystemPush(parseDesignMd(source).fields);
	const pushed = figma.push(push);
	const baseline: DesignSystemBaseline = {
		source,
		collectionId: pushed.collectionId,
		variables: pushed.variables,
		textStyles: pushed.textStyles,
	};
	const read = () =>
		figmaDesignSystem(
			figma.read({
				variables: Object.values(baseline.variables),
				textStyles: Object.values(baseline.textStyles),
			}),
			baseline,
		);
	return { figma, baseline, read };
}

describe("Design System Push", () => {
	test("turns colors, spacing and rounded into variables and typography into text styles", () => {
		const { push, warnings } = designSystemPush(parseDesignMd(designMd).fields);
		expect(warnings).toEqual([]);
		expect(push.collection).toEqual({ name: "Design System" });
		expect(push.variables).toEqual([
			{
				token: "colors.primary",
				name: "colors/primary",
				type: "COLOR",
				value: { color: "#3366ff" },
			},
			{
				token: "colors.surface",
				name: "colors/surface",
				type: "COLOR",
				value: { color: "#ffffff" },
			},
			{
				token: "colors.text",
				name: "colors/text",
				type: "COLOR",
				value: { color: "#111111" },
			},
			{
				token: "colors.heading",
				name: "colors/heading",
				type: "COLOR",
				value: { token: "colors.text" },
			},
			{
				token: "rounded.md",
				name: "rounded/md",
				type: "FLOAT",
				value: 8,
			},
			{
				token: "spacing.md",
				name: "spacing/md",
				type: "FLOAT",
				value: 16,
			},
			{
				token: "spacing.lg",
				name: "spacing/lg",
				type: "FLOAT",
				value: 24,
			},
		]);
		expect(push.textStyles).toEqual([
			{
				token: "typography.title",
				name: "title",
				fontName: { family: "Inter", style: "Bold" },
				fontSize: 28,
			},
		]);
	});

	test("updates what the Baseline made by ID, and removes tokens DESIGN.md dropped", () => {
		const { baseline } = pushDesignMd();
		const edited = designMd
			.replace('  surface: "#ffffff"\n', "")
			.replace("#3366FF", "#0055ff");
		const { push } = designSystemPush(parseDesignMd(edited).fields, baseline);
		expect(push.collection.id).toBe(baseline.collectionId);
		expect(push.variables[0]).toMatchObject({
			id: baseline.variables["colors.primary"],
			value: { color: "#0055ff" },
		});
		expect(push.textStyles[0]?.id).toBe(
			baseline.textStyles["typography.title"],
		);
		expect(push.remove).toEqual({
			variables: [baseline.variables["colors.surface"] as string],
			textStyles: [],
		});
	});

	test("converts line height and letter spacing, and warns about tokens Figma can't hold", () => {
		const { push, warnings } = designSystemPush(
			parseDesignMd(`---
colors:
  accent: oklch(0.7 0.1 200)
typography:
  body:
    fontFamily: Public Sans
    fontSize: 1rem
    lineHeight: 1.5
    letterSpacing: -0.02em
---
`).fields,
		);
		expect(push.variables).toEqual([]);
		expect(warnings).toEqual([
			{
				path: "colors.accent",
				message: expect.stringContaining("isn't pushed to Figma"),
			},
		]);
		expect(push.textStyles).toEqual([
			{
				token: "typography.body",
				name: "body",
				fontName: { family: "Public Sans", style: "Regular" },
				fontSize: 16,
				lineHeight: { value: 150, unit: "PERCENT" },
				letterSpacing: { value: -2, unit: "PERCENT" },
			},
		]);
	});

	test("binds the Screen elements that use a token's variable", async () => {
		const project = await fixtureProject();
		const original = project.screens[0] as ScreenFile;
		const screen = { ...original, source: assignKeys(original.source).source };
		const { root } = checkScreen(project, screen);
		const { push } = designSystemPush(project.fields);
		const { tree } = await screenPush(
			project,
			screen,
			root as NonNullable<typeof root>,
			undefined,
			tokenBindings(push),
		);
		const [logo, title, subtitle, button, divider] = tree.children ?? [];
		expect(tree.bindings).toEqual({
			fill: "colors.surface",
			itemSpacing: "spacing.md",
			paddingRight: "spacing.lg",
			paddingLeft: "spacing.lg",
		});
		expect(logo?.bindings).toEqual({ cornerRadius: "rounded.md" });
		expect(title?.bindings).toEqual({
			fill: "colors.heading",
			textStyle: "typography.title",
		});
		expect(subtitle?.bindings).toBeUndefined();
		expect(button?.bindings).toEqual({ fill: "colors.primary" });
		expect(divider?.bindings).toBeUndefined();
	});

	test("binds no text style when the text's family or weight differs from it", async () => {
		const project = await fixtureProject();
		const screen = {
			...(project.screens[0] as ScreenFile),
			source: assignKeys(
				'<body style="display:flex"><h1 style="font-size:var(--typography-title-font-size)">Hi</h1></body>',
			).source,
		};
		const { root } = checkScreen(project, screen);
		const { tree } = await screenPush(
			project,
			screen,
			root as NonNullable<typeof root>,
			undefined,
			tokenBindings(designSystemPush(project.fields).push),
		);
		expect(tree.children?.[0]?.bindings).toBeUndefined();
	});
});

describe("Design System Pull", () => {
	test("reads back exactly what was pushed: no changes", () => {
		const { baseline, read } = pushDesignMd();
		expect(designSystemChanges(parseDesignMd(designMd).fields, read())).toEqual(
			[],
		);
		expect(pullDesignSystem(designMd, baseline, read())).toEqual({
			changed: [],
			conflicts: 0,
			baselineSource: designMd,
		});
	});

	test("writes Figma's changes into DESIGN.md, leaving the rest of the file as it is", () => {
		const { figma, baseline, read } = pushDesignMd();
		figma.variable("colors/primary").value = { color: "#ff0000" };
		figma.variable("spacing/lg").value = 32;
		figma.textStyle("title").fontSize = 32;
		figma.textStyle("title").lineHeight = { value: 120, unit: "PERCENT" };

		const pulled = pullDesignSystem(designMd, baseline, read());
		expect(pulled.changed).toEqual([
			"colors.primary",
			"spacing.lg",
			"typography.title.fontSize",
			"typography.title.lineHeight",
		]);
		expect(pulled.conflicts).toBe(0);
		const expected = designMd
			.replace('primary: "#3366FF"', 'primary: "#ff0000"')
			.replace("lg: 24px", "lg: 32px")
			.replace(
				"fontSize: 28px\n    fontWeight: 700\n",
				"fontSize: 32px\n    fontWeight: 700\n    lineHeight: 1.2\n",
			);
		expect(pulled.source).toBe(expected);
		expect(pulled.baselineSource).toBe(expected);
		expect(lint(pulled.source as string).summary.errors).toBe(0);
	});

	test("keeps the Design Project's own edits to other tokens", () => {
		const { figma, baseline, read } = pushDesignMd();
		figma.variable("colors/primary").value = { color: "#ff0000" };
		const local = designMd.replace("md: 16px", "md: 12px");
		const pulled = pullDesignSystem(local, baseline, read());
		expect(pulled.source).toBe(
			local.replace('primary: "#3366FF"', 'primary: "#ff0000"'),
		);
	});

	test("an alias a designer pointed elsewhere becomes a reference", () => {
		const { figma, baseline, read } = pushDesignMd();
		figma.variable("colors/heading").value = {
			alias: baseline.variables["colors.primary"] as string,
		};
		const pulled = pullDesignSystem(designMd, baseline, read());
		expect(pulled.source).toContain('heading: "{colors.primary}"');
	});

	test("marks a Sync Conflict where both changed a token, which Check reports", async () => {
		const { figma, baseline, read } = pushDesignMd();
		figma.variable("colors/primary").value = { color: "#ff0000" };
		const local = designMd.replace("#3366FF", "#00aa00");
		const pulled = pullDesignSystem(local, baseline, read());
		expect(pulled.conflicts).toBe(1);
		expect(pulled.source).toContain(
			[
				"<<<<<<< Design Project",
				'  primary: "#00aa00"',
				"=======",
				'  primary: "#ff0000"',
				">>>>>>> Figma",
			].join("\n"),
		);
		const project = await fixtureProject({
			"DESIGN.md": pulled.source as string,
		});
		expect(checkDesignMd(project).errors).toEqual([
			expect.objectContaining({
				file: "DESIGN.md",
				line: 5,
				rule: "sync-conflict",
			}),
		]);
	});

	test("a variable deleted in Figma isn't a change: the next Push makes it again", () => {
		const { figma, baseline, read } = pushDesignMd();
		figma.variables.delete(baseline.variables["colors.primary"] as string);
		expect(designSystemChanges(parseDesignMd(designMd).fields, read())).toEqual(
			[],
		);
	});
});

describe("Check of DESIGN.md", () => {
	test("reports spec errors and low contrast with their lines", async () => {
		const project = await fixtureProject({
			"DESIGN.md": designMd
				.replace('surface: "#ffffff"', "surface: not-a-color")
				.replace(
					"rounded:",
					'components:\n  button:\n    backgroundColor: "#ffffff"\n    textColor: "#eeeeee"\nrounded:',
				),
		});
		const { errors, warnings } = checkDesignMd(project);
		expect(errors).toEqual([
			{
				file: "DESIGN.md",
				line: 6,
				element: "colors.surface",
				rule: "design-md",
				message: expect.stringContaining("is not a valid color"),
			},
		]);
		expect(warnings.map((warning) => warning.element)).not.toContain(
			"colors.surface",
		);
		expect(warnings).toContainEqual({
			file: "DESIGN.md",
			line: 15,
			element: "components.button",
			rule: "contrast-ratio",
			message: expect.stringContaining("below WCAG AA minimum"),
		});
	});

	test("accepts the fixture DESIGN.md without findings", async () => {
		const project = await fixtureProject();
		expect(checkDesignMd(project)).toEqual({ errors: [], warnings: [] });
	});
});
