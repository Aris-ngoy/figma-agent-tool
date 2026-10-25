# Prototype Links are `href`s, and Push owns only on-click NAVIGATEs to Screens' frames

A Prototype Link is an `href="<screen>.html"` on any element but `<body>` (an `<a>` is a frame, text or rectangle like the other tags), with an optional `data-transition` written like CSS (`push left 200ms ease-in-out`; instant by default, 300ms and ease-out when left out). It pushes as the layer's on-click NAVIGATE to that Screen's frame, and Pull reads one back only from a reaction that is exactly that: an ON_CLICK with a single NODE NAVIGATE to a frame a Screen has (or had), with no transition or one Screens can express (preset easings, layers not matched). Every other reaction is Figma-only: Pull leaves it out of the Screen, and Push leaves it where it is, along with every reaction on a Screen's own frame and on Figma-owned Elements.

Push and Pull must agree on which reactions are Prototype Links, or Push would delete a designer's interaction that Pull never wrote into the Screen. So both decide by the same function (`prototypeLink` in the protocol) and by the same set of Screen frames, which the server computes from the Baselines' frame IDs and the frames it read, and sends with the push (`screenFrames`). Including the Baselines' IDs means a link to a Screen whose frame was deleted and pushed anew still reads as that Screen's, so it isn't an Unpulled Change, and the next Push points it at the new frame.

## Consequences

- Links are set after every frame of the push exists, so Screens pushed together can link to each other; a push of some Screens gets the frames of the others (`frames`), and the server refuses a link to a Screen that has no frame yet.
- A link whose destination and transition didn't change is left as Figma has it, so fields Screens don't express (like `resetScrollPosition`) survive Pushes; changing the link in the Screen resets them.
- Pull writes a reaction a designer gave a custom curve or matched layers as nothing, and the Screen loses that `href`: the reaction itself stays in Figma as a Figma-only one.
- The Preview follows links by navigating to the linked Screen (in the same Mode); it doesn't animate transitions.
