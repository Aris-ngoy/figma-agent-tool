export * from "./fake-figma";

// A fixture Design Project both test seams use: the design-project tests,
// and the MCP tests that Push and Pull it through the fake plugin.
import { afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { framePng } from "@figma-agent-tool/protocol/fixtures";

export const designMd = `---
version: alpha
name: Sample App
colors:
  primary: "#3366FF"
  surface: "#ffffff"
  text: "#111111"
  heading: "{colors.text}"
typography:
  title:
    fontFamily: Inter
    fontSize: 28px
    fontWeight: 700
rounded:
  md: 8px
spacing:
  md: 16px
  lg: 24px
---

# Sample App

Calm and clear.
`;

/** The login Screen: every kind of element, tokens and a default size. */
export const loginScreen = `<body style="display:flex; flex-direction:column; align-items:center; gap:var(--spacing-md); padding:64px var(--spacing-lg) 34px; background:var(--colors-surface)">
  <img src="../assets/logo.png" style="width:64px; height:64px; border-radius:var(--rounded-md)">
  <h1 style="font-size:var(--typography-title-font-size); font-weight:700; color:var(--colors-heading); text-align:center">Welcome back</h1>
  <p style="color:#666666; width:280px; text-align:center">Sign in to pick up
    where you left off.</p>
  <div data-name="Button" style="display:flex; justify-content:center; padding:12px 16px; align-self:stretch; background-color:var(--colors-primary); border-radius:12px">
    <p style="font-weight:600; color:#fff">Sign in</p>
  </div>
  <div style="height:1px; align-self:stretch; background:#dddddd"></div>
</body>
`;

/** A tablet-sized Screen overriding the default Screen Size. */
export const welcomeScreen = `<body style="display:flex; justify-content:space-between; width:1024px; height:768px">
  <p>Welcome</p>
  <div style="width:200px; flex:1; background:#eeeeee"></div>
</body>
`;

/**
 * Screens using each mapping wider than the basic subset, one per mapping:
 * each must Check, and Push then Pull must give it back byte for byte.
 */
export const widerScreens: Record<string, string> = {
	absolute: `<body style="display:flex; flex-direction:column; padding:16px">
  <p>Inbox</p>
  <div data-name="Dot" style="position:absolute; left:40px; top:-4px; width:8px; height:8px; background-color:#ff3b30; border-radius:4px"></div>
  <div data-name="Badge" style="display:flex; padding:2px 6px; position:absolute; left:300px; top:12px; background-color:#111111">
    <span style="color:#ffffff; font-size:12px">New</span>
  </div>
</body>
`,
	vector: `<body style="display:flex; gap:8px; padding:16px">
  <svg data-name="Check" viewBox="0 0 24 24" style="width:48px; height:48px; fill:none; stroke:#111111; stroke-width:2px; stroke-linecap:round; stroke-linejoin:round">
    <path d="M4 12l5 5L20 6" />
  </svg>
  <svg xmlns="http://www.w3.org/2000/svg" style="width:20px; height:20px; fill:var(--colors-primary)">
    <path d="M 0 0 L 20 0 L 20 20 L 0 20 Z M 5 5 L 5 15 L 15 15 L 15 5 Z" fill-rule="evenodd"></path>
    <path d="M 8 8 L 12 8 L 12 12 Z" />
  </svg>
</body>
`,
	border: `<body style="display:flex; gap:8px; padding:16px">
  <div data-name="Card" style="display:flex; padding:12px; border-width:1px; border-color:#dddddd; border-radius:8px">
    <p>Card</p>
  </div>
  <img src="../assets/logo.png" style="width:32px; height:32px; border:2px solid var(--colors-primary)">
  <div style="width:40px; height:40px; border:4px solid #000"></div>
</body>
`,
	clipping: `<body style="display:flex; padding:16px">
  <div data-name="Window" style="display:flex; width:100px; height:60px; overflow:hidden">
    <div style="width:200px; height:200px; background-color:#3366ff"></div>
  </div>
</body>
`,
};

/**
 * Two Screens linked into a prototype: `<a>` frames, text and rectangles,
 * and an `href` on a <div>, with and without transitions.
 */
export const linkedScreens: Record<string, string> = {
	home: `<body style="display:flex; flex-direction:column; gap:16px; padding:24px">
  <h1>Home</h1>
  <a href="signup.html" data-transition="push left" data-name="Sign up" style="display:flex; padding:12px; background-color:#3366ff">
    <p style="color:#ffffff">Sign up</p>
  </a>
  <a href="signup.html">I have an account</a>
  <div href="home.html" data-transition="dissolve 200ms ease-in-out" style="width:40px; height:40px; background-color:#dddddd"></div>
</body>
`,
	signup: `<body style="display:flex; flex-direction:column; padding:24px">
  <a href="home.html" data-transition="slide-out right 0.25s" data-name="Back" style="width:24px; height:24px; background-color:#111111"></a>
  <p>Create your account</p>
</body>
`,
};

export const logoPng = framePng;

export const projectConfig = {
	screenSize: { width: 393, height: 852 },
	screensPage: "Screens",
};

/** Files of the fixture project; PNGs as base64. */
export const projectFiles: Record<string, string> = {
	"project.json": `${JSON.stringify(projectConfig, null, "\t")}\n`,
	"DESIGN.md": designMd,
	"screens/login.html": loginScreen,
};

const scratch: string[] = [];

afterEach(async () => {
	for (const dir of scratch.splice(0))
		await rm(dir, { recursive: true, force: true });
});

/**
 * Writes the fixture project into a fresh temporary folder (removed after
 * the test), with `overrides` added or replacing files; null deletes one.
 */
export async function writeFixtureProject(
	overrides: Record<string, string | null> = {},
): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "design-project-"));
	scratch.push(dir);
	const files: Record<string, string | null> = {
		...projectFiles,
		...overrides,
	};
	await writeBytes(dir, "assets/logo.png", Buffer.from(logoPng, "base64"));
	for (const [name, content] of Object.entries(files)) {
		if (content !== null) await writeBytes(dir, name, content);
	}
	return dir;
}

async function writeBytes(
	dir: string,
	name: string,
	content: string | Uint8Array,
) {
	const path = join(dir, name);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
}
