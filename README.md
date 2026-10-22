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

   The bridge listens on `ws://127.0.0.1:3055` (localhost only). Set `FIGMA_AGENT_BRIDGE_PORT` to change it; the plugin currently always connects to the default port.

3. In Figma desktop: Plugins → Development → Import plugin from manifest… and pick `packages/figma-plugin/manifest.json`. Run it in the file you want to bridge; the panel shows whether it's connected and which file is bridged.
4. Ask your agent to call `get_status` to check the connection.
