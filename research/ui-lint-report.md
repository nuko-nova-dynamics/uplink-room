# Issue 173: UI lint implementation report

Implemented section 4 on `t3/173-ui-lint`. No PR was opened. The branch starts at `46954599` from the shared UI-quality work. The design plan was written in [ui-lint-tools.md](ui-lint-tools.md) before implementation.

## Tools and placement

Registry versions were checked in this session. [The research](ui-lint-tools.md) has the primary-source links, dates, capability probes and timings.

- CSSTree 3.2.1 parses authored CSS with declaration locations. Its direct tree walk was the fastest measured way to expose the syntax this checker needs. Stylelint 18.0.0, Biome 2.6.5 and Lightning CSS 1.33.0 were compared.
- Keep oxlint 1.90.0, already pinned. Latest is 1.91.0. The pinned binary supports all four requested native TSX rules and the local JS plugin.
- Oxc parser 0.157.0 provides TSX trees in tests. Production TSX checks reuse oxlint's parse.
- svg-path-bbox 2.1.0 calculates path bounds, including curve extrema. Circle, ellipse, rectangle, line and point-list bounds are checked directly. Half the stroke is included; filled silhouettes have no stroke margin.

| Rule | Implementation |
| --- | --- |
| Raw pixels, colors, durations, radii and z-index | `scripts/ui-lint/css.mjs`, `css/tokens` |
| Spacing, type and icon scale | `css.mjs`, `css/scale`; `tsx.mjs`, `ui/icon-scale` |
| Outline suppression | `css.mjs`, `css/focus-visible` |
| Transition all and layout properties | `css.mjs`, `css/transition-all`, `css/transition-layout` |
| Important declarations | `css.mjs`, `css/no-important`; three exact xterm exceptions in `exceptions.json` |
| Physical and logical accent side stripes | `css.mjs`, `css/no-side-stripe` |
| Inline SVG | `tsx.mjs`, `ui/no-inline-svg`; named art exceptions with reasons |
| Emoji used as icons | `tsx.mjs`, `ui/no-emoji-icon`; emoji message content is allowed |
| Inline pixel styles, including numeric React lengths | `tsx.mjs`, `ui/no-inline-px` |
| Button type | Native oxlint `react/button-has-type` |
| Keyboard handlers, roles and labels | Native oxlint `jsx-a11y/click-events-have-key-events`, `no-static-element-interactions`, `control-has-associated-label` |
| Icon viewBox, stroke and bounds | `tsx.mjs`, `ui/icon-geometry`, exposed through `oxlint-plugin.mjs` |
| Shrinking baseline and CLI | `baseline.mjs`, `baseline.json`, `index.mjs` |

`pnpm lint` runs the original oxlint pass followed by the UI runner. The runner calls oxlint's JS entry through Node, so it does not depend on `.cmd` execution, bash, shell globs or POSIX-only paths. `.github/workflows/ci.yml` already runs this command and needed no edit. `pnpm test` includes the 25 custom guard tests before the existing workspace tests.

## Timings and baseline

Mac, Node 26.13.0, pnpm 12.16.1, dependencies installed:

- Before: `pnpm lint` 0.09 seconds wall time. The very first invocation also installed dependencies and took 3.23 seconds; that installation is excluded from lint timing.
- After: five final full root runs took 0.988, 0.907, 0.917, 0.89, 0.888 seconds; median 0.907 seconds. Added time is about 0.82 seconds, below the 15-second budget.

The baseline holds 2,800 findings across 39 files:

| Rule | Count |
| --- | ---: |
| `css/tokens` | 1,705 |
| `css/scale` | 998 |
| `css/no-important` | 12 |
| `ui/no-inline-px` | 69 |
| `ui/icon-scale` | 16 |
| All other requested rules | 0 |

Counts are per file and rule, not line. Normal lint fails on an increase and on a decrease that has not been recorded. `pnpm lint:baseline` refuses increases before writing and only preserves or reduces counts. Moving a finding to a new file does not preserve its allowance. CSS syntax and icon geometry cannot be baselined. The initial reviewed inventory was written once during implementation; the shipped command has no initialization or force-increase mode.

