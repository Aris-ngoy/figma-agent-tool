# Figma Agent Tool

An MCP server plus a Figma development plugin that lets any MCP client work on the live Figma document.

## Packages

- `packages/protocol`: runtime-validated (zod) bridge messages and the shared test fixtures.
- `packages/mcp-server`: the MCP server (stdio) and the localhost WebSocket bridge the plugin connects to.
- `packages/figma-plugin`: the Figma plugin (sandbox command handler + UI iframe that owns the connection).

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

3. In Figma desktop: Plugins → Development → Import plugin from manifest… and pick `packages/figma-plugin/manifest.json`. Run it in the file you want to bridge; the panel shows whether it's connected, which file is bridged and the last command it ran.

   The plugin reconnects on its own (with backoff) if the MCP server restarts, and the server accepts it again after Figma reloads the plugin. Only one plugin window is bridged at a time: opening the plugin in another file replaces the older connection (the server logs a warning, and the older panel offers **Reconnect** to take the bridge back).
4. Ask your agent to call `get_status` to check the connection.
