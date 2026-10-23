// The fake plugin's Motion commands, applied to its copy of the document
// fixture. The plugin tests replay the same fixture exchanges against the
// real handler on a mocked Motion API.
import {
	type AppliedAnimationStyle,
	animationStyleNotFoundError,
	type BridgeError,
	type CommandParams,
	type CommandResult,
	compareKeyframeTracks,
	type KeyframeTrack,
	keyframeFieldError,
	keyframeFieldKey,
	type NodeMotion,
	noMotionError,
	noTimelineError,
	type SerializedNode,
} from "@figma-agent-tool/protocol";
import {
	appliedStyleId,
	type DocumentFixture,
	findNode,
	keyframeId,
	keyframeTrackId,
	nodeNotFoundResponse,
	timelineId,
} from "@figma-agent-tool/protocol/fixtures";

export function createFakeMotion(doc: DocumentFixture) {
	// How many styles each node has had applied, for their IDs.
	const applied = new Map(
		Object.entries(doc.motion.nodes).map(([id, motion]) => [
			id,
			motion.animationStyles.length,
		]),
	);

	/** The node, or why it can't be animated. */
	function animatable(nodeId: string): SerializedNode | BridgeError {
		const node = findNode(nodeId, doc);
		if (!node) return nodeNotFoundResponse("", nodeId).error;
		if (node.type === "PAGE") return noMotionError(nodeId, node.type);
		return node;
	}

	function stateOf(nodeId: string) {
		doc.motion.nodes[nodeId] ??= { animationStyles: [], keyframeTracks: [] };
		return doc.motion.nodes[nodeId];
	}

	/** The top-level frame holding the node; timelines belong to it. */
	function frameOf(nodeId: string): string | undefined {
		const contains = (node: SerializedNode): boolean =>
			node.id === nodeId || (node.children ?? []).some(contains);
		for (const page of doc.pages) {
			const frame = page.children.find(contains);
			if (frame) return frame.id;
		}
		return undefined;
	}

	function read(nodeId: string): NodeMotion {
		const frame = frameOf(nodeId);
		const duration = frame ? doc.motion.timelines[frame] : undefined;
		const { animationStyles, keyframeTracks } = stateOf(nodeId);
		return structuredClone({
			nodeId,
			timelines: frame && duration ? [{ id: timelineId(frame), duration }] : [],
			animationStyles,
			keyframeTracks: [...keyframeTracks].sort(compareKeyframeTracks),
		});
	}

	return {
		get_motion({
			nodeId,
			availableStyles,
		}: CommandParams<"get_motion">): CommandResult<"get_motion"> | BridgeError {
			const node = animatable(nodeId);
			if ("code" in node) return node;
			const motion = read(nodeId);
			if (!availableStyles) return motion;
			return { ...motion, availableStyles: structuredClone(doc.motion.styles) };
		},

		set_motion({
			nodeId,
			mode,
			animationStyles,
			keyframeTracks,
			timelineDuration,
		}: CommandParams<"set_motion">): CommandResult<"set_motion"> | BridgeError {
			const node = animatable(nodeId);
			if ("code" in node) return node;
			const offered = (type: string, styleId: string) =>
				doc.motion.styles.find(
					(style) => style.type === type && style.styleId === styleId,
				);
			for (const { type, styleId } of animationStyles ?? []) {
				if (!offered(type, styleId)) {
					return animationStyleNotFoundError(type, styleId);
				}
			}
			const counts = {
				fills: Array.isArray(node.fills) ? node.fills.length : 0,
				strokes: node.strokes?.length ?? 0,
				effects: 0,
			};
			for (const { field } of keyframeTracks ?? []) {
				const error = keyframeFieldError(nodeId, field, counts);
				if (error) return error;
			}
			const frame = frameOf(nodeId);
			const hasTimeline = frame && doc.motion.timelines[frame] !== undefined;
			if (timelineDuration !== undefined && !hasTimeline) {
				return noTimelineError(nodeId);
			}

			const state = stateOf(nodeId);
			if (animationStyles) {
				const added = animationStyles.map(
					({ type, styleId, ...config }): AppliedAnimationStyle => {
						const id = appliedStyleId(nodeId, (applied.get(nodeId) ?? 0) + 1);
						applied.set(nodeId, (applied.get(nodeId) ?? 0) + 1);
						const { name, description } = offered(type, styleId) ?? {};
						return type === "CUSTOM"
							? withoutUndefined({
									type,
									id,
									styleId,
									name: name as string,
									timelineOffset: config.timelineOffset,
								})
							: withoutUndefined({
									type,
									id,
									styleId,
									name: name as string,
									description,
									...config,
								});
					},
				);
				state.animationStyles =
					mode === "append" ? [...state.animationStyles, ...added] : added;
			}
			if (keyframeTracks) {
				const tracks = new Map(
					(mode === "append" ? state.keyframeTracks : []).map((track) => [
						keyframeFieldKey(track.field),
						track,
					]),
				);
				for (const { field, id, baseValue, keyframes } of keyframeTracks) {
					const trackId = id ?? keyframeTrackId(nodeId, field);
					tracks.set(keyframeFieldKey(field), {
						field,
						id: trackId,
						...(baseValue && { baseValue }),
						keyframes: keyframes.map((keyframe, index) => ({
							id: keyframeId(trackId, index),
							...keyframe,
						})),
					} satisfies KeyframeTrack);
				}
				state.keyframeTracks = structuredClone([...tracks.values()]);
			}
			if (frame && timelineDuration !== undefined) {
				doc.motion.timelines[frame] = timelineDuration;
			}
			return read(nodeId);
		},
	};
}

function withoutUndefined<T extends object>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, v]) => v !== undefined),
	) as T;
}
