// Push and Pull of the Design System: variables in one collection, with a
// variable mode per Mode, and text styles, updated in place by ID. Like push_screens, which
// carries it, the async lookups come first and the edits happen in one
// synchronous pass; tokens are addressed by their DESIGN.md path so the
// Screens' bindings can refer to variables this push creates.
import type {
	CommandParams,
	CommandResult,
	DesignSystemPush,
	PushedDesignSystem,
	VariableValue,
} from "@figma-agent-tool/protocol";
import { CommandError } from "./errors";
import { hex, round } from "./serialize";

/** What a push needs from the file before it edits anything. */
export type LoadedDesignSystem = {
	spec: DesignSystemPush;
	collection?: VariableCollection;
	variables: Map<string, Variable>;
	/** The collections of the variables found, for their default modes. */
	collections: Map<string, VariableCollection>;
	textStyles: Map<string, TextStyle>;
	/** Fonts the text styles have now and will have. */
	fonts: FontName[];
};

export async function loadDesignSystem(
	spec: DesignSystemPush,
): Promise<LoadedDesignSystem> {
	const variableIds = [
		...spec.variables.flatMap(({ id }) => (id ? [id] : [])),
		...spec.remove.variables,
	];
	const styleIds = [
		...spec.textStyles.flatMap(({ id }) => (id ? [id] : [])),
		...spec.remove.textStyles,
	];
	const [collection, variables, textStyles] = await Promise.all([
		spec.collection.id
			? figma.variables.getVariableCollectionByIdAsync(spec.collection.id)
			: null,
		Promise.all(
			variableIds.map((id) => figma.variables.getVariableByIdAsync(id)),
		),
		Promise.all(styleIds.map((id) => figma.getStyleByIdAsync(id))),
	]);
	const found = new Map(
		variables.flatMap((variable) =>
			variable ? [[variable.id, variable] as const] : [],
		),
	);
	const collectionIds = new Set(
		[...found.values()].map((variable) => variable.variableCollectionId),
	);
	const collections = new Map(
		(
			await Promise.all(
				[...collectionIds].map((id) =>
					figma.variables.getVariableCollectionByIdAsync(id),
				),
			)
		).flatMap((c) => (c ? [[c.id, c] as const] : [])),
	);
	const styles = new Map(
		textStyles.flatMap((style) =>
			style?.type === "TEXT" ? [[style.id, style] as const] : [],
		),
	);
	return {
		spec,
		collection: collection ?? undefined,
		variables: found,
		collections,
		textStyles: styles,
		fonts: [
			...spec.textStyles.map((style) => style.fontName),
			...[...styles.values()].map((style) => style.fontName),
		],
	};
}

/** Variables and text styles by token path, for the Screens' bindings. */
export type AppliedDesignSystem = {
	result: PushedDesignSystem;
	variables: Map<string, Variable>;
	textStyles: Map<string, TextStyle>;
};

