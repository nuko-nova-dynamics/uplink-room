---
status: accepted
---

# A person's Link is a roster agent that reads their Inbox conversation

On 2026-11-18 Julio asked for the Inbox to work like an iMessage conversation, as Grok Bot does: you send, your message shows as your bubble, and if it is work, a task and a thread start without a dialog asking for a task first. He picked each part on a Parley page of mocks (`.parley/decisions/inbox-link-conversation/`): one timeline, an event line and a run card when work starts, a plain answer when it isn't clear the message is work, a "Send to" chip in the composer, and an agent from the roster deciding rather than the room. The first step, shipped before this, made Enter in the Inbox start a Claude Code thread with no dialog.

The open question was who reads a message and decides whether it is work. The room has no model of its own: every decision in it is made by a person or an agent. Three ways were weighed. The room could call a small model on each message: always on, but it needs an API key, pays per message, and puts a second decision-maker beside the team's agents. Every message could start a thread, as T3 Code does: fast, but "thanks!" becomes a thread. Or an agent the team already runs could read the message and use the Room API it already has.

## Decisions

- **A person's Link is one agent from the roster, picked by that person** (`members.setLink`, stored as `members.link`: the agent's member and the direct message with it). Each person picks their own or none. Only an agent the room can reach (over A2A, at a routine webhook, or through the connector when it checks in) can be picked, since any other would never get the messages.
- **The Inbox conversation is the direct message between the person and that agent.** Setting a Link opens it the way `channels.openDirect` does, so it is an ordinary direct message: the router already sends an agent every message in a direct message it is in (ADR 0026), and the conversation keeps its files, history and deliveries.
- **The agent decides, with the tools it already has.** A message the person writes there reaches the agent with one more instruction: it is that person's Link; it answers conversation and questions there; when a message asks for work, it starts it itself with `tasks.create` and `runs.start` instead of asking first; and it posts one line with the run in `mentionedRuns`. The webhook body's `instruction` and the A2A message's footer carry it. An agent that checks in reads the conversation through the Room API and gets no such line.
- **The Inbox draws the conversation as one timeline above what needs you:** your messages on the right, the agent's on the left, and each run the agent names as a centered "Started a thread: …" line with a card that follows the run. A reply that names no run offers "Make it a task", which starts a thread from your message before it.
- **The composer's "Send to" chip** sends to your Link by default, or as a new thread with no question asked (the first step's behavior), or to another roster agent as a task (ADR 0044). The same menu picks or clears your Link. With no Link, the box starts a thread on Enter.

## Consequences

- A Link that is offline or slow leaves the message waiting in the conversation, as any direct message to it would. The Inbox says so in one quiet line under the message (a failed send, a wait for an agent that checks in, an A2A message not taken), and when the room can't reach the Link at all, the box starts a thread until it can.
- Whether a message is work is the agent's call, so two people's Links can treat the same words differently. "Make it a task" and the "New thread" target are the person's ways around a wrong call.
- Work the Link starts is team work, as the Inbox's box always made it: the task's title and description are visible to the team like any task's, and the task is the person's own (the Link passes ownerId). What stays in the direct message is the conversation, not the work.
- The room holds no model key and pays for no calls for this.
