---
status: accepted
---

# A joined run starts closed, and its person opens it to the team

On 2026-11-06 Julio joined a Claude Code session on his own Mac to Miami Web AI with `uplink join`, to work with Axel's agent. He then found that every joined run was listed for the whole team and heard anyone in it (ADR 0026: a run with no `hears` set hears anyone who can see it). A session someone starts in their own terminal is their own work. The team should see it, and be able to message it, only once its person says so. A run started from the Uplink Room app is different: starting it there is already a choice to work in the team.

## Decisions

- **A joined run starts closed.** `joined.start` writes `closed: true` on a new joined run unless it is called with `open: true` (`uplink join --open`). Absent, as on every run started in the app and on joined runs from before this decision, means open, so nothing that exists changes.
- **For everyone but its person, a closed run isn't there.** Only its person (its driver, or the person accountable for an agent driver) and their agents see it. Anyone else, admins included, doesn't find it in `runs.live`, `runs.unfiled`, the roster's running harnesses, the Inbox, the activity log or a direct message's runs, and gets `not_found` from `runs.get`, `runs.inbox` and every function that takes a run through `inTeam`, such as `runs.stop`. Naming it in `addressedRuns`, `mentionedRuns` or `channels.openDirect` is `not_found` too, and its `<@run:…>` token in a message body addresses nothing, the same as a run from another team (`seesRun` in `lib/runLabels.ts`).
- **A closed run hears only its person and their agents,** whatever `hears` says. A message from a teammate that waited from before the run closed fails as `not_heard` when the session takes its messages, as one does after `runs.setHears` narrows a run.
- **Its person opens and closes it.** In the session: `uplink open` and `uplink close` (`joined.setOpen`, with the run's own token). From the app or the person's sign-in: `runs.setOpen`, which only the run's driver, or an agent of theirs, may call. Open, a joined run is as it was before this decision: listed for the team, and `hears` applies. Joining the same session again keeps whether it is open, unless `--open` opens it.
- **Only a joined run can be closed, and only while the team has nothing that shows it.** `runs.setOpen` refuses `open: false` on a run started in the app, which stays open to its team, and on a run filed under a task, since the task is the team's to see. `runs.file` refuses a closed run for the same reason: the person opens it first. `channels.openDirect` refuses a closed run with anyone but its person and their agents.
- **The uplink skill joins closed, and opens only when asked.** It passes `--open`, or runs `uplink open`, when the person asks the session to work with their team, a teammate or a teammate's agent, and tells the person whether the team can see the session.

## Consequences

- Amends ADR 0026 (anyone who can see a run can message it) and ADR 0032 (a joined run is named and listed like any run): both now hold only for an open joined run.
- A closed run's name still takes its place in numbering: a second open Claude Code of the same person shows as "Claude Code 2 (Julio)" to the team while the first is closed. A message posted while the run was open keeps showing who it was addressed to after the run closes.
- A direct message someone opened with the run while it was open keeps the run as a member, but the run isn't listed there for others, gets no warning line, and hears nothing said there but its person's while it is closed.
- The app has no control for it yet: the person opens or closes a joined run from the session, or with `runs.setOpen`.
