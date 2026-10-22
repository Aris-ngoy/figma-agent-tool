# Coding Standards

The reviewer agent loads this file during code review via @.sandcastle/CODING_STANDARDS.md.

## Tooling

- Bun is the package manager and runtime — never npm, pnpm or yarn.
- Biome owns linting and formatting (`biome.json`): tab indentation, double quotes, recommended rules. `bun run check` must pass; CI runs `biome ci .`.
- Don't hand-format to fight Biome — run `bun run check:fix`.

## Domain

- Use the vocabulary in `CONTEXT.md` (when present) for names of modules, types and functions.
- Respect decisions recorded in `docs/adr/`. Don't silently contradict one; flag it instead.

## Testing

- New behaviour comes with tests that exercise it through its public interface.
- Test names describe the expected behaviour.

## Architecture

- Keep modules focused on a single responsibility, with small interfaces hiding real work.
- Prefer named exports over default exports.
