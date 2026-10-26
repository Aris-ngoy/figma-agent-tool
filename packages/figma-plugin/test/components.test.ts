import { describe, expect, test } from "bun:test";
import {
	assignKeys,
	type Baseline,
	baselineAfterPush,
	checkScreen,
	type DesignProject,
	figmaComponents,
	hasUnpulledChanges,
	loadProject,
	type ScreenFile,
	screenPush,
	writeLinkedComponentRecord,
} from "@figma-agent-tool/design-project";
import {
	componentFiles,
	writeFixtureProject,
} from "@figma-agent-tool/design-project/fixtures";
import type {
	CommandName,
	LinkedComponentInfo,
	SyncedNode,
} from "@figma-agent-tool/protocol";
import { document, handshake } from "@figma-agent-tool/protocol/fixtures";
import { createCommandHandler } from "../src/handler";
import { installMockFigma } from "./mock-figma";

async function send<T = unknown>(
	command: CommandName,
	params: unknown,
): Promise<T> {
	const response = await createCommandHandler({
		pluginVersion: handshake.pluginVersion,
	}).handle({ type: "request", id: "req-1", command, params });
	return (response.ok ? response.result : { error: response.error }) as T;
}

type PushResult = {
	page: { id: string; name: string };
	screens: { screen: string; frame: SyncedNode }[];
	components: { component: string; node: SyncedNode }[];
	linked: LinkedComponentInfo[];
};

/** The fixture's Components and start Screen, its avatar Linked to the file's Chip set. */
async function componentProject(overrides: Record<string, string | null> = {}) {
	return loadProject(
		await writeFixtureProject({
			"screens/login.html": null,
			...componentFiles,
			"components/app-avatar.json": `{ "key": "ch1p" }\n`,
			"screens/start.html": (
				componentFiles["screens/start.html"] as string
			).replace('size="large"', 'size="Large"'),
			...overrides,
		}),
	);
}

const keyed = (file: ScreenFile) => ({
	...file,
	source: assignKeys(file.source).source,
});

/** Pushes every Component and the start Screen, as Push does; again with the Baselines of `previous`. */
type Pushed = {
	result: PushResult;
	project: DesignProject;
	screen: ScreenFile;
	frame: SyncedNode;
	baseline: Baseline;
	componentBaselines: Map<string, Baseline>;
};

async function push(
	project: DesignProject,
	previous?: Pushed,
	expectError = false,
): Promise<Pushed> {
	const components = await Promise.all(
		project.components.map(async (original) => {
			const component = keyed(original);
			const { root } = checkScreen(project, component);
			if (!root) throw new Error(`${component.file} doesn't check`);
			const baseline = previous?.componentBaselines.get(component.name);
			const { tree, remove } = await screenPush(
				project,
				component,
				root,
				baseline,
			);
			return { component, tree, remove, nodeId: baseline?.frameId };
		}),
	);
	const screen = keyed(project.screens[0] as ScreenFile);
	const { root } = checkScreen(project, screen);
	if (!root) throw new Error("start doesn't check");
	const { tree, remove } = await screenPush(
		project,
		screen,
		root,
		previous?.baseline,
	);
	const result = await send<
		PushResult & { error?: { code: string; message: string } }
	>("push_screens", {
		page: { name: "Screens" },
		screens: [
			{ screen: "start", frameId: previous?.baseline.frameId, tree, remove },
		],
		components: components.map(({ component, tree, remove, nodeId }) => ({
			component: component.name,
			nodeId,
			tree,
			remove,
		})),
		linked: project.linkedComponents.map(({ name, key, id }) => ({
			component: name,
			key,
			id,
		})),
	});
	if (result.error) {
		if (!expectError)
			throw new Error(`${result.error.code}: ${result.error.message}`);
		return { ...result, error: result.error } as never;
	}
	const componentBaselines = new Map<string, Baseline>(
		components.map(({ component }, index) => [
			component.name,
			baselineAfterPush(
				project,
				component.source,
				result.components[index]?.node as SyncedNode,
				{},
			),
		]),
	);
	for (const { component, ...record } of result.linked)
		await writeLinkedComponentRecord(project, component, record);
	const withRecords = await loadProject(project.dir);
	const frame = result.screens[0]?.frame as SyncedNode;
	return {
		result,
		project: withRecords,
		screen,
		frame,
		baseline: baselineAfterPush(withRecords, screen.source, frame, {}),
		componentBaselines,
	};
}

