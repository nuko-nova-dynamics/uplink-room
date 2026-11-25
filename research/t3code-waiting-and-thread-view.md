# T3 Code: waiting, approvals, thread launch, and live view

Research for [#13](https://github.com/nuko-nova-dynamics/uplink-room/issues/13) and [#12](https://github.com/nuko-nova-dynamics/uplink-room/issues/12), checked on 2026-11-02 on Julio's Mac.

> **Update, 2026-11-04.** [t3code-capabilities.md](t3code-capabilities.md) re-checks T3 Code at v0.1.8-nightly.20261104.4179 (`9e85538`) and supersedes parts of this report:
>
> - The approval allow/deny round trip and the client protocol's connection and subscriptions are now **verified live**, on an isolated server with a scripted ACP provider, both by script and through the bridge's own adapter. Questions are still not verified live.
> - The bridge recommendation below (polling, a `start_thread` that always fails, `t3_thread_launch` first) is **done differently**: the bridge now uses `subscribeShell`, `launchThread` and `dispatchCommand`.
> - For #12, the bridge's existing `orchestration:read` scope already allows a live thread view (`subscribeThread`), so no second pairing is needed, and T3 now offers a thread link (`https://app.t3.codes/threads/<environmentId>/<threadId>`) for an "Open in T3 Code" button.
> - Still true at the new pin: MCP cannot answer approvals, an MCP token cannot be used for the client protocol, and guest links are unchanged.

## Answers

**#13:** T3 Code exposes pending questions and approval text through MCP reads, but its thread-list status alone can miss a request. A live blocking question had `status: "running"` in both MCP and CLI while T3's sidebar showed Input requested. MCP can answer structured questions; it deliberately cannot answer approvals. The client protocol exposes the request ID, kind, response capability, prompt, and approval decisions, with live subscriptions. Use that protocol for the bridge's complete Waiting/allow/deny integration. Thread creation with a repo, harness instance, model, and prompt already exists; Uplink Room's current Failed response is a local implementation stub.

**#12:** Reuse selected MIT client code for a Room-owned thread view. The existing full web app can be opened in a separate top-level desktop web surface, but it is not a documented single-thread embed. A cross-site iframe has cookie/auth problems. Guest links offer a live, restricted view close to Suggest, but require T3 Connect and Labs, expire in 24 hours, bind to one browser, and cannot answer approvals. They do not provide Room team roles or persistent access.

## Source pin and verification limits

The installed executable was `/opt/homebrew/bin/t3`:

```text
$ t3 --version
t3 v0.1.7-nightly.20261102.4080
```

All upstream source links below are pinned to **`47f2c8d29e981c7723467efe137ee19e91df924e`**, the commit named by that release, rather than moving `main`. Downloaded and inspected the official repository under `/tmp/uplink-t3-research.Myy3Qz/t3code`:

```sh
git clone --depth 1 https://github.com/pingdotgg/t3code.git "$TEMP/t3code"
git -C "$TEMP/t3code" fetch --depth 1 origin tag v0.1.7-nightly.20261102.4080
git -C "$TEMP/t3code" checkout --detach v0.1.7-nightly.20261102.4080
git -C "$TEMP/t3code" rev-parse HEAD
# 47f2c8d29e981c7723467efe137ee19e91df924e
```

`$TEMP` above abbreviates the temporary directory. The [official release notes](https://github.com/pingdotgg/t3code/releases/tag/v0.1.7-nightly.20261102.4080) describe four fixes, including CLI startup performance; they do not announce an embedding API. The running server's build was not independently matched to this commit. Installed CLI behavior and live MCP results are recorded separately from source conclusions.

**Verified live:** MCP launch in a new scratch repo; a structured blocking question; CLI list/show and waiting exit code; MCP question read/respond; probe completion and cleanup; unauthenticated local HTML response headers. **Verified in source:** subscription/replay contracts, approval response path, guest authentication and restrictions, client packaging dependencies. **Unverified live:** an approval's allow/deny round trip, CLI `thread start` execution, client-protocol connection/subscriptions, guest redemption, and embedded rendering. Further notification-producing probes were skipped after the first one appeared in Julio's sidebar. No existing threads or projects were changed.

## #13: what each interface exposes

### MCP

The connected Mac server's advertised tools were inspected directly. Relevant names were `t3_project_list`, `t3_project_create`, `orchestrator_capabilities`, `t3_thread_launch`, `t3_thread_list`, `t3_thread_read`, `t3_thread_wait`, `t3_thread_send`, `t3_thread_interrupt`, and `t3_pending_request`. There was no advertised approval-response or thread-event-subscription tool. The question tool's description explicitly excludes approvals. These declarations also appear in the pinned [thread tools, lines 111–145][question-tool] and [list/read tools, lines 223–248][list-read-tools].

| Need | MCP result | Transport/limit |
|---|---|---|
| Discover threads | `t3_thread_list`, paginated, filterable by status/project | Polling. Status can remain running during input requests. |
| Detect outstanding requests | `t3_thread_read` returns `thread.pendingRequestCount` | Polling. Count includes all pending runtime requests, not only human approvals. |
| Read what is requested | `t3_thread_read` with `view: "activity"` includes `user_input_request` and `approval_request` items, status and text | Poll/page the activity timeline. Approval text is prompt/request kind plus reason, not the complete typed approval record. |
| Read/answer a question | `t3_pending_request` actions `list`, `read`, `respond` | Only pending `user_input` requests. Answers keyed by question ID. |
| Answer an approval | No tool | `t3_pending_request` rejects non-question request IDs. Sending “allow” as a thread message does not resolve an approval. |
| Wait for completion | `t3_thread_wait` | A bounded wait, not an event feed. Do not depend on it returning immediately when a request appears. |

The source explains the live mismatch: list uses `shell.activityRunStatus ?? shell.status`, while read uses the active/latest run's status and separately counts pending runtime requests ([service, lines 790–859][mcp-status]). It formats approval activity as prompt/kind and reason ([lines 895–921][mcp-text]). The question handler filters by kind and pending status, joins the matching question item, and dispatches a response only for that question ([handlers, lines 53–75][question-guard]; [229–264][question-handler]).

MCP supplies useful evidence of Waiting without the client protocol, but not a complete approval integration. Activity items are flattened, paginated records. They do not expose the typed `requestId`/`responseCapability` combination that a bridge should use to answer an approval safely. Do not scrape a request ID from display text or assume `itemId` is the request ID.

Outside clients sign in to `/mcp` through OAuth and a pairing approval. Read only permits reads; higher access permits starting/messaging/stopping within that access ceiling. See [outside agents, lines 1–57][outside-auth]. The host CLI uses a short-lived MCP client session and revokes it afterward ([CLI, lines 209–261][cli-auth]). **An MCP OAuth token cannot simply be reused for client RPC:** the server rejects MCP-audience credentials outside `/mcp` ([auth, lines 611–618][mcp-audience]).

### Installed CLI

Read `t3 --help`, `t3 thread --help`, all four thread subcommands' help, `t3 project --help`, `t3 project add --help`, and `t3 auth session issue --help`.

```text
$ t3 thread --help                 # subcommands
list     List a project's threads, newest first.
start    Start a thread in a project and print its id.
send     Send a message to a thread. A busy thread gets it as its next turn; nothing is interrupted.
show     Show a thread's state and its latest messages.

$ t3 thread start --help           # selected help lines
t3 thread start [flags] <project> <message>
--provider string    Provider instance id. Pass with --model.
--model string       Model slug. Defaults to the project's default model.
--worktree string    Run in a new git worktree based on this branch, tag, or commit, instead of the project folder.
--branch string      Branch name for the new worktree.
--wait               Wait for the agent to finish and print its reply. Exits 1 if the run fails and 2 if it waits for an answer.
--json               Print JSON instead of text.
```

`project` accepts a registered project ID or a path inside it. `message` accepts `-` for stdin. `list --json` emits an array; `show --json` emits `{thread,messages}` with the pending count but no approval-answer command. `send` queues behind a busy turn. The CLI has no `approve`, `deny`, or structured question-response subcommand. Its default permission mode comes from the project, and `start` exposes no permission-mode flag. Source: [CLI commands, lines 557–765][cli-commands], [host script guide, lines 95–115][host-cli].

The CLI's `--wait` uses 15-second wait slices, reads the pending count after a timeout, and rechecks the run before returning a waiting result. Thus it can report waiting even when list/show status remains running. This is verified in [CLI, lines 432–512][cli-wait] and in the probe below.

### Live scratch probe and cleanup

Only one new repo/project/thread was created. IDs used in the following selected output:

```text
P = fbc4051e-8e37-4956-a282-5350e44f48e5
Q = mcp:launch:659a8f1bb51923f150d4549892b873ebcfd64b4f23153d893e2c5a460167c00b
R = runtime-request:provider:codex:provider-turn:provider-turn%3Aprovider%3Acodex%3Anative-turn%3A01a19d05-6739-77c1-b89f-b7e2bbdd5e6d:native-request:call_47ff240a2f74465cbc76e7848056ec81:cd2f43d9-55ac-47fb-b919-51403afce724
```

1. `git init -q /tmp/uplink-t3-research.Myy3Qz/scratch`, then `t3 project add /tmp/uplink-t3-research.Myy3Qz/scratch --title 'Uplink research scratch 2026-11-02'` returned `Added project P ...`. Read `orchestrator_capabilities` first and selected an enabled instance and model from its live response, rather than guessing them.
2. Called `t3_thread_launch` with `projectId: P`, `workspaceStrategy: {type:"root"}`, `modelSelection: {instanceId:"codex_px",model:"gpt-6.1-sol",options:[{id:"reasoningEffort",value:"low"}]}`, `runtimeMode:"approval-required"`, `interactionMode:"plan"`, and `clientRequestId:"uplink-research-question-20261102"`. The prompt requested one tool question, “Which research marker?”, choices Alpha/Beta, then a final reply after the answer; it forbade file access, commands, edits, browsers, and delegation. Launch returned `threadId: Q`, `projectId: P`, a run ID, and `status:"preparing"`.
3. `t3_thread_read({threadId:Q,view:"activity",limit:8,maxCharsPerItem:1600})` returned these fields while the question was pending:

   ```json
   {"thread":{"status":"running","pendingRequestCount":1},"recentRuns":[{"status":"running"}],"items":[{"type":"user_input_request","status":"waiting","text":"[question research_marker: Which research marker?; Alpha/Beta]"}]}
   ```

   This is an excerpt with question text condensed, not the full wire response. `t3 thread list --project /tmp/uplink-t3-research.Myy3Qz/scratch --json` likewise returned `status:"running"`. `t3 thread show Q --messages 1 --json` returned `thread.status:"running"` and `thread.pendingRequestCount:1`. Julio observed **Input requested** in the sidebar and received a notification. A live probe can therefore interrupt him even though it is in a separate repo.
4. `t3_pending_request({action:"list",threadId:Q})` returned `{requestIds:[R]}`. `read` with R returned question ID `research_marker`, its text, and both options.
5. `t3 thread send Q 'After the pending question is answered, reply READY without tools.' --wait --json` queued a second run and exited **2** with `{threadId:Q,runId:"...:ordinal:2",status:"waiting",reply:null,error:null}`. Stderr directed the user to T3 Code to respond. This demonstrated a queued run blocked by an earlier request, not a second question.
6. Answered the question ourselves through `t3_pending_request({action:"respond",threadId:Q,requestId:R,answers:{research_marker:{answers:["Alpha"]}}})`. It returned `{sequence:414937}`. The first run completed; the queued second run was cancelled. An explicit `t3_thread_interrupt({threadId:Q,stop:true,...})` reported `no_active_run`.
7. Archived Q with `t3_thread_organize({action:"archive",threadId:Q})`, returning `{sequence:414989}`. Read-back showed `archived:true`, `pendingRequestCount:0`, `activeRunId:null`; run 1 was completed and run 2 cancelled. Deleted only P with `t3_project_delete({projectId:P,force:true})`, returning `deletedAt:"2026-11-02T16:10:09.950Z"`. Final `t3_project_list({limit:100})` had no P and no next page; `t3_thread_list({projectId:P,includeSubagents:true,limit:10})` returned `threads:[]`, `total:0`.

No action from Julio was needed. The [archived probe](<t3-thread://v2/2b9de087-c234-49f7-b01c-2e1c4269ecf7/mcp:launch:659a8f1bb51923f150d4549892b873ebcfd64b4f23153d893e2c5a460167c00b>) is retained only as archived history under a deleted project. No further live approval or view probe was run.

### Client protocol: full details, push, and allow/deny

This is T3's typed Effect RPC client over JSON WebSocket transport at `/ws`, not an invented REST approval endpoint. Reuse its contracts/transport rather than hand-writing generic JSON-RPC frames ([transport, lines 226–245][transport]; [socket path, lines 78–88][socket-path]).

Subscribe to `orchestration.subscribeShell` for environment-wide thread summaries, then `orchestration.subscribeThread({threadId,afterSequence?})` for relevant details. The shell has `pendingRuntimeRequest: {id,kind,createdAt,blocking?}` as well as run status; `blocking:false` distinguishes an async question. The thread projection contains `runtimeRequests` with `id`, `kind`, `status`, and `responseCapability`, and turn items provide question text/options or approval `prompt`, `reason`, `requestKind`, and provider-specific options. Join by **request ID**, as T3's client does. See [request contract, lines 1203–1227][request], [approval/question items, lines 1645–1698][items], [shell, lines 2051–2057 and 2094–2108][shell], and [client join, lines 230–283][client-requests].

These subscriptions push snapshots and subsequent events. Thread subscription supports sequence replay and snapshot fallback, including subscribing before replay to retain concurrent events ([implementation, lines 902–959][subscription]). Retain sequence numbers, deduplicate, and resubscribe on reconnect. Keep `runtime-request.updated` and matching turn-item updates together. MCP has no equivalent advertised event subscription; its streaming HTTP transport does not itself make list/read a thread change feed.

Answer via `orchestration.dispatchCommand` with this command payload:

```json
{"type":"runtime-request.respond","commandId":"<unique-command-id>","threadId":"<thread-id>","requestId":"<current-request-id>","decision":"accept"}
```

Map Room **allow once → `accept`**, **deny → `decline`**. Other valid enum values are `acceptForSession`, `acceptAlways`, and `cancel`; do not turn a one-time Room answer into persistent permission. Respect the approval's offered `options`. Questions instead supply `answers` keyed by question ID. Source: [command schema, lines 3273–3282][respond], [decision enum, lines 49–79][decisions], and [client command helpers, lines 879–904][client-response]. The server rejects absent, already-resolved, and `not_resumable` requests ([validation, lines 8903–8936][response-validation]). Only offer approval buttons for a pending request with a live response capability. This path is source-verified; an approval allow/deny round trip was not exercised on this Mac.

Authenticate as a paired **client session**, with `orchestration:read` for reads/subscriptions and `orchestration:operate` for launch/respond. Scope requirements are explicit in [RPC authorization, lines 40–61][scopes]. Cookie requests check the origin; bearer/DPoP clients have their own flow. WebSocket tickets are audience-checked and may require DPoP proof ([request auth, lines 766–820][origin-auth]; [socket auth, lines 1243–1294][socket-auth]). Do not reuse a Room login as T3 authorization. Keep T3 credentials on the machine in the bridge, and mediate Room roles/driver checks there.

### Concrete bridge and start_thread recommendation

> Superseded on 2026-11-04: the bridge now follows threads, launches, stops and answers approvals over the client protocol. See [the comparison](t3code-capabilities.md#comparison-with-our-integration).

At inspected Uplink commit `994c21a40957e97335f7145bd4675e8ecd00b8fc`, [the adapter](../packages/bridge/src/adapters/t3code.ts#L26) polls list every three seconds, maps running to Working, and has no prompt or answer path. It therefore reports Working during the verified blocking question. [The bridge's start_thread branch](../packages/bridge/src/bridge.ts#L337) unconditionally emits Failed. This is an implementation gap, not a failed T3 launch experiment. The [protocol message](../packages/protocol/src/index.ts#L207) already has `runId`, `harness`, optional `repo`, `cwd`, and `prompt`.

1. **Immediate read-only improvement:** preserve list discovery, but read details independently of list status. Use pending count plus activity/question reads to publish Waiting with the actual question or approval text. Map interrupted/cancelled to Stopped. Do not treat every `waiting` status as an approval or every pending runtime record as a human request. If details are unavailable, report Unknown or a request needing T3 Code, without actionable approval buttons.
2. **Complete adapter:** replace polling with the client subscriptions above. Track `{environmentId,threadId,requestId}` and response capability. Expose a fresh Room `promptId` mapped to that exact T3 request; validate the current driver and request before dispatch, clear resolved prompts on updates, and read back the resolution. Handle several pending requests explicitly. Background work alone does not belong in Needs you. Async questions can still need an answer while work continues; retain that distinction.
3. **Start threads through `t3_thread_launch` initially, or `orchestration.launchThread` once the client connection exists.** Resolve the registered T3 project from the machine's repo/cwd, resolve the Room harness to an enabled T3 provider **instance**, and select a model from live capabilities/project configuration. Supply the prompt, explicit workspace strategy, and intended runtime/interaction modes. Use a stable `clientRequestId` derived from the Room command/run for MCP retries. The client launch contract uses a `commandId` and typed launch input ([schema, lines 3630–3658][launch-schema]). Persist the returned thread ID and bind it to the existing Room run before discovery can create a duplicate unfiled run. Add an explicit binding/ack message if the current protocol cannot carry that association.
4. **CLI fallback:** `t3 thread start REGISTERED_REPO - --provider INSTANCE --model MODEL --json`, with prompt on stdin and argument-array execution. It returns the created IDs without waiting. This command is supported by installed help and implementation, but was not executed in this probe. CLI defaults permissions to the project and does not expose the MCP retry key, so do not blindly retry an ambiguous launch or use it when the requested mode differs. Report registration, disabled-harness, mode, auth, and launch errors with their cause instead of a generic Failed.

The successful MCP probe verified repo binding, explicit harness/model selection, prompt delivery, and a completed first run. It did not test a new worktree. Keep any later acceptance probe on an isolated T3 server/data directory so its requests cannot ping Julio.

## #12: embed or reuse

### Existing full web client

The normal URL is `/<environmentId>/<encodedThreadId>`. It routes through the full `_chat` layout, not a standalone embed component ([thread route, lines 1–6][thread-route]; [layout, lines 1–43][chat-layout]). No single-thread iframe/postMessage integration contract was found in the inspected docs/routes.

An Electron top-level web contents surface on T3's own origin is a plausible way to show the existing app unchanged. It would need a separate T3 pairing/session in that surface's storage, a reachable T3 server, and handling for navigation, sign-in windows, permissions, clipboard, downloads, and external links. It shows T3's UI and grants whatever that T3 session permits across the environment. Hiding navigation does not narrow server authorization to one Room run. **This is an implementation option inferred from the web client, not a tested embed.**

A generic cross-site iframe is a poor default. Regular browser sessions use `HttpOnly; SameSite=Lax` cookies ([cookie source, lines 201–208][browser-cookie]); guest sessions use `HttpOnly; Secure; SameSite=Strict` ([guest redemption, lines 140–156][guest-cookie]). Those settings prevent relying on cookies in a cross-site frame. Cookie-authenticated API/socket requests also enforce same/trusted origins, and the built-in desktop origins are `t3code://app` and `t3code-dev://app`, not Uplink's origin ([origin check][origin-auth]; [origin constants, lines 1–13][origins]). The normal client also supports paired bearer credentials and WS tickets; copying a URL into a frame does not provision those credentials.

Local read-only header checks returned:

```text
$ curl -sS -I http://127.0.0.1:3773/guest
HTTP/1.1 200 OK
cache-control: no-cache
content-type: text/html; charset=utf-8
content-length: 21702
vary: Accept-Encoding
access-control-allow-origin: *
```

`/` returned the same selected headers. Neither response included X-Frame-Options or a CSP header. The static HTML route serves the app with no general frame restriction in the inspected source ([static route, lines 586–645][static-route]). **This verifies headers only, not successful frame authentication or rendering.** A hosted deployment/proxy can add different headers. MCP OAuth error-page headers explicitly deny framing ([source, lines 18–26][oauth-frames]); do sign-in outside a frame. CORS wildcard does not override cookie or frame policy. Development CORS has an explicit origin list and credentials setting ([HTTP, lines 256–274][cors]).

Embedding packages almost no T3 code if the desktop loads a reachable existing server URL. Self-hosting its unmodified web assets means shipping its web build and keeping it compatible with the server; it still needs T3 auth and routing. The hosted app needs an HTTPS backend ([remote-access guide, lines 198–206][hosted-web]).

### Guest view

Guest links already render one live timeline without an account, including streaming replies, work, plans, questions, and files. Incoming guest messages need the owner to Send or Dismiss them. They require Labs plus T3 Connect, last 24 hours, and work in one browser. Guests cannot answer the agent, change models, inspect diffs, or act on the thread ([guest guide, lines 3–32][guest-guide]). This resembles Suggest, but T3's owner approval is not automatically the Room's current driver or approval authority.

The guest client fetches same-origin session state and uses EventSource for `/api/guest/stream`; redemption creates the strict cookie ([client, lines 203–224 and 303–318][guest-client]; [HTTP cookie][guest-cookie]). A top-level T3-origin surface is more plausible than a cross-site iframe, but guest lifecycle, one-browser redemption, and approval routing would still need integration. No guest link was minted, redeemed, or embedded during this research.

### Reuse selected client code: recommended

T3's [MIT license, lines 1–21][license] permits reuse and modification with the copyright and permission notice retained. Include the licenses/notices for the actual copied dependencies/assets as well; T3 documents a separate [third-party notice inventory][third-party].

Start with the timeline approach used by `GuestPage`, which imports the shared `MessagesTimeline` and client-runtime projection helpers ([imports, lines 20–57][guest-imports]). Reuse contracts, request projection, timeline/markdown/work rendering, and sequence handling. Replace its guest auth/composer with Room commands over the machine bridge. Feed only authorized run data to teammates; retain machine credentials in the bridge. Room Watch/Suggest/Drive/Open and driver changes must be enforced by Room/bridge policy, not by visual controls or T3 guest naming.

This requires extracting code and its providers, styles, asset rendering, and dependencies. It is not an npm widget: both [web package][web-package] and [client-runtime package][runtime-package] are private workspace packages, and client-runtime depends on other `@t3tools/*` packages plus Effect. Build a small maintained extraction at the stated commit rather than copying the entire app and its unrelated environment settings. T3's [development runbook, lines 3–14 and 51–69][development] gives its build/dev setup; packaging a Room component does not require shipping a second T3 server or provider credentials. The existing machine server still runs the harness.

Pin the extracted contracts and maintain protocol compatibility checks. T3's own client blocks mismatched orchestration versions and appends its protocol version to the socket URL ([compatibility, lines 9–40][compatibility]). That maintenance cost is the main disadvantage of reuse. The benefit is a run-scoped view whose controls use the same Room authority as the Inbox, without cross-site-cookie dependence or 24-hour guest links. Keep Open in T3 Code as a fallback while unsupported item types and approval responses are implemented and tested.

## Remaining acceptance checks

Run these only against an isolated server/state directory, with automatic response/cancellation and cleanup: a real approval accept and decline; stale request/reconnect behavior; a CLI start with success/error read-back; protocol subscription recovery; and a packaged Room timeline with streaming, command output, questions, and authorized approval controls. No app-code change or live embedding success is claimed by this report.

Status on 2026-11-04 ([details](t3code-capabilities.md#live-results-selected)): approval accept and decline, and a stale answer refused, are done live. Questions, reconnect recovery, a CLI start and a Room timeline remain open.

[question-tool]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/mcp/toolkits/thread/tools.ts#L111-L145
[list-read-tools]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/mcp/toolkits/orchestrator/tools.ts#L223-L248
[mcp-status]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/mcp/OrchestratorMcpService.ts#L790-L859
[mcp-text]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/mcp/OrchestratorMcpService.ts#L895-L921
[question-guard]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/mcp/toolkits/thread/handlers.ts#L53-L75
[question-handler]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/mcp/toolkits/thread/handlers.ts#L229-L264
[outside-auth]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/docs/user/outside-agents.md#L1-L57
[cli-auth]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/cli/thread.ts#L209-L261
[mcp-audience]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/auth/EnvironmentAuth.ts#L611-L618
[cli-commands]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/cli/thread.ts#L557-L765
[host-cli]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/docs/user/outside-agents.md#L95-L115
[cli-wait]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/cli/thread.ts#L432-L512
[transport]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/packages/client-runtime/src/rpc/session.ts#L226-L245
[socket-path]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/packages/client-runtime/src/connection/resolver.ts#L78-L88
[request]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/packages/contracts/src/orchestrationV2.ts#L1203-L1227
[items]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/packages/contracts/src/orchestrationV2.ts#L1645-L1698
[shell]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/packages/contracts/src/orchestrationV2.ts#L2051-L2108
[client-requests]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/packages/client-runtime/src/state/threadRequests.ts#L230-L283
[subscription]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/ws.ts#L902-L959
[respond]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/packages/contracts/src/orchestrationV2.ts#L3273-L3282
[decisions]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/packages/contracts/src/providerPolicy.ts#L49-L79
[client-response]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/packages/client-runtime/src/operations/commands.ts#L879-L904
[response-validation]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/orchestration-v2/Orchestrator.ts#L8903-L8936
[scopes]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/auth/RpcAuthorization.ts#L40-L61
[origin-auth]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/auth/EnvironmentAuth.ts#L766-L820
[socket-auth]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/auth/EnvironmentAuth.ts#L1243-L1294
[launch-schema]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/packages/contracts/src/orchestrationV2.ts#L3630-L3658
[thread-route]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/web/src/routes/_chat.%24environmentId.%24threadId.tsx#L1-L6
[chat-layout]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/web/src/routes/_chat.tsx#L1-L43
[browser-cookie]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/auth/http.ts#L201-L208
[guest-cookie]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/guest/http.ts#L140-L156
[origins]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/httpCors.ts#L1-L13
[static-route]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/http.ts#L586-L645
[oauth-frames]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/auth/mcpOAuthHttp.ts#L18-L26
[cors]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/server/src/http.ts#L256-L274
[hosted-web]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/docs/user/remote-access.md#L198-L206
[guest-guide]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/docs/user/guest-links.md#L3-L32
[guest-client]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/web/src/components/guest/GuestPage.tsx#L203-L318
[license]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/LICENSE#L1-L21
[third-party]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/docs/user/open-source-licenses.md#L1-L13
[guest-imports]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/web/src/components/guest/GuestPage.tsx#L20-L57
[web-package]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/apps/web/package.json#L1-L42
[runtime-package]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/packages/client-runtime/package.json#L1-L8
[development]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/docs/operations/development.md#L3-L69
[compatibility]: https://github.com/pingdotgg/t3code/blob/47f2c8d29e981c7723467efe137ee19e91df924e/packages/client-runtime/src/connection/compatibility.ts#L9-L40
