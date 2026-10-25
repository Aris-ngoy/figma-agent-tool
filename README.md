# Figma Agent Tool

An MCP server plus a Figma development plugin that lets any MCP client work on the live Figma document.

## Packages

- `packages/protocol`: runtime-validated (zod) bridge messages and the shared test fixtures.
- `packages/design-project`: pure: reads and writes a Design Project, checks Screens against the Screen Subset, converts Screens to and from the node trees the plugin applies, and does Pull's three-way merge. No Figma, network or browser knowledge.
- `packages/preview`: the local Preview server and the one renderer that both the Preview and Render use.
- `packages/mcp-server`: the MCP server (stdio), the localhost WebSocket bridge the plugin connects to, and the `figma-agent-tool` CLI.
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

   The bridge listens on `ws://127.0.0.1:3055` and `ws://[::1]:3055` (localhost only); the plugin connects to it as `ws://localhost:3055`, since Figma's manifest accepts host names but not IP addresses, and `localhost` may resolve to either loopback (macOS tries `::1` first). Configure it with environment variables in the server entry (`"env": { ... }`):

   - `FIGMA_AGENT_BRIDGE_PORT`: bridge port (default `3055`). Set the same port in the plugin panel's **Bridge port** field, and add `ws://localhost:<port>` to `devAllowedDomains` in `packages/figma-plugin/manifest.json`, since Figma only lets the plugin reach listed origins.
   - `FIGMA_AGENT_REQUEST_TIMEOUT_MS`: how long a command may wait for the plugin before the tool returns a timeout error (default `30000`).
   - `FIGMA_AGENT_YOQA_URL`: base URL of the Yoqa runner (default `http://127.0.0.1:7420`, Yoqa's own default port).
   - `FIGMA_AGENT_DESIGN_DIR`: the Design Project's folder (default `design`, relative to the working directory).
   - `FIGMA_AGENT_CHROME`: a Chrome or Chromium binary for Render; otherwise Render downloads Chrome for Testing's headless shell into `~/.cache/figma-agent-tool` on first use.

3. In Figma desktop: Plugins → Development → Import plugin from manifest… and pick `packages/figma-plugin/manifest.json`. Run it in the file you want to bridge; the panel shows whether it's connected, which file is bridged and the last command it ran.

   The plugin reconnects on its own (with backoff) if the MCP server restarts, and the server accepts it again after Figma reloads the plugin. Only one plugin window is bridged at a time: opening the plugin in another file replaces the older connection (the server logs a warning, and the older panel offers **Reconnect** to take the bridge back).
4. Ask your agent to call `get_status` to check the connection.

### The official Figma MCP

Every read and write goes through the plugin and the Plugin API, so this tool works on any Figma seat (free included), without the official Figma MCP server and without the REST API's rate limits. It doesn't proxy or wrap the official server. With a Full or Dev seat you can run both side by side; they don't share state.

Before a release, run the manual [smoke test](docs/smoke-test.md) against real Figma.

## Design Projects (v2)

The Agent designs **Screens** as files in a **Design Project** in the repo, sees them in a local **Preview**, and **Pushes** them to Figma; designers' edits come back with **Pull**. See `CONTEXT.md` for the vocabulary and `docs/adr/` for the decisions.

```
design/
  project.json        { "screenSize": { "width": 393, "height": 852 }, "screensPage": "Screens", "explorationsPage": "Explorations" }
  DESIGN.md           the Design System (Google Labs' DESIGN.md format), in its default Mode
  modes.yaml          optional: the tokens' values in other Modes (dark, high contrast, …)
  screens/login.html  one Screen per file
  screens/login.directions/bold.html
                      optional: alternative versions (Directions) of a Screen, compared in the Preview
  assets/             images Screens use
  sync/               the Linked File, each Screen's Baseline and the Design System's; commit it so teammates share it
```

Every tool has a CLI command doing the same thing (`bun packages/mcp-server/src/cli.ts <command>`, or the `figma-agent-tool` bin once built):

| MCP tool | CLI | |
| --- | --- | --- |
| `init_design_project` | `init [--size 393x852]` | Create the folder above. |
| `check_design_project` | `check` | Check Screens, DESIGN.md (the DESIGN.md spec's own linter, WCAG contrast included) and `modes.yaml`; each finding names the file, line, element or token and rule. Warnings don't fail it. |
| `render_screen` | `render <screen> [--direction bold] [--mode Dark] [--out file.png]` | A PNG of the Screen (or one of its Directions) exactly as the Preview shows it, in a Mode. |
| `open_preview` | `preview [--port 4321]` | Every Screen at its Screen Size with its Directions side by side, in the Mode its switcher picks, reloading as files change. |
| `choose_direction` | `choose <screen> <direction>` | Make a Direction the Screen and delete the other Directions. |
| `push` | `push [<screen>…] [--directions] [--yes]` | Screens → frames on the Screens Page, DESIGN.md → variables and text styles, all updated in place. With `directions`, copies the Screens' Directions to the Explorations Page instead. |
| `pull` | `pull` | Designers' edits → the Screens and DESIGN.md, merged against the Baseline. |
| `relink_file` | `relink [--yes]` | Link the Bridged File instead of the Linked File. |

The CLI's `push`, `pull` and `relink` host the plugin bridge while they run, so they can't run while the MCP server holds its port; use the MCP tools then.

### Screens

A Screen is one `<body>` element in the **Screen Subset**, where everything has an exact Figma equivalent:

```html
<body style="display:flex; flex-direction:column; gap:var(--spacing-md); padding:24px; background:var(--colors-surface)">
  <img src="../assets/logo.png" style="width:64px; height:64px; border-radius:var(--rounded-md)">
  <h1 style="font-size:28px; font-weight:700; color:var(--colors-text)">Welcome back</h1>
  <div data-name="Button" style="display:flex; justify-content:center; padding:12px 16px; align-self:stretch; background:var(--colors-primary); border-radius:12px">
    <p style="font-weight:600; color:#ffffff">Sign in</p>
  </div>
  <div style="height:1px; align-self:stretch; background:#dddddd"></div>
</body>
```

- `<body>` is the Screen's frame, at the project's Screen Size unless it sets both `width` and `height`.
- `<div style="display:flex">` is an auto-layout frame (`flex-direction`, `gap`, `padding`, `justify-content`, `align-items`, `flex-wrap`); a `<div>` without children or `display` is a rectangle; `<p>`, `<span>` and `<h1>`–`<h6>` are text (`<br>` for line breaks); `<img>` is a rectangle with an image fill (`object-fit: cover | contain`).
- Sizes: a `px` width or height is fixed, none hugs the content, `flex: 1` fills the parent's main axis and `align-self: stretch` its cross axis.
- Boxes take `background`, `border-radius`, `opacity` and a solid border (`border: 1px solid #dddddd`, or `border-width` with `border-color`: an inside stroke that takes up room in auto layout); frames take `overflow: hidden` (clip content). Text takes `color`, `font-family`, `font-size`, `font-weight`, `font-style` and `text-align`. There's no inheritance: text styles go on text elements.
- `position: absolute` with `left` and `top` (both, in px, negative too) takes an element out of its parent's auto layout at that offset (absolute position in Figma, pinned top left). It can't fill its parent.
- `<svg>` with `<path d="…">`s (`fill-rule` optional) is a vector layer: `width` and `height` are required, `viewBox` scales the paths as a browser does, and its style takes `fill`, `stroke`, `stroke-width`, `stroke-linecap` and `stroke-linejoin`. Paths use M, L, H, V, C, S, Q, T and Z (no arcs). Pull writes vectors in their own pixels, without a `viewBox`.
- **Prototype Links**: `href="signup.html"` on any element but `<body>` links it to another Screen, an on-click NAVIGATE to that Screen's frame in Figma's prototype; `<a href>` is a frame (with `display:flex`), text (holding text) or a rectangle. `data-transition` animates it, CSS-style: `instant` (the default), or `dissolve`, `smart-animate`, `scroll-animate`, `move-in`, `move-out`, `push`, `slide-in` or `slide-out`, with a direction for move, push and slide (`left`, `right`, `top`, `bottom`), then optionally a duration (`300ms` by default) and an easing (`ease-out` by default; `ease-in`, `ease-in-out`, `linear`, `ease-in-back`, `ease-out-back`, `ease-in-out-back`, `gentle`, `quick`, `bouncy`, `slow`), as in `data-transition="push left 200ms ease-in-out"`. Check rejects links to Screens that don't exist and transitions Figma can't take.
- `data-name` names the layer. Push writes a `data-key` into each element, which links it to its layer: leave it, and don't copy it onto another element.
- DESIGN.md's tokens are CSS variables named after their path: `colors.primary` is `var(--colors-primary)`, `typography.title.fontSize` is `var(--typography-title-font-size)`.

### Directions

A **Direction** is an alternative version of a Screen, written next to it in `screens/<screen>.directions/<direction>.html` (a Screen that doesn't exist yet can have Directions too). It is a Screen in every other way: the same Screen Subset, Components and Prototype Links, and its images' `src`s are relative to its own folder (`../../assets/logo.png`).

- Check checks Directions; the Preview shows each Screen's Directions side by side with it, and Render takes `direction`. A Direction is designed at its Screen's Screen Size unless its `<body>` sets one.
- Choosing a Direction (its Choose button in the Preview, `choose_direction`, or `choose`) writes it over the Screen, with its image paths adjusted, and deletes the Screen's Directions folder; git keeps the others. The Screen's frame updates at the next Push, in place for elements whose `data-key` the Direction kept (copy the Screen, keys and all, to start a Direction from it).
- A regular Push never sends Directions to the Screens Page. `push` with `directions: true` (CLI `push --directions`) copies them for designers to compare: one frame per Direction, labelled `<screen> / <direction>`, side by side in a row per Screen on the Explorations Page (`explorationsPage` in `project.json`). Pushing them again replaces that Screen's copies where they were. Copies aren't linked to anything: Pull never reads them, and edits to them stay in Figma. Tokens are pushed as values (no variable bindings), and Figma-owned Elements copy their Screen's layers. Directions' files get no `data-key`s from it.

### Push and Pull

- The first Push names the Bridged File and asks to confirm it (the `push` tool returns `status: "confirm_link"`; call it again with `confirmLink: true`). The file then is the Linked File: Push and Pull refuse any other Bridged File, naming both, until `relink`.
- Push creates or updates one frame per Screen on the Screens Page, keeping node IDs (and with them comments and Figma-only interactions), as one undo step. Layers designers added stay. It refuses Screens that fail Check or have Sync Conflicts, and frames with Unpulled Changes.
- Pull merges each frame's edits into its Screen against the Baseline. A Screen Figma didn't change stays byte for byte; one it did is rewritten in canonical form. Where both sides changed the same element the file gets markers to resolve:

  ```
  <<<<<<< Design Project
      <p data-key="e6" style="color:#fff; font-weight:600">Log in</p>
  =======
      <p data-key="e6" style="color:#ffffff; font-weight:600">Continue</p>
  >>>>>>> Figma
  ```

- A layer the Screen Subset can't express (effects, gradients, boolean shapes, stars, frames without auto layout, rotated or hidden layers, …) becomes a **Figma-owned Element**: `<figma-owned data-key="e8" data-name="Star" style="width:40px; height:38px"></figma-owned>`, at the layer's place and size. Pull lists each with the reason and caches a PNG export of its layer in `sync/exports/`, fetched again only when a designer changed it. The Preview and Render show that export, and say when it's stale (the Screen resized the element since) or missing. The Agent can move, resize, rename (`data-name`) or delete the element, and Push does the same to the layer, never touching its content; it holds nothing and takes only `width`, `height`, `flex`, `align-self`, `position`, `left` and `top`. Push refuses one Pull didn't make (its `data-key` names no layer).
- Push turns each Prototype Link into its layer's on-click NAVIGATE, and Pull turns on-click NAVIGATEs to a Screen's frame back into `href` and `data-transition`, merged like any other change. Every other interaction (hover, drag, overlays, other actions, custom easing curves, Motion) is Figma-only: Pull leaves it out of the Screen and Push leaves it as the designers made it, as it does every reaction on a Screen's own frame. `trace_flow` and the handoff tools work on the pushed frames like on any others. A Push of only some Screens is refused when they link to a Screen that has no frame yet.
- `get_status` reports the Design Project, its Linked File, Screens with Unpulled Changes or Sync Conflicts, and the Design System's (`designSystem`).

### The Design System

- Push sends DESIGN.md with the Screens: `colors`, `spacing` and `rounded` tokens become variables in a “Design System” collection, named by path (`colors/primary`, `spacing/md`), references (`"{colors.text}"`) become aliases, and each `typography` token becomes a text style (font family, size, weight, line height, letter spacing). Later Pushes update them in place, keeping their IDs, and remove those DESIGN.md dropped.
- Screen elements written with a token's variable are bound to it: `background`/`color` (fill), `gap`, `padding` and `border-radius` to the variable; text whose `font-size` is a typography token's, and whose family and weight match it, gets that text style.
- Pull reads those variables and styles back and writes what designers changed into DESIGN.md, merged against its Baseline: only the changed values are edited, so the file stays as written and passes `npx @google/design.md lint`. Where both sides changed a token, the line gets the same Sync Conflict markers. Screens bound to a token Figma changed aren't rewritten: they keep `var(--…)`.
- Push is refused while the Design System has Unpulled Changes, naming the tokens. A variable or style deleted in Figma isn't a change: the next Push makes it again.
- Check warns about tokens Figma can't hold (colors other than hex, lengths in units other than px or rem); Push leaves them out.

### Modes

DESIGN.md holds the default Mode and stays spec-pure. Other Modes (dark, high contrast, brand variants) go in `modes.yaml` next to it, which the tool owns until the DESIGN.md spec can express Modes (ADR-0004, ADR-0012):

```yaml
default: Light            # the default Mode's name: DESIGN.md's values (Default if left out)
modes:
  Dark:
    colors:
      surface: "#111111"
      text: "#eeeeee"
      heading: "{colors.text}"   # references follow the Mode's values
    spacing:
      lg: 32px
  High contrast:
    colors:
      text: "#000000"
```

- A Mode gives other values to DESIGN.md's `colors`, `spacing` and `rounded` tokens, the ones that become variables; every token it leaves out keeps the default's value. Typography stays as DESIGN.md has it in every Mode (Figma's text styles have no modes).
- Check rejects a token DESIGN.md doesn't have (`unknown-token`), other groups (`mode-group`), values variables can't take (`mode-value`), broken references (`broken-ref`), a Mode named like the default (`duplicate-mode`) and a file that doesn't parse (`modes-file`), and warns about low contrast in each Mode as in the default.
- Push gives the “Design System” collection a variable mode per Mode: the default mode renamed, the others added, found again by ID on later Pushes (renamed back if a designer renamed them), and removed when the file drops them. Every variable gets a value in every Mode, the default's where the Mode leaves it out. Figma's plan limits how many modes a collection has; Push explains when Figma refuses one.
- Pull writes designers' edits to a Mode's values into `modes.yaml`, merged against the Baseline like DESIGN.md: only the changed values are edited (a value the Mode left to the default is added under it), conflicts get the usual markers. Edits to the default mode go to DESIGN.md. Modes a designer adds or deletes aren't Pulled: Push makes deleted ones again.
- The Preview's Mode switcher shows every Screen in a Mode; `render_screen` takes `mode` (the CLI `--mode`). Frames in Figma show the default Mode.

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