async function read(pushed: Pushed) {
	return send<{
		screens: { frame: SyncedNode }[];
		components: { component: string; node: SyncedNode | null }[];
	}>("read_screens", {
		screens: [{ screen: "start", frameId: pushed.baseline.frameId }],
		components: [...pushed.componentBaselines].map(([component, baseline]) => ({
			component,
			nodeId: baseline.frameId,
		})),
	});
}

type Mock = ReturnType<typeof installMockFigma>;

const node = async (figma: Mock, id: string) =>
	(await figma.getNodeByIdAsync(id)) as unknown as Record<string, unknown> & {
		parent: { id: string; type: string };
		children: { id: string; name: string }[];
		getSharedPluginData(namespace: string, key: string): string;
		componentPropertyDefinitions: Record<string, unknown>;
		componentPropertyReferences: Record<string, string> | null;
		getMainComponentAsync(): Promise<{ id: string; name: string }>;
	};

describe("push_screens with Components", () => {
	test("makes a Defined Component's component set on the Screens Page, with its variants and text property", async () => {
		const figma = installMockFigma(document);
		const { result } = await push(await componentProject());
		const [button] = result.components;
		expect(button?.component).toBe("app-button");
		expect(button?.node).toMatchObject({
			type: "COMPONENT_SET",
			key: "component-set",
			name: "app-button",
			layout: { mode: "HORIZONTAL", itemSpacing: 40 },
			sizing: { horizontal: "HUG", vertical: "HUG" },
			children: [
				{
					type: "COMPONENT",
					key: "e1",
					name: "kind=primary",
					layout: { mode: "HORIZONTAL", primaryAxisAlignItems: "CENTER" },
					fills: [{ type: "SOLID", color: "#3366ff" }],
					children: [{ type: "TEXT", property: "label" }],
				},
				{ type: "COMPONENT", key: "e3", name: "kind=secondary" },
			],
		});
		const set = await node(figma, button?.node.id as string);
		expect(set.parent.id).toBe(result.page.id);
		expect(set.getSharedPluginData("figmaagent", "component")).toBe(
			"app-button",
		);
		const definitions = set.componentPropertyDefinitions;
		expect(Object.values(definitions)).toEqual([
			{
				type: "VARIANT",
				defaultValue: "primary",
				variantOptions: ["primary", "secondary"],
			},
			{ type: "TEXT", defaultValue: "Sign in" },
		]);
		const label = await node(
			figma,
			button?.node.children?.[1]?.children?.[0]?.id as string,
		);
		expect(label.componentPropertyReferences?.characters).toBe(
			Object.keys(definitions)[1] as string,
		);
		expect(figma.undoCommits).toBe(1);
	});

	test("makes a Component without variants a lone component", async () => {
		installMockFigma(document);
		const { result } = await push(
			await componentProject({
				"components/app-chip.html":
					'<component style="display:flex; padding:4px">\n  <p data-property="text">Chip</p>\n</component>\n',
			}),
		);
		expect(result.components.map(({ component }) => component)).toEqual([
			"app-button",
			"app-chip",
		]);
		expect(result.components[1]?.node).toMatchObject({
			type: "COMPONENT",
			name: "app-chip",
			children: [{ type: "TEXT", property: "text" }],
		});
	});

	test("Screens get instances of their Components' variants with their properties; Linked ones are found by key", async () => {
		const figma = installMockFigma(document);
		const { result, frame } = await push(await componentProject());
		const set = result.components[0]?.node as SyncedNode;
		const [, primary, secondary, avatar] = frame.children ?? [];
		expect(primary).toMatchObject({
			type: "INSTANCE",
			key: "e3",
			name: "app-button",
			sizing: { horizontal: "FILL", vertical: "HUG" },
			instance: {
				mainId: set.children?.[0]?.id,
				setId: set.id,
				properties: { kind: "primary", label: "Get started" },
			},
		});
		expect(primary?.children).toBeUndefined();
		expect(secondary?.instance).toMatchObject({
			mainId: set.children?.[1]?.id,
			properties: { kind: "secondary", label: "Sign in" },
		});
		expect(avatar).toMatchObject({
			type: "INSTANCE",
			width: 40,
			instance: { mainId: "3:3", setId: "3:1", setKey: "ch1p" },
		});
		expect(result.linked).toEqual([
			{
				component: "app-avatar",
				componentId: "3:1",
				key: "ch1p",
				properties: {
					size: {
						type: "VARIANT",
						default: "Small",
						options: ["Small", "Large"],
					},
				},
				variants: ["size=Small", "size=Large"],
			},
		]);
		const main = await (
			await node(figma, avatar?.id as string)
		).getMainComponentAsync();
		expect(main.name).toBe("Size=Large");
	});

	test("finds a Linked Component in the file by node ID", async () => {
		installMockFigma(document);
		const { frame, result } = await push(
			await componentProject({
				"components/app-avatar.json": `{ "id": "2:1" }\n`,
				"screens/start.html": `<body style="display:flex">\n  <app-avatar label="Go" disabled="true"></app-avatar>\n</body>\n`,
			}),
		);
		expect(result.linked[0]?.properties).toEqual({
			label: { type: "TEXT", default: "Button" },
			disabled: { type: "BOOLEAN", default: "false" },
		});
		expect(frame.children?.[0]?.instance).toMatchObject({
			mainId: "2:1",
			mainKey: "c0ffee",
			properties: { label: "Go", disabled: "true" },
		});
	});

	test("refuses a Linked Component that isn't in the file or its libraries, changing nothing", async () => {
		const figma = installMockFigma(document);
		const result = (await push(
			await componentProject({
				"components/app-avatar.json": `{ "key": "gone" }\n`,
			}),
			undefined,
			true,
		)) as unknown as { error: { code: string; message: string } };
		expect(result.error).toEqual({
			code: "component_not_found",
			message: expect.stringContaining(
				'Linked Component app-avatar: no component with key "gone"',
			),
		});
		expect(figma.undoCommits).toBe(0);
	});

	test("refuses a property a Linked Component doesn't have", async () => {
		installMockFigma(document);
		const result = (await push(
			await componentProject({
				"screens/start.html": `<body style="display:flex">\n  <app-avatar shape="round"></app-avatar>\n</body>\n`,
			}),
			undefined,
			true,
		)) as unknown as { error: { code: string; message: string } };
		expect(result.error).toEqual({
			code: "invalid_property",
			message: expect.stringContaining(
				"sets shape on app-avatar, which has no such property (it has size)",
			),
		});
	});

	test("reads back as exactly the Screen and Components pushed", async () => {
		installMockFigma(document);
		const pushed = await push(await componentProject());
		const { screens, components } = await read(pushed);
		const figma = figmaComponents(pushed.project, pushed.componentBaselines);
		expect(
			hasUnpulledChanges(
				pushed.project,
				pushed.screen,
				pushed.baseline,
				screens[0]?.frame as SyncedNode,
				{},
				figma,
			),
		).toBe(false);
		const button = pushed.project.components[0] as ScreenFile;
		expect(
			hasUnpulledChanges(
				pushed.project,
				button,
				pushed.componentBaselines.get("app-button") as Baseline,
				components[0]?.node as SyncedNode,
			),
		).toBe(false);
	});

	test("pushing again keeps every node ID; a changed variant swaps the instance in place", async () => {
		const figma = installMockFigma(document);
		const project = await componentProject();
		const first = await push(project);
		const ids = (node: SyncedNode): string[] => [
			node.id,
			...(node.children ?? []).flatMap(ids),
		];
		const before = [
			ids(first.frame),
			ids(first.result.components[0]?.node as SyncedNode),
		];
		await Bun.write(
			first.screen.path,
			first.screen.source.replace(
				'kind="secondary"',
				'kind="primary" label="Hi"',
			),
		);
		const second = await push(await loadProject(project.dir), first);
		expect([
			ids(second.frame),
			ids(second.result.components[0]?.node as SyncedNode),
		]).toEqual(before);
		const secondary = second.frame.children?.[2] as SyncedNode;
		expect(secondary.instance).toMatchObject({
			mainId: first.result.components[0]?.node.children?.[0]?.id,
			properties: { kind: "primary", label: "Hi" },
		});
		expect(figma.undoCommits).toBe(2);
	});
});

describe("read_components", () => {
	test("reads the component set (or lone component) of each node asked for, as Adopt links it", async () => {
		installMockFigma(document);
		const result = await send("read_components", {
			ids: ["3:3", "2:1", "1:2", "9:99"],
		});
		expect(result).toEqual({
			components: [
				{
					id: "3:3",
					name: "Chip",
					remote: false,
					componentId: "3:1",
					key: "ch1p",
					properties: {
						size: {
							type: "VARIANT",
							default: "Small",
							options: ["Small", "Large"],
						},
					},
					variants: ["size=Small", "size=Large"],
				},
				{
					id: "2:1",
					name: "Button",
					remote: false,
					componentId: "2:1",
					key: "c0ffee",
					properties: {
						label: { type: "TEXT", default: "Button" },
						disabled: { type: "BOOLEAN", default: "false" },
					},
				},
			],
		});
	});
});
