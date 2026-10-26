# Adopt keeps the file as designers made it

Adopt starts a Design Project from an existing Figma file: its variables and text styles become DESIGN.md (and `modes.yaml`), chosen frames become Screens, and the file becomes the Linked File. It adopts only what Push would write back unchanged, so a Push straight after Adopt changes nothing in Figma, and Pull then finds nothing to merge.

- Tokens come from the collection with the most color and number variables; its other modes become Modes. Names map to token paths (`Color/Primary` → `colors.primary`; a number is `rounded` when its name or scope says radius, `spacing` otherwise), and the Design System Baseline records each variable's and style's Figma name (`names`), which Push keeps instead of naming them by path. A token Push would send otherwise than Figma has it (a text style DESIGN.md can't describe, an alias to something not adopted) is left in Figma and listed, as are other collections and string or boolean variables.
- A frame is read like a Pull with no Baseline (`adoptFrame`): every layer is new, wherever designers bound a layer to an adopted variable or text style and it shows that value, the Screen gets the token's `var(--…)`, so Push binds it again. Instances become Linked Components (the file's own by node ID, a library's by key), NAVIGATEs between adopted frames Prototype Links, and everything else Figma-owned Elements. A top-level frame without auto layout can't be a Screen and is refused, naming it.
- Frames aren't moved: the first frame's page is the Screens Page, and frames on other pages are updated where they are, by node ID. Pages and frames not chosen stay the designers'.
- Adopt asks to confirm the file and frames before writing anything (like the first Push), and is refused into a folder that already has a Design Project.

## Consequences

- The Screens Page is a page designers also use; Push only ever touches frames with a Baseline, and places new Screens' frames on it.
- Designers' variable collection keeps its name, not “Design System”.
- Not yet: adopting more frames into an existing Design Project, Defined Components from a file's component sets (they're Linked), and paint or effect styles.
