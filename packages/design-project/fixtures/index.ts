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
