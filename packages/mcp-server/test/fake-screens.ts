// The fake plugin's Push and Pull commands: frames live in serialized form,
// applied in place with the same rules as the real plugin (shared with the
// design-project tests), so tests can edit them as a designer would.
import { applyScreenTree } from "@figma-agent-tool/design-project/fixtures";
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
	const images = new Map<string, string>();
	let linkId: string | null = null;

	function frameOf(screen: string, frameId: string) {
		return (
			frames.get(frameId) ??
			[...frames.values()].find((entry) => entry.screen === screen)
		);
	}

	return {
		frames,
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
		}: CommandParams<"push_screens">): CommandResult<"push_screens"> {
			let target =
				doc.pages.find((p) => p.id === page.id) ??
				doc.pages.find((p) => p.name === page.name);
			if (!target) {
				target = { id: nextId(), name: page.name, children: [], flows: [] };
				doc.pages.push(target);
			}
			const hashes: Record<string, string> = {};
			for (const [name, data] of Object.entries(bytes)) {
				const hash = `image-${images.size + 1}`;
				images.set(hash, data);
				hashes[name] = hash;
			}
			const pageId = target.id;
			return {
				page: { id: target.id, name: target.name },
				images: hashes,
				screens: screens.map(({ screen, frameId, tree }) => {
					const previous = frameId ? frames.get(frameId) : undefined;
					const frame = applyScreenTree(tree, previous?.frame, {
						nextId,
						imageHash: (name) => hashes[name] as string,
					});
					if (previous) frames.delete(previous.frame.id);
					frames.set(frame.id, { screen, pageId, frame });
					return { screen, frame: structuredClone(frame) };
				}),
			};
		},

		read_screens({
			screens,
		}: CommandParams<"read_screens">): CommandResult<"read_screens"> {
			return {
				screens: screens.map(({ screen, frameId }) => {
					const entry = frameOf(screen, frameId);
					return { screen, frame: entry ? structuredClone(entry.frame) : null };
				}),
			};
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
