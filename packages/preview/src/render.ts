// Render: a PNG of a Screen exactly as the Preview shows it, for Agents
// without a browser. It screenshots the same document the Preview serves in
// headless Chromium (Chrome for Testing's headless shell), downloaded into
// the user's cache on first use unless FIGMA_AGENT_CHROME names a browser.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type DesignProject,
	type FigmaOwnedPreview,
	type ScreenFile,
	screenSizeOf,
} from "@figma-agent-tool/design-project";
import { figmaOwnedOf, screenDocument } from "./document";

export class RenderError extends Error {}

/** Takes a screenshot of an HTML file at a viewport size. */
export type Screenshotter = (
	htmlPath: string,
	pngPath: string,
	size: { width: number; height: number },
) => Promise<void>;

export async function renderScreen(
	project: DesignProject,
	screen: ScreenFile,
	{
		screenshot = chromeScreenshot,
		mode,
	}: {
		screenshot?: Screenshotter;
		/** The Mode to render in; the default Mode when absent. */
		mode?: string;
	} = {},
): Promise<{
	png: Uint8Array;
	width: number;
	height: number;
	/** Its Figma-owned Elements, shown from their exports. */
	figmaOwned: FigmaOwnedPreview[];
}> {
	const size = screenSizeOf(project, screen);
	const figmaOwned = await figmaOwnedOf(project, screen);
	const document = screenDocument(project, screen, {
		baseUrl: pathToFileURL(`${dirname(screen.path)}/`).href,
		figmaOwned,
		mode,
	});
	const scratch = await mkdtemp(join(tmpdir(), "figma-agent-render-"));
	try {
		const htmlPath = join(scratch, "screen.html");
		const pngPath = join(scratch, "screen.png");
		await writeFile(htmlPath, document);
		await screenshot(htmlPath, pngPath, size);
		if (!existsSync(pngPath)) {
			throw new RenderError(
				`The browser didn't write a screenshot of ${screen.file}.`,
			);
		}
		return {
			png: new Uint8Array(await readFile(pngPath)),
			...size,
			figmaOwned,
		};
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/** Screenshots with headless Chromium, getting it first if needed. */
export const chromeScreenshot: Screenshotter = async (
	htmlPath,
	pngPath,
	{ width, height },
) => {
	const chrome = await findChrome();
	const { code, stderr } = await run(chrome, [
		"--headless",
		"--no-sandbox",
		"--disable-gpu",
		"--hide-scrollbars",
		"--force-device-scale-factor=1",
		`--window-size=${width},${height}`,
		`--screenshot=${pngPath}`,
		pathToFileURL(htmlPath).href,
	]).catch((error: Error) => {
		throw new RenderError(`Couldn't run ${chrome}: ${error.message}`);
	});
	if (code !== 0) {
		throw new RenderError(
			`Headless Chromium (${chrome}) failed with exit code ${code}: ${stderr.trim().split("\n").slice(-3).join(" ")}`,
		);
	}
};

const CHROME_VERSIONS =
	"https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

const PLATFORMS: Record<string, string> = {
	"linux-x64": "linux64",
	"linux-arm64": "linux-arm64",
	"darwin-x64": "mac-x64",
	"darwin-arm64": "mac-arm64",
	"win32-x64": "win64",
	"win32-ia32": "win32",
};

/** The browser Render uses: FIGMA_AGENT_CHROME, else a cached or freshly downloaded headless shell. */
export async function findChrome(): Promise<string> {
	const configured = process.env.FIGMA_AGENT_CHROME;
	if (configured) return configured;
	const platform = PLATFORMS[`${process.platform}-${process.arch}`];
	if (!platform) {
		throw new RenderError(
			`No headless Chromium download for ${process.platform}-${process.arch}. Set FIGMA_AGENT_CHROME to a Chrome or Chromium binary.`,
		);
	}
	const folder = join(cacheDir(), `chrome-headless-shell-${platform}`);
	const binary = join(
		folder,
		process.platform === "win32"
			? "chrome-headless-shell.exe"
			: "chrome-headless-shell",
	);
	if (existsSync(binary)) return binary;
	await downloadChrome(platform, dirname(folder));
	if (!existsSync(binary))
		throw new RenderError(`Downloaded Chromium, but ${binary} is missing.`);
	await chmod(binary, 0o755);
	return binary;
}

function cacheDir(): string {
	const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
	return join(base, "figma-agent-tool");
}

async function downloadChrome(platform: string, into: string) {
	console.error("[render] downloading headless Chromium (first use only)…");
	try {
		const versions = (await (await fetch(CHROME_VERSIONS)).json()) as {
			channels: {
				Stable: {
					downloads: Record<string, { platform: string; url: string }[]>;
				};
			};
		};
		const download = versions.channels.Stable.downloads[
			"chrome-headless-shell"
		]?.find((entry) => entry.platform === platform);
		if (!download) throw new Error(`no build for ${platform}`);
		const zip = new Uint8Array(await (await fetch(download.url)).arrayBuffer());
		await mkdir(into, { recursive: true });
		const zipPath = join(into, "chrome-headless-shell.zip");
		await writeFile(zipPath, zip);
		const [unzip, ...args] =
			process.platform === "win32"
				? ["tar", "-xf", zipPath, "-C", into]
				: ["unzip", "-q", "-o", zipPath, "-d", into];
		const { code } = await run(unzip as string, args);
		await rm(zipPath, { force: true });
		if (code !== 0) throw new Error(`${unzip} exited with ${code}`);
	} catch (error) {
		throw new RenderError(
			`Couldn't download headless Chromium for Render (${(error as Error).message}). Set FIGMA_AGENT_CHROME to a Chrome or Chromium binary.`,
		);
	}
}

/** Runs a program to its end: its exit code and what it wrote to stderr. */
function run(
	command: string,
	args: string[],
): Promise<{ code: number; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
	});
}
