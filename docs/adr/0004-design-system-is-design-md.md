# The Design System is a DESIGN.md file

A Design Project keeps its Design System in Google Labs' open DESIGN.md format (YAML tokens plus Markdown rationale, Apache-2.0), Pushed to Figma variables and styles and Pulled back from them, rather than a token file of our own. Stitch and other agent tools already read it, and its tokens convert to Figma variables. The spec is still alpha and can't express everything Figma can (it has no variable modes such as light and dark), so we track its changes.

## Consequences

DESIGN.md stays strictly to the spec, so Stitch and `npx @google/design.md lint` keep accepting it, and holds the default Mode. The values of other Modes live in a separate file the tool owns, next to it, until the spec can express Modes.
