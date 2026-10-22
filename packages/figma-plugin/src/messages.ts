// Messages between the plugin sandbox and its UI iframe. Bridge messages pass
// through unchanged; `ui_ready` asks the sandbox for the handshake.
import type { Handshake, Request, Response } from "@figma-agent-tool/protocol";

export type UiToSandbox = { type: "ui_ready" } | Request;
export type SandboxToUi = Handshake | Response;
