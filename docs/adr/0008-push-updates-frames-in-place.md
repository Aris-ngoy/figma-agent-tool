# Push updates frames in place, keeping node IDs

Push matches each element of a Screen to the layer it made last time and updates that layer, rather than deleting and recreating the frame. Figma-only interactions, Figma-owned Elements, designer comments and Visual QA's ignored layers all refer to node IDs, so a rebuilding Push would break every one of them. The cost is that the tool keeps a map from Screen elements to node IDs alongside each Baseline, and Push has to diff the Screen against it.
