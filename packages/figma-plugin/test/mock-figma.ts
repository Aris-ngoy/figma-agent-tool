// Seam 2 harness: installs a mocked `figma` global built from the shared
// document fixture, so the real command handler runs as it would in Figma's
// sandbox.
import { afterEach } from "bun:test";
import type { document as documentFixture } from "@figma-agent-tool/protocol/fixtures";

type DocumentFixture = typeof documentFixture;

export function installMockFigma(document: DocumentFixture) {
	const mock = {
		fileKey: document.fileKey,
		root: {
			name: document.name,
			children: document.pages.map((page) => ({ ...page, type: "PAGE" })),
		},
	};
	(globalThis as { figma?: unknown }).figma = mock;
	return mock;
}

afterEach(() => {
	delete (globalThis as { figma?: unknown }).figma;
});
