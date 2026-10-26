import { describe, expect, test } from "bun:test";
import { checkProject } from "../src";
import { fixtureProject } from "./fixture-project";

async function errorsFor(screen: string, extra: Record<string, string> = {}) {
	const project = await fixtureProject({
		"screens/test.html": screen,
		...extra,
	});
	return (await checkProject(project)).errors;
}

describe("check", () => {
	test("accepts a Screen in the basic subset", async () => {
		const project = await fixtureProject();
		expect((await checkProject(project)).errors).toEqual([]);
	});

	test("names the file, line, element and rule of an element outside the subset", async () => {
		const errors = await errorsFor(
			[
				'<body style="display:flex">',
				'  <div style="display:flex">',
				"    <table></table>",
				"  </div>",
				"</body>",
			].join("\n"),
		);
		expect(errors).toEqual([
			{
				file: "screens/test.html",
				line: 3,
				element: "body > div > table",
				rule: "unknown-element",
				message: expect.stringContaining("<table>"),
			},
		]);
	});

	test.each([
		[
			"display:grid on a frame",
			'<body style="display:grid"></body>',
			"invalid-value",
		],
		[
			"an unknown CSS property",
			'<body style="display:flex;box-shadow:0 0 1px #000"></body>',
			"unknown-property",
		],
		[
			"a div with children but no flex",
			'<body style="display:flex"><div><p>Hi</p></div></body>',
			"div-needs-flex",
		],
		[
			"text outside a text element",
			'<body style="display:flex">Hello</body>',
			"text-outside-text-element",
		],
		[
			"an element inside text",
			'<body style="display:flex"><p>Hi <b>there</b></p></body>',
			"text-has-elements",
		],
		[
			"a script",
			'<body style="display:flex"><script></script></body>',
			"unknown-element",
		],
		[
			"a class attribute",
			'<body style="display:flex" class="x"></body>',
			"unknown-attribute",
		],
		[
			"a token DESIGN.md doesn't define",
			'<body style="display:flex;gap:var(--spacing-huge)"></body>',
			"unknown-token",
		],
		[
			"a rectangle without a size",
			'<body style="display:flex"><div style="background:#ff0000"></div></body>',
			"size-required",
		],
		[
			"an image without a size",
			'<body style="display:flex"><img src="../assets/logo.png"></body>',
			"size-required",
		],
		[
			"a missing image file",
			'<body style="display:flex"><img src="../assets/nope.png" style="width:10px;height:10px"></body>',
			"missing-image",
		],
		[
			"flex:1 next to a fixed width in a row",
			'<body style="display:flex"><div style="display:flex;flex:1;width:20px"></div></body>',
			"conflicting-size",
		],
		[
			"a height on text",
			'<body style="display:flex"><p style="height:20px">Hi</p></body>',
			"unknown-property",
		],
		[
			"a duplicated key",
			'<body style="display:flex"><p data-key="e1">A</p><p data-key="e1">B</p></body>',
			"duplicate-key",
		],
		[
			"more than one root",
			'<body style="display:flex"></body><body style="display:flex"></body>',
			"single-root",
		],
		[
			"a root other than body",
			'<div style="display:flex"></div>',
			"single-root",
		],
		[
			"a comment",
			'<body style="display:flex"><!-- note --></body>',
			"parse-error",
		],
		[
			"an unclosed element",
			'<body style="display:flex"><div style="display:flex"></body>',
			"parse-error",
		],
	])("rejects %s", async (_name, screen, rule) => {
		const errors = await errorsFor(screen);
		expect(errors.map((error) => error.rule)).toEqual([rule]);
	});

	test("reports Sync Conflict markers with their line", async () => {
		const errors = await errorsFor(
			[
				'<body style="display:flex">',
				"<<<<<<< Design Project",
				"  <p>A</p>",
				"=======",
				"  <p>B</p>",
				">>>>>>> Figma",
				"</body>",
			].join("\n"),
		);
		expect(errors).toEqual([
			expect.objectContaining({ rule: "sync-conflict", line: 2 }),
		]);
	});

	test("checks every Screen in the project", async () => {
		const project = await fixtureProject({
			"screens/a.html": "<table></table>",
			"screens/b.html": '<body style="display:flex;color:#000"></body>',
		});
		const { errors } = await checkProject(project);
		expect(errors.map(({ file, rule }) => [file, rule])).toEqual([
			["screens/a.html", "single-root"],
			["screens/b.html", "unknown-property"],
		]);
	});

	test("reports DESIGN.md front matter that isn't valid YAML", async () => {
		const project = await fixtureProject({
			"DESIGN.md": "---\nname: [unclosed\n---\n",
			"screens/login.html": null,
		});
		const { errors } = await checkProject(project);
		expect(errors).toEqual([
			expect.objectContaining({ file: "DESIGN.md", rule: "design-md" }),
		]);
	});
});
