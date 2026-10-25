// The fake plugin's Push and Pull commands: frames live in serialized form,
// applied in place with the same rules as the real plugin (shared with the
// design-project tests), so tests can edit them as a designer would.
import {
	applyPrototypeLinks,
	applyScreenTree,
	createFakeDesignSystem,
} from "@figma-agent-tool/design-project/fixtures";
import type {
	BridgeError,
	CommandParams,
	CommandResult,
	SyncedNode,
} from "@figma-agent-tool/protocol";
import type { DocumentFixture } from "@figma-agent-tool/protocol/fixtures";

export function createFakeScreens(doc: DocumentFixture, nextId: () => string) {
	/** Pushed frames by ID, with their Screen and page. */
	const frames = new Map<
		string,
		{ screen: string; pageId: string; frame: SyncedNode }
	>();
	/** Copies of Directions on the Explorations Page, by frame ID: no Screen links them. */
	const explorations = new Map<
		string,
		{ of: string; pageId: string; frame: SyncedNode }
	>();
	const images = new Map<string, string>();
	const designSystem = createFakeDesignSystem(nextId);
	let linkId: string | null = null;

	function frameOf(screen: string, frameId: string) {
		return (
			frames.get(frameId) ??
			[...frames.values()].find((entry) => entry.screen === screen)
		);
	}

	function pageNamed(page: { id?: string; name: string }) {
		let target =
			doc.pages.find((p) => p.id === page.id) ??
			doc.pages.find((p) => p.name === page.name);
		if (!target) {
			target = { id: nextId(), name: page.name, children: [], flows: [] };
			doc.pages.push(target);
		}
		return target;
	}

	function addImages(bytes: Record<string, string>): Record<string, string> {
		const hashes: Record<string, string> = {};
		for (const [name, data] of Object.entries(bytes)) {
			const hash = `image-${images.size + 1}`;
			images.set(hash, data);
			hashes[name] = hash;
		}
		return hashes;
	}

	return {
		frames,
		explorations,
		/** The variables and text styles Push made, which tests edit as a designer would. */
		designSystem,
		get linkId() {
			return linkId;
		},
		/** A Screen's frame, as Figma has it now. */
		frame(screen: string): SyncedNode {
			const entry = [...frames.values()].find((e) => e.screen === screen);
			if (!entry) throw new Error(`No frame for ${screen}`);
			return entry.frame;
		},

		push_screens({
			page,
			screens,
			images: bytes,
			designSystem: tokens,
			frames: linkedFrames,
			screenFrames,
		}: CommandParams<"push_screens">): CommandResult<"push_screens"> {
			const target = pageNamed(page);
			const hashes = addImages(bytes);
			const pageId = target.id;
			const pushed = tokens && designSystem.push(tokens);
			const applied = screens.map(({ screen, frameId, tree, remove }) => {
				const previous = frameId ? frames.get(frameId) : undefined;
				const frame = applyScreenTree(tree, previous?.frame, {
					nextId,
					imageHash: (name) => hashes[name] as string,
					designSystem,
					remove,
				});
				if (previous) frames.delete(previous.frame.id);
				frames.set(frame.id, { screen, pageId, frame });
				return { screen, tree, frame };
			});
			// Links once every frame of the push is in place, as the Plugin does.
			const pushedFrames = new Map(
				applied.map(({ screen, frame }) => [screen, frame.id]),
			);
			for (const { tree, frame } of applied) {
				applyPrototypeLinks(frame, tree, {
					frameOf: (screen) => pushedFrames.get(screen) ?? linkedFrames[screen],
					screenFrames: [...screenFrames, ...pushedFrames.values()],
				});
			}
			return {
				page: { id: target.id, name: target.name },
				images: hashes,
				...(pushed && { designSystem: pushed }),
				screens: applied.map(({ screen, frame }) => ({
					screen,
					frame: structuredClone(frame),
				})),
			};
		},

		push_explorations({
			page,
			screens,
			images: bytes,
		}: CommandParams<"push_explorations">): CommandResult<"push_explorations"> {
			const target = pageNamed(page);
			const hashes = addImages(bytes);
			return {
				page: { id: target.id, name: target.name },
				screens: screens.map(({ screen, directions }) => {
					for (const [id, copy] of explorations) {
						if (copy.of === screen) explorations.delete(id);
					}
					// Figma-owned Elements' layers are copied from the Screen's frame.
					const original = [...frames.values()].find(
						(e) => e.screen === screen,
					);
					return {
						screen,
						frames: directions.map(({ direction, tree }) => {
							const frame = applyScreenTree(tree, original?.frame, {
								nextId,
								imageHash: (name) => hashes[name] as string,
							});
							explorations.set(frame.id, {
								of: screen,
								pageId: target.id,
								frame,
							});
							return { direction, frameId: frame.id };
						}),
					};
				}),
			};
		},

		read_screens({
			screens,
		}: CommandParams<"read_screens">): CommandResult<"read_screens"> {
			return {
				screens: screens.map(({ screen, frameId }) => {
					const entry = frameOf(screen, frameId);
					return {
						screen,
						frame: entry
							? designSystem.resolve(structuredClone(entry.frame))
							: null,
					};
				}),
			};
		},

		read_design_system(
			params: CommandParams<"read_design_system">,
		): CommandResult<"read_design_system"> {
			return designSystem.read(params);
		},

		link_file({
			linkId: id,
		}: CommandParams<"link_file">): CommandResult<"link_file"> {
			linkId = id;
			return { file: { key: doc.fileKey, name: doc.name }, linkId: id };
		},

		get_image({
			imageHash,
		}: CommandParams<"get_image">): CommandResult<"get_image"> | BridgeError {
			const bytes = images.get(imageHash);
			if (!bytes) {
				return {
					code: "image_not_found",
					message: `No image with hash "${imageHash}" exists in this file.`,
				};
			}
			return { bytes };
		},

		/** An image a designer placed, for get_image to return. */
		addImage(imageHash: string, bytes: string) {
			images.set(imageHash, bytes);
		},
	};
}
