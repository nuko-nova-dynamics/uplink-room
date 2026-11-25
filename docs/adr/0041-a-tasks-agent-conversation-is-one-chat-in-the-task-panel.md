---
status: accepted
---

# A task's agent conversation is one chat in the task panel

Amends ADR 0024 for the task panel.

On 2026-11-05 Julio sent Icarus, a Hermes Agent the team reaches over A2A, work on a task and replied to it in the task panel. Each reply after Icarus's A2A task had finished started a new run in the same A2A context, as ADR 0024 and the A2A spec say it should. But the panel drew every run as a card of its own, side by side, so three turns were three boxes, each with its own reply box, its own Agent, It reports and Followed rows, and its own Result. In his words: "why is this creating a new little box? didn't I say it should be a grok bot chat interface?" ADR 0024 quotes his design: agents "should just answer like any other bot … just like Grok works". Channels, threads and direct messages already read that way; the task panel didn't.

## Decisions

**The runs of one agent conversation are one chat in the task panel.** Runs that share an agent conversation (`a2aBindings.conversationId`, the `a2aConversations` row) draw as one block across the Runs grid, laid out as a direct conversation is (DESIGN.md, Conversations): what people sent on the right or under their face, the agent's answers and questions as its own messages in its character's tint, with what it made as result cards under them, and as short centered lines what the agent didn't say itself (it didn't take the message, it couldn't finish, it declined, it stopped, the room lost it) and its progress while it works. "Icarus is writing…" shows under the box while a run works. There is one message box at the bottom.

**Runs stay the unit of tracking.** Nothing about runs changes in the backend: the Inbox, run states, stopping, the task board's counts and the task's own state line still count runs. Each answer and line has Run details (the terminal icon the chat's hover bar uses), which opens that run. The head of the chat shows the agent and the state of the open run, the conversation's latest, and Ask it to stop and Stop following act on that run. The box sends `runs.reply` on that run, which goes to the agent's open task or, once it finished, starts the next run in the same context (ADR 0024).

**Which runs join which chat.** A run joins the chat of its conversation, and the chat sits where the conversation's first run is in the task's list. Two conversations on one task are two chats. A first run whose message the agent never took is in its conversation like any other run, and its refusal shows as a line. A run from before conversations has none, so it is a chat of its own. A run that isn't A2A (a terminal, a T3 Code thread, a Space) keeps its card. Keeping a run (the task's owner, even when the task has only this one) keeps the conversation's latest run.

**The backend gives the panel the conversation, and nothing else changes.** `runs.get`, `tasks.get` and every run view already carried what was sent (`a2a.messages`), the agent's latest status message and artifacts, and its state; the run view now also names its conversation (`a2a.conversationId`). No query was added.

## Consequences

- A run keeps only the agent's latest status message (ADR 0012), so the chat shows each run's latest progress line and its final answer, not every progress message the agent sent during the run. In a channel, thread or direct message those earlier messages are still posted (ADR 0024). Keeping them per run would need a bounded history on `a2aBindings`; nobody has asked for it yet.
- A run lists its last 10 messages sent (`a2a.messages`), so a run with more replies to one open task shows its last 10.
- The run panel (Run details) and an agent's settings keep the per-run view: the reply box there still continues the conversation.
- The schema doesn't change; `a2a.conversationId` is optional on the run view, and absent on runs from before conversations.
- Decided from Julio's steer on 2026-11-05; the PR that brings this ADR is where to object.
