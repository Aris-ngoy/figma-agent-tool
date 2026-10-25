# The Design System pushes as variables and text styles, bound by token path

Push sends DESIGN.md with the Screens, in the same `push_screens` command so it stays one undo step: `colors`, `spacing` and `rounded` tokens become variables in one collection (default mode), named by path, and `typography` tokens become text styles. Variables and styles are addressed by their token path in the push, so references become aliases and Screens' bindings can point at variables the same push creates; their IDs are kept in a Design System Baseline next to the Screens'. A Screen element binds where it writes exactly `var(--token)` for a fill, gap, padding or radius; text binds to a text style only when its font size is that style's token and its family and weight match the style, so applying the style changes nothing the Screen didn't say.

## Consequences

- Pull compares Figma's variables and styles with the Baseline field by field, by meaning (hex case, px vs rem), and edits only the changed values in DESIGN.md's front matter, keeping its quoting, comments and Markdown. DESIGN.md stays spec-pure and Pull leaves an unchanged file byte for byte (as ADR-0010 does for Screens).
- Screens' Baselines resolve tokens as Figma shows them now, since bound layers follow their variables: a designer changing `colors/primary` is an Unpulled Change of the Design System, not of every Screen using it. Pull keeps `var(--…)` in a Screen's Baseline wherever the value matches, so later token edits keep following.
- Deleted variables and styles aren't Pulled as deletions: the next Push recreates them, as it recreates a deleted frame. Variables and styles designers add, and renames, are theirs and aren't Pulled.
- Text styles carry line height and letter spacing, which Screens can't express yet, so a styled text layer can differ from the Preview there.
