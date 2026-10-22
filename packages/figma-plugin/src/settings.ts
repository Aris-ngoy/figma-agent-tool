// Plugin settings, persisted per user in Figma's client storage. Only the
// sandbox can reach `figma.clientStorage`; the UI asks it to load and save.
import { DEFAULT_BRIDGE_PORT } from "@figma-agent-tool/protocol";

export type Settings = { port: number };

const PORT_KEY = "bridgePort";

/** A valid bridge port, or undefined. */
export function parsePort(value: unknown): number | undefined {
	const text = String(value).trim();
	if (!/^\d+$/.test(text)) return undefined;
	const port = Number(text);
	return port >= 1 && port <= 65535 ? port : undefined;
}

export async function loadSettings(): Promise<Settings> {
	const port = parsePort(await figma.clientStorage.getAsync(PORT_KEY));
	return { port: port ?? DEFAULT_BRIDGE_PORT };
}

export async function saveSettings({ port }: Settings): Promise<void> {
	await figma.clientStorage.setAsync(PORT_KEY, port);
}
