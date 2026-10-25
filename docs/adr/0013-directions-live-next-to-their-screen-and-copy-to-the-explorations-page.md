# Directions live next to their Screen and copy to the Explorations Page

A Screen's Directions are files in `screens/<Screen>.directions/`, one per Direction, in the Screen Subset like any Screen. The folder name ties them to their Screen without a manifest, a Screen that doesn't exist yet can have Directions, and choosing one is a file operation: it is written over `screens/<Screen>.html` (its image `src`s rewritten for the Screen's folder) and the folder is deleted, leaving git to keep the others. Choosing keeps the Screen's Baseline, so the next Push updates the same frame in place; elements whose `data-key` the Direction kept keep their layers.

Directions never reach the Screens Page. Pushing them is a separate request (`push` with `directions`, a `push_explorations` command) that copies them as new frames labelled `<Screen> / <Direction>`, in a row per Screen on the Explorations Page, replacing that Screen's earlier copies where they stood. Copies carry only an `exploration` marker naming their Screen, not the `screen` link frames of Screens have, so Pull (which finds frames by ID or by that link) can never mistake one for a Screen.

## Consequences

- Copies have no Baselines or node ID maps: Pull ignores them, designers' edits to them stay in Figma, and pushing Directions again throws those edits away along with the old copies.
- A Direction is keyed only for the push; its file isn't rewritten, so a Direction copied from the Screen keeps the Screen's keys for when it's chosen.
- Copies are pushed with token values rather than variable bindings, so pushing Directions needs neither the Design System's Baseline nor its Unpulled Changes check.
- Figma-owned Elements in a Direction copy (`clone`) the layer of the Screen's element with the same key; one whose key isn't in the Screen's Baseline is refused, as Push refuses it for Screens.
- A Direction inherits its Screen's Screen Size (the Screen's `<body>` override, else the project's) unless its own `<body>` sets one.
