import { describe, expect, test } from "bun:test";
import {
	document,
	exchanges,
	handshake,
	pingRequest,
	pingResponse,
} from "../fixtures";
import {
	commands,
	parsePluginMessage,
	parseServerMessage,
	SerializedNode,
} from "../src";

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

describe("document fixture", () => {
	test("every node is a valid serialized node", () => {
		for (const page of document.pages) {
			for (const node of page.children) {
				expect(SerializedNode.parse(node)).toEqual(node);
			}
		}
	});

	test("every exchange pairs valid params with a valid correlated response", () => {
		for (const [request, response] of exchanges) {
			expect(response.id).toBe(request.id);
			const { params, result } = commands[request.command];
			expect(params.parse(request.params)).toEqual(request.params as never);
			if (response.ok) {
				expect(result.parse(response.result)).toEqual(response.result as never);
			}
		}
	});
});
