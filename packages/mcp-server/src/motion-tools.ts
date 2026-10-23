// Motion tools: read and set the Motion animations on a node. Figma's Motion
// API is beta, so both tools only run when the plugin's handshake reports the
// `motion` capability; otherwise they point the agent at reactions instead.
import { commands, motionUnsupportedError } from "@figma-agent-tool/protocol";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "./bridge";
import { jsonResult, registerFigmaTool, toolError } from "./figma-tool";

const nodeId = z
	.string()
	.min(1)
	.describe("ID of the node to animate, for example `1:3`.");

const shapeNotes =
	"Shapes mirror Figma's beta Motion Plugin API. `animationStyles` are " +
	"applied presets (type FIGMA: `styleId`, `duration`, `timelineOffset` and " +
	"`props`) or CUSTOM styles (`timelineOffset` only). `keyframeTracks` hold " +
	"manual keyframes per `field`: a PROPERTY such as OPACITY, TRANSLATION_X/Y, " +
	"ROTATION, SCALE_XY, WIDTH or CORNER_RADIUS, or an INDEXED_ITEM paint " +
	"(`fills`/`strokes` by `index`) or effect (`effects` by `index`, with a " +
	"`field` such as RADIUS). A keyframe has a `timelinePosition` in seconds, " +
	"a typed `value` (FLOAT, COLOR as 0–1 RGBA, VECTOR, BOOL, …) and an " +
	"`easing` (presets, HOLD, CUSTOM_CUBIC_BEZIER, CUSTOM_SPRING with a 0–1 " +
	"`bounce`). Available only when get_status reports `capabilities.motion`; " +
	"otherwise use set_reactions transitions.";

export function registerMotionTools(server: McpServer, bridge: Bridge) {
	/** The tool error for a connected plugin without Motion. */
	function unsupported() {
		const status = bridge.status();
		if (!status.connected || status.capabilities.motion) return undefined;
		return toolError(motionUnsupportedError().message);
	}

	registerFigmaTool(
		server,
		"get_motion",
		{
			description:
				"Return the Motion animations on a node: applied animation styles, " +
				"manual keyframe tracks and the timeline containing it. Set " +
				"`availableStyles` to also list the animation styles the file " +
				`offers (with their style IDs and props). ${shapeNotes}`,
			inputSchema: { ...commands.get_motion.params.shape, nodeId },
		},
		async (args) =>
			unsupported() ?? jsonResult(await bridge.request("get_motion", args)),
	);

	registerFigmaTool(
		server,
		"set_motion",
		{
			description:
				"Animate a node with Motion. In `replace` mode (default) a given " +
				"`animationStyles` or `keyframeTracks` list replaces the node's " +
				"styles or manual tracks; in `append` mode styles are added and each " +
				"track replaces only its own field's. Omitted lists are left alone. " +
				"`timelineDuration` sets the length of the node's timeline. What " +
				"get_motion returns can be written back. Unknown styles, missing " +
				"paints/effects or a missing timeline fail and nothing is written. " +
				`Returns the node's Motion afterwards; one undo step. ${shapeNotes}`,
			inputSchema: { ...commands.set_motion.params.shape, nodeId },
		},
		async (args) =>
			unsupported() ?? jsonResult(await bridge.request("set_motion", args)),
	);
}
