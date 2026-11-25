# Uplink Room

A shared workspace where the team and its agents work together: the desktop app, the Room API backend, the bridge, and the concept, design and research behind them. The repo is public under the MIT license, so keep secrets, personal machine names and addresses, and session transcripts out of it. See `README.md` for what each folder holds.

## Commands that run until stopped

A time limit or a killed shell ends only the process it hits, so a program that process started can run on with parent pid 1.

- Read the backend's function logs with `pnpm --filter @uplink-room/backend logs -- <convex logs options>`. It stops after 30 seconds (`--for <seconds>` changes that). Don't put `npx convex logs` under `timeout` or `perl -e 'alarm …'`: the limit ends npx, and the `convex` process it started keeps streaming.
- `pnpm release:mac` can take over an hour, most of it Apple's notarization. Run it where no time limit stops it: `nohup pnpm release:mac > /tmp/release-mac.log 2>&1 &`, then wait on its pid. A job limit that kills it throws away any notarization already done. The script checks first, in seconds, that every program it starts runs from Node.
- `convex dev` with a local deployment (`pnpm --filter @uplink-room/backend dev`) stops its local backend on SIGINT, SIGTERM and SIGHUP. `patches/convex@1.49.0.patch` makes the CLI stop the backend with SIGINT, the only signal on which the backend also stops its Node action executor (get-convex/convex-backend#580).

## Checks

`pnpm lint` (oxlint, with the room's rules in `scripts/lint/room.mjs`), `pnpm typecheck`, `pnpm test`, and `pnpm specs` for the TLA+ models in `specs/` (needs Java 11 or later; see `specs/README.md`). When a Sentry report shows a new kind of error, add a lint rule or a model that catches it (`docs/error-reports.md`, "Kept out by lint and models").

GitHub Actions jobs run on GitHub-hosted runners (`ubuntu-latest`, `windows-latest`). Pull requests always do, because the repo is public and a fork's pull request must never run on a machine of ours. For pushes, tags and manual runs only, repository variables in **Settings → Secrets and variables → Actions → Variables** can name other runners as a JSON label: `CI_RUNS_ON` for Linux jobs, `CI_RUNS_ON_LARGE` for the Linux Electron packaging job, and `CI_RUNS_ON_WINDOWS` for Windows jobs. A self-hosted label containing `fleet` runs Linux jobs in the pinned `node:24-bookworm` container.

## UI SDK

The desktop app's controls are built on [UI SDK](https://ui-sdk.dev) (`@ui-sdk/react`, `@ui-sdk/core`). Before you use it, read `apps/desktop/node_modules/@ui-sdk/react/docs/llms.txt` and the page of each component you use. To build a new component from behaviors, search `node_modules/@ui-sdk/react/docs/core.md` by heading and read `rendering.md` beside it. The app doesn't load `@ui-sdk/core/web.css`; style parts with the app's own tokens through their `data-slot` and state attributes. Shared part styles live in `components/ui-sdk.css`.

Use the UI SDK component for each kind of control:

- A modal: `components/Dialog.tsx` (UI SDK Dialog; its content is the dimmed `.overlay`, with the `.dialog` box inside). A question that needs an answer: Alert Dialog. A side panel over the view: Dialog or Drawer.
- A menu from a button or a right-click: Menu (`MenuContent className="pop …"`). Something to edit or explore beside its trigger: Popover.
- A choice from a popup list: Select. An always-visible list to choose from: Listbox. Search and choose: Combobox; free text with suggestions: Autocomplete; suggestions at `@` or `/`: Trigger Menu.
- On or off: Switch. One of a set: Radio, or Segmented Control for a few short choices. Several of a set: Checkbox. A button that stays pressed: Toggle. Related panels: Tabs.
- Text: Input, Textarea, Password Input, Number Input, OTP Input, each in a Field with its label, description and error.
- A button that runs async work and shows it's busy: Button (return the Promise from `onClick`). A plain click handler stays a native `button`, as UI SDK's Button page advises.
- A control's hint: `components/Tip.tsx` (UI SDK Tooltip), not `title`. Toasts: `useToast()` (UI SDK Toast).
- Progress, Meter, Separator, Toolbar and Scroll Area for those roles.

Popups render in the browser's top layer and are portaled to `document.body`, so a test finds dialog content with `document.querySelector`, not inside its render host, and waits for focus and `inert` with `await act(() => settle())` from `@ui-sdk/core/testing`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `nuko-nova-dynamics/uplink-room`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root, created when the first term or decision is settled. See `docs/agents/domain.md`.
