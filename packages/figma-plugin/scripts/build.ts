// Bundles the sandbox code and inlines the UI script into a single HTML file,
// since Figma loads the UI as one document.
import { mkdir } from "node:fs/promises";

const root = new URL("..", import.meta.url).pathname;

async function bundle(entrypoint: string): Promise<string> {
	const result = await Bun.build({
		entrypoints: [`${root}src/${entrypoint}`],
		target: "browser",
		format: "iife",
		minify: true,
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		process.exit(1);
	}
	const [output] = result.outputs;
	if (!output) throw new Error(`No output for ${entrypoint}`);
	return output.text();
}

await mkdir(`${root}dist`, { recursive: true });

await Bun.write(`${root}dist/code.js`, await bundle("code.ts"));

const html = await Bun.file(`${root}src/ui.html`).text();
const script = (await bundle("ui.ts")).replaceAll("</script", "<\\/script");
await Bun.write(
	`${root}dist/ui.html`,
	html.replace("<!-- UI_SCRIPT -->", () => `<script>${script}</script>`),
);
