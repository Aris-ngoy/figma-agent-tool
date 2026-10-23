# Figma Agent Tool

An MCP server plus a Figma development plugin that lets any MCP client work on the live Figma document.

## Packages

- `packages/protocol`: runtime-validated (zod) bridge messages and the shared test fixtures.
- `packages/mcp-server`: the MCP server (stdio) and the localhost WebSocket bridge the plugin connects to.
- `packages/figma-plugin`: the Figma plugin (sandbox command handler + UI iframe that owns the connection).
- `packages/handoff`: pure rendering of the prototype graph, screen layers and design system as handoff Markdown.
- `packages/visual-diff`: pure image comparison (align, mask, pixel-diff, cluster mismatches), with no Figma or device knowledge. Its PNG fixtures are regenerated with `bun run fixtures` in that package.

## Development

```sh
bun install
bun run build      # turbo: build every package
bun run test       # turbo: bun test in every package
bun run typecheck
bun run check      # Biome lint + format
```

## Setup

1. Build: `bun run build`.
2. Add the server to your MCP client:

   ```json
   {
     "mcpServers": {
       "figma-agent-tool": {
         "command": "bun",
         "args": ["/path/to/figma-agent-tool/packages/mcp-server/dist/main.js"]
       }
     }
   }
   ```

   The bridge listens on `ws://127.0.0.1:3055` (localhost only). Configure it with environment variables in the server entry (`"env": { ... }`):

   - `FIGMA_AGENT_BRIDGE_PORT`: bridge port (default `3055`). Set the same port in the plugin panel's **Bridge port** field, and add it to `devAllowedDomains` in `packages/figma-plugin/manifest.json`, since Figma only lets the plugin reach listed origins.
   - `FIGMA_AGENT_REQUEST_TIMEOUT_MS`: how long a command may wait for the plugin before the tool returns a timeout error (default `30000`).
   - `FIGMA_AGENT_YOQA_URL`: base URL of the Yoqa runner (default `http://127.0.0.1:7420`, Yoqa's own default port).

3. In Figma desktop: Plugins → Development → Import plugin from manifest… and pick `packages/figma-plugin/manifest.json`. Run it in the file you want to bridge; the panel shows whether it's connected, which file is bridged and the last command it ran.

   The plugin reconnects on its own (with backoff) if the MCP server restarts, and the server accepts it again after Figma reloads the plugin. Only one plugin window is bridged at a time: opening the plugin in another file replaces the older connection (the server logs a warning, and the older panel offers **Reconnect** to take the bridge back).
4. Ask your agent to call `get_status` to check the connection.

### The official Figma MCP

Every read and write goes through the plugin and the Plugin API, so this tool works on any Figma seat (free included), without the official Figma MCP server and without the REST API's rate limits. It doesn't proxy or wrap the official server. With a Full or Dev seat you can run both side by side; they don't share state.

Before a release, run the manual [smoke test](docs/smoke-test.md) against real Figma.

## Devices (Yoqa)

`list_devices`, `connect_device`, `navigate_device` and `capture_device_screenshot` reach iOS simulators, Android emulators and physical iOS and Android devices through the [Yoqa](https://yoqa.mintlify.app/docs/cli) local runner's HTTP API. **Yoqa is installed separately** (`@yoqa/runner`, not bundled with or imported by this MIT package). Start it with `yoqa serve` (or the `yoqa-runner` bin) before using the device tools. Device setup such as the Appium runtime, iOS signing and trusting the runner on a physical iPhone is Yoqa's job; its errors are passed through to the agent.

- `list_devices`: devices on both platforms (or one, with `platform`), with kind (`simulator` / `emulator` / `physical`) and the runner's status string.
- `connect_device`: reuses the active session when it is already that device. Yoqa holds one session at a time, so connecting a different device moves the session to it; the result names the device it replaced.
- `navigate_device`: brings the app to the screen under test before capture. Pass a `deepLink`, Yoqa `actions` (`tap`, `swipe`, `input`, `key`, `alert`, `open-url`, `activate-app`, `restart-app`; coordinates are 0–1000 of the screen, or target an element `id` / `label` from the screen tree, or a `description` Yoqa grounds on the current screen), or both. Steps run in order and stop at the first failure, which the error names (`deepLink` or `actions[i]`) with Yoqa's reason. `includeScreen` returns the element tree afterwards so the agent can check where it landed.
- `capture_device_screenshot`: writes the active device's screen to the artifacts folder and returns its path and pixel size.
- `get_status` reports whether the runner is reachable and which device is active.

## Artifacts

Image outputs such as `export_node_image` and `capture_device_screenshot` are written to `.figma-agent/` in the server's working directory and returned as file paths (inline images only on request). Set `FIGMA_AGENT_ARTIFACTS_DIR` to write them elsewhere. Add `.figma-agent/` to your project's `.gitignore`; this repo already ignores it.

## Editing

`create_nodes` and `update_nodes` take batches: a whole screen (frames with nested `children`, text, rectangles, component instances) can be built in one call. Properties use the same shape `get_node` returns. Each item succeeds or fails on its own, and the result lists every item in input order with its new ID or an error code (`font_not_found`, `component_not_found`, `unsupported_property`, …). Each batch is committed as one undo step, so Cmd+Z in Figma reverts the agent's last call.

### Restructuring

`delete_nodes`, `reparent_nodes`, `rename_nodes` and `ungroup_nodes` take batches and report each node in input order; `duplicate_node` makes `count` copies of one node and `group_nodes` wraps nodes in one new GROUP. `reparent_nodes` and `duplicate_node` take an `index` among the parent's children (0 is the bottom layer, first in auto-layout; nodes keep the order given), so nodes can be moved into an auto-layout frame at a position or reordered in place. Invalid targets fail with a code: `invalid_parent` (a parent that can't hold children, or an instance), `invalid_index`, `cannot_move` (pages, instance sublayers, a node's own subtree), `cannot_delete`, `cannot_group` and `not_a_group`. Each call is one undo step.

## Prototype reactions

`get_reactions`, `set_reactions` and `remove_reactions` read and wire a node's prototype interactions. Reactions use the Figma Plugin API's shape: a `trigger` (on click, hover, press, drag, after delay, mouse enter/leave/up/down, key or gamepad) and an `actions` array whose NODE actions carry a `destinationId`, a `navigation` and a `transition` (null for instant, or dissolve, smart animate, move in/out, push, slide in/out with a direction) with an easing preset, custom cubic bezier or spring and a duration in seconds. Every trigger and action type round-trips: reactions read with `get_reactions` can be written back unchanged. `set_reactions` replaces (default) or appends; `remove_reactions` clears all reactions or those matching a trigger type and/or destination. NAVIGATE, OVERLAY and SWAP must go to a top-level frame and CHANGE_TO to a component variant; otherwise the call fails with `invalid_destination` and nothing is written. Each write is one undo step.

## Motion animations

`get_motion` and `set_motion` read and write a node's Motion animations through Figma's Motion Plugin API, which is in beta. The plugin's handshake reports whether the open Figma version has that API (`capabilities.motion` in `get_status`). If it doesn't, both tools fail with a "not supported in this Figma version" error, without calling the plugin, and the agent should use `set_reactions` transitions instead.

Shapes follow the Plugin API. `animationStyles` are applied presets (FIGMA: `styleId`, `duration`, `timelineOffset`, `props`) or CUSTOM styles (`timelineOffset` only). `keyframeTracks` hold manual keyframes for one `field` each: a PROPERTY (OPACITY, TRANSLATION_X/Y, ROTATION, SCALE_XY, WIDTH, …), or a paint or effect selected by index. Each keyframe has a `timelinePosition` in seconds, a typed `value` (colors as 0–1 RGBA) and an `easing`, which can be a preset, HOLD, a cubic bezier or a spring with a 0–1 `bounce`. `get_motion` also returns the node's timeline. With `availableStyles: true` it also lists the presets and custom styles the file offers.

By default `set_motion` replaces the styles or tracks it is given. With `append`, styles are added after the existing ones and each track replaces only the track on its own field. Lists you leave out stay as they are. `timelineDuration` sets the length of the timeline. Output from `get_motion` can be passed back unchanged; re-applied styles get new application IDs. If a style is unknown (`animation_style_not_found`), a paint or effect index is missing (`invalid_keyframe_field`) or the node has no timeline (`no_timeline`), the call fails and nothing is written. Each write is one undo step.

## Flows and the prototype graph

`list_flows` lists the flow starting points Figma's prototype viewer shows (every page's, or one page's); `set_flow_start` makes a top-level frame a starting point, or renames the flow it already starts, in one undo step.

`trace_flow` walks breadth-first from a starting frame over the reactions of every layer in each screen, following NAVIGATE, OVERLAY and SWAP to further screens; screens already seen aren't walked again, so cycles end. It returns `screens` (with `depth`, the number of interactions from the start), `edges` (source screen and layer, trigger, action — NAVIGATE, OVERLAY, SWAP, SCROLL_TO, CHANGE_TO, BACK, CLOSE or URL — destination and transition; actions inside conditionals are marked `conditional`) and `dangling` edges whose destination is unset, deleted, unusable for the navigation (say, NAVIGATE to a nested layer) or on another page. `maxDepth` caps the walk and sets `truncated`. The plugin only returns raw reactions (one request per level of the walk); the server builds the graph.

`export_flow_json` returns the same graph as `{ version, file, graph }` and, given a `path`, also writes it there.

## Handoff Markdown

`export_flow_markdown` traces a flow like `trace_flow` (same `nodeId` and `maxDepth`) and renders it for developers and coding agents: a header (file, page, start, screen count, whether it was truncated), then a `## Screen: Name (id)` section per screen in walk order with its Figma link, size and depth, and four subsections that are always present (`None.` when empty):

- `Interactions`: a table of layer, trigger (with its delay, timeout or keys), action (overlay position, new tab, conditional), destination, transition type, direction, easing (preset, `cubic-bezier(…)` or `spring(…)`) and duration in ms. Instant is `INSTANT`.
- `Broken interactions`: dangling edges with their `reason`.
- `Tokens`: the variables (with each mode's value, aliases as `→ name`) and styles the screen's visible layers use, and the fields or slots using them; variables first, then styles, each by name.
- `Components`: the instances on the screen in layer order, with their component (set name and variant for variants) and property values (`#id` suffixes dropped).

Hidden layers are left out, and instances aren't looked inside (only their own bindings count): that's their component's business. `export_screen_markdown` renders one top-level frame the same way. The same document state produces byte-identical Markdown, so diffs between exports show design changes. Both take an optional `path` to also write the file (folders are created).

## Design system

`get_design_system` lists the file's local components and component sets (property definitions, variants and their values), paint, text and effect styles, and variables grouped by collection, with one value per mode (colors as hex, aliases as `{ "alias": "<variableId>" }`).

To build on-system, pass those IDs to `create_nodes` and `update_nodes`:

- `variables` binds node fields to variables by ID, using the Plugin API's field names: `width`, `height`, `itemSpacing`, `counterAxisSpacing`, `paddingTop`/`Right`/`Bottom`/`Left`, `topLeftRadius` and the other corners, `strokeWeight`, `opacity`, `visible`, `characters`, plus `fontFamily`, `fontStyle`, `fontWeight`, `fontSize`, `lineHeight`, `letterSpacing`, `paragraphSpacing` and `paragraphIndent` on text.
- A SOLID paint's `variable` binds its color to a COLOR variable, for example `fills: [{ "type": "SOLID", "variable": "VariableID:1:2" }]`.
- `styles` applies `fill`, `stroke`, `text` and `effect` styles by ID.

`null` unbinds a variable or detaches a style and keeps the current value. Setting `fills` or `strokes` directly detaches their style. Read tools report the bindings in the same shape: `variables`, `styles` and paint `variable`. Wrong IDs or types fail only that item, with `variable_not_found`, `variable_type_mismatch`, `style_not_found` or `style_type_mismatch`.

## Comparing images

`compare_images` diffs two local PNGs, so it needs neither Figma nor a device and also works in CI against stored baselines. Pass a `designPath` (for example a frame exported at 1x) and an `actualPath` (for example a device screenshot). The design is scaled to the actual image's pixel size (`scale: "auto"` derives the ratio from the widths, so a 393pt frame lines up with a 1179px capture; or pass the device pixel ratio). If the aspect ratios differ by more than `aspectTolerance` (default 1%), the tool returns an error instead of a score.

- `platform`: `ios` masks the top 59pt and bottom 34pt, and `android` masks the top 48dp and bottom 48dp (status bar and home indicator / navigation bar). The default is `none`. Masks and `ignoreRegions` are given in design image pixels, so platform masks assume a 1x design.
- `threshold` (default `0.1`), `detectAntiAliasing` (default on) and `mismatchBudget` (percent of unmasked pixels, default `0.5`) control how strict the comparison is.
- The result reports mismatch %, pass/fail, mismatched regions as bounding boxes (in actual-image pixels), the masks applied, and the path of a diff image in the artifacts folder (red: mismatch, yellow: anti-aliasing, blue: masked). Set `markdown: true` for a summary you can paste into a PR, and `inline: true` to get the diff image in the result.

## Visual QA

`run_visual_qa` is the fix loop in one call. Give it the Figma frame of the screen (`nodeId`) and, optionally, a `deepLink` and/or `actions` to reach that screen first (run exactly as `navigate_device` runs them; a failing step stops the run before capture). It captures the active device, exports the frame at the device's pixel ratio (`scale: "auto"` derives it from the widths, up to 4x) and compares the two with the same options as `compare_images`. `ignoreRegions` are in frame points, `platform` defaults to the device's platform, and `ignoreNodes` leaves the boxes of the given layers (timestamps, avatars) out of the score.

Each mismatched region lists the visible Figma layers drawn there. A region over a layer points at something that differs between design and app; a region with no layers means the app shows something the design doesn't. Boxes ignore rotation.

Each run writes `figma.png`, `device.png`, `diff.png` and `report.md` to its own timestamped folder (`.figma-agent/qa-<timestamp>-<id>/`) and returns their paths. `report.md` covers screen, device, mismatch %, pass/fail, the regions with their layers and the three images, ready to paste into a PR. If the frame and the capture don't share an aspect ratio, the error says so and gives the paths of both images.

Before a release, run the manual [visual QA smoke test](docs/visual-qa-smoke-test.md) against real Figma and devices.
