// Prototype tools: read, set and remove the reactions on a node.
import { commands, ReactionMatch } from "@figma-agent-tool/protocol";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "./bridge";
import { jsonResult, registerFigmaTool } from "./figma-tool";

const nodeId = z
	.string()
	.min(1)
	.describe("ID of the node the reactions are on, for example `1:3`.");

const shapeNotes =
	"Reactions mirror the Figma Plugin API: `trigger` (ON_CLICK, ON_HOVER, " +
	"ON_PRESS, ON_DRAG, AFTER_TIMEOUT, MOUSE_ENTER/LEAVE/UP/DOWN, ON_KEY_DOWN " +
	"for keys and gamepads, …) and an `actions` array. A NODE action has a " +
	"`destinationId`, a `navigation` (NAVIGATE, OVERLAY, SWAP, SCROLL_TO, " +
	"CHANGE_TO) and a `transition` (null for instant; DISSOLVE, SMART_ANIMATE, " +
	"or MOVE_IN/MOVE_OUT/PUSH/SLIDE_IN/SLIDE_OUT with a `direction`), whose " +
	"`easing` is a preset, CUSTOM_CUBIC_BEZIER or CUSTOM_SPRING and whose " +
	"`duration` is in seconds.";

export function registerReactionTools(server: McpServer, bridge: Bridge) {
	registerFigmaTool(
		server,
		"get_reactions",
		{
			description: `Return the prototype reactions on a node. ${shapeNotes}`,
			inputSchema: { nodeId },
		},
		async (args) => jsonResult(await bridge.request("get_reactions", args)),
	);

	registerFigmaTool(
		server,
		"set_reactions",
		{
			description:
				"Wire prototype interactions on a node: `replace` (default) its " +
				"reactions or `append` to them. Reactions read with get_reactions " +
				"can be written back unchanged. NAVIGATE, OVERLAY and SWAP need a " +
				"top-level frame as destination, CHANGE_TO a component variant; " +
				"invalid destinations fail and nothing is written. Returns the " +
				`node's reactions afterwards; one undo step. ${shapeNotes}`,
			inputSchema: commands.set_reactions.params.shape,
		},
		async (args) => jsonResult(await bridge.request("set_reactions", args)),
	);

	registerFigmaTool(
		server,
		"remove_reactions",
		{
			description:
				"Remove a node's reactions: all of them, or those matching a " +
				"trigger type and/or destination. Returns how many were removed " +
				"and the reactions left; one undo step.",
			inputSchema: {
				nodeId,
				match: ReactionMatch.optional().describe(
					"Only remove reactions with this trigger type and/or an action going to this destination; omit to clear all.",
				),
			},
		},
		async (args) => jsonResult(await bridge.request("remove_reactions", args)),
	);
}
