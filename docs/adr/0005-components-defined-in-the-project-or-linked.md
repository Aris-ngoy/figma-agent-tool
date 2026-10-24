# Components are Defined in the Design Project or Linked to Figma

A Component is either Defined, as a Screen Subset file with its variants that Screens use as a custom element and that Pushes as a Figma component set, or Linked to an existing component in the Linked File or a library. DESIGN.md's `components` section is only style tokens, not structure, so it can't be the Component model; it stays as the style rules Components follow.

## Considered Options

- **No structural components**: simplest, but designers would get loose frames with no instances to work with.
- **Figma components only**: fits teams with a library, but leaves a fresh Design Project unable to build any. Kept as the Linked option.
