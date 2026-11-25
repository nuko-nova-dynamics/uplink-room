# Error reports

The desktop app, the bridge and the Convex backend report errors to Sentry, in the `nuko-nova-dynamics-llc` organization:

| Sentry project | What reports to it | Turned on by |
| --- | --- | --- |
| `uplink-room-desktop` | The app's main process and its window (renderer) | Release builds only (`electron-vite build --mode release`, which `pnpm dist` and the Package workflow run), with `VITE_SENTRY_DSN` in `apps/desktop/.env.release` |
| `uplink-room-bridge` | The bridge: the standalone `dist/uplink-bridge.mjs` and the copy inside the app | Bundled builds only, with `BRIDGE_DSN` in `packages/bridge/src/telemetry/sentry.ts`. Running from source never reports. |
| `uplink-room-backend` | Convex function errors on the production deployment `fleet-jaguar-632` | Convex's built-in Sentry exception reporting, configured on that deployment (below). The dev deployment doesn't report. |

`UPLINK_NO_TELEMETRY=1` (or `DO_NOT_TRACK=1`) in the environment turns reports off for the app and the bridge. CI sets it.

## What a report may carry

All of it is decided in one place, `packages/bridge/src/telemetry/scrub.ts`, which both the app and the bridge run on every event (`beforeSend`) and breadcrumb (`beforeBreadcrumb`). `packages/bridge/test/scrub.test.ts` checks that a report sent through the real SDK holds no terminal output, file contents, transcripts, message bodies, agent keys, bridge tokens, Clerk tokens, environment values or email addresses.

