// Image outputs land in the artifacts folder and are returned as paths, so
// agents only pull pixels into their context when they ask for them.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Relative to the working directory; git-ignored in this repo. */
export const DEFAULT_ARTIFACTS_DIR = ".figma-agent";

/** Writes `bytes` under a unique, timestamped name and returns its absolute path. */
export async function writeArtifact(
	artifactsDir: string,
	name: string,
	extension: string,
	bytes: Uint8Array,
): Promise<string> {
	const dir = resolve(artifactsDir);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${uniqueName(name)}.${extension}`);
	await writeFile(path, bytes);
	return path;
}

/** Creates a unique, timestamped folder for one run's artifacts. */
export async function createArtifactFolder(
	artifactsDir: string,
	name: string,
): Promise<string> {
	const dir = join(resolve(artifactsDir), uniqueName(name));
	await mkdir(dir, { recursive: true });
	return dir;
}

/** `name-2026-10-23T12-00-00-000Z-1a2b3c4d`, safe as a file name. */
function uniqueName(name: string): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const suffix = crypto.randomUUID().slice(0, 8);
	const safeName = name.replace(/[^\w@.-]/g, "-");
	return `${safeName}-${timestamp}-${suffix}`;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Pixel dimensions from a PNG's IHDR chunk. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
	const isPng =
		bytes.length >= 24 &&
		PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
	if (!isPng) throw new Error("Expected a PNG image but got other bytes.");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Writes a PNG artifact and returns its path and pixel size. */
export async function writePngArtifact(
	artifactsDir: string,
	name: string,
	bytes: Uint8Array,
): Promise<{ path: string; width: number; height: number }> {
	const size = pngSize(bytes);
	const path = await writeArtifact(artifactsDir, name, "png", bytes);
	return { path, ...size };
}
