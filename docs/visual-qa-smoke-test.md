# Visual QA smoke test

Automated tests drive the MCP server with a fake plugin and a fake Yoqa runner. This checklist covers what they can't: real Figma, a booted simulator and a physical device. Run it before a release, or after changing the bridge, the Yoqa adapter, export or comparison.

## Setup

- [ ] `bun install`, then register the MCP server in your client (see the README's Setup).
- [ ] Figma desktop with a sample file holding a screen frame sized like the target device (for example 393×852 for an iPhone 16 Pro), with a timestamp or avatar layer you can ignore.
- [ ] The plugin imported from `packages/figma-plugin/manifest.json` and running in that file; `get_status` reports `bridge.connected: true` and the file name.
- [ ] A React Native/Expo app that renders the same screen, with a deep link to it.
- [ ] Yoqa installed and running (`yoqa serve`); `get_status` reports `runner.reachable: true`.

## iOS simulator

- [ ] `list_devices` shows the booted simulator; `connect_device` connects it, and calling it again returns `reused: true`.
- [ ] `run_visual_qa` with the frame and the deep link: the device lands on the screen, `exportScale` is the device pixel ratio (3 on a Pro iPhone) and the export and capture in the run folder are the same pixel size.
- [ ] A matching screen passes, with the iOS status bar and home indicator masked by default.
- [ ] Change a color or spacing in the app: the run fails, a region boxes the change in `diff.png`, and its layers name the Figma node there.
- [ ] Add something to the app that the design lacks: its region lists no layers.
- [ ] `ignoreNodes` with the timestamp layer takes it out of the score.
- [ ] `report.md` renders in a GitHub PR comment or Markdown preview with all three images (the images upload with the report, or link them from CI artifacts).
- [ ] Pass a frame for another device size: the run fails with the aspect-ratio error and both image paths.
- [ ] Navigate with a broken step (an unknown label): the error names `actions[i]` and nothing is captured.
- [ ] Undo history in Figma is untouched: run_visual_qa only reads and exports.

## Physical devices

- [ ] Physical iPhone (trusted, runner signed, see Yoqa's docs): connect it, run `run_visual_qa` with the deep link and check the capture is the real screen at its native resolution.
- [ ] Physical Android device (USB debugging accepted): same, and check the Android masks (top and bottom 48dp) are applied by default.
- [ ] Android emulator: same as the physical device. Fractional pixel ratios (for example 2.625) export at that scale and still compare.

## Failure messages

- [ ] Close the plugin: `run_visual_qa` says no Figma plugin is connected, before touching the device.
- [ ] Stop Yoqa: the error explains how to start it (`yoqa serve`).
- [ ] No active device: the error says to call `list_devices`, then `connect_device`.

Record the date, Figma version, Yoqa version and devices in the PR that ran the checklist.
