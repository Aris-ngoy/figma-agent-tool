import { writeFixtureProject } from "../fixtures";
import { loadProject } from "../src";

export async function fixtureProject(
	overrides: Record<string, string | null> = {},
) {
	return loadProject(await writeFixtureProject(overrides));
}
