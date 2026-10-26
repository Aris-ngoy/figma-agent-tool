// The local Preview: every Screen at its Screen Size, with Check's errors,
// in the Mode its switcher picks, reloading whenever a file in the Design
// Project changes, each Screen's Directions side by side with it, and the
// Defined Components' variants. It only views, and chooses Directions;
// editing happens in the files.
import { existsSync, type FSWatcher, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	type CheckError,
	checkProject,
	chooseDirection,
	type DesignProject,
	DesignProjectError,
	type DirectionFile,
	directionOf,
	loadProject,
	modeTokens,
	type ScreenFile,
	screenSizeOf,
} from "@figma-agent-tool/design-project";
import {
	componentDocument,
	exportNote,
	figmaOwnedOf,
	screenDocument,
} from "./document";

export const DEFAULT_PREVIEW_PORT = 4321;

const LIVE_RELOAD = `<script>
new EventSource("/events").onmessage = () => location.reload();
</script>`;

/** Clicking a Prototype Link shows its Screen, in the same Mode, as Figma's prototype does. */
const PROTOTYPE_LINKS = `<script>
document.addEventListener("click", (event) => {
  const link = event.target.closest("[href]");
  if (!link) return;
  event.preventDefault();
  const screen = link.getAttribute("href").replace(/\\.html$/, "");
  location.href = "/screens/" + encodeURIComponent(screen) + location.search;
});
</script>`;

/** Sizes a Component's iframe to its variants. */
const FIT =
	"this.style.width = this.contentDocument.body.scrollWidth + 'px'; this.style.height = this.contentDocument.body.scrollHeight + 'px';";

/** The live-reload stream's messages: its greeting, and a reload. */
const CONNECTED_EVENT = new TextEncoder().encode(": connected\n\n");
const RELOAD_EVENT = new TextEncoder().encode("data: reload\n\n");

/** Content types of the files Screens use, by extension. */
const CONTENT_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".json": "application/json",
};

export type Preview = { url: string; port: number; stop(): void };

