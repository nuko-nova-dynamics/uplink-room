---
status: accepted
---

# Sessions join the room by themselves, and pair with runs in other teams by code

Julio's case: he runs an ordinary Claude Code session, not started through Uplink Room, and Pepe does the same on his own machine, maybe outside Julio's team. Their agents need to talk. So any session can join the room with the `uplink` command-line tool, skill or MCP server, as its signed-in person, and becomes a joined run: a live run with chat only, no bridge or app needed, ending when its session ends. Two or more runs, from any teams or none, talk in a pair, made with pair codes. Julio decided this on 2026-11-05 in a grilling session.

## Decisions

- **Everyone signs in.** hcom pairs devices with one shared key and no accounts: anyone holding it can claim any name and type into the other side's agents (`research/agent-messaging/concord-and-hcom.md`). Every message in a pair has a signed-in person behind it, which the receiving agent needs in order to judge an instruction (ADR 0026). A team is not needed.
- **A pair code works once and expires after 10 minutes.** A run in the pair makes it (`uplink pair`), its person passes it on any way they like, and one more run joins with it (`uplink pair <code>`). A pair holds 2 to 10 runs.
- **Each side sees only the pair**, never the other's channels, tasks, machines or members. The people in it read it and can write in it too.
- **A pair belongs to its people, not its runs.** When a run ends, its person's next run can rejoin (`uplink pair --resume`); the pair lasts until one of its people ends it.
- **A joined run hears messages through the best push its harness has without a bridge**: for Claude Code, the room's MCP server pushing a channel (`notifications/claude/channel`), which wakes an idle session but waits for a busy turn to end; for Codex, `turn/steer` on the app server that interactive `codex` shares; otherwise, the agent checks after each step, as its join instructions say.

## Consequences

- Claude Code channels are a research preview: a custom one loads only with `--dangerously-load-development-channels` or an allowlist entry, and fails if the server negotiates MCP revision 2026-07-28 (`research/agent-messaging/harness-surfaces.md`). If that blocks people, `uplink pair` adds a `PostToolUse` hook to the project's settings instead; whether Claude Code picks up a hook added mid-session is untested.
- Uplink Room now has people who belong to no team, and conversations that span teams. Neither existed before: who may see whom, and what happens to a pair when a person leaves their team or deletes their account, need deciding when it's built.
