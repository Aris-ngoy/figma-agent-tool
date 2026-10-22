import { describe, expect, test } from "bun:test";
import {
	document,
	exchanges,
	exportFrameRequest,
	handshake,
	pingRequest,
	pingResponse,
} from "@figma-agent-tool/protocol/fixtures";
import { createCommandHandler } from "../src/handler";
import { installMockFigma } from "./mock-figma";

const pluginVersion = handshake.pluginVersion;

describe("plugin command handler", () => {
	test("builds the handshake from the open file", () => {
		installMockFigma(document);
		expect(createCommandHandler({ pluginVersion }).handshake()).toEqual(
			handshake,
		);
	});

	test("reports a null file key when Figma withholds it", () => {
		installMockFigma({ ...document, fileKey: undefined as never });
		expect(createCommandHandler({ pluginVersion }).handshake().file).toEqual({
			key: null,
			name: document.name,
		});
	});

	test("answers a ping request with the correlated response", async () => {
		installMockFigma(document);
		expect(
			await createCommandHandler({ pluginVersion }).handle(pingRequest),
		).toEqual(pingResponse);
	});

	test.each(
		exchanges.map(([request, response]) => [
			`${request.command} ${JSON.stringify(request.params)}`,
			request,
			response,
		]),
	)("replays the %s fixture exchange", async (_name, request, response) => {
		installMockFigma(document);
		expect(
			await createCommandHandler({ pluginVersion }).handle(request),
		).toEqual(response);
	});

	test("exports a node as PNG at the requested scale", async () => {
		const figma = installMockFigma(document);
		await createCommandHandler({ pluginVersion }).handle(exportFrameRequest);
		expect(figma.exports).toEqual([
			{
				nodeId: "1:2",
				settings: { format: "PNG", constraint: { type: "SCALE", value: 2 } },
			},
		]);
	});

	test("answers an unknown command with an error response", async () => {
		installMockFigma(document);
		const response = await createCommandHandler({ pluginVersion }).handle({
			...pingRequest,
			command: "does_not_exist",
		});
		expect(response).toMatchObject({
			type: "response",
			id: pingRequest.id,
			ok: false,
			error: { code: "invalid_request" },
		});
	});
});
