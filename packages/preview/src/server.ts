// The local Preview: every Screen at its Screen Size, with Check's errors,
// reloading whenever a file in the Design Project changes. It only views;
// editing happens in the files.
import { type FSWatcher, watch } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
	type CheckError,
	checkProject,
	type DesignProject,
	loadProject,
} from "@figma-agent-tool/design-project";
import { screenDocument, screenSize } from "./document";

export const DEFAULT_PREVIEW_PORT = 4321;

const LIVE_RELOAD = `<script>
new EventSource("/events").onmessage = () => location.reload();
</script>`;

export type Preview = { url: string; port: number; stop(): void };

export function startPreview({
	dir,
	port = DEFAULT_PREVIEW_PORT,
	hostname = "127.0.0.1",
}: {
	dir: string;
	port?: number;
	hostname?: string;
}): Preview {
	const root = resolve(dir);
	const clients = new Set<ReadableStreamDefaultController<string>>();
	let watcher: FSWatcher | undefined;
	let debounce: ReturnType<typeof setTimeout> | undefined;
	try {
		watcher = watch(root, { recursive: true }, () => {
			clearTimeout(debounce);
			debounce = setTimeout(() => {
				for (const client of clients) client.enqueue("data: reload\n\n");
			}, 50);
		});
	} catch {
		// No recursive watching on this platform: the Preview won't live-reload.
	}

	const server = Bun.serve({
		hostname,
		port,
		idleTimeout: 0,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			if (pathname === "/events") {
				let controller: ReadableStreamDefaultController<string>;
				const stream = new ReadableStream<string>({
					start(c) {
						controller = c;
						clients.add(c);
						c.enqueue(": connected\n\n");
					},
					cancel() {
						clients.delete(controller);
					},
				});
				return new Response(stream, {
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
					},
				});
			}
			const project = await loadProject(root);
			if (pathname === "/") return html(await indexPage(project));
			const screenMatch = /^\/screens\/([^/]+)$/.exec(pathname);
			if (screenMatch) {
				const name = decodeURIComponent(screenMatch[1] as string);
				const screen = project.screens.find((s) => s.name === name);
				if (!screen) return new Response("No such Screen", { status: 404 });
				return html(
					screenDocument(project, screen, {
						baseUrl: "/files/screens/",
						head: LIVE_RELOAD,
					}),
				);
			}
			if (pathname.startsWith("/files/")) {
				const path = resolve(
					root,
					decodeURIComponent(pathname.slice("/files/".length)),
				);
				const inside = relative(root, path);
				if (inside.startsWith("..") || inside.startsWith(sep)) {
					return new Response("Outside the Design Project", { status: 403 });
				}
				const file = Bun.file(path);
				return (await file.exists())
					? new Response(file)
					: new Response("Not found", { status: 404 });
			}
			return new Response("Not found", { status: 404 });
		},
	});

	return {
		url: `http://${hostname}:${server.port}/`,
		port: server.port ?? port,
		stop() {
			clearTimeout(debounce);
			watcher?.close();
			for (const client of clients) client.close();
			server.stop(true);
		},
	};
}

function html(body: string): Response {
	return new Response(body, {
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

async function indexPage(project: DesignProject): Promise<string> {
	const { errors } = await checkProject(project);
	const screens = project.screens.map((screen) => {
		const { width, height } = screenSize(project, screen);
		const screenErrors = errors.filter((error) => error.file === screen.file);
		return `<section>
<h2>${escapeHtml(screen.name)} <small>${width}×${height}</small></h2>
${errorList(screenErrors)}
<iframe src="/screens/${encodeURIComponent(screen.name)}" width="${width}" height="${height}" title="${escapeHtml(screen.name)}"></iframe>
</section>`;
	});
	const designMdErrors = errorList(
		errors.filter((error) => error.file === "DESIGN.md"),
	);
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Preview: ${escapeHtml(join(project.dir))}</title>
<style>
body { margin: 0; padding: 24px; background: #e5e5e5; font: 14px system-ui, sans-serif; }
main { display: flex; flex-wrap: wrap; gap: 32px; align-items: flex-start; }
h2 { font-size: 14px; margin: 0 0 8px; } small { color: #666; font-weight: normal; }
iframe { border: 0; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.2); }
ul { color: #b00020; margin: 0 0 8px; padding-left: 18px; }
</style>
${LIVE_RELOAD}
</head>
<body>
${designMdErrors}
<main>
${screens.join("\n") || "<p>No Screens yet: add HTML files to screens/.</p>"}
</main>
</body>
</html>
`;
}

function errorList(errors: CheckError[]): string {
	if (errors.length === 0) return "";
	const items = errors.map(
		(error) =>
			`<li>line ${error.line}${error.element ? ` ${escapeHtml(error.element)}` : ""}: ${escapeHtml(error.message)} <code>${error.rule}</code></li>`,
	);
	return `<ul>${items.join("")}</ul>`;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
