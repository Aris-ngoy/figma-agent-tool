# Figma Agent Tool

Lets any coding agent design UI as files in a repo, see it in a local preview, and work on it together with Figma: sending screens in, reading designers' changes back, and wiring prototypes, handoff and visual QA on the Figma side.

## Language

### Designing

**Agent**:
The user's own AI coding agent or harness (Claude Code, Codex, Gemini CLI, a script), reaching the tool over MCP or the CLI. It does all the design thinking; the tool has no model of its own.
_Avoid_: AI, model, assistant

**Design Project**:
The folder of design files in the user's repo that is the source of truth for the UI the Agent designs.
_Avoid_: Project (alone), workspace, canvas

**Screen**:
One designed UI view in a Design Project, written in the Screen Subset.
_Avoid_: Page, artboard, mockup

**Screen Subset**:
The restricted HTML a Screen may use: only what has an exact Figma equivalent, so Push and Pull are both predictable.
_Avoid_: HTML (alone), markup

**Screen Size**:
The device size a Screen is designed at: the Design Project's default unless the Screen overrides it. It is the frame size in Figma and the target of Visual QA.
_Avoid_: Viewport, breakpoint

**Component**:
A reusable part used across Screens, which Pushes to Figma as a component set and its instances. It is either Defined (written in the Design Project, with its variants) or Linked (an existing component in the Linked File or a library). Designers' instance overrides are Pulled into the Screen; edits to a Linked Component's own design never are.
_Avoid_: Widget, partial, symbol

**Figma-owned Element**:
A placeholder in a Screen for a layer the Screen Subset can't express, made by Pull. Push leaves that layer as the designers made it.
_Avoid_: Unsupported node, blob

**Design System**:
A Design Project's tokens and rules, kept in its DESIGN.md and mirrored in Figma as variables and styles.
_Avoid_: Theme, tokens file, style guide

**Mode**:
An alternative set of values for the Design System's tokens, such as dark, mirrored as a Figma variable mode.
_Avoid_: Theme, scheme

**Direction**:
One of several alternative versions of a Screen, kept next to it and compared side by side in the Preview. Choosing a Direction makes it the Screen and discards the others.
_Avoid_: Variant (that's a Figma component term), option, draft

**Render**:
An image of a Screen or Direction exactly as the Preview shows it, so an Agent without a browser can see its work.
_Avoid_: Screenshot, export

**Check**:
Validating a Design Project's Screens against the Screen Subset and its DESIGN.md against the spec, with errors the Agent can fix.
_Avoid_: Lint (alone), validate

**Preview**:
The local view of a Design Project's Screens and Directions, from which the user can Push. It does not edit.
_Avoid_: Canvas, editor

### Working with Figma

**Linked File**:
The one Figma file a Design Project Pushes to and Pulls from, chosen at the first Push and changed only by an explicit re-link. Push and Pull are refused while the Bridged File is a different file.

**Screens Page**:
The page of the Linked File that the Design Project owns, holding one top-level frame per Screen. Every other page belongs to the designers.

**Explorations Page**:
A page of the Linked File holding copies of Directions that were Pushed for designers to compare. Pull ignores it.

**Adopt**:
Starting a Design Project from an existing Figma file: Pulling its Design System and chosen frames into Screens, which makes it the Linked File.
_Avoid_: Import, onboard

**Push**:
Sending Screens and the Design System from a Design Project into the Linked File. A Push is refused while a Screen's frame has Unpulled Changes.
_Avoid_: Export, sync, upload

**Pull**:
Reading changes made in the Linked File back into the Design Project. Pull never drops a designer's work: what the Screen Subset can't express becomes a Figma-owned Element.
_Avoid_: Import, sync, download

**Prototype Link**:
A link from an element in a Screen to another Screen, with an optional transition, which Pushes as an on-click navigation in Figma's prototype. Interactions Screens can't express (hover, drag, overlays, motion) stay Figma-only and survive Pushes.
_Avoid_: Reaction (that's the Figma-side term), hotspot

**Unpulled Changes**:
Edits made in Figma to a Screen's frame or to the Design System since the last Pull or Push.
_Avoid_: Conflict, drift

**Baseline**:
The version of a Screen, Component or Design System as of its last Push or Pull, against which Pull merges Figma's changes with the Design Project's.
_Avoid_: Snapshot, last sync

**Sync Conflict**:
A place where Figma and the Design Project both changed the same element since the Baseline, marked in the file for the Agent to resolve. Push is refused while any remain.
_Avoid_: Merge conflict (that's git's)

**Export**:
Writing something out of Figma as a standalone file: an image, handoff Markdown, a flow graph.
_Avoid_: Using it for Push

**Plugin**:
The Figma plugin, installed from the Figma Community, that carries out every read and write inside Figma.

**Bridged File**:
The one Figma file whose Plugin is currently connected to the tool.
_Avoid_: Active file, current document

**Visual QA**:
Comparing a frame in Figma with a capture of the running app on a device, region by region, to find where the build differs from the design.
_Avoid_: Screenshot test, visual regression
