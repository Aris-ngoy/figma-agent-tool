---
name: figma-agent-tool
description: Design UI as files in a Design Project (design/), preview it, and sync it with Figma both ways through the figma-agent-tool MCP server or CLI. Use when the user asks to design, mock up or prototype screens, compare design directions, write a DESIGN.md, or push designs to or pull designers' edits from Figma.
---

# Designing with figma-agent-tool

You design Screens as HTML files in a Design Project in the user's repo. The tool checks them, previews and renders them, Pushes them into Figma as real auto-layout frames and Pulls designers' edits back. It has no model of its own: all of the design thinking is yours.

Each step works through MCP tools or the CLI, which do the same thing. Use the MCP tools when you have them. Otherwise run `npx figma-agent-tool <command>` (`--dir <folder>` if the Design Project isn't `design/`).

| Step | MCP tool | CLI |
| --- | --- | --- |
| Create the Design Project | `init_design_project` | `init [--size 393x852]` |
| Validate everything | `check_design_project` | `check` |
| See a Screen as a PNG | `render_screen` | `render <screen> [--direction d] [--mode m]` |
| Show the user the Preview | `open_preview` | `preview` |
| Send to Figma | `push` | `push [<screen>…] [--yes] [--directions]` |
| Bring designers' edits back | `pull` | `pull` |
| Make a Direction the Screen | `choose_direction` | `choose <screen> <direction>` |
| Start from an existing Figma file | `adopt_file` | `adopt [<frame>…] [--yes]` |
| Status, Unpulled Changes, Sync Conflicts | `get_status` | — |

## The loop

1. If there's no `design/project.json`, run `init`. If the user has a Figma file to start from, Adopt it instead (below).
2. Write or update `design/DESIGN.md` first (below), then the Screens.
3. Write each Screen as `design/screens/<name>.html`.
4. Run Check after every edit, and fix every error before you go on. Each error names the file, line, element and rule, and says how to fix it.
5. Look at your work: Render the Screen and view the PNG. Fix anything that looks wrong.
6. Push when the user wants the Screens in Figma. Pull whenever designers may have edited them.

## The Design Project

```
design/
  project.json          the default Screen Size, the Screens Page's name
  DESIGN.md             the Design System: tokens (YAML front matter) and prose
  modes.yaml            optional: other Modes (dark, …)
  screens/<name>.html   one Screen per file
  screens/<name>.directions/<direction>.html
                        optional: alternative versions of a Screen
  components/<name>.html | <name>.json
                        Defined and Linked Components
  assets/               images Screens use
  sync/                 the tool's: Baselines, the Linked File, exports. Never edit it; commit it.
```

## Screens: the Screen Subset

A Screen is one `<body>` written in the Screen Subset, a restricted HTML in which every element and property has an exact Figma equivalent. Anything outside it fails Check, so don't reach for other HTML or CSS.

```html screens/login.html
<body style="display:flex; flex-direction:column; gap:var(--spacing-lg); padding:var(--spacing-lg); background:var(--colors-surface)">
  <h1 style="font-size:28px; font-weight:700; color:var(--colors-text)">Welcome back</h1>
  <div data-name="Email field" style="display:flex; align-self:stretch; padding:12px 16px; border:1px solid #d0d5dd; border-radius:var(--rounded-md)">
    <p style="color:#667085">you@example.com</p>
  </div>
  <a href="home.html" data-transition="push left" data-name="Sign in" style="display:flex; justify-content:center; align-self:stretch; padding:12px 16px; background:var(--colors-primary); border-radius:var(--rounded-md)">
    <p style="font-weight:600; color:var(--colors-on-primary)">Sign in</p>
  </a>
  <div style="height:1px; align-self:stretch; background:#eaecf0"></div>
</body>
```

Elements:

- `<body style="display:flex">` is the Screen's frame. It has the project's Screen Size unless it sets both `width` and `height`.
- `<div style="display:flex">` is an auto-layout frame. A `<div>` without `display` and without children is a rectangle. There's no other `display`: no grid, no block.
- `<p>`, `<span>` and `<h1>`–`<h6>` are text. They hold only text and `<br>`. Text can't sit directly in a `<div>`.
- `<img src="../assets/x.png">` is an image. `object-fit` is `cover` (the default) or `contain`.
- `<svg width height viewBox>` holding `<path d="…">`s is a vector. Paths use M L H V C S Q T Z, with no arcs. The svg's style takes `fill`, `stroke`, `stroke-width`, `stroke-linecap` and `stroke-linejoin`.
- `<a href="other.html">` is a frame (with `display:flex`), text (when it holds text) or a rectangle.
- A Component's name (`<app-button>`) is an instance of it (see Components).

Styles go in `style`, and nothing inherits: put text styles on the text elements themselves.

- Frames: `flex-direction` (`row` by default), `flex-wrap`, `gap`, `padding`, `justify-content` (`flex-start`, `center`, `flex-end`, `space-between`), `align-items` (`flex-start`, `center`, `flex-end`) and `overflow:hidden`.
- Sizing: a `px` `width` or `height` is fixed and none hugs the content. `flex:1` fills the parent's main axis and `align-self:stretch` its cross axis. Don't combine a fill with a fixed size on the same axis.
- Boxes (frames, rectangles, images): `background` (a color), `border-radius` (one to four values), `border: 1px solid #rrggbb` (or `border-width` and `border-color`) and `opacity`.
- Text: `color`, `font-family`, `font-size`, `font-weight` (100–900), `font-style` and `text-align`.
- `position:absolute` with both `left` and `top` in px places an element outside its parent's auto layout. It can't fill its parent.
- Values: lengths in `px` (or `rem`, or `0`); colors as `#rrggbb` or `#rgb`. No `%`, `em`, `rgb()`, gradients, shadows, transforms or `margin`: use `gap` and `padding`.
- Attributes: `style`, `data-name` (the layer's name in Figma), `href` and `data-transition`, plus `src` on images and the svg ones. No `class` or `id`.

Use the Design System's tokens wherever one fits, as CSS variables named after their path: `colors.primary` is `var(--colors-primary)`, `spacing.md` is `var(--spacing-md)` and `typography.body-md.fontSize` is `var(--typography-body-md-font-size)`. Push binds those values to Figma variables and text styles, so the file stays on-system.

Give layers that matter a `data-name` (`Sign in`, `Email field`): designers see these names in Figma.

### Keys

Push writes a `data-key="e12"` into every element. It ties the element to its Figma layer, which is how designers' edits and comments survive.

- Keep the `data-key`s when you edit an element, move it or restyle it.
- Never copy a `data-key` onto another element, and never invent one. A new element gets its key at the next Push.
- When you rewrite a Screen, keep the keys of the elements that are still there. Otherwise designers' work on those layers is lost.

### Figma-owned Elements

Pull turns a layer the Screen Subset can't express (shadows, gradients, rotated layers, frames without auto layout, …) into a placeholder:

```html
<figma-owned data-key="e8" data-name="Star" style="width:40px; height:38px"></figma-owned>
```

It shows the designers' layer in the Preview and in Renders. You may move it (in the auto layout, or with `position`), resize it (`width`, `height`, `flex`, `align-self`), rename it (`data-name`) or delete it. Never give it content or other styles, never change its `data-key`, and never write one yourself.

## Prototype Links

`href="<screen>.html"` on any element but `<body>` makes it an on-click link to that Screen in Figma's prototype. The Preview follows it too. `data-transition` animates it the way CSS's `transition` shorthand reads: a type, then a direction for `move-in`, `move-out`, `push`, `slide-in` and `slide-out` (`left`, `right`, `top` or `bottom`), then an optional duration and easing.

- Types: `instant` (the default), `dissolve`, `smart-animate`, `scroll-animate`, `move-in`, `move-out`, `push`, `slide-in`, `slide-out`.
- Duration: `300ms` by default. Easing: `ease-out` by default, or `ease-in`, `ease-in-out`, `linear`, `ease-in-back`, `ease-out-back`, `ease-in-out-back`, `gentle`, `quick`, `bouncy` or `slow`.
- For example: `data-transition="smart-animate 400ms ease-in-out"`.

Check rejects links to Screens that don't exist. Hover effects, overlays, drag and Motion can't be written in a Screen. Designers add them in Figma, and Push leaves them alone.

## Components

A Component is a reusable part, named in lower case with a hyphen (`app-button`). It's used in Screens as a custom element of that name.

A Defined Component is `components/<name>.html`, holding one `<component style="display:flex">` frame per variant:

```html components/app-button.html
<component data-variant="kind=primary" style="display:flex; justify-content:center; padding:12px 16px; background:var(--colors-primary); border-radius:var(--rounded-md)">
  <p data-property="label" style="font-weight:600; color:var(--colors-on-primary)">Continue</p>
</component>
<component data-variant="kind=secondary" style="display:flex; justify-content:center; padding:12px 16px; border:1px solid var(--colors-primary); border-radius:var(--rounded-md)">
  <p data-property="label" style="font-weight:600; color:var(--colors-primary)">Continue</p>
</component>
```

- `data-variant="name=value, …"` names each variant. Every variant uses the same property names, in the same order. A Component without variants has a single `<component>` and no `data-variant`.
- `data-property="label"` on a text makes it a text property. Its default is that text, and every variant that has it shows the same default.
- Components can't contain instances or Prototype Links.

An instance sets properties as attributes and holds nothing. Its `style` only places and sizes it (`width`, `height`, `flex`, `align-self`, `position`, `left`, `top`). It also takes `data-name` and `href`:

```html screens/home.html
<body style="display:flex; flex-direction:column; gap:var(--spacing-md); padding:var(--spacing-lg); background:var(--colors-surface)">
  <h1 style="font-size:28px; font-weight:700; color:var(--colors-text)">Home</h1>
  <app-button label="Get started" style="align-self:stretch"></app-button>
  <app-button kind="secondary" label="Log out" href="login.html"></app-button>
</body>
```

A Linked Component, `components/<name>.json`, points at a component that already exists: `{ "key": "…" }` for a library's (the user can copy the key from Figma) or `{ "id": "…" }` for one in the Linked File. Prefer the team's real components over Defining look-alikes when the user has them. The Preview draws a Linked Component as a grey box, and Check validates its instances' attributes once a Push has recorded its properties.

## DESIGN.md: the Design System

`DESIGN.md` follows Google Labs' [DESIGN.md format](https://github.com/google-labs-code/design.md/blob/main/docs/spec.md). Tokens go in YAML front matter, followed by prose that explains how to use them:

```markdown DESIGN.md
---
version: alpha
name: Acme
colors:
  primary: "#3366ff"
  on-primary: "#ffffff"
  surface: "#ffffff"
  text: "#111111"
  muted: "{colors.text}"
typography:
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24px
rounded:
  md: 8px
spacing:
  sm: 8px
  md: 16px
  lg: 24px
---

# Acme

## Overview

Calm and direct: one primary action per Screen, generous whitespace.

## Colors

Primary is only for the main action. Text on primary uses on-primary.
```

- `colors`, `spacing` and `rounded` become Figma variables, and each `typography` token becomes a text style. Write colors as hex and lengths in `px`; Figma can't hold other units.
- A reference such as `"{colors.text}"` makes the token an alias of another.
- Check runs the spec's own linter, WCAG contrast included. Fix errors, and fix contrast warnings unless the user decides otherwise.
- Other Modes (dark, high contrast) go in `modes.yaml` and never in DESIGN.md, which stays spec-pure:

  ```yaml
  default: Light
  modes:
    Dark:
      colors:
        surface: "#111111"
        text: "#eeeeee"
  ```

  A Mode overrides only `colors`, `spacing` and `rounded` tokens that DESIGN.md has. Render with `mode` to see one, and design Screens with tokens so that every Mode works.

### Writing DESIGN.md from an existing codebase

When the repo already has UI code, the Design System should match it rather than be invented:

1. Find where the code defines its look: Tailwind's config or `@theme`, CSS custom properties, a theme object (MUI, Chakra, styled-components), design token JSON, iOS asset catalogs, Android `colors.xml` or Compose themes.
2. Take the colors that are actually used. Name them by role (`primary`, `on-primary`, `surface`, `on-surface`, `error`) rather than by hue, and write a value the code uses in another token's place as a reference.
3. Take the type scale from the code's text styles: family, size, weight, line height and letter spacing, all in `px`.
4. Take the spacing scale and corner radii, converting `rem` to `px` (×16).
5. Write a light Mode in DESIGN.md and put a dark theme, if the code has one, in `modes.yaml`.
6. Describe in the prose how the code uses the tokens: which color is for what, the button styles, the density.
7. Run Check, and Render a Screen built from the tokens to compare it with the app.

## Directions

When the user wants options to compare, write each one as `screens/<screen>.directions/<direction>.html` (`login.directions/bold.html`). A Direction is a Screen in every way, but its image `src`s are relative to its own folder (`../../assets/logo.png`). Start a Direction from a copy of the Screen, keys and all, so that choosing it later updates the Figma frame in place.

- The Preview shows a Screen's Directions side by side with it. Render takes `direction`.
- Only the user picks a Direction. Then call `choose_direction`: it writes the Direction over the Screen and deletes the other Directions.
- `push` with `directions: true` copies the Directions to the Explorations Page for designers to compare. A regular Push never sends Directions.

## Push and Pull etiquette

Figma is shared with designers. Their work matters as much as yours.

- **Pull before you edit and before you Push**, whenever the Design Project has a Linked File. Push is refused while any frame, Component or the Design System has Unpulled Changes, and the refusal names them: Pull, then Push again.
- **The first Push links a file.** It returns `status: "confirm_link"` with the Bridged File's name. Ask the user whether that's the right file, and only call `push` again with `confirmLink: true` once they say yes (CLI: `--yes`). Never relink (`relink_file`) or Adopt without the user's explicit go-ahead.
- **Wrong file.** Push and Pull refuse while the Figma file open in the Plugin isn't the Linked File, naming both. Ask the user to open the right file; don't relink to get around it.
- **Sync Conflicts.** When both sides changed the same element or token, Pull writes markers into the file:

  ```
  <<<<<<< Design Project
  <p data-key="e6" style="color:#ffffff">Log in</p>
  =======
  <p data-key="e6" style="color:#ffffff">Continue</p>
  >>>>>>> Figma
  ```

  Resolve each one: keep the designer's side unless the user asked for your change, or combine the two. Delete the markers, run Check, then Push. Push is refused while any markers remain. Never resolve a conflict by deleting both sides.
- **Respect what Pull brings back.** After a Pull, read the Screens again before you edit, and keep the designers' changes. Never touch a Figma-owned Element's content, and never edit `sync/`.
- If no Plugin is connected, ask the user to open the Figma Agent Tool plugin in their file. The CLI's `push`, `pull`, `relink` and `adopt` wait for it, but can't run while the MCP server is running, because it holds the Plugin's port.

## Adopting an existing Figma file

When designers already have a file, start from it: `adopt_file` without `frames` lists the file's top-level frames by page. Ask the user which ones to adopt, call it again with them, show the user what it will adopt, and call once more with `confirm: true` after they agree. Their variables and text styles become DESIGN.md, the frames become Screens, and the file becomes the Linked File. Adopt refuses a folder that already holds a Design Project.
