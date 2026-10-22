// Messages between the plugin sandbox and its UI iframe. Bridge messages pass
// through unchanged; `ui_ready` asks the sandbox for the settings and the
// handshake, and `save_settings` persists settings changed in the panel.
import type { Handshake, Request, Response } from "@figma-agent-tool/protocol";
import type { Settings } from "./settings";

export type UiToSandbox =
	| { type: "ui_ready" }
	| { type: "save_settings"; settings: Settings }
	| Request;
export type SandboxToUi =
	| { type: "settings"; settings: Settings }
	| Handshake
	| Response;
