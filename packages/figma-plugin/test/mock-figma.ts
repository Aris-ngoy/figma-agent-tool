// Seam 2 harness: installs a mocked `figma` global built from the shared
// document fixture, so the real command handler runs as it would in Figma's
// sandbox.
import { afterEach } from "bun:test";
import {
	type document as documentFixture,
	framePng,
} from "@figma-agent-tool/protocol/fixtures";

type DocumentFixture = typeof documentFixture;

export function installMockFigma(document: DocumentFixture) {
	const exports: { nodeId: string; settings: unknown }[] = [];
	const pages = document.pages.map((page) => ({ ...page, type: "PAGE" }));
	// Every frame exports the fixture PNG; tests check the settings it got.
	const frames = document.frames.map((frame) => ({
		...frame,
		type: "FRAME",
		async exportAsync(settings: unknown) {
			exports.push({ nodeId: frame.id, settings });
			return new Uint8Array(Buffer.from(framePng, "base64"));
		},
	}));
	const nodes = [...pages, ...frames];
	const mock = {
		fileKey: document.fileKey,
		root: { name: document.name, children: pages },
		async getNodeByIdAsync(id: string) {
			return nodes.find((node) => node.id === id) ?? null;
		},
		base64Encode(data: Uint8Array) {
			return Buffer.from(data).toString("base64");
		},
		exports,
	};
	(globalThis as { figma?: unknown }).figma = mock;
	return mock;
}

afterEach(() => {
	delete (globalThis as { figma?: unknown }).figma;
});
