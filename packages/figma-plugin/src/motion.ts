// Motion animations (Figma's beta Motion API): read and write the animation
// styles and manual keyframe tracks on one node. Everything is checked before
// anything is written, and every write is one undo step. Figma versions
// without the API get a motion_unsupported error.
import {
	type AppliedAnimationStyle,
	type AvailableAnimationStyle,
	animationStyleNotFoundError,
	type BridgeError,
	type CommandParams,
	type CommandResult,
	compareKeyframeTracks,
	type KeyframeField,
	type KeyframeTrack,
	keyframeFieldError,
	motionUnsupportedError,
	type NodeMotion,
	noMotionError,
	noTimelineError,
} from "@figma-agent-tool/protocol";
import { CommandError, nodeNotFound } from "./errors";

type MotionNode = SceneNode & MotionNodeMixin;

/** Whether this Figma version exposes the Motion API. */
export function motionSupported(): boolean {
	try {
		return typeof figma.motion?.figmaAnimationStyles === "function";
	} catch {
		return false;
	}
}

export async function getMotion({
	nodeId,
	availableStyles,
}: CommandParams<"get_motion">): Promise<CommandResult<"get_motion">> {
	const node = await motionNode(nodeId);
	const motion = readMotion(node);
	if (!availableStyles) return motion;
	return { ...motion, availableStyles: await listStyles() };
}

export async function setMotion({
	nodeId,
	mode,
	animationStyles,
	keyframeTracks,
	timelineDuration,
}: CommandParams<"set_motion">): Promise<CommandResult<"set_motion">> {
	const node = await motionNode(nodeId);
	const styles = await listStyles();
	for (const { type, styleId } of animationStyles ?? []) {
		if (!styles.some((s) => s.type === type && s.styleId === styleId)) {
			fail(animationStyleNotFoundError(type, styleId));
		}
	}
	const counts = {
		fills: paintCount(node, "fills"),
		strokes: paintCount(node, "strokes"),
		effects: "effects" in node ? node.effects.length : 0,
	};
	for (const { field } of keyframeTracks ?? []) {
		const error = keyframeFieldError(nodeId, field, counts);
		if (error) fail(error);
	}
	const [timeline] = node.timelines;
	if (timelineDuration !== undefined && !timeline) {
		fail(noTimelineError(nodeId));
	}

	if (animationStyles) {
		if (mode === "replace") {
			for (const { id } of node.animationStyles) node.removeAnimationStyle(id);
		}
		for (const { styleId, ...config } of animationStyles) {
			// Figma checks the values it's given, so leave unset ones out.
			node.applyAnimationStyle(
				styleId,
				definedOnly(config) as AnimationStyleConfiguration,
			);
		}
	}
	if (keyframeTracks) {
		if (mode === "replace") {
			for (const { field } of readTracks(node)) {
				node.removeManualKeyframeTrack(field as globalThis.KeyframeField);
			}
		}
		for (const { field, ...track } of keyframeTracks) {
			// Our schema mirrors the Plugin API's; it only types `readonly` looser.
			node.applyManualKeyframeTrack(
				field as globalThis.KeyframeField,
				track as ManualKeyframeTrackInput,
			);
		}
	}
	if (timeline && timelineDuration !== undefined) {
		node.setTimelineDuration(timeline.id, timelineDuration);
	}
	figma.commitUndo();
	return readMotion(node);
}

async function motionNode(id: string): Promise<MotionNode> {
	if (!motionSupported()) fail(motionUnsupportedError());
	const node = await figma.getNodeByIdAsync(id);
	if (!node) throw nodeNotFound(id);
	if (!("animationStyles" in node)) fail(noMotionError(id, node.type));
	return node as MotionNode;
}

function definedOnly(value: object) {
	return Object.fromEntries(
		Object.entries(value).filter(([, v]) => v !== undefined),
	);
}

function fail(error: BridgeError): never {
	throw new CommandError(error.code, error.message);
}

function paintCount(node: SceneNode, key: "fills" | "strokes"): number {
	if (!(key in node)) return 0;
	const paints = (node as GeometryMixin)[key];
	return Array.isArray(paints) ? paints.length : 0;
}

function readMotion(node: MotionNode): NodeMotion {
	return {
		nodeId: node.id,
		timelines: node.timelines.map(({ id, duration }) => ({ id, duration })),
		animationStyles: node.animationStyles.map(
			(style) => ({ ...style }) as AppliedAnimationStyle,
		),
		keyframeTracks: readTracks(node),
	};
}

/** The node's nested `manualKeyframeTracks`, flattened to one track per field. */
function readTracks(node: MotionNode): KeyframeTrack[] {
	const { fills, strokes, effects, ...properties } = node.manualKeyframeTracks;
	const tracks: KeyframeTrack[] = [];
	const add = (field: KeyframeField, binding: ManualKeyframeBinding) =>
		tracks.push({ field, ...binding } as KeyframeTrack);
	const addProperties = (
		field: Omit<KeyframeField & { type: "INDEXED_ITEM" }, "propertyId">,
		bindings: ComponentPropKeyframeTracks | undefined,
	) => {
		for (const [propertyId, binding] of Object.entries(bindings ?? {})) {
			if (binding) add({ ...field, propertyId }, binding);
		}
	};
	for (const [name, binding] of Object.entries(properties)) {
		if (binding) add({ type: "PROPERTY", name } as KeyframeField, binding);
	}
	for (const [collection, paints] of [
		["fills", fills],
		["strokes", strokes],
	] as const) {
		for (const [index, track] of Object.entries(paints ?? {})) {
			const field = {
				type: "INDEXED_ITEM",
				collection,
				index: Number(index),
			} as const;
			if (!track) continue;
			if ("properties" in track) addProperties(field, track.properties);
			else add(field, track);
		}
	}
	for (const [index, effect] of Object.entries(effects ?? {})) {
		const field = {
			type: "INDEXED_ITEM",
			collection: "effects",
			index: Number(index),
		} as const;
		const { properties: effectProperties, ...fields } = effect ?? {};
		for (const [name, binding] of Object.entries(fields)) {
			if (binding) add({ ...field, field: name } as KeyframeField, binding);
		}
		addProperties(field, effectProperties);
	}
	return tracks.sort(compareKeyframeTracks);
}

/** Figma's animation presets, then the file's local custom animation styles. */
async function listStyles(): Promise<AvailableAnimationStyle[]> {
	const presets = figma.motion
		.figmaAnimationStyles()
		.map(({ styleId, name, description, props }) => ({
			type: "FIGMA" as const,
			styleId,
			name,
			...(description !== undefined && { description }),
			...(props && { props: { ...props } }),
		}));
	const custom = (await figma.getLocalCustomAnimationStylesAsync()).map(
		({ id, name, description }) => ({
			type: "CUSTOM" as const,
			styleId: id,
			name,
			...(description && { description }),
		}),
	);
	return [...presets, ...custom];
}
