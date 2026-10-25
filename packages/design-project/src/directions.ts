// Directions: alternative versions of a Screen in screens/<Screen>.directions/.
// Choosing one makes it the Screen and discards the others (git keeps them).
import { rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
	type DesignProject,
	type DirectionFile,
	directionsPath,
	screenPath,
} from "./project";

/** A Screen's Direction by name, if it has one by that name. */
export function directionOf(
	project: DesignProject,
	screen: string,
	direction: string,
): DirectionFile | undefined {
	return project.directions.find(
		(d) => d.of === screen && d.direction === direction,
	);
}

/** An <img>'s `src` attribute, in either quotes. */
const IMG_SRC = /(<img\b[^>]*?\ssrc=)(["'])(.*?)\2/gi;

/**
 * Writes the Direction over its Screen (creating it if there was none) and
 * removes the Screen's Directions folder. The Screen's Baseline stays, so
 * the next Push updates its frame in place.
 */
export async function chooseDirection(
	project: DesignProject,
	direction: DirectionFile,
): Promise<{
	screen: string;
	file: string;
	chose: string;
	discarded: string[];
}> {
	const path = screenPath(project, direction.of);
	await writeFile(path, moveSources(direction.source, direction.path, path));
	await rm(directionsPath(project, direction.of), {
		recursive: true,
		force: true,
	});
	return {
		screen: direction.of,
		file: `screens/${direction.of}.html`,
		chose: direction.direction,
		discarded: project.directions
			.filter((d) => d.of === direction.of && d !== direction)
			.map((d) => d.direction),
	};
}

/** The source with its images' relative `src`s rewritten for a file at `to`. */
function moveSources(source: string, from: string, to: string): string {
	return source.replace(IMG_SRC, (match, start, quote, src: string) => {
		if (/^[a-z]+:/i.test(src) || src.startsWith("/")) return match;
		const moved = relative(dirname(to), resolve(dirname(from), src));
		return `${start}${quote}${moved.split(sep).join("/")}${quote}`;
	});
}
