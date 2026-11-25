# Issue 173 inventory capture repair

All 21 requested components have all 49 listed component states captured in dark and light at 1x and 2x: **196/196 captures; zero inventory findings**. No production UI files changed. Changes are confined to gym fixtures, inventory metadata and capture tooling.

Capture paths below are relative to `/data/home/gym-out/inventory`. Each brace expands to all listed values. PNGs have matching `measure-1x.json` / `measure-2x.json` and `overlay.png`; zoom-enabled entries also have `zoom-400.png` / `zoom-800.png`.

The preflight reproduced the broad disabled targets, missing updater, and empty-machine Spaces failures. Several reported missing components already captured on the supplied integration base. Those entries retain their working scenes and now use more specific roots or the corrected controls layout; the table distinguishes those cases rather than attributing an unobserved failure to them.

| Component | Cause and change (file and line) | Capture paths |
| --- | --- | --- |
| `agent-avatar` | The old selector matched the harness character because no separate agent specimen existed. Added a real agent Face and a distinct scoped selector; [InventoryPage.tsx:289](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/InventoryPage.tsx:289), [inventory.css:18](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.css:18). [inventory.json:11728](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.json:11728). | `captures/agent-avatar/{default}/{dark,light}/{1x,2x}.png` ([2x example](/data/home/gym-out/inventory/captures/agent-avatar/default/dark/2x.png)) |
| `button` | The broad .btn selector selected an enabled control before the disabled specimen. Added a dedicated target and moved/wrapped the controls fixture; [InventoryPage.tsx:170](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/InventoryPage.tsx:170), [inventory.css:18](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.css:18). [inventory.json:5](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.json:5). | `captures/button/{default,hover,focus-visible,pressed,disabled,overflow}/{dark,light}/{1x,2x}.png` ([2x example](/data/home/gym-out/inventory/captures/button/default/dark/2x.png)) |
| `harness-face` | The reported absence did not reproduce on the supplied base; its specimen was deep in the generic inventory page. Scoped the existing real HarnessMark and brought the controls section first; [inventory.css:18](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.css:18). [inventory.json:11755](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.json:11755). | `captures/harness-face/{default}/{dark,light}/{1x,2x}.png` ([2x example](/data/home/gym-out/inventory/captures/harness-face/default/dark/2x.png)) |
| `icon-button` | The broad .btn.icon selector selected an enabled media control in the disabled scene. Added a dedicated target and restored the fixture row layout; [InventoryPage.tsx:176](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/InventoryPage.tsx:176), [inventory.css:18](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.css:18). [inventory.json:66](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.json:66). | `captures/icon-button/{default,hover,focus-visible,pressed,disabled}/{dark,light}/{1x,2x}.png` ([2x example](/data/home/gym-out/inventory/captures/icon-button/default/dark/2x.png)) |
| `machine-spaces-machine-spaces` | The empty scene removed every machine and unmounted Spaces; many multiplied machines rather than Spaces. Added default/empty/many discovered/shared-Space data while retaining the machine, and selected the exact Spaces section; [inventoryScenes.ts:185](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventoryScenes.ts:185). [inventory.json:9837](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.json:9837). | `captures/machine-spaces-machine-spaces/{default,empty,many}/{dark,light}/{1x,2x}.png` ([2x example](/data/home/gym-out/inventory/captures/machine-spaces-machine-spaces/default/dark/2x.png)) |
| `message-body-html-frame` | The entry depended on opening a project file, rather than an identified HTML-message specimen. Added the real HtmlFrame with a bounded authored document and a content-ready wait; [InventoryPage.tsx:97](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/InventoryPage.tsx:97), [inventoryScenes.ts:178](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventoryScenes.ts:178), [steps.ts:7](/data/home/tasks/fix2-inventory/repo/apps/desktop/scripts/upclose/steps.ts:7). [inventory.json:2930](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.json:2930). | `captures/message-body-html-frame/{default}/{dark,light}/{1x,2x}.png` ([2x example](/data/home/gym-out/inventory/captures/message-body-html-frame/default/dark/2x.png)) |
| `message-item-agent-results` | The reported absence did not reproduce; the answered-agent scene contains a result card. Required a nonempty .agent-results root with an .agent-result child, then captured its actual card. [inventory.json:4751](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.json:4751). | `captures/message-item-agent-results/{default}/{dark,light}/{1x,2x}.png` ([2x example](/data/home/gym-out/inventory/captures/message-item-agent-results/default/dark/2x.png)) |
| `native-tooltip` | The old [title] hit a non-focusable avatar; page screenshots omit native tooltip windows. Added a focusable titled button, real hover and Tab steps, and X11 surface capture with evidence sidecars; [InventoryPage.tsx:212](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/InventoryPage.tsx:212), [native-tooltip.ts:29](/data/home/tasks/fix2-inventory/repo/apps/desktop/scripts/upclose/native-tooltip.ts:29), [run.ts:68](/data/home/tasks/fix2-inventory/repo/apps/desktop/scripts/upclose/run.ts:68). [inventory.json:10872](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.json:10872). | `captures/native-tooltip/{default,open,hover,focus-visible}/{dark,light}/{1x,2x}.png` ([2x example](/data/home/gym-out/inventory/captures/native-tooltip/default/dark/2x.png)) |
| `new-channel-new-channel` | The reported absence did not reproduce; the existing New channel button opens the form. Kept the real click and narrowed the crop to the dialog with the New channel accessible name. [inventory.json:4813](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.json:4813). | `captures/new-channel-new-channel/{default}/{dark,light}/{1x,2x}.png` ([2x example](/data/home/gym-out/inventory/captures/new-channel-new-channel/default/dark/2x.png)) |
| `new-direct-message-new-direct-message` | The reported absence did not reproduce; runs-new-dm already opens the picker through gym preparation. Narrowed the crop to the New direct message dialog by role and accessible name. [inventory.json:4847](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.json:4847). | `captures/new-direct-message-new-direct-message/{default}/{dark,light}/{1x,2x}.png` ([2x example](/data/home/gym-out/inventory/captures/new-direct-message-new-direct-message/default/dark/2x.png)) |
| `new-work-new-task-dialog` | The reported absence did not reproduce; the project New task action opens the dialog. Required the dialog containing #task-title in both default and open states. [inventory.json:3021](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.json:3021). | `captures/new-work-new-task-dialog/{default,open}/{dark,light}/{1x,2x}.png` ([2x example](/data/home/gym-out/inventory/captures/new-work-new-task-dialog/default/dark/2x.png)) |
| `output-warning-output-head-note` | The reported absence did not reproduce; runs-dm supplies the output warning in the current fixture. Required the actual .head-output note role. [inventory.json:4875](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.json:4875). | `captures/output-warning-output-head-note/{default}/{dark,light}/{1x,2x}.png` ([2x example](/data/home/gym-out/inventory/captures/output-warning-output-head-note/default/dark/2x.png)) |
| `presence-face` | The reported absence did not reproduce; MemberFace already renders active presence in the controls fixture. Scoped the presence specimen and moved the fixture into view; [inventory.css:18](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.css:18). [inventory.json:11782](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.json:11782). | `captures/presence-face/{default}/{dark,light}/{1x,2x}.png` ([2x example](/data/home/gym-out/inventory/captures/presence-face/default/dark/2x.png)) |
| `primitive-banner` | The reported absence did not reproduce; Notifications already renders real banner previews. Selected a direct banner child of the preview stack, excluding surrounding notification settings. [inventory.json:1152](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.json:1152). | `captures/primitive-banner/{default}/{dark,light}/{1x,2x}.png` ([2x example](/data/home/gym-out/inventory/captures/primitive-banner/default/dark/2x.png)) |
| `primitive-toggle` | The selector already matched the toggle, but the old controls layout put it below unrelated media and allowed vertical control rows. Brought the controls section first and restored wrapping horizontal sample rows; [inventory.css:18](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.css:18). [inventory.json:1242](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.json:1242). | `captures/primitive-toggle/{default,hover,focus-visible,pressed,disabled}/{dark,light}/{1x,2x}.png` ([2x example](/data/home/gym-out/inventory/captures/primitive-toggle/default/dark/2x.png)) |
| `reaction-chip` | The reported absence did not reproduce; the real reaction chip existed lower in the generic page. Scoped all states to the controls sample and corrected its fixture placement; [inventory.css:18](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.css:18). [inventory.json:11679](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.json:11679). | `captures/reaction-chip/{default,hover,focus-visible,disabled}/{dark,light}/{1x,2x}.png` ([2x example](/data/home/gym-out/inventory/captures/reaction-chip/default/dark/2x.png)) |
| `reactions-reaction-chips` | The disabled/selected overrides cropped a single reaction, not the group. Kept the group as the target in all states, verifying its disabled/pressed descendant; [inventory.css:18](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.css:18). [inventory.json:4902](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.json:4902). | `captures/reactions-reaction-chips/{default,disabled,selected}/{dark,light}/{1x,2x}.png` ([2x example](/data/home/gym-out/inventory/captures/reactions-reaction-chips/default/dark/2x.png)) |
| `saved-logins-keep-seg` | The reported absence did not reproduce; clicking Keep logins exposes KeepSeg in the current browser-start scene. Scoped Keep for to .logins-picker, keeping the real Keep logins click. [inventory.json:8372](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.json:8372). | `captures/saved-logins-keep-seg/{default}/{dark,light}/{1x,2x}.png` ([2x example](/data/home/gym-out/inventory/captures/saved-logins-keep-seg/default/dark/2x.png)) |
| `saved-logins-logins-picker` | The reported absence did not reproduce; the browser-start scene already renders the picker. Replaced the broad text-matched .field selector with the actual .logins-picker root. [inventory.json:8345](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.json:8345). | `captures/saved-logins-logins-picker/{default}/{dark,light}/{1x,2x}.png` ([2x example](/data/home/gym-out/inventory/captures/saved-logins-logins-picker/default/dark/2x.png)) |
| `update-ready-update-ready` | The controls fixture rendered Settings UpdatesView, which has no .update-ready prompt. Added a ready UpdateReadyView specimen (the wrapper delegates presentation to this view), with a pending restart promise for loading/disabled; [InventoryPage.tsx:110](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/InventoryPage.tsx:110), [inventoryScenes.ts:178](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventoryScenes.ts:178). [inventory.json:3369](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.json:3369). | `captures/update-ready-update-ready/{default,loading,disabled}/{dark,light}/{1x,2x}.png` ([2x example](/data/home/gym-out/inventory/captures/update-ready-update-ready/default/dark/2x.png)) |
| `update-ready-update-ready-view` | The controls fixture rendered a different updater component, so every .update-ready state timed out. Pointed all three states to the ready-prompt fixture; the real restart click shows Restarting and disables its button; [InventoryPage.tsx:110](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/InventoryPage.tsx:110). [inventory.json:3415](/data/home/tasks/fix2-inventory/repo/apps/desktop/src/renderer/gym/inventory.json:3415). | `captures/update-ready-update-ready-view/{default,loading,disabled}/{dark,light}/{1x,2x}.png` ([2x example](/data/home/gym-out/inventory/captures/update-ready-update-ready-view/default/dark/2x.png)) |

