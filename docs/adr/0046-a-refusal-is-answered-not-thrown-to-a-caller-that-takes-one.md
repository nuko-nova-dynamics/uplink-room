---
status: accepted
---

# A refusal is answered, not thrown, to a caller that takes one

The room says no with `roomError(code, message)`, a thrown `ConvexError`. Convex's exception reporting sends every error a function lets escape to Sentry as an uncaught exception, so while 0.2.15 was landing on 2026-11-06, refusals the room makes by design opened new issues in `uplink-room-backend` and fired its high-priority alert: an ended run's token watching `live:query` (UPLINK-ROOM-BACKEND-8), `uplink pair --resume` with no live Pair (-7), an invite for another address (-5), a private A2A address (-6). Each distinct message is a new issue. Convex's Sentry integration takes only a DSN and tags: it has no filter and no `beforeSend`. Sentry's error-message inbound filter needs a Business plan, and the organization is on a sponsored Team plan. So refusals stop being exceptions where they're made: a function answers one as the value `{ refused: { code, message }, thrown: true }`, which is a successful execution and is never reported.

## Decisions

- **A refusal is a `roomError` with one of the codes `unauthenticated`, `forbidden`, `not_found`, `invalid`, `conflict`, `no_free_slot` or `warning_required`.** `not_configured` isn't one: a deployment missing a setting is something to fix, so it stays an error and is reported, as is every other throw (`lib/refusals.ts`).
- **The internal functions of every Room API function always answer refusals.** Their only callers are the HTTP endpoint, `live:query` and the remote MCP connector, which ship with the backend and already turned a returned refusal into its error (`answer()` in `http.ts`). Over HTTP the response is the same status and code as before.
- **A public function answers refusals only to a caller that sends `acceptsRefusals: true`.** Every public function is built with `publicQuery` or `publicMutation` (the Room API factories and the hand-written ones: `live:query`, `bridge:*`, `invites`, `teams`, `people`, the Pair pages), and a test checks that each one takes the argument. The app (`RoomConvexClient`), the bridge's Convex link and room-client's watches (`acceptingRefusals` in `@uplink-room/protocol/refusals`) send it on every call and throw a refusal marked `thrown` again as the same `ConvexError`, so no code above them changes. An older app, bridge or command line that doesn't send it gets the thrown error, as before.
- **A mutation answers a refusal only when it has written nothing yet:** no document, scheduled function or file (`ctx.meta.getTransactionMetrics()`). Then answering changes no data, exactly as throwing would. A refusal after a write is thrown, so Convex rolls the write back; it is still reported.
- **A refusal a mutation returns on purpose, so its writes stay** (a wrong pair code counted, `lib/pairs.ts`), has no `thrown` mark and is returned as it always was, with or without the argument. The app reads it as a value (`joinOutcome` in `views/Pairs.tsx` shows its message), so the clients throw again only a refusal marked `thrown`.

## Considered options

- **A Sentry inbound filter on the message** drops events at ingest, but needs a Business plan, and it would match message text that the code is free to change.
- **Fingerprint rules that group refusals by code, then archiving those issues**, work on any plan, but the events still arrive and count against the quota, and the grouping hangs on message text too. It hides the symptom instead of removing it.
- **Running each mutation's work in a nested `ctx.runMutation`**, whose writes roll back when it throws even if its caller catches (Convex docs, "Writing data"), would answer refusals after writes as well. It costs a nested function call on every mutation, and every Room API function would need a second registered function to call. Refusals after writes are rare, and they stay reported, which is the old behavior.
- **Answering refusals to every caller, without the argument**, would break each app, bridge and command line already installed: an old app would read a refused `invites.accept` as a success.

## Consequences

- **Deploy the backend before publishing the app, bridge or command line that send `acceptsRefusals`.** A backend from before this change refuses the unknown argument on every call, so such a client against it fails everything. Nothing enforces the order yet; `docs/releases.md` doesn't name a backend step.
- A new public function must use `publicQuery` or `publicMutation`; the test in `tests/refusals.test.ts` fails otherwise, since the app sends the argument to every function.
- Refusals still reach Sentry from callers built before this change (0.2.17 and older) until they update, and from a mutation that refuses after writing.
- The query arguments the app subscribes with carry the flag, so `RoomConvexClient` maps an optimistic update's local store to them (`acceptingStore`).

On 2026-11-06 a local Convex backend ran this change. A mutation refusing before any write answered `{ refused: { code: "not_found" } }`. One refusing after inserting a document, and one after scheduling a function, threw, and neither the document nor the scheduled function remained. `bridge:heartbeat` and `live:query` with a token that isn't valid threw a logged `Uncaught ConvexError` without the argument, and with it answered the refusal and logged nothing. The bridge's adapter and a room-client watch received the same `ConvexError` as before. `joined.pairResume` over HTTP with a token that isn't valid returned the same 401, and nothing was logged. With the previous `lib/room.ts` the same call logged `M(joined:pairResumeByRun) Uncaught ConvexError`, the function UPLINK-ROOM-BACKEND-7 names.
