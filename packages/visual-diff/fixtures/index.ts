// Stored PNG fixtures for visual-diff tests (regenerate with
// `bun run fixtures`). The design is a 393×852pt screen exported at 1x; every
// `actual*` image is a 3x (1179×2556) capture of it with one kind of change.
import { join } from "node:path";

const fixture = (name: string) => join(import.meta.dir, name);

export const pngFixtures = {
	/** 393×852, the 1x design. */
	design: fixture("design.png"),
	/** The design rendered at 3x, pixel for pixel. */
	identical: fixture("actual-identical.png"),
	/** The card moved down by 16pt. */
	shifted: fixture("actual-shifted.png"),
	/** The button turned red. */
	recolored: fixture("actual-recolored.png"),
	/** Only the clock and battery in the status bar differ. */
	statusBar: fixture("actual-status-bar.png"),
	/** 1179×1179: not the same screen shape. */
	wrongAspect: fixture("actual-wrong-aspect.png"),
};

/** Where the design's shapes sit, in design (1x) coordinates. */
export const designLayout = {
	card: { x: 24, y: 140, width: 345, height: 200 },
	button: { x: 24, y: 700, width: 345, height: 52 },
};
