// Editing YAML the way a person would: a changed value replaces just the old
// one (keeping its quotes and comments), a new field goes after its
// siblings, and everything else in the text stays as written. Pull edits
// DESIGN.md's front matter and the Modes file this way.
import {
	type Document,
	isMap,
	isScalar,
	type Pair,
	parseDocument,
	Scalar,
	type YAMLMap,
} from "yaml";
import { CONFLICT_END, CONFLICT_SEPARATOR, CONFLICT_START } from "./print";

export type FieldEdit = {
	/** The field's key path, like `colors.primary`. */
	path: string;
	/** The new value; undefined removes the field. */
	value: string | undefined;
	/** Keep the current line too, between Sync Conflict markers. */
	conflict?: boolean;
};

export type EditOptions = {
	/** Write the parents a new field needs; otherwise such a field is left out. */
	createParents?: boolean;
	/** Whether a field's new value is quoted even when it needn't be. */
	quoted?: (path: string) => boolean;
};

/** Applies the edits; every line of `text` must end in a newline. */
export function editYaml(
	text: string,
	edits: FieldEdit[],
	options: EditOptions = {},
): { text: string; conflicts: number } {
	let edited = text;
	// Plain edits one at a time, so new fields sharing a new parent share it.
	for (const edit of edits.filter((e) => !e.conflict)) {
		const region = fieldRegion(edited, edit.path, options);
		if (!region || (edit.value === undefined && region.start === region.end))
			continue;
		edited = splice(edited, region, region.write(edit.value));
	}
	const conflicts = edits.filter((e) => e.conflict);
	if (options.createParents) {
		for (const edit of conflicts) {
			const parent = edit.path.split(".").slice(0, -1).join(".");
			const region = parent && fieldRegion(edited, parent, options);
			if (region && region.start === region.end)
				edited = splice(edited, region, region.write(null));
		}
	}
	// Markers break the YAML, so every conflict is placed in one parse.
	const replacements = conflicts.flatMap((edit) => {
		const region = fieldRegion(edited, edit.path, options);
		if (!region) return [];
		const current = edited.slice(region.start, region.end);
		const lines = edit.value === undefined ? "" : region.write(edit.value);
		return [
			{
				...region,
				text: `${CONFLICT_START}\n${current}${CONFLICT_SEPARATOR}\n${lines}${CONFLICT_END}\n`,
			},
		];
	});
	for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
		edited = splice(edited, replacement, replacement.text);
	}
	return { text: edited, conflicts: replacements.length };
}

function splice(
	text: string,
	{ start, end }: { start: number; end: number },
	replacement: string,
): string {
	return text.slice(0, start) + replacement + text.slice(end);
}

type Region = {
	start: number;
	end: number;
	/** The field's line(s) with this value; null writes the key alone, as a parent. */
	write: (value: string | null | undefined) => string;
};

/** Where a field's line is (or would go), and how to write it. */
function fieldRegion(
	text: string,
	path: string,
	options: EditOptions,
): Region | undefined {
	const document = parseDocument(text);
	const segments = path.split(".");
	const lineStart = (at: number) => text.lastIndexOf("\n", at - 1) + 1;
	const lineEnd = (at: number) => text.indexOf("\n", at) + 1;
	const quoted = options.quoted?.(path) ?? false;
	let parent: YAMLMap | undefined = isMap(document.contents)
		? document.contents
		: undefined;
	for (const [index, segment] of segments.slice(0, -1).entries()) {
		const pair = parent && findPair(parent, segment);
		if (pair && isMap(pair.value)) {
			parent = pair.value;
			continue;
		}
		if (!options.createParents) return undefined;
		const missing = segments.slice(index + 1);
		if (pair && pair.value === null && isScalar(pair.key)) {
			// `key:` with nothing under it yet.
			const keyStart = (pair.key.range as number[])[0] as number;
			const at = lineEnd(keyStart);
			const indent = `${text.slice(lineStart(keyStart), keyStart)}  `;
			return insertion(at, indent, missing, quoted);
		}
		if (pair) return undefined;
		if (!parent) return rootInsertion(text, document, segments, quoted);
		const at = afterLast(text, parent, lineEnd);
		const indent = indentOf(text, parent, lineStart);
		return insertion(at, indent, segments.slice(index), quoted);
	}
	if (!parent) {
		return options.createParents
			? rootInsertion(text, document, segments, quoted)
			: undefined;
	}
	const key = segments.at(-1) as string;
	const pair = findPair(parent, key);
	if (pair && isScalar(pair.value) && isScalar(pair.key)) {
		const value = pair.value;
		const [valueStart, valueEnd] = value.range as [number, number, number];
		const start = lineStart((pair.key.range as number[])[0] as number);
		const end = lineEnd(valueEnd);
		return {
			start,
			end,
			write: (written) =>
				written
					? text.slice(start, valueStart) +
						yamlScalar(written, quoted, value.type) +
						text.slice(valueEnd, end)
					: "",
		};
	}
	if (pair || parent.items.length === 0) return undefined;
	const at = afterLast(text, parent, lineEnd);
	return insertion(at, indentOf(text, parent, lineStart), [key], quoted);
}

function findPair(map: YAMLMap, key: string): Pair | undefined {
	return map.items.find(
		(item) => isScalar(item.key) && String(item.key.value) === key,
	) as Pair | undefined;
}

/** Just after a map's last line. */
function afterLast(
	text: string,
	map: YAMLMap,
	lineEnd: (at: number) => number,
): number {
	const end = (map.range as number[])[1] as number;
	return lineEnd(Math.max(end - 1, 0)) || text.length;
}

function indentOf(
	text: string,
	map: YAMLMap,
	lineStart: (at: number) => number,
): string {
	const first = map.items[0]?.key;
	if (!isScalar(first)) return "";
	const keyStart = (first.range as number[])[0] as number;
	return text.slice(lineStart(keyStart), keyStart);
}

/** In a file without a mapping yet: at the end. */
function rootInsertion(
	text: string,
	document: Document,
	segments: string[],
	quoted: boolean,
): Region | undefined {
	if (document.contents !== null) return undefined;
	return insertion(text.length, "", segments, quoted);
}

/** New lines at `at`: the missing parents, then the field. */
function insertion(
	at: number,
	indent: string,
	segments: string[],
	quoted: boolean,
): Region {
	return {
		start: at,
		end: at,
		write: (value) => {
			if (value === undefined) return "";
			return segments
				.map((segment, depth) => {
					const last = depth === segments.length - 1;
					const written =
						last && value !== null ? ` ${yamlScalar(value, quoted)}` : "";
					return `${indent}${"  ".repeat(depth)}${segment}:${written}\n`;
				})
				.join("");
		},
	};
}

/** A value as YAML, quoted as the value it replaces was, or as it needs. */
function yamlScalar(
	value: string,
	quoted: boolean,
	type?: Scalar.Type,
): string {
	if (type === Scalar.QUOTE_SINGLE) return `'${value.replaceAll("'", "''")}'`;
	if (type === Scalar.QUOTE_DOUBLE) return JSON.stringify(value);
	const plain = /^-?[A-Za-z0-9][\w .-]*$/.test(value) && !/\s$/.test(value);
	return plain && !quoted ? value : JSON.stringify(value);
}
