// The MCP server's instructions: the agent skill (skill/SKILL.md) in brief,
// for MCP clients that don't load skills.
export const INSTRUCTIONS = `Design UI as files in a Design Project (design/ in the user's repo), see it, and sync it with Figma both ways. You do the design thinking; this server checks, renders, Pushes and Pulls. For the full guide, install the agent skill: \`npx figma-agent-tool skill\`.

Loop: init_design_project if there's no design/project.json (or adopt_file to start from the user's Figma file). Write DESIGN.md's tokens, then each Screen as design/screens/<name>.html. Run check_design_project after every edit and fix every error. Look at your work with render_screen. Use open_preview to show the user. Push when they want it in Figma.

Screens use the Screen Subset only, where everything has an exact Figma equivalent. A Screen is one <body style="display:flex">. <div style="display:flex"> is an auto-layout frame (flex-direction, gap, padding, justify-content, align-items, flex-wrap, overflow:hidden). An empty <div> is a rectangle. <p>, <span> and <h1>-<h6> are text, holding only text and <br>. <img> is an image, and <svg> with <path>s a vector. Sizes: px is fixed, none hugs, flex:1 and align-self:stretch fill. position:absolute takes left and top. Boxes take background, border-radius, border (1px solid #hex) and opacity. Text takes color, font-family, font-size, font-weight, font-style and text-align, with no inheritance. Colors are #hex and lengths px. There's no grid, margin, class, shadow or gradient. Use DESIGN.md's tokens as CSS variables named after their path, like var(--colors-primary) and var(--spacing-md). Push binds them to Figma variables and text styles.

Prototype Links: href="<screen>.html" on any element (or <a>), with data-transition="push left 300ms ease-out" and the like. Components: components/<name>.html holds one <component style="display:flex" data-variant="kind=primary"> per variant, with data-property="label" on text. components/<name>.json links an existing one ({"key"} from a library, or {"id"} in the file). Screens use <app-button kind="secondary" label="Go">, which holds nothing. Directions, alternatives the user compares, go in screens/<screen>.directions/<direction>.html. Only the user picks one, then call choose_direction. Other Modes (dark, …) go in modes.yaml, never in DESIGN.md.

Etiquette with designers:
- Pull before you edit or Push whenever the project has a Linked File. Push is refused while Figma has Unpulled Changes.
- The first Push returns confirm_link: ask the user whether the named file is right before calling push with confirmLink. Never relink_file or adopt_file without the user's go-ahead.
- Keep every data-key that Push writes. Never copy one onto another element, and never invent one.
- A <figma-owned> element is a designer's layer. You may move, resize, rename or delete it, but never give it content.
- A Sync Conflict is marked <<<<<<< Design Project / ======= / >>>>>>> Figma. Keep the designer's side unless the user asked for yours, delete the markers, check, then Push.
- Never edit design/sync/.

The other tools (get_node, create_nodes, set_reactions, trace_flow, export_screen_markdown, run_visual_qa, …) work on the live Figma file through the Plugin, including the frames Push made. get_status reports the connection, the Linked File, Unpulled Changes and Sync Conflicts.`;
