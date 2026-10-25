# Smoke test

Automated tests drive the MCP server with a fake plugin and a fake Yoqa runner, and the plugin handler with a mocked `figma` global. This checklist covers what they can't: real Figma desktop, a real MCP client and real devices, running the full loop. Run it before a release, or after changing the bridge or the plugin. The device half is the [visual QA smoke test](visual-qa-smoke-test.md).

## Setup

- [ ] `bun install` and `bun run build`, then register the MCP server in your client (see the README's Setup). Do it on a free Figma seat, without the official Figma MCP running: nothing below needs it.
- [ ] Figma desktop with a sample file: two or three screen frames, a component set with variants, a few local variables (one aliased) and styles.
- [ ] The plugin imported from `packages/figma-plugin/manifest.json` and running in that file.

## Connection

- [ ] Before opening the plugin, any Figma tool says no plugin is connected and to open it.
- [ ] `get_status` reports `bridge.connected: true`, the file name, the plugin version and `capabilities.motion`.
- [ ] The plugin panel shows connected, the file name and the last command each tool call ran.
- [ ] Restart the MCP server: the panel reconnects on its own and `get_status` works again. Close and reopen the plugin: same.
- [ ] Open the plugin in a second file: it takes the bridge, the server logs a warning, and the first panel offers **Reconnect**.
- [ ] With `FIGMA_AGENT_BRIDGE_PORT` changed (and the panel's port and `devAllowedDomains` updated to match), the plugin connects on the new port.

## Read

- [ ] Select a layer: `get_selection` returns it and its tree. `get_node` with a small `depth` cuts the tree off there.
- [ ] `list_pages` and `list_frames` match the file.
- [ ] `get_design_system` lists the components, variants, styles and variables with each mode's value.

## Edit

- [ ] `create_nodes` builds a screen in one call: an auto-layout frame with text, a rectangle and a component instance, using a variable for spacing, a color variable and a text style. It looks like a hand-made one.
- [ ] Cmd+Z in Figma removes the whole batch in one step; Cmd+Shift+Z brings it back.
- [ ] `update_nodes` changes size, fills, corner radius, text and font; a missing font fails only that item with `font_not_found`.
- [ ] `rename_nodes`, `duplicate_node` (where do copies land?), `group_nodes` (at the topmost node's position in the layer list?), `ungroup_nodes` and `delete_nodes` each do what they say in one undo step.
- [ ] `reparent_nodes` into an auto-layout frame at an `index`, and to reorder a node within its own parent: it ends up at that index.
- [ ] `export_node_image` writes a PNG to `.figma-agent/` at the given scale; `inline: true` also shows it in the client.

## Prototype

- [ ] `set_reactions` wires a button to the next screen with a PUSH transition (direction, EASE_OUT, 300 ms); Figma's prototype panel shows the same.
- [ ] Set a few triggers by hand in Figma (after delay, key, mouse enter, on drag), read them with `get_reactions`, write them back unchanged with `set_reactions`, and check that nothing changed in the prototype panel.
- [ ] A custom cubic bezier and a spring easing round-trip the same way.
- [ ] `remove_reactions` by trigger type leaves the others alone.
- [ ] `set_flow_start` adds a flow that shows up in the prototype viewer; `list_flows` lists it.
- [ ] `trace_flow` from that start returns every screen reachable from it, including an overlay, a back action and a cycle. Delete a destination frame and trace again: the edge is reported as dangling.
- [ ] Present the flow in Figma and click through it: the transitions look like what was set.

## Motion (if `capabilities.motion` is true)

- [ ] `get_motion` on an animated layer returns its styles, keyframe tracks and timeline; `availableStyles: true` lists the presets.
- [ ] `set_motion` applies a preset and a manual opacity track; both play in Figma. Check what easing and base value Figma uses for keyframes that leave them out, and whether a frame without a timeline gets one.
- [ ] On a Figma version without Motion (or with `figma.motion` missing), both tools say "not supported in this Figma version" and point at reactions.

## Handoff

- [ ] `export_flow_markdown` with a `path` in a repo: one section per screen, Figma links that open the right frame, the interactions as set above, and the tokens and component variants used.
- [ ] Export again without changes: the file is byte-identical (`git diff` is empty). Change one color and export: only that line changes.
- [ ] `export_screen_markdown` on one screen and `export_flow_json` on the flow match what the flow export says.

## Design Project loop (v2)

In a scratch repo, with the MCP server's working directory there (or `FIGMA_AGENT_DESIGN_DIR` set):

- [ ] `init_design_project` (or `figma-agent-tool init`) creates `design/` with `project.json`, `DESIGN.md`, `screens/` and `assets/`.
- [ ] Ask the agent for a login screen: it writes `design/screens/login.html` with tokens as CSS variables, and `check_design_project` passes. Break it on purpose (a `<table>`, `display:grid`): Check names the file, line, element and rule.
- [ ] `figma-agent-tool preview` shows the Screen at its Screen Size; editing the file reloads the page. `render_screen` (or `figma-agent-tool render login`) writes a PNG that looks the same as the Preview (headless Chromium downloads on first use).
- [ ] With the plugin open in a fresh file, `push` asks to confirm “<file name>”; confirming links it. The frame appears on the Screens Page at 393×852 with auto layout, layers named as in the Screen and editable text, and Cmd+Z removes the whole Push in one step.
- [ ] Rename the frame and move it to another page, then `pull`: nothing changes (`unchanged`) and `git diff` on the Screen is empty.
- [ ] Open the plugin in another file and `push`: refused, naming both files. Go back to the Linked File.
- [ ] In Figma, change the title's text and the button's padding: `get_status` lists `login` under `unpulledChanges`, and `push` is refused naming it.
- [ ] `pull`: the Screen gets the new text and padding, the tokens it used elsewhere stay `var(--…)`, and `push` works again; every layer keeps its node ID (check one with `get_node`).
- [ ] Change the same text in Figma and in the file, then `pull`: the file has `<<<<<<< Design Project` / `>>>>>>> Figma` markers, `get_status` lists `syncConflicts`, and `push` is refused. Keep one side, delete the markers, `push`: the frame shows the kept text.
- [ ] Add a star with a drop shadow in Figma, then `pull`: the Screen gets a `<figma-owned>` element for it, Pull lists it, and `sync/exports/login/` has its PNG. The Preview and `render_screen` show the star. Edit the Screen to move it (`position:absolute; left:…; top:…`) and make it wider, `push`: the star moves and resizes, its shadow and points unchanged, and the Preview says its export is stale until the next `pull`. Delete the element and `push`: the star is gone.
- [ ] Write a Screen with an `<svg viewBox="0 0 24 24">` icon (stroked path), a `border: 1px solid …` card, an `overflow:hidden` frame and an absolutely positioned badge; `push` then `pull`: `unchanged`. In Figma the icon is one vector layer at the Screen's size with a centered stroke, the card has an inside stroke included in its auto layout, the frame clips, and the badge is absolutely positioned. Edit a vector point in Figma and `pull`: the `<svg>` gets the new path in its own pixels.
- [ ] Unverified against the mock: `vectorPaths` on a vector resized first (Figma may normalize a vector's bounds to its paths, which would read back as an edit), `layoutPositioning = "ABSOLUTE"` with `constraints`, `strokesIncludedInLayout`, and `exportAsync` of a star at 2x.
- [ ] Cut the frame and paste it back (new node IDs): `pull` still finds it, and `push` updates it rather than making a new one.
- [ ] After a `push`, the file's local variables have a “Design System” collection with `colors/…`, `spacing/…` and `rounded/…` (aliases where DESIGN.md references a token), and a text style per typography token. Select the frame: its fill, gap and padding show the variables; the title shows its text style.
- [ ] Change `colors/primary` and the title style's size in Figma: the button and title update, `get_status` lists both under `designSystem.unpulledChanges`, and `push` is refused naming them. `pull`: DESIGN.md gets the new values and nothing else changes (`git diff`), the Screen file doesn't change, and `npx @google/design.md lint design/DESIGN.md` reports no errors.
- [ ] Change the same token in Figma and in DESIGN.md, then `pull`: DESIGN.md has the markers and `push` is refused until they're resolved.
- [ ] Unverified against the mock: binding corner radii and padding with `setBoundVariable`, `setTextStyleIdAsync` after the synchronous pass, and creating variables with `createVariable(name, collection, type)`.

## Agent loop

- [ ] Ask the agent to "wire the onboarding flow with push transitions and export the handoff Markdown": it sets the reactions, traces the flow and writes the file without help.
- [ ] Ask it to "make the login screen match Figma on my iPhone": it runs `run_visual_qa`, fixes the code or the design, and runs it again until it passes (see the [visual QA smoke test](visual-qa-smoke-test.md) for the device setup).

Record the date, Figma version, MCP client, Yoqa version and devices in the PR that ran the checklist.
