# Screens are a restricted HTML subset, not free HTML or Figma JSON

A Screen is HTML limited to what has an exact Figma equivalent (flex layout as auto layout, Design System tokens as CSS variables, images and inline SVG; no scripts, no grid), and the tool rejects anything outside it with an error the Agent can act on. That keeps agents and developers writing the language they know best while making two-way sync exact, which ADR-0001 depends on.

## Considered Options

- **Free HTML/CSS** (Stitch's approach): easiest for agents, but converting it to Figma means laying it out in a browser and measuring boxes, which yields absolutely positioned layers with no auto layout, and Pull could never rebuild the Agent's HTML.
- **A Figma-shaped JSON tree** (the `create_nodes` shape): lossless both ways, but agents and developers read and write it far less fluently, and the Preview would need its own renderer.
