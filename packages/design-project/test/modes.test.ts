import { describe, expect, test } from "bun:test";
import { createFakeDesignSystem, designMd } from "../fixtures";
import {
	checkProject,
	type DesignSystemBaseline,
	designSystemChanges,
	designSystemPush,
	figmaDesignSystem,
	MODES_FILE,
	modeTokens,
	parseDesignMd,
	parseModes,
	pullDesignSystem,
} from "../src";
import { fixtureProject } from "./fixture-project";

const modes = `# Dark mode for the Sample App.
default: Light
modes:
  Dark:
    colors:
      surface: "#111111"
      text: "#eeeeee"
    spacing:
      lg: 32px
`;

describe("Modes file", () => {
	test("gives each Mode the default's tokens with its own values on top", async () => {
		const project = await fixtureProject({ [MODES_FILE]: modes });
		expect(project.modes.default).toBe("Light");
		expect(project.modes.names).toEqual(["Light", "Dark"]);
		const dark = modeTokens(project, "Dark").variables;
		expect(dark.get("--colors-surface")).toBe("#111111");
		expect(dark.get("--colors-primary")).toBe("#3366FF");
		// References follow the Mode's values.
		expect(dark.get("--colors-heading")).toBe("#eeeeee");
		expect(dark.get("--spacing-lg")).toBe("32px");
		expect(modeTokens(project, "Light")).toBe(project.tokens);
		expect(() => modeTokens(project, "Sepia")).toThrow(
			"No Mode named “Sepia”: the Design System has Light, Dark.",
		);
	});

	test("without a Modes file, the Design System has its default Mode only", async () => {
		const project = await fixtureProject();
		expect(project.modes.names).toEqual(["Default"]);
		expect((await checkProject(project)).errors).toEqual([]);
	});

	test("Check validates it against DESIGN.md's tokens", async () => {
		const project = await fixtureProject({
			[MODES_FILE]: `default: Light
modes:
  Dark:
    colors:
      surface: "#111111"
      missing: "#000000"
      text: oklch(0.9 0 0)
      heading: "{colors.nowhere}"
    typography:
      title:
        fontSize: 30px
  Light:
    colors:
      surface: "#ffffff"
`,
		});
		const { errors } = await checkProject(project);
		expect(
			errors.map(({ line, element, rule }) => ({ line, element, rule })),
		).toEqual([
			{ line: 6, element: "modes.Dark.colors.missing", rule: "unknown-token" },
			{ line: 7, element: "modes.Dark.colors.text", rule: "mode-value" },
			{ line: 8, element: "modes.Dark.colors.heading", rule: "broken-ref" },
			{ line: 9, element: "modes.Dark.typography", rule: "mode-group" },
			{ line: 12, element: "modes.Light", rule: "duplicate-mode" },
		]);
		expect(errors[0]).toMatchObject({
			file: MODES_FILE,
			message: expect.stringContaining("DESIGN.md has no token colors.missing"),
		});
	});

	test("Check reports a Modes file that isn't valid YAML or has Sync Conflicts", async () => {
		const broken = await fixtureProject({ [MODES_FILE]: "modes: [\n" });
		expect((await checkProject(broken)).errors).toEqual([
			expect.objectContaining({ file: MODES_FILE, rule: "modes-file" }),
		]);
		const conflicted = await fixtureProject({
			[MODES_FILE]: `modes:
  Dark:
    colors:
<<<<<<< Design Project
      surface: "#111111"
=======
      surface: "#222222"
>>>>>>> Figma
`,
		});
		expect((await checkProject(conflicted)).errors).toContainEqual(
			expect.objectContaining({
				file: MODES_FILE,
				line: 4,
				rule: "sync-conflict",
			}),
		);
	});

	test("Check warns about low contrast in a Mode", async () => {
		const project = await fixtureProject({
			"DESIGN.md": `---
version: alpha
name: Sample App
colors:
  surface: "#ffffff"
  text: "#111111"
components:
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
---

# Sample App
`,
			"screens/login.html": null,
			[MODES_FILE]: `modes:
  Dark:
    colors:
      surface: "#222222"
`,
		});
		const { errors, warnings } = await checkProject(project);
		expect(errors).toEqual([]);
		expect(warnings).toContainEqual(
			expect.objectContaining({
				file: "DESIGN.md",
				element: "components.card",
				rule: "contrast-ratio",
				message: expect.stringMatching(/^In Mode Dark: /),
			}),
		);
	});
});

