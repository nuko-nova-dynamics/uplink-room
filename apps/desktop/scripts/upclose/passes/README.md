# Interaction passes

Run only on the pinned Linux gym snapshot. These scripts refuse to start on
macOS. They use the shared `openGym`, `showState`, `resize`, `Finding` and
`runPaths` contract. The box runner sends committed HEAD only.

```sh
apps/desktop/scripts/gym-box/run.sh gym173-passes .scratch/upclose-passes -- \
  bash -c 'bash scripts/upclose/passes/run-all.sh "$OUT" 6'
```

A single process supports selected passes, state ids, or a one-based shard:

```sh
node scripts/upclose/passes/run.ts "$OUT" \
  --passes mouse,keyboard,motion,overflow,detector \
  --states inbox,channel --shard 1/2
```

Each process owns one Electron PID and closes it in `finally`. Each shard has
its own Xvfb display. The local Node inspector positions and sizes the box's
window and reads native image regions without changing the video viewport.
The shared loader is wrapped to recognize the isolated inventory roots.
The launcher and inventory source are unchanged. The gym adds an Inbox shortcut
fixture and a mutation receipt log so Allow and Settle can be checked.

The mouse pass records every initially visible control's cursor, including disabled controls, and a 5 by 5
hit grid two CSS pixels inside and outside the box, accounting for rounded
corners, plus tooltip crops. A nonempty native `title` and accessible name satisfy the tooltip check. Keyboard preserves open overlays when it starts and records tab stops
until a cycle repeats, allowing at least 200 presses and enough for two passes
through the document's control count, plus focus crops, border pixel
differences, menu traversal and eligible Inbox shortcuts. `order.json` is the
stop list; `cycle.json` contains cycle metadata. Composite navigation follows
`aria-activedescendant` when present. Only menu and popover items are traversed
for deeper levels; dialog controls are checked for focus and Escape. Only modal dialogs must trap Tab; a modeless panel keeps the rest of the page reachable. The keyboard video includes the tab traversal; overlay
and shortcut screenshots are separate. Motion records root tokens, keyframes,
computed timings, repeating activity, frame strips and 60 fps video. An early
observer retains entry animations while the shared loader settles. Identical
input sequences share a capture, and each observed animation gets its own
frames and a link to the interaction video. Reduced motion keeps static frames
when the corresponding normal interaction moves. Overflow
captures both standard and narrow windows for every state, including inventory
long-content and many-item states. Ancestors, descendants and named avatar
stacks are excluded from overlap findings. Hidden 1 by 1 pixel accessibility
labels are excluded from text-clipping findings. The detector always runs from the
repository root with the pinned Impeccable version.

The source inventory, including step corrections, is
`src/renderer/gym/inventory.json`. Skipped menu actions and missing motion targets remain in
coverage artifacts. `pass-error` means the pass did not complete for that state
and theme; it is not a UI finding.

`run-all.sh` merges the five findings files and produces `passes-summary.json`,
`passes-report.md`, and the shared `report.json` and `report.md`. Artifacts stay outside Git. Review measurements before
turning them into UI changes: overlap candidates can include intentionally
layered content, and image differences alone do not establish focus contrast.

`run-all.sh <out> <shards> [passes] [states] [--overlays-only]` can rerun selected
work. The last flag runs keyboard overlay and Inbox shortcut checks without repeating tab videos.
The normal keyboard pass always includes those checks.

`node scripts/upclose/passes/motion-recheck.ts <run>` rechecks the recorded
keyframe easing and known live-spinner classifications without opening a
window. Its correction ledger is `motion-recheck.json`.

`node scripts/upclose/passes/captured-recheck.ts <run>` reapplies the pure clipping
rule to saved measurements, names detector findings from their `antipattern`
field, and runs the motion recheck. It does not launch Electron. The Inbox menu steps in the source inventory use ArrowDown before the shortcut.

Calibration uses nearest ancestor ownership, CSS selector specificity and the
current scene to resolve inventory aliases. Scene declarations, generic primitives
and unique view roots take precedence. If none owns the element, an unambiguous
inventory root provides its owner. This keeps a shared class from displacing a
declared owner on another screen. Excalidraw, xterm and PDF.js contents
are outside every pass; surrounding controls remain in scope. During Tab
traversal those library roots are temporarily inert, so terminal key handlers
cannot consume the traversal. Their original inert attributes are restored
afterward. Painted overlap
rectangles are clipped by their scroll ancestors and the viewport. Overlay
layers and avatar stacks are intentional; ordinary app overlap remains open.
Hit testing accepts rounded-corner expansion and accounts for one CSS pixel of
edge rasterization. Cursor expectations distinguish editable, disabled and
clickable controls. Focus comparisons wait for rendered frames around normal Tab input and save
both actual focus targets beside the images. Each state reload clears only the
isolated gym document's local and session storage, so prior Snooze and Settle
actions do not change a later fixture.
Inbox row reachability includes its observed arrow-key selection. Arrow navigation
may wrap to the same item when a menu has only one eligible option; empty menus
have no focus target to move between.
Combobox option reachability records the active descendants visited by ArrowDown.
Escape may clear an active query or close a nested layer before closing its parent;
each additional press requires observed progress.

Use `../full-run.sh` for capture, measurements, passes and the shared grouped
report in one run. The five raw findings files remain available for audits.
