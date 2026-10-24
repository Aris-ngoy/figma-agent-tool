# Pull keeps what Screens can't express as Figma-owned Elements

When a designer adds something in Figma that the Screen Subset can't express exactly (a blur, a boolean shape, a plugin's custom layer), Pull writes a Figma-owned Element that refers to the layer, the Preview shows an exported image of it, and Push leaves the layer untouched. Pull never fails and never silently drops a designer's work, at the price of Screens holding parts the Agent can see and position but not edit. Where an exact mapping exists (vectors as inline SVG, absolute positioning), the subset is widened instead.
