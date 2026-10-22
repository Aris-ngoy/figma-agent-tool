import { describe, expect, test } from "bun:test";
import { handshake, pingRequest, pingResponse } from "../fixtures";
import { parsePluginMessage, parseServerMessage } from "../src";

describe("bridge messages", () => {
	test("accepts a plugin handshake with file, version and capabilities", () => {
		expect(parsePluginMessage(handshake)).toEqual(handshake);
	});

	test("accepts a response correlated to a request id", () => {
		expect(parsePluginMessage(pingResponse)).toEqual(pingResponse);
	});

	test("accepts a server request carrying a correlation id", () => {
		expect(parseServerMessage(pingRequest)).toEqual(pingRequest);
	});

	test("rejects a handshake without a file key", () => {
		const { file, ...rest } = handshake;
		expect(() =>
			parsePluginMessage({ ...rest, file: { name: file.name } }),
		).toThrow();
	});

	test("rejects a request without a correlation id", () => {
		const { id: _id, ...rest } = pingRequest;
		expect(() => parseServerMessage(rest)).toThrow();
	});

	test("rejects unknown message types", () => {
		expect(() => parsePluginMessage({ type: "nope" })).toThrow();
	});
});
