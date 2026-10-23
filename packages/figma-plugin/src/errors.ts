// Command failures with machine-readable codes the server relays to agents.
import type { BridgeError } from "@figma-agent-tool/protocol";

export class CommandError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export function nodeNotFound(id: string) {
	return new CommandError(
		"node_not_found",
		`No node with ID "${id}" exists in this file. Node IDs look like "12:34"; get them from get_selection, list_frames or a parent node's children.`,
	);
}

export function pageNotFound(id: string | undefined) {
	return new CommandError(
		"page_not_found",
		`No page with ID "${id}" exists in this file. Get page IDs from list_pages.`,
	);
}

export function toBridgeError(error: unknown): BridgeError {
	return {
		code: error instanceof CommandError ? error.code : "command_failed",
		message: error instanceof Error ? error.message : String(error),
	};
}