/** Starts the Preview; rejects when it can't listen, the port being taken say. */
export async function startPreview({
	dir,
	port = DEFAULT_PREVIEW_PORT,
	hostname = "127.0.0.1",
}: {
	dir: string;
	port?: number;
	hostname?: string;
}): Promise<Preview> {
	const root = resolve(dir);
	const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
	let watcher: FSWatcher | undefined;
	let debounce: ReturnType<typeof setTimeout> | undefined;
	try {
		watcher = watch(root, { recursive: true }, () => {
			clearTimeout(debounce);
			debounce = setTimeout(() => {
				for (const client of clients) client.enqueue(RELOAD_EVENT);
			}, 50);
		});
	} catch {
		// No recursive watching on this platform: the Preview won't live-reload.
	}

	async function respond(request: Request): Promise<Response> {
		const { pathname, searchParams } = new URL(request.url);
		if (pathname === "/events") {
			let controller: ReadableStreamDefaultController<Uint8Array>;
			const stream = new ReadableStream<Uint8Array>({
				start(c) {
					controller = c;
					clients.add(c);
					c.enqueue(CONNECTED_EVENT);
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
		const mode = searchParams.get("mode") ?? undefined;
		try {
			modeTokens(project, mode);
		} catch (error) {
			if (!(error instanceof DesignProjectError)) throw error;
			return new Response(error.message, { status: 404 });
		}
		if (pathname === "/") return html(await indexPage(project, mode));
		if (pathname === "/choose" && request.method === "POST") {
			const form = await request.formData();
			const direction = directionOf(
				project,
				String(form.get("screen")),
				String(form.get("direction")),
			);
			if (!direction) return new Response("No such Direction", { status: 404 });
			await chooseDirection(project, direction);
			return new Response(null, { status: 303, headers: { Location: "/" } });
		}
		const componentMatch = /^\/components\/([^/]+)$/.exec(pathname);
		if (componentMatch) {
			const name = decodeURIComponent(componentMatch[1] as string);
			const component = project.components.find((c) => c.name === name);
			if (!component) return new Response("No such Component", { status: 404 });
			return html(
				componentDocument(project, component, {
					baseUrl: "/files/components/",
					head: LIVE_RELOAD,
					mode,
				}),
			);
		}
		const route = screenRoute(project, pathname);
		if (route) {
			const { screen } = route;
			if (!screen) return new Response("No such Screen", { status: 404 });
			return html(
				screenDocument(project, screen, {
					baseUrl: `/files/${dirname(screen.file)}/`,
					head: `${LIVE_RELOAD}\n${PROTOTYPE_LINKS}`,
					figmaOwned: await figmaOwnedOf(project, screen),
					mode,
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
			if (!existsSync(path)) return new Response("Not found", { status: 404 });
			const type =
				CONTENT_TYPES[extname(path).toLowerCase()] ??
				"application/octet-stream";
			return new Response(await readFile(path), {
				headers: { "Content-Type": type },
			});
		}
		return new Response("Not found", { status: 404 });
	}

	const server = createServer(async (incoming, outgoing) => {
		let response: Response;
		try {
			response = await respond(await toRequest(incoming));
		} catch (error) {
			response = new Response(String(error), { status: 500 });
		}
		outgoing.writeHead(response.status, Object.fromEntries(response.headers));
		if (!response.body) return outgoing.end();
		// A closed page cancels its live-reload stream.
		pipeline(Readable.fromWeb(response.body), outgoing).catch(() => {});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, hostname, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const bound = (server.address() as AddressInfo).port;

	return {
		url: `http://${hostname}:${bound}/`,
		port: bound,
		stop() {
			clearTimeout(debounce);
			watcher?.close();
			for (const client of clients) client.close();
			server.close();
			server.closeAllConnections();
		},
	};
}

/** The web Request for a Node one; its body is read whole (forms only). */
async function toRequest(incoming: IncomingMessage): Promise<Request> {
	const { href: url } = new URL(incoming.url ?? "/", "http://localhost");
	const headers = new Headers();
	for (const [name, value] of Object.entries(incoming.headers)) {
		if (typeof value === "string") headers.set(name, value);
	}
	if (incoming.method === "GET" || incoming.method === "HEAD")
		return new Request(url, { method: incoming.method, headers });
	const chunks: Buffer[] = [];
	for await (const chunk of incoming) chunks.push(chunk as Buffer);
	return new Request(url, {
		method: incoming.method,
		headers,
		body: Buffer.concat(chunks),
	});
}

function html(body: string): Response {
	return new Response(body, {
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

async function indexPage(
	project: DesignProject,
	mode = project.modes.default,
): Promise<string> {
	const { errors } = await checkProject(project);
	const query =
		mode === project.modes.default ? "" : `?mode=${encodeURIComponent(mode)}`;
	const card = async (screen: ScreenFile, src: string, choose?: string) => {
		const { width, height } = screenSizeOf(project, screen);
		const screenErrors = errors.filter((error) => error.file === screen.file);
		const notes = (await figmaOwnedOf(project, screen)).flatMap((owned) => {
			const note = exportNote(owned);
			return note ? [note] : [];
		});
		return `<section>
<h2>${escapeHtml(screen.name)} <small>${width}×${height}</small>${choose ?? ""}</h2>
${errorList(screenErrors)}${noteList(notes)}
<iframe src="${src}${query}" width="${width}" height="${height}" title="${escapeHtml(screen.name)}"></iframe>
</section>`;
	};
	const names = [
		...new Set([
			...project.screens.map((screen) => screen.name),
			...project.directions.map((direction) => direction.of),
		]),
	];
	const screens = names.map(async (name) => {
		const screen = project.screens.find((s) => s.name === name);
		const current = screen
			? await card(screen, `/screens/${encodeURIComponent(name)}`)
			: "";
		const directions = project.directions.filter((d) => d.of === name);
		if (directions.length === 0) return current;
		const cards = directions.map((direction) =>
			card(
				direction,
				`/directions/${encodeURIComponent(name)}/${encodeURIComponent(direction.direction)}`,
				chooseForm(direction),
			),
		);
		return `<div class="directions">
${current}
${(await Promise.all(cards)).join("\n")}
</div>`;
	});
	const components = project.components.map((component) => {
		const componentErrors = errors.filter(
			(error) => error.file === component.file,
		);
		return `<section>
<h2>${escapeHtml(component.name)} <small>Component</small></h2>
${errorList(componentErrors)}
<iframe src="/components/${encodeURIComponent(component.name)}${query}" title="${escapeHtml(component.name)}" onload="${FIT}"></iframe>
</section>`;
	});
	const designSystemErrors = errorList(
		errors.filter(
			(error) =>
				!error.file.startsWith("screens/") &&
				!project.components.some((c) => c.file === error.file),
		),
	);
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Preview: ${escapeHtml(join(project.dir))}</title>
<style>
body { margin: 0; padding: 24px; background: #e5e5e5; font: 14px system-ui, sans-serif; }
main, .directions { display: flex; flex-wrap: wrap; gap: 32px; align-items: flex-start; }
.directions { flex-basis: 100%; padding: 16px; background: #d8d8d8; }
h2 form { display: inline; margin: 0 0 0 8px; }
h2 { font-size: 14px; margin: 0 0 8px; } small { color: #666; font-weight: normal; }
iframe { border: 0; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.2); }
ul { color: #b00020; margin: 0 0 8px; padding-left: 18px; }
ul.notes { color: #8a5a00; }
form { margin: 0 0 16px; }
</style>
${LIVE_RELOAD}
</head>
<body>
${modeSwitcher(project, mode)}
${designSystemErrors}
<main>
${(await Promise.all(screens)).join("\n") || "<p>No Screens yet: add HTML files to screens/, and Directions to screens/&lt;Screen&gt;.directions/.</p>"}
${components.join("\n")}
</main>
</body>
</html>
`;
}

/**
 * The Screen or Direction a /screens/<screen> or /directions/<screen>/<direction>
 * path shows (undefined if there's none by that name), or undefined for any other path.
 */
function screenRoute(
	project: DesignProject,
	pathname: string,
): { screen: ScreenFile | undefined } | undefined {
	const screenMatch = /^\/screens\/([^/]+)$/.exec(pathname);
	if (screenMatch) {
		const name = decodeURIComponent(screenMatch[1] as string);
		return { screen: project.screens.find((s) => s.name === name) };
	}
	const directionMatch = /^\/directions\/([^/]+)\/([^/]+)$/.exec(pathname);
	if (directionMatch) {
		return {
			screen: directionOf(
				project,
				decodeURIComponent(directionMatch[1] as string),
				decodeURIComponent(directionMatch[2] as string),
			),
		};
	}
	return undefined;
}

/** Chooses the Direction: it becomes the Screen, and the other Directions are deleted. */
function chooseForm(direction: DirectionFile): string {
	const confirm = `Make ${direction.direction} the ${direction.of} Screen and delete its other Directions?`;
	return `<form method="post" action="/choose" onsubmit="return confirm(${escapeHtml(JSON.stringify(confirm))})"><input type="hidden" name="screen" value="${escapeHtml(direction.of)}"><input type="hidden" name="direction" value="${escapeHtml(direction.direction)}"><button>Choose</button></form>`;
}

/** Picks the Mode every Screen shows, when the Design System has several. */
function modeSwitcher(project: DesignProject, current: string): string {
	const { names } = project.modes;
	if (names.length < 2) return "";
	const options = names.map(
		(name) =>
			`<option value="${escapeHtml(name)}"${name === current ? " selected" : ""}>${escapeHtml(name)}</option>`,
	);
	return `<form><label for="mode">Mode</label> <select id="mode" name="mode" onchange="this.form.submit()">${options.join("")}</select></form>`;
}

function errorList(errors: CheckError[]): string {
	if (errors.length === 0) return "";
	const items = errors.map(
		(error) =>
			`<li>line ${error.line}${error.element ? ` ${escapeHtml(error.element)}` : ""}: ${escapeHtml(error.message)} <code>${error.rule}</code></li>`,
	);
	return `<ul>${items.join("")}</ul>`;
}

function noteList(notes: string[]): string {
	if (notes.length === 0) return "";
	const items = notes.map((note) => `<li>${escapeHtml(note)}</li>`);
	return `<ul class="notes">${items.join("")}</ul>`;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