/** Synchronous: creates or updates every variable and text style, and removes dropped ones. */
export function applyDesignSystem(
	loaded: LoadedDesignSystem,
): AppliedDesignSystem {
	const { spec } = loaded;
	for (const id of spec.remove.variables) loaded.variables.get(id)?.remove();
	for (const id of spec.remove.textStyles) loaded.textStyles.get(id)?.remove();
	const variables = new Map<string, Variable>();
	let collection = loaded.collection;
	let modes: Record<string, string> | undefined;
	if (spec.collection.modes) {
		collection ??= figma.variables.createVariableCollection(
			spec.collection.name,
		);
		modes = applyModes(collection, spec.collection.modes, spec.remove.modes);
	}
	for (const entry of spec.variables) {
		const existing = entry.id ? loaded.variables.get(entry.id) : undefined;
		let variable: Variable;
		if (existing && existing.resolvedType === entry.type) {
			variable = existing;
			variable.name = entry.name;
		} else {
			collection ??= figma.variables.createVariableCollection(
				spec.collection.name,
			);
			variable = figma.variables.createVariable(
				entry.name,
				collection,
				entry.type,
			);
		}
		variables.set(entry.token, variable);
	}
	for (const entry of spec.variables) {
		const variable = variables.get(entry.token) as Variable;
		const own =
			collection?.id === variable.variableCollectionId
				? collection
				: loaded.collections.get(variable.variableCollectionId);
		if (!own) continue;
		variable.setValueForMode(
			own.defaultModeId,
			variableValue(entry.value, variables),
		);
		if (own !== collection || !modes) continue;
		for (const [mode, value] of Object.entries(entry.modes ?? {})) {
			const modeId = modes[mode];
			if (modeId)
				variable.setValueForMode(modeId, variableValue(value, variables));
		}
	}
	const textStyles = new Map<string, TextStyle>();
	for (const { token, id, name, ...entry } of spec.textStyles) {
		const style = (id && loaded.textStyles.get(id)) || figma.createTextStyle();
		style.name = name;
		style.fontName = entry.fontName;
		style.fontSize = entry.fontSize;
		style.lineHeight = entry.lineHeight ?? { unit: "AUTO" };
		style.letterSpacing = entry.letterSpacing ?? { value: 0, unit: "PERCENT" };
		textStyles.set(token, style);
	}
	const ids = <T extends { id: string }>(map: Map<string, T>) =>
		Object.fromEntries([...map].map(([token, item]) => [token, item.id]));
	return {
		result: {
			collectionId: collection?.id ?? spec.collection.id ?? "",
			variables: ids(variables),
			textStyles: ids(textStyles),
			...(modes && { modes }),
		},
		variables,
		textStyles,
	};
}

/**
 * Gives the collection the Modes as variable modes: the default mode
 * renamed, the others found by ID, else by name, else added (Figma copies
 * the default's values into a new mode). Dropped ones go first, so they
 * don't count against the plan's limit on modes. Returns name → mode ID.
 */
function applyModes(
	collection: VariableCollection,
	[defaultMode, ...others]: NonNullable<
		DesignSystemPush["collection"]["modes"]
	>,
	remove: string[] = [],
): Record<string, string> {
	for (const id of remove) {
		const exists = collection.modes.some((mode) => mode.modeId === id);
		if (exists && id !== collection.defaultModeId) collection.removeMode(id);
	}
	const rename = (modeId: string, name: string) => {
		const mode = collection.modes.find((m) => m.modeId === modeId);
		if (mode && mode.name !== name) collection.renameMode(modeId, name);
	};
	const name = defaultMode?.name as string;
	rename(collection.defaultModeId, name);
	const ids: Record<string, string> = { [name]: collection.defaultModeId };
	const taken = new Set([collection.defaultModeId]);
	for (const mode of others) {
		const candidates = collection.modes.filter((m) => !taken.has(m.modeId));
		const found =
			candidates.find((m) => m.modeId === mode.id) ??
			candidates.find((m) => m.name === mode.name);
		const modeId = found?.modeId ?? addMode(collection, mode.name);
		rename(modeId, mode.name);
		taken.add(modeId);
		ids[mode.name] = modeId;
	}
	return ids;
}

function addMode(collection: VariableCollection, name: string): string {
	try {
		return collection.addMode(name);
	} catch (error) {
		throw new CommandError(
			"mode_limit",
			`Figma refused to add the variable mode “${name}” to “${collection.name}”: ${(error as Error).message}. Figma's plan limits how many modes a collection can have. Nothing but the collection's modes changed; remove Modes from the Modes file, or push to a file on a plan with more modes.`,
		);
	}
}

function variableValue(
	value: DesignSystemPush["variables"][number]["value"],
	variables: Map<string, Variable>,
): VariableValueType {
	if (typeof value === "number") return value;
	if ("token" in value) {
		return figma.variables.createVariableAlias(
			variables.get(value.token) as Variable,
		);
	}
	const channel = (offset: number) =>
		Number.parseInt(value.color.slice(offset, offset + 2), 16) / 255;
	return {
		r: channel(1),
		g: channel(3),
		b: channel(5),
		a: value.opacity ?? 1,
	};
}

