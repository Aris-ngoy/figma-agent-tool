// Push and Pull through the fake plugin's in-place apply, as the MCP tools
// do through the real one.
import type { SyncedNode } from "@figma-agent-tool/protocol";
import { applyScreenTree } from "../fixtures";
import {
	assignKeys,
	type Baseline,
	baselineAfterPush,
	checkScreen,
	type DesignProject,
	pullScreen,
	pushedImageRecords,
	type ScreenFile,
	screenPush,
} from "../src";
import { fixtureProject } from "./fixture-project";

/** Pushes a Screen into a fake frame, as Push does through the Plugin. */
export async function push(
	project: DesignProject,
	screen: ScreenFile,
	previous?: { frame: SyncedNode; baseline: Baseline },
) {
	const { source } = assignKeys(screen.source);
	const keyed = { ...screen, source };
	const { root } = checkScreen(project, keyed);
	if (!root) throw new Error("Screen doesn't check");
	const { tree, images, sources, remove } = await screenPush(
		project,
		keyed,
		root,
		previous?.baseline,
	);
	let id = previous ? 100 : 0;
	const frame = applyScreenTree(tree, previous?.frame, {
		nextId: () => `9:${++id}`,
		imageHash: (name) => `hash-of-${name}`,
		remove,
	});
	const hashes = Object.fromEntries(
		Object.keys(images).map((name) => [name, `hash-of-${name}`]),
	);
	const imageRecords = pushedImageRecords(sources, hashes);
	const baseline = baselineAfterPush(project, source, frame, imageRecords);
	return { tree, images, remove, frame, baseline, screen: keyed };
}

export async function pushedLogin() {
	const project = await fixtureProject();
	const screen = project.screens[0] as ScreenFile;
	return { project, ...(await push(project, screen)) };
}

export function pull(
	project: DesignProject,
	screen: ScreenFile,
	baseline: Baseline,
	frame: SyncedNode,
) {
	const { root } = checkScreen(project, screen);
	if (!root) throw new Error("Screen doesn't check");
	return pullScreen(project, screen, root, baseline, frame);
}
