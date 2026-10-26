# Pull rewrites a Screen in canonical form, and only when Figma changed it

Push keeps a Screen's file as the Agent wrote it, adding only `data-key` attributes. Pull compares Figma's frame with the Baseline by meaning (tokens resolved, units and defaults normalized), so a file Figma didn't change is left byte for byte; when it did, the merged Screen is printed in one canonical form (two-space indents, one element per line, properties in a fixed order). That keeps Push then Pull exact, and makes merges and Sync Conflict markers line-based, at the price of the Agent's own formatting where a designer edited the Screen. Comments are rejected by Check for the same reason: Pull couldn't keep them.

## Consequences

The Baseline of a pulled Screen is Figma's version printed canonically, with literal values; tokens the Design Project used survive because a value Figma left alone keeps the file's `var(--…)`. A value a designer changed comes back as a literal until the Design System is synced with Figma variables.
