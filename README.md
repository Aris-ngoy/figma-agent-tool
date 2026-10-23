# Figma Agent Tool

An MCP server plus a Figma development plugin that lets any MCP client work on the live Figma document.

## Packages

- `packages/protocol`: runtime-validated (zod) bridge messages and the shared test fixtures.
- `packages/mcp-server`: the MCP server (stdio) and the localhost WebSocket bridge the plugin connects to.
- `packages/figma-plugin`: the Figma plugin (sandbox command handler + UI iframe that owns the connection).
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

## Devices (Yoqa)

`list_devices`, `connect_device` and `capture_device_screenshot` reach iOS simulators, Android emulators and physical iOS and Android devices through the [Yoqa](https://yoqa.mintlify.app/docs/cli) local runner's HTTP API. **Yoqa is installed separately** (`@yoqa/runner`, not bundled with or imported by this MIT package). Start it with `yoqa serve` (or the `yoqa-runner` bin) before using the device tools. Device setup such as the Appium runtime, iOS signing and trusting the runner on a physical iPhone is Yoqa's job; its errors are passed through to the agent.

- `list_devices`: devices on both platforms (or one, with `platform`), with kind (`simulator` / `emulator` / `physical`) and the runner's status string.
- `connect_device`: reuses the active session when it is already that device. Yoqa holds one session at a time, so connecting a different device moves the session to it; the result names the device it replaced.
- `capture_device_screenshot`: writes the active device's screen to the artifacts folder and returns its path and pixel size.
- `get_status` reports whether the runner is reachable and which device is active.

## Artifacts

Image outputs such as `export_node_image` and `capture_device_screenshot` are written to `.figma-agent/` in the server's working directory and returned as file paths (inline images only on request). Set `FIGMA_AGENT_ARTIFACTS_DIR` to write them elsewhere. Add `.figma-agent/` to your project's `.gitignore`; this repo already ignores it.

## Editing

`create_nodes` and `update_nodes` take batches: a whole screen (frames with nested `children`, text, rectangles, component instances) can be built in one call. Properties use the same shape `get_node` returns. Each item succeeds or fails on its own, and the result lists every item in input order with its new ID or an error code (`font_not_found`, `component_not_found`, `unsupported_property`, …). Each batch is committed as one undo step, so Cmd+Z in Figma reverts the agent's last call.

## Prototype reactions

`get_reactions`, `set_reactions` and `remove_reactions` read and wire a node's prototype interactions. Reactions use the Figma Plugin API's shape: a `trigger` (on click, hover, press, drag, after delay, mouse enter/leave/up/down, key or gamepad) and an `actions` array whose NODE actions carry a `destinationId`, a `navigation` and a `transition` (null for instant, or dissolve, smart animate, move in/out, push, slide in/out with a direction) with an easing preset, custom cubic bezier or spring and a duration in seconds. Every trigger and action type round-trips: reactions read with `get_reactions` can be written back unchanged. `set_reactions` replaces (default) or appends; `remove_reactions` clears all reactions or those matching a trigger type and/or destination. NAVIGATE, OVERLAY and SWAP must go to a top-level frame and CHANGE_TO to a component variant; otherwise the call fails with `invalid_destination` and nothing is written. Each write is one undo step.

## Comparing images

`compare_images` diffs two local PNGs, so it needs neither Figma nor a device and also works in CI against stored baselines. Pass a `designPath` (for example a frame exported at 1x) and an `actualPath` (for example a device screenshot). The design is scaled to the actual image's pixel size (`scale: "auto"` derives the ratio from the widths, so a 393pt frame lines up with a 1179px capture; or pass the device pixel ratio). If the aspect ratios differ by more than `aspectTolerance` (default 1%), the tool returns an error instead of a score.

- `platform`: `ios` masks the top 59pt and bottom 34pt, and `android` masks the top 48dp and bottom 48dp (status bar and home indicator / navigation bar). The default is `none`. Masks and `ignoreRegions` are given in design image pixels, so platform masks assume a 1x design.
- `threshold` (default `0.1`), `detectAntiAliasing` (default on) and `mismatchBudget` (percent of unmasked pixels, default `0.5`) control how strict the comparison is.
- The result reports mismatch %, pass/fail, mismatched regions as bounding boxes (in actual-image pixels), the masks applied, and the path of a diff image in the artifacts folder (red: mismatch, yellow: anti-aliasing, blue: masked). Set `markdown: true` for a summary you can paste into a PR, and `inline: true` to get the diff image in the result.