describe("Modes Push", () => {
	test("sends each Mode as a variable mode, with every variable's value in it", async () => {
		const project = await fixtureProject({ [MODES_FILE]: modes });
		const { push } = designSystemPush(project.fields, undefined, project.modes);
		expect(push.collection).toEqual({
			name: "Design System",
			modes: [{ name: "Light" }, { name: "Dark" }],
		});
		const variable = (token: string) =>
			push.variables.find((entry) => entry.token === token);
		expect(variable("colors.surface")).toMatchObject({
			value: { color: "#ffffff" },
			modes: { Dark: { color: "#111111" } },
		});
		// Tokens a Mode leaves out keep the default's value, aliases included.
		expect(variable("colors.primary")?.modes).toEqual({
			Dark: { color: "#3366ff" },
		});
		expect(variable("colors.heading")?.modes).toEqual({
			Dark: { token: "colors.text" },
		});
		expect(variable("spacing.lg")?.modes).toEqual({ Dark: 32 });
	});

	test("updates the Baseline's modes by ID and removes the Modes the file dropped", async () => {
		const project = await fixtureProject({ [MODES_FILE]: modes });
		const { push } = designSystemPush(
			project.fields,
			{
				source: project.designMd,
				collectionId: "c",
				variables: {},
				textStyles: {},
				modesSource: "",
				modes: { Light: "m:1", Dark: "m:2", Sepia: "m:3" },
			},
			project.modes,
		);
		expect(push.collection.modes).toEqual([
			{ id: "m:1", name: "Light" },
			{ id: "m:2", name: "Dark" },
		]);
		expect(push.remove.modes).toEqual(["m:3"]);
	});

	test("without a Modes file, leaves the collection's modes alone", async () => {
		const project = await fixtureProject();
		const { push } = designSystemPush(project.fields, undefined, project.modes);
		expect(push.collection.modes).toBeUndefined();
		expect(push.variables[0]?.modes).toBeUndefined();
	});
});

/** Pushes DESIGN.md and the Modes file into a fake file, as Push does. */
function pushModes(modesSource = modes) {
	let id = 0;
	const figma = createFakeDesignSystem(() => `5:${++id}`);
	const { push } = designSystemPush(
		parseDesignMd(designMd).fields,
		undefined,
		parseModes(modesSource),
	);
	const pushed = figma.push(push);
	const baseline: DesignSystemBaseline = {
		source: designMd,
		modesSource,
		...pushed,
	};
	const read = (current = baseline) =>
		figmaDesignSystem(
			figma.read({
				variables: Object.values(current.variables),
				textStyles: Object.values(current.textStyles),
			}),
			current,
		);
	const changes = (current = baseline) =>
		designSystemChanges(
			parseDesignMd(current.source).fields,
			read(current),
			parseModes(current.modesSource ?? ""),
		);
	const pull = (local = { designMd, modes: modesSource }) =>
		pullDesignSystem(local.designMd, baseline, read(), local.modes);
	return { figma, baseline, read, changes, pull };
}

describe("Modes Pull", () => {
	test("a Push changes nothing to pull", () => {
		const { changes, pull } = pushModes();
		expect(changes()).toEqual([]);
		expect(pull()).toMatchObject({ changed: [], conflicts: 0 });
	});

	test("writes a designer's edit to a Mode into the Modes file, editing only that value", () => {
		const { figma, changes, pull } = pushModes();
		const dark = figma.modeId("Dark");
		figma.variable("colors/surface").modes[dark] = { color: "#000000" };
		expect(changes()).toEqual(["modes.Dark.colors.surface"]);
		const pulled = pull();
		expect(pulled.source).toBeUndefined();
		expect(pulled.modesSource).toBe(
			modes.replace('surface: "#111111"', 'surface: "#000000"'),
		);
		expect(pulled.conflicts).toBe(0);
	});

	test("adds the values a designer gave tokens the Mode left to the default", () => {
		const { figma, pull } = pushModes();
		const dark = figma.modeId("Dark");
		figma.variable("colors/primary").modes[dark] = { color: "#99bbff" };
		figma.variable("rounded/md").modes[dark] = 4;
		const pulled = pull();
		expect(pulled.modesSource).toBe(`# Dark mode for the Sample App.
default: Light
modes:
  Dark:
    colors:
      surface: "#111111"
      text: "#eeeeee"
      primary: "#99bbff"
    spacing:
      lg: 32px
    rounded:
      md: 4px
`);
		expect(parseModes(pulled.modesSource as string).errors).toEqual([]);
	});

	test("marks a Mode's token both sides changed", () => {
		const { figma, pull } = pushModes();
		figma.variable("spacing/lg").modes[figma.modeId("Dark")] = 40;
		const local = modes.replace("lg: 32px", "lg: 36px");
		const pulled = pull({ designMd, modes: local });
		expect(pulled.conflicts).toBe(1);
		expect(pulled.modesSource).toContain(
			"<<<<<<< Design Project\n      lg: 36px\n=======\n      lg: 40px\n>>>>>>> Figma\n",
		);
	});

	test("a default value edited in Figma leaves the Modes that kept the old one as they are", () => {
		const { figma, baseline, changes, pull } = pushModes();
		figma.variable("colors/primary").value = { color: "#ff0000" };
		expect(changes()).toEqual(["colors.primary"]);
		const pulled = pull();
		expect(pulled.modesSource).toBeUndefined();
		// The Baseline holds what Figma has: Dark kept the old primary.
		const next = {
			...baseline,
			source: pulled.baselineSource,
			modesSource: pulled.baselineModesSource,
		};
		expect(changes(next)).toEqual([]);
		expect(
			parseModes(next.modesSource).overrides.get("Dark")?.get("colors.primary"),
		).toBe("#3366ff");
	});

	test("a Mode deleted in Figma isn't a change: Push makes it again", () => {
		const { figma, changes } = pushModes();
		figma.removeMode("Dark");
		expect(changes()).toEqual([]);
	});
});
