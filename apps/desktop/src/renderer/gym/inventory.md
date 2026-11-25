# Component inventory

Issue #173, section 1. `inventory.json` follows `scripts/upclose/types.ts` without changing that contract.

The inventory has 67 primitives, 233 components and 30 views. It has 676 state mappings: 358 use inventory scenes and 318 use existing scenes. Every entry accounts for the twelve requested states. The seven nonvisual files are listed separately. Private React components have their own entries as well as exported components. Ids include the source file name to distinguish repeated component names.

## New scenes

The inventory scenes include the original 75 scenes and nine capture fixtures. All use sample data, the normal gym providers, or real components with sample props.

- `inventory-controls-{default,disabled,loading,error,empty,overflow,many}`: native CSS primitives, faces, permission modes, copy results, file chips, updater, media boxes and the view error boundary.
- `inventory-browser-{driver,watcher,start,unset,starting,error,many,overflow}`: the real BrowserPanel, saved login controls and a BrowserFrame with no connection ticket. Actions are local no-ops.
- `inventory-cloud-{default,add}`: the real cloud machine views and add dialog, with sample actions.
- `inventory-invite-{default,loading,invalid,expired,used,revoked,member,other,overflow,error}`: the real invite view with injected results. It never signs in or switches an account.
- `inventory-space-{ready,opening,unreachable,failed,ended,stopped}`: SpaceScreen with a local sample frame and no machine connection.
- `inventory-files`: all five file formats and a pinned comment for each. The PDF is an embedded one-page document. The image and HTML are embedded sample content. The Files tab is opened by `gymPrepare.ts`.
- `inventory-pairs-many`: 73 Pairs, paged through the real More Pairs control.
- `inventory-unfiled`: a sample unfiled run in the app shell.
- `inventory-{inbox,task,project,settings,settings-members,settings-profiles,settings-agents,settings-activity,private,terminal,search,files,unfiled}-{overflow,many,empty}`: the same routes with reshaped sample query results. Ids and relationships are kept for long labels. Crowded lists retain the original first item.

## Contract gaps and capture limits

- Native `title` tooltips have no DOM box or role. `native-tooltip` uses a dedicated focusable trigger and captures the actual X11 popup with `xdotool`, `xwininfo` and `ffmpeg`. Its crop includes the trigger and the tooltip surface; a sidecar records the surface bounds and keyboard focus. The focus state tabs to the trigger before the platform pointer opens the title (native titles do not open on keyboard focus alone).
- `role` has no radiogroup, combobox, toolbar, meter or status value. Those entries retain their real selector, and supported menu, listbox, dialog, tooltip, tabs and grid values are used where applicable.
- `Step` has no scroll, file chooser, selection-range, frame-navigation or drag operation. The inventory uses existing preparation, ordinary clicks, keyboard input and typing. The source text selection workflow and external frame contents require a later interaction-pass extension.
- Fragments, data-provider wrappers and error boundaries have no box of their own. Their selector names the real child box. An error boundary's error scene deliberately throws from a sample child.
- Media elements can be cropped, but the gym's inert track does not decode a real video stream. Actual camera, microphone, screen-share and remote browser pixels are outside this sample-only inventory. No capture here authenticates, starts media, opens an external URL or uses the system clipboard.
- Long text and crowded lists are fixture properties, not forced CSS states. A child that disappears when its data is empty has no empty box; its containing view owns that capture.

## Capture repairs

The missing-capture repair adds dedicated HTML-message and ready-update scenes. The HTML scene renders `HtmlFrame` itself and waits for its sandbox document to paint. Both update entries share the real `UpdateReadyView` presentation (the `UpdateReady` wrapper only obtains its state); clicking Restart keeps its promise pending to expose loading and disabled states without restarting Electron. Machine Spaces keeps the selected machine in all three scenes and changes its discovered/shared Spaces, rather than removing or multiplying machines. The controls page places its specimens first, restores horizontal wrapping for sample rows, and scopes buttons, faces and reactions to their intended samples. The agent face is distinct from the harness face. Dialog, banner and login selectors identify their actual roots.

The capture pass adds fixtures for an owned agent and key, a terminal asking for control, a terminal output preview, call proposals and a transcript, a failed agent run line, a run mention, a multi-question form and a Space watcher. Image and PDF samples are bundled assets, with inlining disabled so the app can fetch them under its normal content policy. The browser's long and crowded login scenes show the login list. Its wheel button is absent during startup; a watcher who has already asked for control supplies its disabled state. Empty project and file scenes retain their selected project. The primitive chip selector stays inside the controls fixture, so an attachment chip cannot replace its long-text sample.

Thirty-two hover, focus and disabled states were added after comparing rendered targets with the loaded CSS. Global scrollbar hover styling is excluded from this component-state audit; keyboard focus is added only to focusable targets. The audit records matching rules in each run folder. Generic button rules do not make an always-enabled component disable itself or open a menu.

## Verification boundary

The inventory tests check unique ids, source and scene existence, source coverage, all twelve state decisions, and input-step shapes. Runtime capture uses `scripts/upclose/run.ts` on the pinned Linux box. It reports selector and input failures without stopping the rest of the inventory. Captures, measurements, input evidence, CSS audit results, determinism probes and the combined findings stay in the run folder. No capture launches an app window on the Mac.