- **Sent:** the error's type, its stack frames (file, function, line, column), the OS, runtime, Electron and app versions, CPU and memory, the release, and the member id of whoever is signed in (the app) or whom the machine belongs to (the bridge). No name, no email.
- **Messages:** JavaScript's own error types (TypeError, SyntaxError, RangeError and the rest) keep their message, because the engine writes those (`Cannot read properties of undefined (reading '…')`). Quoted text in them is redacted, since V8 quotes the input in parse errors. Any other error (`Error`, `ConvexError`, a library's class) is sent as its type and stack with its message reduced:
  - a library or platform message on the safe list (`SAFE_MESSAGES` in `scrub.ts`: WebAssembly and content security policy refusals, Krisp's, LiveKit's connection and device errors, fetch and socket failures) is sent as its **template**, the message with quoted text, URLs, emails, ids, long runs and numbers replaced by `<q>`, `<url>`, `<email>`, `<id>` and `<n>`;
  - anything else is `(message not sent)`, with nothing derived from the message: no text and no hash, since a hash of short leftover text lets anyone holding a report test guesses at it. The error's class and stack say where it came from. Code puts content in messages (`Couldn't send ${body}`), and no pattern can tell that apart from a description.
  - Environment values are taken out of a message before its template is made, so a safe message can't carry one. A template is made only where the environment is known: the app's window doesn't know it, so its reports leave messages for the main process (`messagesLater`), which templates each once after taking the values out. Where the environment isn't known and nothing scrubs after it (the window's log lines), a safe message is kept only when it has nothing to template; a variable one is `(message not sent)`, since `pass-2024-otter-blue` templated there would reach main as `pass-<n>-otter-blue`, which no redaction matches.
- **The error's class:** when the page's error event has no error object, Sentry builds one from the message and knows only the standard names, so `Uncaught CompileError: …` arrived as type `Error`. The scrubber takes the class back from the message.
- **Frames in `blob:` scripts:** a script run from a `blob:` URL (Krisp's noise filter runs its code that way) has no source map. The window notes which bundle made each script blob (`renderer/lib/log.ts`), and such a frame is sent as `app:///blob/<that bundle>`, not in-app, so a report says it was Krisp's (`assets/dist-*.js`, its lazily loaded chunk) and the bundle's own frames still map.
- **Redacted in what's left:** JWTs, the room's secrets (`urk_…`, `ubt_…` and the rest from `packages/backend/convex/lib/crypto.ts`), pairing codes, long hex or base64 runs, email addresses, URL query strings and fragments, and the value of any environment variable 8 characters or longer. The home folder becomes `app:///~` in file paths. It must stay an absolute path or URL: Sentry skips the source map for a frame at `~/…`.
- **No IP or location:** every event tells Sentry not to infer the IP (`sdk.settings.infer_ip: "never"`). Sentry still derives a city from the connection, even with IP storage off ([its docs](https://docs.sentry.io/security-legal-pii/scrubbing/server-side-scrubbing/#geographic-information)), so each project has the advanced scrubbing rule [Remove] [Anything] from [`$user.geo.**`], and "Prevent Storing of IP Addresses" is on.
- **Dropped:** request headers, cookies and bodies, extra data, local variables, source lines, the hostname, every user field but `id`, and every breadcrumb except the app's own log lines (category `uplink`, `docs/logs.md`, scrubbed as they're written and again here), Electron lifecycle events, navigation, and requests (method, status and the URL without its query). Console, click and key-press breadcrumbs are never recorded.
- **Integrations left out of the app:** native crash dumps (a minidump holds raw process memory, so it could hold a terminal's text; renderer and GPU crashes are still reported, without a dump), console capture, local variables, source context, screenshots, and the GPU context (it calls `app.getGPUInfo()`, and for an error before the app is ready that trips Chromium's startup check, `Check failed: !GpuDataManagerImpl::Initialized()`).
- **Session Replay is off.** The terminal view draws its text into the page (xterm's DOM renderer) and file and page names sit in `title` attributes, so a replay would depend on Sentry's masking defaults covering every one of them. Tracing, profiling and logs are off too.

The backend is different: Convex's integration sends what Convex sends, and it can't be scrubbed in code. It tags each event with the function name, type and request id, and uses the caller's Clerk `tokenIdentifier` (issuer and Clerk user id, no email) as the Sentry user. A function's error message goes as thrown, so the backend should not put message bodies or file contents in errors it throws. Sentry's server-side data scrubbing (on for all three projects, with the defaults) is the backstop there.

## Readable stack traces

Release builds make hidden source maps (the bundles name no `.map`; electron-builder leaves the maps out of the app and the bridge's tarball ships only the `.mjs`) and stamp each bundle with a Sentry debug id. When `SENTRY_AUTH_TOKEN` is set, `@sentry/bundler-plugins` uploads the bundles and maps: the app's to `uplink-room-desktop`, the app's main bundle also to `uplink-room-bridge` (it holds the app's bridge), and the standalone bridge's to `uplink-room-bridge`. Sentry matches each frame to its map by debug id. Without the token the build is the same and nothing is uploaded; a failed upload is a warning, not a failed build.

The Package workflow has `SENTRY_AUTH_TOKEN` (an organization token with the `org:ci` scope) and also packs the standalone bridge on Linux, so its map is uploaded once from a known build.

## Check it

`UPLINK_TELEMETRY_TEST=1` makes each process send one `TelemetryTestError` (its message isn't sent, like any non-engine error):

```sh
# The app: build for release, then run it
unset ELECTRON_RUN_AS_NODE
pnpm --filter @uplink-room/desktop build:release
cd apps/desktop && UPLINK_TELEMETRY_TEST=1 ./node_modules/.bin/electron .   # one error from main, one from the window

# The bridge
pnpm --filter @uplink-room/bridge build
UPLINK_TELEMETRY_TEST=1 node packages/bridge/dist/uplink-bridge.mjs limits
```

`UPLINK_BRIDGE_SENTRY_DSN` points the bridge at another DSN, and `VITE_SENTRY_DSN=… pnpm build:release` builds the app against one, for a local receiver.

## The backend's setup

The team is on Convex Professional, which exception reporting needs. `fleet-jaguar-632` reports to `uplink-room-backend` through the integration Convex lists under Deployment settings → Integrations. It was created with the [Deployment API](https://docs.convex.dev/deployment-api/create-log-stream) call below, which takes a deploy key or team token; the dashboard does the same. To point it at another DSN, delete it there (or with `delete_log_stream`) and create it again.

```sh
printf 'Authorization: Convex %s' "$CONVEX_DEPLOY_KEY" | curl -s -H @- -H 'content-type: application/json' \
  -X POST https://fleet-jaguar-632.convex.cloud/api/v1/create_log_stream \
  --data '{"logStreamType":"sentry","dsn":"<uplink-room-backend DSN>"}'
```

Convex says events take a minute or two to reach Sentry, and its docs ask for the Node.js platform on the Sentry project, which `uplink-room-backend` has.

### Refusals aren't reported

Convex reports every error a function lets escape, and nothing in the integration or in Sentry on our plan can drop some of them: a Sentry log stream takes only `dsn` and `tags`, and Sentry's error-message inbound filter needs a Business plan. So a refusal the room makes by design (a `roomError` with `unauthenticated`, `forbidden`, `not_found`, `invalid`, `conflict`, `no_free_slot` or `warning_required`) doesn't escape. The function answers it as the value `{ refused: { code, message }, thrown: true }`, which is a successful execution, never an uncaught exception (ADR 0046, `packages/backend/convex/lib/refusals.ts`):

- The internal functions behind the HTTP endpoint, `live:query` and the remote MCP connector always answer refusals. The HTTP response is the same as before.
- A public function answers them to a caller that sends `acceptsRefusals: true`: the app (`apps/desktop/src/renderer/lib/roomConvexClient.ts`), the bridge's Convex link and room-client's watches (`@uplink-room/protocol/refusals`). Each throws a refusal marked `thrown` again as the same `ConvexError`; one a function returns on purpose (`pairs.join`'s for a wrong code) has no mark and stays a value. An older client that doesn't send it still gets the thrown error, and Sentry still gets that one.
- A mutation that refuses after it wrote something still throws, so Convex rolls the writes back; that one is reported too.
- An agent's call with another table's id (a Pair message's id passed to `messages.get`) is refused the same way, as `invalid`. Convex checks an id's table before a function runs, and a call that fails that check is reported, so the internal functions behind the HTTP endpoint, `live:query` and the remote MCP connector take ids as strings and check each one's table first (`packages/backend/convex/lib/idArgs.ts`). The answer names both tables. That was UPLINK-ROOM-BACKEND-J.

What still reaches `uplink-room-backend` is a real error: anything else a function throws, `not_configured` (a deployment missing a setting), a refusal after a write, and refusals from an app, bridge or command line built before this change (0.2.17 and older). UPLINK-ROOM-BACKEND-5 to -8 are the refusals this stopped. To check a change here, run it against a local deployment with `npx convex dev --tail-logs always`: a refusal answered logs nothing, and a thrown one logs `Uncaught ConvexError: …`, which is the failure prod sends to Sentry (its issue title is that line).

## Kept out by lint and models

Each kind of error Sentry has caught gets a check that fails before the next one ships:

- **Lint** (`scripts/lint/room.mjs`, run by `pnpm lint`):
  - `room/entry-handles-closed-output`: every Node entry point calls `onClosedOutput` (`@uplink-room/protocol/closedOutput`), so a write after its reader went away doesn't crash it with EPIPE. The app's bridge did, on a log line during its shutdown after the app had quit (UPLINK-ROOM-BRIDGE-3). The bridge now finishes stopping; `uplink`, `uplink-mcp` and `uplink-notetaker` exit.
  - `room/public-functions-answer-refusals`: a backend function is public only through `publicQuery` or `publicMutation`.
  - `room/convex-calls-accept-refusals`: shipped code reaches the room only through a client that sends `acceptsRefusals`.
  - `room/run-by-name-through-catalog`: the backend runs a function by name only at a catalog path (`agentFunctionPath`, `accountFunctionPath`, `runFunctionPath`). Those internal functions check an agent's ids themselves, so a wrong-table id can't come back as UPLINK-ROOM-BACKEND-J. `packages/backend/tests/idArgs.test.ts` checks that each of them takes its ids loosened.
  - `room/room-api-reads-runs-through-access`: a Room API handler that lists rows of `runs` or `tasks` itself filters them through a check of who may see such a row (`seesRun`, `runVisible`, `taskOutsideChannels`, and the like; `inTeam` checks one id, not a list). `a2a.runs` didn't, so it listed runs a viewer shouldn't see; found in review before it shipped (ADR 0049).
  - `no-await-in-loop` in `packages/backend/convex/inbox.ts` (an override in `.oxlintrc.json`): the Inbox query, which every app window subscribes to, sends its reads together instead of one await per row. Convex adds up the time a function waits on reads and stops it past a limit with "Your request timed out performing too many system operations" (`SYSTEM_TIMEOUT_ERROR_MESSAGE` in convex-backend's `crates/isolate/src/timeout.rs`). `inbox.get` awaited its reads one at a time, several for each run and task, so with only 37 runs in the team, slow reads on Convex's side were enough (UPLINK-ROOM-BACKEND-K). The app's shell subscribed to it outside every view's error boundary, so the failure took down the whole window: React removes the UI on an error no boundary catches (UPLINK-ROOM-DESKTOP-7); the shell's own queries are soft now (`useSoftRoomQuery`).
  - `room/child-process-reports-start-failure`: code that reads a `spawnSync` result's `status` also reads its `error`. On the 0.2.22 release the Mac's pnpm was a half-installed file with no `#!` line: a shell ran it, but Node's `spawnSync` got ENOEXEC, and `release:mac` said only "pnpm build:release failed (exit null)".
- **TLA+ models** (`specs/`, run by `pnpm specs`): the app and its bridge as the app quits, the scheduled checks that mark a machine offline, with Convex rerunning a failed run, and the queue that starts a machine's queued tasks one at a time (ADR 0050). `specs/README.md` says what each checks and when to add one.
