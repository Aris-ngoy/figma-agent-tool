# The Linked File is identified by a Link ID stored in the file

Figma only gives a plugin the file key when it's private (or a development plugin with `enablePrivatePluginApi`); the Community plugin gets none. So the first Push writes a random Link ID into the file's shared plugin data and into the Design Project's `sync/link.json`, and the plugin reports it in every handshake. Push and Pull are refused while the Bridged File's Link ID isn't the Design Project's, and where both sides do have a file key, the keys must match too.

## Consequences

Duplicating a Figma file copies its plugin data, so the copy claims the same Link ID: without a file key the tool can't tell them apart. Frames are still matched by node ID, so pushing into the copy creates new frames rather than overwriting anything, and the frames' own shared plugin data (their Screen, each layer's element key) is what keeps a frame linked through renames, moves and cut and paste.
