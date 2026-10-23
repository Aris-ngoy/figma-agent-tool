// Figma-backed tools need the plugin; these wrappers turn bridge (or device
// runner) failures into tool errors the agent can act on.
import type {
	McpServer,
	ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { BridgeRequestError } from "./bridge";

type ToolConfig<
	Shape extends z.ZodRawShape,
	OutputShape extends z.ZodRawShape,
> = {
	title?: string;
	description: string;
	inputSchema?: Shape;
	outputSchema?: OutputShape;
};

type ErrorClass = abstract new (...args: never[]) => Error;

/** Registers a tool that needs the plugin; bridge failures become tool errors. */
export function registerFigmaTool<
	Shape extends z.ZodRawShape,
	OutputShape extends z.ZodRawShape = z.ZodRawShape,
>(
	server: McpServer,
	name: string,
	config: ToolConfig<Shape, OutputShape>,
	handler: ToolCallback<Shape>,
) {
	registerGuardedTool(server, name, config, handler, BridgeRequestError);
}

/**
 * Registers a tool whose `expected` failures (with messages written for the
 * agent) become tool errors; anything else still throws.
 */
export function registerGuardedTool<
	Shape extends z.ZodRawShape,
	OutputShape extends z.ZodRawShape = z.ZodRawShape,
>(
	server: McpServer,
	name: string,
	config: ToolConfig<Shape, OutputShape>,
	handler: ToolCallback<Shape>,
	expected: ErrorClass | ErrorClass[],
) {
	const expectedClasses = [expected].flat();
	const callback = (async (...args: Parameters<typeof handler>) => {
		try {
			return await (handler as (...a: typeof args) => Promise<CallToolResult>)(
				...args,
			);
		} catch (error) {
			if (expectedClasses.some((type) => error instanceof type)) {
				return toolError((error as Error).message);
			}
			throw error;
		}
	}) as ToolCallback<Shape>;
	server.registerTool(name, config, callback);
}

/** A tool error the agent sees as text. */
export function toolError(message: string): CallToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

/** A tool result carrying the same JSON as text and as structured content. */
export function jsonResult(structuredContent: Record<string, unknown>) {
	return {
		content: [
			{ type: "text" as const, text: JSON.stringify(structuredContent) },
		],
		structuredContent,
	};
}
