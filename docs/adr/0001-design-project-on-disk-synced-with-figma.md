# The Design Project on disk is the source of truth, synced with Figma both ways

To be "like Stitch, for any agent", the Agent designs Screens as files in a Design Project in the user's repo, which a local preview renders; the user Pushes Screens to Figma and Pulls Figma edits back. Files are the one interface every agent and harness has, with or without MCP, and two-way sync keeps Figma a working partner rather than a dump target. The v1 tools that edit live Figma stay as the Figma side of the product.

## Considered Options

- **Figma as the only canvas** (v1 plus Stitch-like generation tools): no new surface, but tied to MCP and to Figma being open, and nothing for the repo to keep.
- **A local canvas with one-way export to Figma**: closest to Stitch, but Figma edits would be lost on the next export.
- **Clipboard paste into Figma, no Plugin**: Figma's clipboard format is undocumented and proprietary, so Push goes through the Plugin, published to the Figma Community for a one-click install. The REST API can't create nodes.