## Real findings fixed

- Removed five outline-reset declarations in `styles.css`. They affected onboarding, document editing, sidebar search, chat composition and inline editing. The existing global neutral `:focus-visible` ring now applies. A document-editor reset was repeated on its focus selector, so both declarations were removed.
- Removed two 1.6 stroke overrides from the wheel icon. It now uses the family's 1.5 stroke. Moved fixed Icon SVG attributes after caller props so a caller cannot replace the viewBox.
- Added accessible names to the empty Actions table headings in Profiles and Members.
- Added keyboard zoom to attachment images, keyboard selection to comment cards, keyboard center-point placement to image/canvas annotation surfaces, and a tab stop with Enter/Space activation for Inbox row titles. Focusing an Inbox title selects its row for the existing shortcut system.
- Preserved the RepoPicker's input-based keyboard path and added Enter/Space handling to options.
- Marked the dialog/lightbox backdrop, sanitized-Markdown event-delegation container and comment-actions event boundary as presentation. Their native child controls, Escape handling or existing keyboard paths provide the actual interaction; these were static-analysis findings, not missing standalone controls.
- No button missing its type, inline view SVG, emoji icon, `transition: all`, layout transition or accent side stripe was found in the checked source. The neutral Markdown quotation edge remains intentional.

## Visible changes

The wheel's outer ring and spokes become 0.1 SVG units thinner. Previously suppressed keyboard focus rings appear on the five surfaces above and on newly focusable image, annotation, comment and Inbox controls. Keyboard users can zoom images, select comments, open Inbox rows and place a comment at the center of an image or canvas. Other content, colors, dimensions and motion remain as before. Screenshots and running-app validation belong to the orchestrator's capture pass; this worker did not start Electron, the gym or an app window.

## Added tokens

Forty-two tokens were added to `styles.css` `:root`, without replacing existing rendered values:

- `--space-{1,2,3,4,5,6,7,8,10,12,14,16,18,20,24,28,32,40,48}` in px.
- `--font-{11,12,13,13-5,14,14-5,15,16,18,20,24}` in px, with `13-5` = 13.5 and `14-5` = 14.5.
- `--icon-{12,14,16,18,20,24}` in px.
- `--border-hairline: 1px`, `--focus-width: 2px`, `--focus-color: color-mix(in srgb, var(--text) 72%, transparent)`, `--radius-control: 7px`, `--motion-fast: 120ms`, `--motion-normal: 250ms`.

Proposed DESIGN.md addition for the orchestrator, not applied here:

> New spacing uses the shared space tokens. The default control gap is 6 px, row gap 8 px, content gutter 18 px and window edge inset 16 px. New type uses the font tokens: 13 px UI labels and 15 px messages, retaining 13.5 and 14 px density steps. Icons use 12, 14, 16, 18, 20 or 24 px, with 14 px in standard controls. The authored icon grid is 16 by 16 with a 1.5 stroke. Use the 1 px hairline, 7 px control radius and named motion tokens instead of new literals.

## Verification and limits

Local `pnpm lint`, `pnpm typecheck` and `pnpm test` passed. The final check tails are below. Existing warnings include PostHog package sourcemaps and Node 26's experimental localStorage message; they did not fail the checks.

The `gym173-lint` box used the `agent-browser` template. Node 24.22.2 was installed through fnm and pnpm 12.16.1 was installed in that Node environment. The code was sent using `git archive HEAD` and `instabox push`, with no GitHub credentials or clone in the box. Frozen install, lint and typecheck passed. The box was deleted. The final isolated rerun used a fresh full `git archive HEAD`, covering the focus, transition-list and emoji guard refinements. It repeated the same frozen install, lint and typecheck sequence before deletion.

Impeccable 4.8.0 source scan from the repo root returned `[]` with exit 0. No rendered detector, screenshot or Windows runner was used. Linux proves the Node CLI path; Windows compatibility follows the same Node APIs but was not executed on Windows here. The rules are syntax guards, not a substitute for the issue's rendered focus, alignment and contrast checks.

