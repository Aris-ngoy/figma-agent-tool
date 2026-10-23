// Figma-backed tools need the plugin; this wrapper turns bridge failures into
// tool errors the agent can act on.
import type {
	McpServer,
	ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { BridgeRequestError } from "./bridge";

type FigmaToolConfig<
	Shape extends z.ZodRawShape,
	OutputShape extends z.ZodRawShape,
> = {
	title?: string;
	description: string;
	inputSchema?: Shape;
	outputSchema?: OutputShape;
};

/** Registers a tool that needs the plugin; bridge failures become tool errors. */
export function registerFigmaTool<
	Shape extends z.ZodRawShape,
	OutputShape extends z.ZodRawShape = z.ZodRawShape,
>(
	server: McpServer,
	name: string,
	config: FigmaToolConfig<Shape, OutputShape>,
	handler: ToolCallback<Shape>,
) {
	const callback = (async (...args: Parameters<typeof handler>) => {
		try {
			return await (handler as (...a: typeof args) => Promise<CallToolResult>)(
				...args,
			);
		} catch (error) {
			if (error instanceof BridgeRequestError) return toolError(error.message);
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