The native-tooltip PNGs contain the actual native X11 window, not a DOM imitation. A keyboard capture first reaches the button with Tab, then hovers to display its title while preserving the visible focus ring. Native titles do not open on keyboard focus alone. The per-scale `native-tooltip-*.json` files record the title, native surface bounds, focus and reduced-motion state. Additional 960 x 600 reduced-motion crops are under `/data/home/gym-out/inventory-extra/captures/native-tooltip/focus-visible/{dark,light}/{1x,2x}.png`. All four sidecars confirm `focused: true` and `reducedMotion: true`.

The extra verification also exercised every button, icon-button and toggle state at 960 x 600 in both themes/scales: 68 cases passed, including bounds, nine hit-test samples, disabled state and real Tab reachability. Evidence: [verification.json](/data/home/gym-out/inventory-extra/verification.json).

Opened 2x crops for the native tooltip with focus, HTML frame, update prompt, empty Spaces, and representative controls/faces to confirm identifiable specimens.

The requested measurement CLI exited 2 with **56 open measurement findings**, zero waived and **zero inventory findings**. Its remaining findings are size/contrast observations on existing component rendering, outside this capture repair. No checks or waivers were weakened. Full report: [report.md](/data/home/gym-out/inventory/report.md).

Check tails (prep ran from the repository root; capture and CLI from apps/desktop; Node 24.22.2 from /data/gym-env.sh):

Capture:

```text
shard 1/1 scale 2: 21/74 groups, 126 captures, 0 inventory findings
shard 1/1 scale 2: 41/74 groups, 153 captures, 0 inventory findings
shard 1/1 scale 2: 61/74 groups, 183 captures, 0 inventory findings
Captured 196/196 in 156.4s; inventory findings 0
```

Measurement checks:

```text
56 open findings, 0 waived. Report: /data/home/gym-out/inventory/report.md
```

Lint:

```text
UI lint passed: 23 CSS files, 2134 existing findings.
```

Typecheck:

```text
apps/desktop typecheck$ tsc-rs -p tsconfig.json
packages/notetaker typecheck$ tsc-rs -p tsconfig.json
packages/notetaker typecheck: Done
apps/desktop typecheck: Done
```

Desktop tests:

```text
 Test Files  117 passed (117)
      Tests  702 passed | 5 skipped (707)
   Duration  12.39s (tests 42%, environment 19%, import 19%, transform 18%, worker 1%)
```

Narrow window and reduced motion:

```text
Verified 68 narrow-window/reduced-motion cases
```
