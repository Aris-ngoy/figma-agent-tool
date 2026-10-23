// get_design_system: the file's local components, styles and variables, so
// agents build with them instead of raw values.
import type {
	CommandResult,
	DesignComponent,
	DesignSystem,
	VariableInfo,
	VariableValue,
} from "@figma-agent-tool/protocol";
import { componentInfo, effect, hex, paint, round } from "./serialize";

export async function getDesignSystem(): Promise<
	CommandResult<"get_design_system">
> {
	return {
		components: await components(),
		styles: await styles(),
		collections: await collections(),
	};
}

async function components(): Promise<DesignComponent[]> {
	// Components can live on any page, and pages load on demand.
	await figma.loadAllPagesAsync();
	const found: DesignComponent[] = [];
	for (const page of figma.root.children) {
		const nodes = page.findAllWithCriteria({
			types: ["COMPONENT_SET", "COMPONENT"],
		});
		for (const node of nodes) {
			// Variants are listed under their component set.
			if (node.parent?.type === "COMPONENT_SET") continue;
			const { variantProperties: _, ...info } = componentInfo(node);
			const component: DesignComponent = {
				id: node.id,
				name: node.name,
				type: node.type,
				...info,
				page: { id: page.id, name: page.name },
			};
			if (node.type === "COMPONENT_SET") {
				component.variants = node.children.map((variant) => ({
					id: variant.id,
					name: variant.name,
					properties: { ...(variant as ComponentNode).variantProperties },
				}));
			}
			found.push(component);
		}
	}
	return found;
}

async function styles(): Promise<DesignSystem["styles"]> {
	const base = ({ id, name, description }: BaseStyle) =>
		description ? { id, name, description } : { id, name };
	const [paints, texts, effects] = await Promise.all([
		figma.getLocalPaintStylesAsync(),
		figma.getLocalTextStylesAsync(),
		figma.getLocalEffectStylesAsync(),
	]);
	return {
		paint: paints.map((style) => ({
			...base(style),
			paints: style.paints.map(paint),
		})),
		text: texts.map((style) => {
			const info: DesignSystem["styles"]["text"][number] = {
				...base(style),
				fontName: { ...style.fontName },
				fontSize: round(style.fontSize),
			};
			const { lineHeight, letterSpacing } = style;
			if (lineHeight.unit !== "AUTO") {
				info.lineHeight = {
					value: round(lineHeight.value),
					unit: lineHeight.unit,
				};
			}
			if (letterSpacing.value !== 0) {
				info.letterSpacing = {
					value: round(letterSpacing.value),
					unit: letterSpacing.unit,
				};
			}
			return info;
		}),
		effect: effects.map((style) => ({
			...base(style),
			effects: style.effects.map(effect),
		})),
	};
}

async function collections(): Promise<DesignSystem["collections"]> {
	const [all, variables] = await Promise.all([
		figma.variables.getLocalVariableCollectionsAsync(),
		figma.variables.getLocalVariablesAsync(),
	]);
	const byId = new Map(variables.map((variable) => [variable.id, variable]));
	return all.map((collection) => {
		const modeName = new Map(
			collection.modes.map(({ modeId, name }) => [modeId, name]),
		);
		return {
			id: collection.id,
			name: collection.name,
			modes: collection.modes.map(({ modeId, name }) => ({ id: modeId, name })),
			defaultMode: modeName.get(collection.defaultModeId) ?? "",
			variables: collection.variableIds.flatMap((id) => {
				const variable = byId.get(id);
				return variable ? [variableInfo(variable, modeName)] : [];
			}),
		};
	});
}

function variableInfo(
	variable: Variable,
	modeName: Map<string, string>,
): VariableInfo {
	const info: VariableInfo = {
		id: variable.id,
		name: variable.name,
		type: variable.resolvedType,
		valuesByMode: Object.fromEntries(
			Object.entries(variable.valuesByMode).map(([modeId, value]) => [
				modeName.get(modeId) ?? modeId,
				variableValue(value),
			]),
		),
	};
	if (variable.description) info.description = variable.description;
	if (!variable.scopes.includes("ALL_SCOPES")) {
		info.scopes = [...variable.scopes];
	}
	return info;
}

function variableValue(value: unknown): VariableValue | null {
	if (typeof value !== "object" || value === null) {
		return value as VariableValue;
	}
	if ("type" in value && value.type === "VARIABLE_ALIAS" && "id" in value) {
		return { alias: value.id as string };
	}
	if ("r" in value && "g" in value && "b" in value) {
		const color = value as RGBA;
		const a = color.a ?? 1;
		return a === 1
			? { color: hex(color) }
			: { color: hex(color), opacity: round(a) };
	}
	// Easing curves and composed colors have no compact form yet.
	return null;
}