The first malformed-CSS test used a missing final brace, which CSSTree accepts under CSS recovery. It was corrected to an invalid function value that raises a parse error. Final review added tests for zero-width focus replacements, standalone emoji, nested emoji tooltips and commas inside transition timing functions. No application check failed. Final output contains no added oxlint warning from the checker.

## Changed files

- `apps/desktop/src/renderer/components/Dialog.tsx`
- `apps/desktop/src/renderer/components/Icon.tsx`
- `apps/desktop/src/renderer/components/MessageBody.tsx`
- `apps/desktop/src/renderer/components/RepoPicker.tsx`
- `apps/desktop/src/renderer/components/chat/Attachments.tsx`
- `apps/desktop/src/renderer/components/files/CanvasViewer.tsx`
- `apps/desktop/src/renderer/components/files/CommentRail.tsx`
- `apps/desktop/src/renderer/components/files/ImageViewer.tsx`
- `apps/desktop/src/renderer/styles.css`
- `apps/desktop/src/renderer/views/Inbox.tsx`
- `apps/desktop/src/renderer/views/settings/Members.tsx`
- `apps/desktop/src/renderer/views/settings/Profiles.tsx`
- `docs/ui-lint.md`
- `package.json`
- `pnpm-lock.yaml`
- `research/ui-lint-report.md`
- `research/ui-lint-tools.md`
- `scripts/ui-lint/baseline.json`
- `scripts/ui-lint/baseline.mjs`
- `scripts/ui-lint/css.mjs`
- `scripts/ui-lint/exceptions.json`
- `scripts/ui-lint/index.mjs`
- `scripts/ui-lint/oxlint-plugin.mjs`
- `scripts/ui-lint/oxlint.json`
- `scripts/ui-lint/rules.test.mjs`
- `scripts/ui-lint/tsx.mjs`
- `scripts/ui-lint/vitest.config.mjs`

## Local check tails

### pnpm lint

```text
apps/desktop/src/renderer/views/Inbox.tsx:82:3: warning eslint(no-unused-vars): Parameter 'setGroupByProject' is declared but never used. Unused parameters should start with a '_'. help: Consider removing this parameter.
packages/bridge/src/bridge.ts:453:25: warning unicorn(no-useless-spread): Using a spread operator here creates a new array unnecessarily. help: `for…of` can iterate over iterable, it's unnecessary to convert to an array.
UI lint passed: 9 CSS files, 2800 existing findings.
```

### pnpm typecheck

```text
packages/backend typecheck: Done
packages/room-client typecheck$ tsc-rs -p tsconfig.json
packages/room-client typecheck: Done
apps/desktop typecheck$ tsc-rs -p tsconfig.json
packages/notetaker typecheck$ tsc-rs -p tsconfig.json
packages/notetaker typecheck: Done
apps/desktop typecheck: Done
```

### pnpm test

```text
apps/desktop test: (node:25660) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
apps/desktop test: (Use `node --trace-warnings ...` to show where the warning was created)
apps/desktop test: 
apps/desktop test:  Test Files  89 passed (89)
apps/desktop test:       Tests  526 passed | 1 skipped (527)
apps/desktop test:    Start at  03:55:28
apps/desktop test:    Duration  11.39s (tests 56%, environment 25%, import 15%, transform 3%, worker 1%)
apps/desktop test: 
apps/desktop test:     Isolate  89 workers spawned · ~188ms startup each (spawn + environment, per file)
apps/desktop test:              at least ~1.10s faster with isolate: false — reuses workers across files instead of one per file
apps/desktop test: 
apps/desktop test: Done
```

## Final Linux evidence

Tested implementation commit `80ee967c` with Node 24.22.2 and pnpm 12.16.1. Frozen installation, lint and typecheck all exited 0. The final `gym173-lint` box was deleted after the command completed.

```text
UI lint passed: 9 CSS files, 2800 existing findings.
packages/protocol typecheck: Done
apps/site typecheck: Done
packages/bridge typecheck: Done
packages/backend typecheck: Done
packages/room-client typecheck: Done
packages/notetaker typecheck: Done
apps/desktop typecheck: Done
```
