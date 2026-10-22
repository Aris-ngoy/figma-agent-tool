import { describe, expect, test } from "bun:test";
import { DEFAULT_BRIDGE_PORT } from "@figma-agent-tool/protocol";
import { document } from "@figma-agent-tool/protocol/fixtures";
import { loadSettings, parsePort, saveSettings } from "../src/settings";
import { installMockFigma } from "./mock-figma";

describe("plugin settings", () => {
	test("default to the default bridge port", async () => {
		installMockFigma(document);
		expect(await loadSettings()).toEqual({ port: DEFAULT_BRIDGE_PORT });
	});

	test("remember the bridge port across plugin runs", async () => {
		installMockFigma(document);
		await saveSettings({ port: 4000 });
		expect(await loadSettings()).toEqual({ port: 4000 });
	});

	test("fall back to the default when the stored port is invalid", async () => {
		const figma = installMockFigma(document);
		await figma.clientStorage.setAsync("bridgePort", "nope");
		expect(await loadSettings()).toEqual({ port: DEFAULT_BRIDGE_PORT });
	});

	test("accept only whole ports between 1 and 65535", () => {
		expect(parsePort("3056")).toBe(3056);
		expect(parsePort(" 3056 ")).toBe(3056);
		for (const bad of ["", "0", "65536", "30.5", "abc", "-1"]) {
			expect(parsePort(bad)).toBeUndefined();
		}
	});
});
