---
status: accepted
---

# Grok Bot gets messages at its routine webhook, and the other hosted assistants check in on their own schedule

ADR 0028 has Grok Bot take messages at its routine webhook, and has dots, Muse and Duet read and post through the connector (ADR 0031) when they run. Decision D17 of ADR 0029 made a webhook send a delivery record, not a run. This is how slice 14 of #139 builds both, decided on 2026-11-05 while building it.

xAI documents the webhook this way (docs.x.ai/grok-bot/skills-routines-and-automations, "Webhooks", and cursor.com/help/grok-bot/routines, read 2026-11-05): a routine shows **POST to** (the URL) and a **key**; "Senders include it as `Authorization: Bearer <key>`"; the request is an HTTP POST "with the header and, optionally, a JSON body; the Bot receives the body with the routine instruction"; "A `200` response means Grok Bot accepted the call and started a run, not that the Bot has finished ... Any other response means a run didn't start." No signature, schema or size limit for the body is documented, and the security pages say nothing more about webhooks.

## Decisions

- **A person sets an agent's routine webhook** with `webhooks.set` (its URL and key), under the same rule as an A2A endpoint: the person accountable for the agent, or an admin, with `people.invite` (ADR 0012). In the app it is a section of the agent's panel, so Grok Bot is first approved through the connector, then given its webhook. An agent has an A2A endpoint or a webhook, never both, so each message goes one way.
- **The key is kept as endpoint tokens are** (ADR 0012): sealed with AES-GCM under `A2A_CREDENTIALS_KEY`, bound to the agent and the URL, opened only by the send action just before the call. No query returns it; `webhooks.get` shows its last four characters. Setting the webhook again replaces the row, so a send queued for the old URL fails instead of going to the new one.
- **A message reaches the webhook under ADR 0026's hearing rules**, the router's (`lib/router.ts`): a mention, every message in a direct message the agent is in, and replies in its own thread. Its own messages never go back to it. Sending starts a run of the agent's own, so it is work: an agent sender needs `runs.start`, as for A2A.
- **The request.** `POST <url>` with `Authorization: Bearer <key>`, `Content-Type: application/json` and its `Content-Length`. The body is one JSON object:
  - `type`: `"uplink-room.message"`, so a routine instruction can tell it apart.
  - `instruction`: a paragraph for the model: who wrote to it where, whether the person accountable for the sender is the one who added it, that it decides whether to act on a request, and to answer by calling `messages_post` through its Uplink Room connector with the arguments in `reply`.
  - `team` `{ teamId, name }`, `you` `{ memberId, name }`.
  - `message` `{ messageId, text, sentAt, attachments? }`: the text as written, mention tokens turned into names, cut at 16,000 characters.
  - `from` `{ memberId, name, kind: "person" | "agent" | "run", runId? }` and `accountable` `{ memberId, name, isYourPerson }`.
  - `place` `{ label, kind: "channel" | "direct", channelId, channel?, threadRootId? }`.
  - `history`: what was said in the place before it, as ADR 0024 sends it: at most 20 messages and 4,000 characters, each cut to 1,000, oldest first, the agent's own marked "(you)", credentials taken out, and nothing from a place the agent can't see. A routine starts fresh every time, so it is always the place's recent messages.
  - `reply` `{ tool: "messages_post", arguments: { channelId, replyTo? } }`: at a channel's top level and in a direct message it answers in the place; in a thread, in the thread.
- **The same outbound guards as A2A** (ADR 0012): public https only (`A2A_ALLOW_INSECURE_PEERS` for development), checked when the URL is set and again by `guardedFetch` when each request connects, so a name that rebinds to a private address is refused at the send; no user name or password in the URL; never the deployment itself; redirects never followed; a 15-second deadline on the whole exchange.
- **Only 200 is sent.** Anything else is failed, with the status, up to 2 KB of what the webhook said, and a hint for 401, 403, 404 and 429. Every reason has the key taken out (the token, URL-encoded and JSON-escaped, and credential headers) before it is kept, cut to 300 characters. **Nothing is sent twice**: a send that timed out may have started a run, and a retry would start another. xAI's docs leave a rerun to the person ("send the call again").
- **Checked again just before the send.** The send action takes the delivery in one mutation that checks the agent, its person, the webhook and the message are still there and that the agent can still see the place. An agent removed from a private channel or direct message after the message was queued gets nothing, and the message says why. Taking it records the attempt, so a second run of the action never sends it.
- **A send never stays "Sending".** Convex doesn't retry a scheduled action that fails (docs.convex.dev/scheduling/scheduled-functions, "Error handling"), so each send schedules a check two minutes later, a mutation, which Convex runs exactly once. A delivery still sending then fails: "Unconfirmed: it may have reached Grok Bot" if the action had taken it, or "wasn't sent" if not. Neither sends it again.
- **An agent checks in on its own schedule** when it joined through the connector, its key still works, and it has neither an A2A endpoint nor a webhook. This is worked out when read (`reach` on `teams.members` and `teams.roster`), not stored, so adding a webhook changes it at once. A message that reaches such an agent is recorded as waiting.
- **Waiting turns to seen when the agent reads the message through the connector**: a message that `messages.list`, `messages.replies`, `messages.get` or `messages.addressed` returned to it, and only those, so the rest of a page and other places keep waiting; or when it posts in the place (a channel's top level, or a thread and its first message). The connector marks it only while something waits for the agent (one indexed read per call otherwise). Reads through `/api/v1/call` with a pasted key don't mark it: such an agent doesn't check in by this rule.
- **One table holds both**, `agentDeliveries`, one row per message and agent (`via` webhook or check_in; status sending, sent, failed, waiting, seen). A message counts its rows (`deliveryCount`), so a channel's messages read them only when they have some. `messages.get` and the lists show them as `deliveries`.

## Consequences

- The schema change is additive: `webhooks`, `agentDeliveries`, an index of `connectors` by agent, optional `deliveryCount` on `messages`, optional `attemptedAt` on a delivery, and `"webhook"` in an agent's `connection`.
- The app has no Test button for a webhook: a test starts a real routine run and spends its person's usage. A send that failed is sent again by writing the message again.
- A routine's own run is invisible to the room: a 200 shows "Sent", and the answer shows when Grok Bot posts it through the connector. If it never does, the room can't say why.
- What a routine does with the body is its instruction's business. Changing the body's fields breaks routines written against them, so new fields are added beside the old ones.
- Waiting rows for an agent that never checks in stay waiting; a read marks at most 100 messages at a time, and a post at most 100 rows in its place. The place is part of the index range, so rows waiting elsewhere never use up that batch.
- Not checked against a live Grok Bot routine: the tests run the real send against a local server. The request format follows xAI's docs, which document no body schema.
