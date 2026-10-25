// SVG path data as Figma's vector paths take it: absolute M, L, C, Q and Z
// commands. Screens may write the other SVG commands too, except arcs,
// which have no exact equivalent; they become these on the way to Figma.

export type PathCommand = {
	command: "M" | "L" | "C" | "Q" | "Z";
	points: number[];
};

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi;
const COMMAND = /[mlhvcsqtza]/gi;
const TOKEN = new RegExp(`${COMMAND.source}|${NUMBER.source}`, "gi");

/** Coordinates each command takes. */
const ARITY: Record<string, number> = {
	M: 2,
	L: 2,
	H: 1,
	V: 1,
	C: 6,
	S: 4,
	Q: 4,
	T: 2,
	Z: 0,
};

/** Absolute M, L, C, Q and Z commands, or why the data can't be read. */
export function parsePath(d: string): PathCommand[] | { problem: string } {
	const tokens = d.match(TOKEN);
	const rest = d.replace(NUMBER, " ").replace(COMMAND, " ");
	if (!tokens || rest.replace(/[\s,]/g, "") !== "") {
		return { problem: `\`d="${d}"\` isn't SVG path data.` };
	}
	const commands: PathCommand[] = [];
	let [x, y, startX, startY] = [0, 0, 0, 0];
	// The last control point, for S and T.
	let control: [number, number] | undefined;
	let at = 0;
	let letter = "";
	while (at < tokens.length) {
		const token = tokens[at] as string;
		if (/[a-z]/i.test(token)) {
			letter = token;
			at++;
		} else if (!letter) {
			return { problem: "Path data needs a command before its numbers." };
		}
		const upper = letter.toUpperCase();
		if (upper === "A") {
			return {
				problem:
					"Arcs (A) have no exact equivalent in Figma: draw them with curves (C or Q).",
			};
		}
		const arity = ARITY[upper];
		if (arity === undefined)
			return { problem: `Unknown path command ${letter}.` };
		const values = tokens.slice(at, at + arity).map(Number);
		if (values.length < arity || values.some(Number.isNaN)) {
			return { problem: `${letter} needs ${arity} numbers.` };
		}
		at += arity;
		const relative = letter !== upper;
		const point = (i: number): [number, number] => [
			(values[i] as number) + (relative ? x : 0),
			(values[i + 1] as number) + (relative ? y : 0),
		];
		let next: [number, number] = [x, y];
		let nextControl: [number, number] | undefined;
		const reflected = (): [number, number] =>
			control ? [2 * x - control[0], 2 * y - control[1]] : [x, y];
		switch (upper) {
			case "Z":
				commands.push({ command: "Z", points: [] });
				next = [startX, startY];
				// Z takes no numbers, so none can follow it.
				letter = "";
				break;
			case "M":
				next = point(0);
				commands.push({ command: "M", points: next });
				[startX, startY] = next;
				// Further pairs after M are lines.
				letter = relative ? "l" : "L";
				break;
			case "L":
				next = point(0);
				commands.push({ command: "L", points: next });
				break;
			case "H":
				next = [(values[0] as number) + (relative ? x : 0), y];
				commands.push({ command: "L", points: next });
				break;
			case "V":
				next = [x, (values[0] as number) + (relative ? y : 0)];
				commands.push({ command: "L", points: next });
				break;
			case "C": {
				nextControl = point(2);
				next = point(4);
				commands.push({
					command: "C",
					points: [...point(0), ...nextControl, ...next],
				});
				break;
			}
			case "S": {
				nextControl = point(0);
				next = point(2);
				commands.push({
					command: "C",
					points: [...reflected(), ...nextControl, ...next],
				});
				break;
			}
			case "Q": {
				nextControl = point(0);
				next = point(2);
				commands.push({ command: "Q", points: [...nextControl, ...next] });
				break;
			}
			case "T": {
				nextControl = reflected();
				next = point(0);
				commands.push({ command: "Q", points: [...nextControl, ...next] });
				break;
			}
		}
		// S reflects only a C's control point, T only a Q's.
		control = nextControl;
		[x, y] = next;
	}
	if (commands[0]?.command !== "M") {
		return { problem: "Path data starts with a move (M)." };
	}
	return commands;
}

/** Scales a path, then moves it. */
export function transformPath(
	commands: PathCommand[],
	scale: number,
	dx: number,
	dy: number,
): PathCommand[] {
	return commands.map(({ command, points }) => ({
		command,
		points: points.map((value, index) =>
			index % 2 === 0 ? value * scale + dx : value * scale + dy,
		),
	}));
}

/** `M 4 12 L 9 17 Z`, as Figma writes path data, to 1/100 px. */
export function formatPath(commands: PathCommand[]): string {
	return commands
		.map(({ command, points }) =>
			[command, ...points.map((value) => String(round(value)))].join(" "),
		)
		.join(" ");
}

function round(value: number): number {
	const rounded = Math.round(value * 100) / 100;
	return Object.is(rounded, -0) ? 0 : rounded;
}
