# Uplink Room

A shared space where the team and all of its agents work together. Uplink Room doesn't build agents. It connects the ones we already use (Claude Code, Codex, Grok Build, Hermes, OpenClaw) through the tools that already run them (T3 Code, Cua Spaces, and a small bridge that shares each machine's terminals), and adds what a team needs around them: channels, calls, projects, and one view of everyone's work.

The name comes from the uplink room at NASA's JPL, where the Curiosity team sends commands to its rover.

Status: early. The desktop app, the backend and the bridge work, and builds ship from https://uplinkroom.com/download.

## Code

| Path | What it is |
|---|---|
| `apps/desktop` | The Electron app: Inbox, project boards, shared terminals, machines, agents, channels and calls. See its README for setup. |
| `apps/site` | uplinkroom.com: what the app does, downloads and the update feed |
| `packages/backend` | The Room API, on Convex. Every action in the app goes through it (ADR 0003). |
| `packages/bridge` | Shares a machine's terminals with the room and enforces that machine's local limits |
| `packages/room-client` | A TypeScript client, an MCP server (`uplink-mcp`) and a CLI (`uplink`) for the Room API |
| `packages/notetaker` | An agent that transcribes calls and proposes tasks (ADR 0008) |
| `packages/protocol` | Code shared by the bridge, the backend and the room client: run messages, refusals, terminal text and Codex app-server messages |
| `specs/` | TLA+ models of the room's concurrent parts |

Node 24 or newer and pnpm (the version in `package.json`). `pnpm install`, then `pnpm lint`, `pnpm typecheck` and `pnpm test`. `pnpm specs` checks the TLA+ models and needs Java 11 or later.

## Design and research

| Path | What it is |
|---|---|
| `GLOSSARY.md` | The project's vocabulary: which word to use for each concept, and which to avoid |
| `docs/adr/` | Decisions that are hard to reverse, with the reason for each |
| `DESIGN.md` | The design system: color, type, Inbox, conversations, calls, characters and sound |
| `design/rounds/` | The design decision pages, with their live prototypes |
| `design/link-rig.js` | The code-built character rig for Link and the agents |
| `design/films/`, `design/scenes/` | Stageshow films from the decision rounds and their sources |
| `concept/uplink-room.html` | The first concept page. Open it in a browser. |
| `concept/history/` | Earlier rendered versions of the page, from when it was called Malecón |
| `concept/screenshots/` | Screenshots taken while building the page |
| `research/notes.md` | Key findings: stack, prices, T3 Code, Cua Spaces, protocols, competitors, open experiments |
| `research/naming.md` | How the name was picked and which .com names were free |
| `research/design/` | Notes on design references (Linear, Superhuman, Discord, Grok Bot, Muse and others) and the character explorations |
| `research/agent-reports/` | The research agents' reports, with their sources |

## Links

- Site: https://uplinkroom.com
- Concept page: https://handout.nuko-nova-dynamics.workers.dev/uplink-room/handbag-wise-gesture-utensil
- Releases: `docs/releases.md`
- Security reports: `SECURITY.md`

## License

MIT. See `LICENSE`.
