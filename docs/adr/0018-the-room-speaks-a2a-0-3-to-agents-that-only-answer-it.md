---
status: accepted
---

# The room speaks A2A 0.3 to agents that only answer it, and checks a connection before work is sent

ADR 0012 had the room speak A2A 1.0 only and refuse cards that offer only 0.3. On 2026-11-04 the first real gateway the room called, Icarus, a Hermes Agent on a VPS, refused the room's first run: its `SendStreamingMessage` and then its `SendMessage` both came back as JSON-RPC `-32601` "method not found: ", with no method named. The person who sent the work saw that raw text under a second box, "The agent didn't take it."

What happened: the room sent its request bodies chunked (Node's `http.request` with `write()` and no `Content-Length`). Hermes's A2A gateway runs on Python's `http.server`, which reads a body by its `Content-Length` only (`plugins/platforms/a2a/adapter.py` in NousResearch/hermes-agent). It read an empty body, so the method was `""`. Hermes serves `SendMessage` and the other 1.0 methods, and the 0.3 names as aliases (its docs, `user-guide/messaging/a2a`). A Python server with the same read logic answered `method not found: ` to the room's chunked request, and `SendMessage` once the request carried `Content-Length`.

Other gateways do answer only 0.3, some behind a card that promises 1.0: LiteLLM's A2A bridge (BerriAI/litellm#30795, #32609) and OmniRoute (diegosouzapw/omniroute#10839) were reported for it, and agents built on the official SDKs before their 1.0 releases (`a2a-sdk` 0.3.x, `@a2a-js/sdk` 0.3.x) are honest 0.3 servers. This ADR covers both cases.

## Decisions

**Every request carries `Content-Length`.** `guardedFetch` sends the body whole, with its length, never chunked. This alone fixes Icarus.

**A2A 1.0 stays the default; a card that names 0.3 is accepted, and the room speaks 0.3 to it.** The card names 0.3 with a top-level `protocolVersion` of 0.3.x and `url`, served over `preferredTransport` (JSON-RPC when absent) or a JSON-RPC entry in `additionalInterfaces`, or with a 0.3 JSON-RPC entry in `supportedInterfaces`. A 1.0 JSON-RPC interface is always chosen first. Cards for 0.2 and earlier, and cards with no JSON-RPC interface, are still refused, with a message saying so.

**What differs when the room speaks 0.3** (a2a-protocol.org/latest/whats-new-v1, and the 0.3.0 JSON schema in a2aproject/A2A):

| | A2A 1.0 | A2A 0.3 |
| --- | --- | --- |
| Methods | `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask` | `message/send`, `message/stream`, `tasks/get`, none, `tasks/cancel`, `tasks/resubscribe` |
| `A2A-Version` header | `1.0` | left out: an agent reads a missing one as 0.3 (spec 3.6.1, 3.6.2) |
| Message | role `ROLE_USER`, parts told apart by their members (`{ text }`) | `kind: "message"`, role `user`, parts with `kind` (`{ kind: "text", text }`) |
| Send options | `returnImmediately: true` | `blocking: false` |
| Send result | `{ task }` or `{ message }` | the Task or Message itself, with `kind` |
| Stream events | `{ statusUpdate }`, `{ artifactUpdate }` | `kind: "status-update"` (with `final`), `kind: "artifact-update"` |
| Task states | `TASK_STATE_WORKING`, … | `working`, `input-required`, … |
| File parts | `{ url, mediaType, filename }` | `{ kind: "file", file: { uri, mimeType, name } }` |

The error codes the room reads (`-32001` task not found, `-32002` not cancelable, `-32004` unsupported, `-32601` method not found) are the same in both. The room reads either shape from any agent; only what it sends depends on the version.

**When a send is refused for its version, the room asks once in the other version, and remembers the answer.** If the agent answers `SendMessage` (or `message/send`) with `-32601` "method not found", or `-32009` "version not supported", and the room hasn't yet learned which version the agent answers, the same message, with the same message id, goes once in the other version. JSON-RPC 2.0 defines `-32601` as "the method does not exist / is not available", and a 1.0 agent answers `-32009` to a request without the version header (it reads that as 0.3, spec 3.6.2) before it processes anything. Either way the agent took nothing, and the second send can't deliver the work twice. Only a clear refusal counts: an answer that never came, a timeout, an HTTP 5xx (even one carrying `-32601`) or `-32603` may come after the agent took the message, so those go to the search for the message (ADR 0012) as before, never to the other version, and never from a stream to a plain send either. A stream refused with `-32009` switches version the same way, once, and streams again in the other version; if that version offers no stream, the message goes plainly there. A stream answered `-32601` still means only "no stream here": the message goes plainly in the same version, and that send decides the version. The version a message last went out in is kept with the message (`a2aBindings.outbox[].dialect`), apart from what the room learned, so a message whose answer was lost is looked for in the version it went in; if the agent answers there, that is the version the room speaks to it. The version that answered is kept on the endpoint (`a2aPeers.speaks`), and every later call to that agent uses it. It is cleared when the card names another endpoint or another version, or the address changes, and each of those bumps `a2aPeers.dialectGeneration`, so a send or a check that started before can't bring it back. When neither version's method is found, the run fails with a sentence that names both methods and quotes the gateway.

**A2A 0.3 has no way to list tasks.** When the room speaks 0.3 and a message's delivery is unclear, it can't look for the message, so the run shows Unknown at once: "delivery not confirmed".

**Check connection.** The person accountable for an agent, or an admin, can check its endpoint from Settings → Agents before sending it work (`a2a.checkConnection`). The room makes one call that needs the token and changes nothing: `GetTask` on a task id that doesn't exist (`tasks/get` in 0.3). "Task not found" means the method is there and the token was taken. A `-32601` or "version not supported" is asked once in the other version, as for a send. HTTP 401 or 403 means the token was refused, the same in either version, so the other version isn't tried. The result is a sentence, kept on the endpoint (`a2aPeers.connection`), with who ran it and when. A version other than the card's becomes what the room speaks to the agent. Each check has its own id, never reused: a result lands only on the check it belongs to, and only while the endpoint and the card's version generation are the ones it read, so a late result for an old address or card changes nothing.

**The token never stays in what an agent said.** A gateway can echo the request's headers in an error, and a run's errors, a check's result and the agent's messages are readable by anyone in the team with `room.read`, while the token shows only as its last four characters. Every text an agent supplied is cleaned before it is kept (`lib/a2a/redact.ts`): the token (as sent, URL-encoded and JSON-escaped), the value after a credential header's name (`Authorization`, `X-API-Key`, the named header the room sends, and others), and `Bearer` or `Basic` followed by something shaped like a token (16 or more characters with no space, holding a digit or both cases, so "basic arithmetic" stays as written). Cleaning always comes before cutting: the worker cleans each text as it parses it, before cutting it to 4,000 characters (or an error to 600), and a cut that ends with the start of the token (6 characters or more) loses that start too. Pieces of a streamed artifact are joined in the mutation that saves them, so that mutation opens the token itself, the way a step does before a call, and cleans the joined artifact and the status message right before it writes them; a token sent in pieces is taken out once its pieces meet. The token never travels in an argument.

## Consequences

- Errors from a gateway are quoted without an empty tail: "method not found: " shows as “method not found”.
- A run whose send was refused shows one box with the reason, not the reason and "The agent didn't take it."
- The fake agents in the tests read bodies by `Content-Length` only, as Hermes does, so a chunked request fails every A2A test. They also run the official SDK at 0.3 (`@a2a-js/sdk` 0.3.14), honestly or behind a 1.0 card.
- Schema changes are additive: `a2aPeers.speaks`, `a2aPeers.connection` and `a2aPeers.card.protocolVersion` are optional; a card read before them counts as 1.0.
- Decided while fixing the Icarus failure, 2026-11-04, without a meeting; the PR that brings this ADR is where to object.