type VariableValueType = Variable["valuesByMode"][string];

export async function readDesignSystem({
	variables: variableIds,
	textStyles: styleIds,
}: CommandParams<"read_design_system">): Promise<
	CommandResult<"read_design_system">
> {
	const collections = new Map<string, VariableCollection | null>();
	const collectionOf = async (variable: Variable) => {
		const id = variable.variableCollectionId;
		if (!collections.has(id)) {
			collections.set(
				id,
				await figma.variables.getVariableCollectionByIdAsync(id),
			);
		}
		return collections.get(id);
	};
	/** A variable's value in a mode of its collection; the default mode if it has no such mode. */
	const valueIn = async (variable: Variable, modeId?: string) => {
		const collection = await collectionOf(variable);
		if (!collection) return undefined;
		const own = modeId && collection.modes.some((m) => m.modeId === modeId);
		return variable.valuesByMode[own ? modeId : collection.defaultModeId];
	};
	/** Follows aliases to a value: in the same mode within a collection, the default across. */
	const resolved = async (
		value: unknown,
		modeId?: string,
		depth = 0,
	): Promise<VariableValue | null> => {
		if (isAlias(value)) {
			const target = await figma.variables.getVariableByIdAsync(value.id);
			return target && depth < 10
				? resolved(await valueIn(target, modeId), modeId, depth + 1)
				: null;
		}
		return compact(value);
	};
	const read = async (value: unknown, modeId?: string) => ({
		value: isAlias(value) ? { alias: value.id } : compact(value),
		resolved: await resolved(value, modeId),
	});
	const variables = (
		await Promise.all(
			variableIds.map(async (id) => {
				const variable = await figma.variables.getVariableByIdAsync(id);
				if (!variable) return [];
				const collection = await collectionOf(variable);
				const otherModes = (collection?.modes ?? []).filter(
					(mode) => mode.modeId !== collection?.defaultModeId,
				);
				const modes = await Promise.all(
					otherModes.map(
						async ({ modeId }) =>
							[
								modeId,
								await read(variable.valuesByMode[modeId], modeId),
							] as const,
					),
				);
				return [
					{
						id: variable.id,
						name: variable.name,
						type: variable.resolvedType,
						...(await read(await valueIn(variable))),
						...(modes.length > 0 && { modes: Object.fromEntries(modes) }),
					},
				];
			}),
		)
	).flat();
	const styles = await Promise.all(
		styleIds.map((id) => figma.getStyleByIdAsync(id)),
	);
	return {
		variables,
		textStyles: styles.flatMap((style) => {
			if (style?.type !== "TEXT") return [];
			const text = style as TextStyle;
			const info: CommandResult<"read_design_system">["textStyles"][number] = {
				id: text.id,
				name: text.name,
				fontName: { ...text.fontName },
				fontSize: round(text.fontSize),
			};
			if (text.lineHeight.unit !== "AUTO") {
				info.lineHeight = {
					value: round(text.lineHeight.value),
					unit: text.lineHeight.unit,
				};
			}
			if (text.letterSpacing.value !== 0) {
				info.letterSpacing = {
					value: round(text.letterSpacing.value),
					unit: text.letterSpacing.unit,
				};
			}
			return [info];
		}),
	};
}

function isAlias(value: unknown): value is VariableAlias {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "VARIABLE_ALIAS"
	);
}

function compact(value: unknown): VariableValue | null {
	if (typeof value === "number") return round(value);
	if (typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "object" && value !== null && "r" in value) {
		const color = value as RGBA;
		const a = color.a ?? 1;
		return a === 1
			? { color: hex(color) }
			: { color: hex(color), opacity: round(a) };
	}
	return null;
}
