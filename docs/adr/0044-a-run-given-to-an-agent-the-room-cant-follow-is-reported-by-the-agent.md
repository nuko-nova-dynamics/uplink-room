---
status: accepted
---

# A run given to an agent the room can't follow is reported by the agent

Amends ADR 0012 and ADR 0033 for agents the room doesn't reach over A2A.

Until now a task could go only to an agent reached over A2A, such as Hermes or OpenClaw: the task panel listed A2A endpoints, and `runs.start` with `via: "a2a"` sent the work. The rest of the roster was left out: Grok Bot, reached at its routine webhook; dots, Muse and Duet, which check in on their own schedule (ADR 0033); and agents that hold only an agent key. For them nothing made a run, and no Room API function let an agent set a run's state. That was on purpose: ADR 0012 gives a run one reporter, the backend worker, and ADR 0029 D17 keeps a webhook send out of `runs`, because the room can't follow a routine. On 2026-11-06 the team decided that every roster agent can take a project task, from the task panel, a board card and the agent's row in the roster.

## Decisions

**A run given to an agent the room can't follow over A2A is a run of its own kind, reported by that agent.** It has `harness: "agent"` and the agent's `agentId`. `driverId` and `startedBy` are the sender, as on an A2A run, so a waiting run lands in the sender's Needs you. It starts Unknown. `runs.start` takes `via: "agent"` for any agent: an agent reached over A2A gets an A2A run, as before, and any other gets this kind. `via: "a2a"` stays for existing callers. Who may send is checked as for A2A: the `runs.start` scope for an agent sender, never to itself, the private-channel visibility check, and an open task.

**The agent reports with `runs.report`, which needs `messages.post`.** It takes `{ runId, state, message? }`, where `state` is working, waiting, done or failed; a waiting report needs its question as the message. Only the run's own agent may call it, and only on a `harness: "agent"` run that hasn't finished or been stopped. The message becomes the run's latest status line, as an A2A run's latest message does; with waiting, it is the question. The scope is `messages.post` and not a new one because connector keys already hold it, so the keys dots, Muse and Duet have now can report without being issued again.

**Each reach hears about it its own way.**

- **Webhook:** one POST of a new body, `type: "uplink-room.task"`, with `task { taskId, title, description }`, `run { runId }`, `from`, `accountable`, and `report { tool: "runs_report", arguments: { runId } }`. The message body is unchanged, as ADR 0033 requires.
- **Check-in and key-only:** nothing is pushed. The run is in the agent's `inbox.get` (view `mine`), which now also lists runs whose `agentId` is the caller, not only the runs it drives.

**Each send is recorded on `agentDeliveries`,** with a new optional `runId` (and `messageId` and `channelId` now optional), so the run shows sent, failed, waiting or seen, under ADR 0033's rules for sending. A check-in agent's first `runs.get` or `runs.report` on the run marks it seen.

**Replies are kept on the run.** `runs.reply` keeps the last 10 messages sent, in the shape of an A2A run's `a2a.messages`, and sends a webhook agent another task POST, with a `replies` field. A check-in agent reads them with `runs.get`.

**Stopping is immediate.** Nothing can be canceled at the agent, so `runs.stop` marks the run Stopped at once. A `runs.report` after that is refused with "stopped by {name}".

**A2A runs keep their single reporter.** ADR 0012 is unchanged for them: no Room API function reports an A2A run's state. ADR 0029 D17 still holds for messages: a message that reaches a webhook is a delivery record, not a run.

## Consequences

- The room trusts the agent's report. It can't check that a run the agent calls done did the work, as it can't for a routine's answer (ADR 0033).
- An agent that never reports leaves the run Unknown, and its delivery shows how far the room got: sent, waiting or seen. Stop ends it.
- The task's owner stays a person (the glossary's Owner): giving a task to an agent starts a run on it for that agent and changes no owner. There is no assignee. The app says "Give to an agent" on a board card and "Give it a task" on an agent's row in the roster.
- A `harness: "agent"` run draws in the task panel's chat, as an A2A run does (ADR 0041).
- The schema change is additive: `harness: "agent"`, an optional `given` on `runs`, and on `agentDeliveries` an optional `runId`, optional `messageId` and `channelId`, and an index by run.
- Decided by the team on 2026-11-06; the PR that brings this ADR is where to object.
