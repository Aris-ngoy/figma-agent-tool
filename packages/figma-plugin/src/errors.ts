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

/** Whether the server has (nearly) stopped waiting for the current command. */
export type Deadline = { passed(): boolean };

export const NO_DEADLINE: Deadline = { passed: () => false };

/** Throws `timed_out` once the server has stopped waiting for the command. */
export function checkDeadline(deadline: Deadline) {
	if (deadline.passed()) {
		throw new CommandError(
			"timed_out",
			"The server stopped waiting for this command, so it stopped without changing the document.",
		);
	}
}

export function toBridgeError(error: unknown): BridgeError {
	return {
		code: error instanceof CommandError ? error.code : "command_failed",
		message: error instanceof Error ? error.message : String(error),
	};
}
