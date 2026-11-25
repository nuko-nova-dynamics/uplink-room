---
status: accepted
---

# How v1 builds agent messaging, pairs and connectors

ADRs 0026, 0027 and 0028 decided what agents and runs can do with each other. Building them (issue #139) needed nineteen choices the ADRs left open, mostly where today's code can't take the ADRs as written: a message's author must be a team member, `mentionedRuns` already means a link chip, and every Room API function needs a team. The build plan attached to #139 names the file and line behind each. Julio decided these on 2026-11-05: all as the plan recommended, except agents in pairs (D11). He left the technical ones (D1, D2, D4, D8, D9, D16, D17) to the lead, who took the recommendations.

## Decisions

**Runs in chat**

- **D1. A run is addressed with `<@run:RUNID>`** in a message's body, or its id in `addressedRuns` on `messages.post` and `messages.edit`, and the message records it in `addressedRuns`. `mentionedRuns` keeps its meaning, a chip linking a run, because agents already pass it that way.
- **D2. A run's message is stored under its driver at the time**, with `asRun { runId, label }`: a message's author must be a member, and ADR 0026 makes the driver answer for the run.
- **D3. Messaging a run needs only `messages.post`.** The run decides what to do with it. `runs.start` stays the scope for handing an A2A agent work (ADR 0012).
- **D4. A run joins a direct message as a `channelRuns` row, and its person joins as an ordinary member**, so the one access check (ADR 0015) stays as it is. Amended by ADR 0039: a run hears a direct message only when everyone who can see its output is in it, so a team run in one hears nothing there.
- **D5. `uplink-bridge say` needs `--in <place>`**, and `reply <messageId>` answers in that message's place and thread, so a run never posts in a team channel by surprise.
- **D6. Only a run's driver and its person read the texts in its inbox.** Others see that it got messages, not what, as ADR 0015 does for private run texts.
- **D18. The room retries a Hermes context refused for its turn limit only for a person's message.** With no loop limit in the room (ADR 0026), Hermes's own limit is the one guard its owner set.
- **D19. A message to a run doesn't banner its driver** unless it also mentions them, so a busy exchange between agents doesn't flood the person.

**Proving who is speaking**

- **D7. A T3 Code thread run is trusted by `T3CODE_THREAD_ID` on a personal machine**, where every thread is its person's. On a team machine it uses a key valid for one hour that posts only as that run, given in each delivered message's reply hint. Amended by ADR 0037: after the #138 tests, every thread run uses the key, on every machine, and `T3CODE_THREAD_ID` only has to agree with it.
- **D8. A joined run proves itself with a run token.** Signing in with Clerk once per machine gives a room session token; each join gets its own run token, tied to that session and to the harness's session id. The agent never holds an agent key.

**Pairs**

- **D9. Pairs live in their own account-level tables and `pairs.*` functions**, not in a channel, so no team path can reach one.
- **D10. Leaving a team changes nothing about a person's pairs**, since a pair belongs to its people. Deleting the account takes their runs out, keeps their messages under "A deleted account", and ends a pair left with fewer than two people.
- **D11. Agents can join a pair too.** An agent joins with a pair code its person passes on, as a run does, and acts there with its agent key. The pair shows nothing of the agent's team. (The plan had proposed people and their runs only.)
- **D12. People in a pair see each other's name, picture and run labels**, never an email or a team's name.
- **D13. A joined run without `--team` can only pair.** With `--team` it is a team run, Live in the roster and in nobody's Needs you, since a joined run reports no state.

**Hosted assistants**

- **D14. A remote connector's agent key starts with `room.read` and `messages.post`**, and only the person raises it in the app (ADR 0005).
- **D15. The person approves a connector in the app**, choosing its team, name and scopes, because Clerk's consent screen can't pick a team. Until then every tool says so.
- **D16. The room checks Clerk's token on each call**, in a Node action, cached by its hash until it expires, and never mints a second token, as the MCP specification asks of a resource server. Clerk's token format and audience are confirmed before building.
- **D17. A Grok Bot routine started from the webhook is not a run.** The message shows a delivery record, sent or failed, because a 200 says only that a routine started, which the room can't follow.

## Consequences

- Schema changes stay additive: new tables (`runInbox`, `channelRuns`, pairs, tokens, grants), new optional fields (`addressedRuns`, `asRun` and `runs.hears`), wider unions.
- A run's name is worked out from the live runs each time it's shown, so it can change (Claude Code 2 (Julio) becomes Claude Code (Julio) when the first ends); a message keeps the name its run had when it posted.
- An app from before shows `<@run:…>` as text.
