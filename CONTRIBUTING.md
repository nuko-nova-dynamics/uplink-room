# Contributing to Uplink Room

Thanks for helping. This page covers how to get the code running, what a pull request needs, and the few conventions this repo is strict about.

## Before you start

- **A bug:** open an issue with the steps to reproduce it, what you expected and what happened. Include your OS and the app version from Settings, Updates.
- **A change in behavior or a new feature:** open an issue first and describe the problem it solves. Some decisions are already recorded in `docs/adr/`, and a short discussion saves you from building something that conflicts with one.
- **A security problem:** don't open an issue. Follow [SECURITY.md](SECURITY.md).

## Set up

You need Node 24 or newer, pnpm (the version pinned in `package.json`), and Java 11 or later if you touch the TLA+ models in `specs/`.

```sh
pnpm install
cp apps/desktop/.env.example apps/desktop/.env.local
pnpm --filter @uplink-room/backend dev     # a local Convex backend
pnpm --filter @uplink-room/desktop dev     # the app, against that backend
```

If Electron starts as plain Node, `unset ELECTRON_RUN_AS_NODE` first. `apps/desktop/README.md` covers sign-in, packaging and updates, and `packages/bridge/README.md` covers the bridge.

## Checks

CI runs these on every pull request, on Linux and Windows. Run them locally first:

```sh
pnpm lint          # oxlint with the room's own rules (scripts/lint/room.mjs) and the UI lint
pnpm typecheck
pnpm test
pnpm specs         # the TLA+ models
```

A pull request from a first-time contributor waits for a maintainer to approve its CI run. That's a GitHub setting, not a judgment on the change.

## Conventions

- **Words.** `GLOSSARY.md` says which word to use for each concept and which to avoid. Use it in code, UI copy and docs.
- **Decisions.** A choice that's hard to reverse gets an ADR in `docs/adr/`. Read the ones near your change before you start; `docs/agents/domain.md` explains the format.
- **The look.** UI follows `DESIGN.md`. The desktop app's controls are built on [UI SDK](https://ui-sdk.dev); `AGENTS.md` lists which component to use for each kind of control.
- **Every action goes through the Room API.** The desktop app has no endpoints of its own (ADR 0003). New behavior belongs in `packages/backend`, with the app calling it.
- **Tests.** Add about one test per behavior you add or fix, next to the existing tests for that area. A test for a bug should fail without your fix.
- **Errors found in the wild.** When a Sentry report shows a new kind of error, add a lint rule or a TLA+ model that keeps it out (`docs/error-reports.md`).
- **No secrets, machine names or personal paths** in code, tests, docs or screenshots. The values in `apps/desktop/.env.release` are public client keys and are fine.

## Pull requests

- Keep one change per pull request, and keep unrelated cleanups out of it.
- Title it with what changes, in plain words. Recent examples: "Join voice in one click, and see who's online and what they're doing", "Upload the bridge release with @vercel/blob".
- In the description, say what was broken or missing, what you changed, and how you checked it. Include screenshots for anything people can see, in both the dark and light themes.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
