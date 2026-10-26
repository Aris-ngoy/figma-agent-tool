# Modes live in a Modes file and push as variable modes

The DESIGN.md spec has no Modes, so a Design Project keeps the values of its other Modes in `modes.yaml` next to DESIGN.md (as ADR-0004 planned): `default` names DESIGN.md's Mode, and `modes` maps each other Mode to values for DESIGN.md's `colors`, `spacing` and `rounded` tokens, in DESIGN.md's own groups and value syntax, references included. A Mode only overrides: whatever it leaves out keeps the default's value, so a Mode is as small as its differences and DESIGN.md alone is still a whole Design System. Push makes each Mode a variable mode of the one “Design System” collection (ADR-0011), in the same `push_screens` command, and gives every variable a value in every Mode.

## Consequences

- Typography can't have Modes: Push makes text styles, which Figma doesn't vary by mode, so Check rejects typography in the Modes file rather than pushing something Figma would ignore.
- Figma has no "inherit the default" for a mode, so a token a Mode leaves out is pushed as a copy of the default's value (or the same alias). Pull treats a Mode's value as changed only when it differs from what the Baseline gave that Mode; a designer changing only the default leaves the copies in Figma's other modes behind, so the Modes Baseline records them explicitly and nothing reads as an Unpulled Change. The next Push sends the default's new value to those Modes again.
- Modes are matched by mode ID, kept in the Design System Baseline (default first), so renaming the default Mode renames Figma's default mode, and a mode a designer renamed is renamed back. Modes designers add aren't Pulled, and a deleted one is made again, as with variables.
- Pull edits the Modes file as it edits DESIGN.md's front matter: changed values in place, new values (a token the Mode left to the default) added under the Mode, with the groups they need, Sync Conflicts marked around the lines.
- Screens don't choose a Mode yet: frames show the collection's default mode, and the Preview and Render show any Mode with the Mode's values as the CSS variables.
- Figma limits modes per collection by plan; Push adds modes before it changes any variable or Screen, so a refused mode stops it there with `mode_limit`.
