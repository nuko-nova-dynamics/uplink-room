# T3 Code: what an outside program can do, and full integration for Uplink Room

Research for Julio's question "doesn't t3 code have environments and mcps and all that, allows you full control?", checked on 2026-11-04. It follows the [earlier T3 Code research](t3code-waiting-and-thread-view.md) for [#12](https://github.com/nuko-nova-dynamics/uplink-room/issues/12) and [#13](https://github.com/nuko-nova-dynamics/uplink-room/issues/13).

## Answers

**Yes, an outside program can control almost everything in T3 Code, and the bridge already holds enough access to show a thread's conversation and send it messages.** The bridge pairs with `orchestration:read` and `orchestration:operate`. With exactly those two scopes, on an isolated server running the installed build, a script read a thread's full conversation live (`orchestration.subscribeThread`), sent a follow-up message into it (`message.dispatch`), interrupted a run, answered a real approval with accept and then another with decline, and read the turn's diff. T3 refused the same session's attempts to read files, open a terminal, change settings, create a guest link or list linked environments. We need no new scope, no T3 Connect and no linked environment to build a thread view and a message box in the room.

**Environments, linked environments, T3 Connect and the MCP server are other ways to reach the same server; none of them can do more than the client protocol the bridge uses.** A linked environment is one T3 server signed in to another's `/mcp` as an OAuth client, with a pairing code and an access level (Supervised through Full access). A plain Node script did the same sign-in and got a 30-day MCP session with 68 tools. MCP still cannot answer approvals: `t3_pending_request` returned an empty list while a command approval was pending. MCP also has no event feed, and it records messages as sent by an agent (`createdBy: "agent"`, `creationSource: "mcp"`). T3 Connect is a relay plus a Cloudflare tunnel per machine, tied to the owner's T3 account.

**Recommended next build:** a live thread view in the run panel and a message box for the driver, both through the bridge, plus three fixes the live tests surfaced (session expiry, revocation advice, secret and link cards). See [Plan](#plan).

## Source pin and method

```text
$ t3 --version
t3 v0.1.8-nightly.20261104.4179
```

That tag is commit **`9e85538535c8553901351112ab02dd1dd62db5ee`** (2026-11-04), per its [release page](https://github.com/pingdotgg/t3code/releases/tag/v0.1.8-nightly.20261104.4179). Every source link below is pinned to it. `main` was two commits ahead when cloned (`95e53a5`, a typecheck change). The pin is 330 commits after `47f2c8d`, the earlier research's pin. The orchestration protocol is still version 2 ([environment.ts, lines 13–14][protocol-version]), so the bridge's `orchestrationProtocol=2` socket still connects.

Each claim below carries one of three labels:

- **Docs**: T3's own documentation at the pin.
- **Source**: read in T3's code at the pin, not run.
- **Live**: run on the isolated server on 2026-11-04.

### How the live tests ran

The isolated server was `t3 serve --base-dir <temp> --port 39781 --host 127.0.0.1 --no-browser <temp>/repo`, with `HOME` set to a temporary folder, `T3CODE_TELEMETRY_ENABLED=false` and `OTEL_SDK_DISABLED=true`. Pairing tokens were minted with `t3 auth pairing create --base-dir <temp>` into a private folder and never printed. Julio's T3 Code (port 3773, its own data folder) was not touched. Nothing was linked, tunneled or signed in on his T3 account.

The earlier research could not get a real approval because the temporary `HOME` has no provider logins. This time the provider was a scripted [ACP](https://agentclientprotocol.com) agent, about 100 lines of Node, added as a **Local ACP command** provider (`driver: "acpRegistry"`, `config.source: "local"`; [settings][acp-local]). It answers `initialize` and `session/new`, streams a reply for each prompt, and when the prompt contains `APPROVE` it starts a tool call, sends `session/request_permission` with Allow once and Deny options, and writes a file only when allowed. T3 turns that into an ordinary `command` approval with a live response capability. The result is real turns, approvals, checkpoints and diffs, with no model, no login and no cost. The agent lives in the session scratchpad, not in this PR; it is worth keeping as a test fixture (see [Plan](#effort)).

One side effect: when the MCP-sent message arrived, T3 generated a thread title with its default text-generation provider, which ran the Codex CLI from `PATH`. That reached the machine's local CLI proxy at `127.0.0.1:8318` and was refused with HTTP 401, because the temporary `HOME` had no login. Nothing else left the machine. The server was stopped afterwards.

## Capability matrix

"Scope" is the permission a client session needs ([RpcAuthorization.ts, lines 40–213][rpc-scopes]; [clientRpcPermissions.ts, lines 17–73][client-scopes]). `read` and `operate` abbreviate `orchestration:read` and `orchestration:operate`, the bridge's two scopes. "Bridge" says whether our adapter uses it today.

### Threads and their conversation (client protocol over `/ws`)

All of these are Effect RPC calls on the WebSocket the bridge already opens ([method list][ws-methods]). Commands go through `orchestration.dispatchCommand` ([command union][commands]).

| Capability | Call | Scope | Evidence | Bridge |
| --- | --- | --- | --- | --- |
| Follow every thread's summary, including its pending request | `orchestration.subscribeShell` (snapshot, then `thread.updated` / `thread.removed`) | read | Live | Yes |
| Read a thread's whole record once | `orchestration.getThreadProjection`: `messages`, `turnItems`, `visibleTurnItems`, `runtimeRequests`, `runs`, `plans`, `checkpoints`, `subagents`, provider sessions and turns ([projection][projection]) | read | Live | Only to read a request's text |
| Follow a thread's conversation live | `orchestration.subscribeThread {threadId, afterSequence?}`: a `snapshot` with the projection, then `event` items with a sequence ([stream item][thread-stream]) | read | Live: 114 events over four turns (`turn-item.updated`, `message.updated`, `run.updated`, `runtime-request.updated`, `checkpoint.captured` and others) | No |
| Page long histories | `subscribeThread` with `acceptBoundedSnapshot`, plus the HTTP `/history` route ([subscribe input][subscribe-thread-input]) | read | Source | No |
| Live output of one command row | `orchestration.subscribeCommandOutput {threadId, itemId}`: `replace`/`append` frames of a bounded tail ([frame][command-output]) | read | Source | No |
| One turn item in full | `orchestration.getTurnItem` | read | Source | No |
| Diffs | `orchestration.getTurnDiff {threadId, fromTurnCount, toTurnCount}` and `getFullThreadDiff {threadId, toTurnCount}`, as unified diff text | read | Live: returned the file the agent wrote after an allowed approval | No |
| Search | `searchThreads`, `searchThread`, `searchThreadStream` | read | Source | No |
| Subagents, forks, workflows | `getThreadFamily`, `getNativeChildWork`, `getWorkflowScript`, `stopWorkflow` (operate) | read / operate | Source | No |
| Start a thread | `orchestration.launchThread` with project, provider instance, model, runtime and interaction modes, workspace strategy (`root`, `worktree`, `existing_worktree`) and first message ([input][launch-input]) | operate | Live | Yes, at the project root |
| Send a follow-up message | command `message.dispatch` with `text`, `attachments`, optional `modelSelection`, `dispatchMode` (`start_immediately`, `queue_after_active`, `steer_active`, `restart_active`, `defer_start`) and `deliveryIntent` (`auto`, `steer`, `restart`) ([schema][message-dispatch]); T3's own client builds it in [commands.ts, lines 733–777][client-send] | operate | Live: into an idle thread with `start_immediately`; it started run 2 | No |
| Interrupt a run | command `run.interrupt {runId, holdQueue?}` ([schema][run-interrupt]) | operate | Live: run 2 went `interrupted` | Only on servers without `thread.stop` |
| Stop a thread | command `thread.stop` ([schema][thread-stop]); `orchestration.forceStopThread` kills the agent's processes | operate | Live on 2026-11-02 ([bridge README](../packages/bridge/README.md#t3-code)) | Yes |
| Answer an approval | command `runtime-request.respond {decision}`: `accept`, `decline`, `acceptForSession`, `acceptAlways`, `cancel` ([schema][respond]) | operate | Live: accept and decline; answering an already-resolved request failed with `OrchestrationV2DispatchCommandError` | Yes, accept and decline only |
| Answer or dismiss a question | the same command with `answers` keyed by question id (and `attachmentsByQuestionId`); `thread.user-input.dismiss` | operate | Source | No: the room says to answer in T3 Code |
| Manage the queue | `queued-run.start`, `.reorder`, `.cancel`, `.edit`, `queue.resume`, `queued-message.promote-to-steer` | operate | Source | No |
| Change model or permission mode | `thread.model-selection.set`, `thread.runtime-mode.set`, `thread.interaction-mode.set`, `provider.switch` | operate | Source | No |
| Organize | `thread.archive`, `.unarchive`, `.delete`, `.settle`, `.unsettle`, `.snooze`, `.pin`, `.tag.set`, `.metadata.update`, `.mark-unread` | operate | Source | Reads archive and delete only |
| Roll back to a checkpoint | `checkpoint.rollback {scopeId, checkpointId, restoreFiles?}` ([schema][rollback]) | operate | Source | No |
| Fork, merge back | `thread.fork`, `thread.merge_back` | operate | Source | No |
| Link or watch a pull request | `thread.pull-request.link`, `.unlink`, `.watch` | operate | Source | No |
| Attachments | `attachments.createUploadUrl` and `assets.persistChatAttachments` (operate); `assets.createUrl` for a chat attachment (read) or a workspace file (`filesystem:read`) | mixed | Source | No |
| Secret requests (new in this build) | a `secret_request` turn item ([item][secret-item]); answered with `secrets.answerRequest` | operate | Source | No |

### Projects, files, source control

| Capability | Call | Scope | Evidence |
| --- | --- | --- | --- |
| List or change projects | `projects.mutate`, HTTP `/api/projects` | operate (per mutation) | Source |
| Read files, list and search a project | `projects.readFile`, `listEntries`, `searchContents`, `searchEntries`, `filesystem.browse` | `filesystem:read` | Live: refused for the bridge's session ("missing required scope: filesystem:read") |
| Write files | `projects.writeFile` | `filesystem:write` | Source |
| Git status, branches | `vcs.refreshStatus`, `vcs.listRefs`, `subscribeVcsStatus` | read | Source |
| Create or remove worktrees, switch branches, pull | `vcs.createWorktree`, `removeWorktree`, `createRef`, `switchRef`, `pull` | `source-control:write` | Source |
| Start a thread in a new worktree | `launchThread` with `workspaceStrategy: {type: "worktree", ...}` | operate | Source |
| Pull requests | `pullRequests.*` reads (read); comments, reviews, labels, merges (`source-control:write`); review guide generation (operate) | mixed | Source |
| Local change review | `review.getDiffPreview`, `getDiffFileContents`, `getBranchCommits` | `filesystem:read` | Source |

### Terminals, browser, devices, SnapShots

| Capability | Call | Scope | Evidence |
| --- | --- | --- | --- |
| T3's own terminals | `terminal.open`, `write`, `resize`, `close` (`terminal:operate`); `terminal.observe`, `subscribeTerminalMetadata` (`terminal:read`) | terminal | Live: `terminal.open` refused for the bridge |
| Browser tabs and HTML previews | `preview.open`, `resize`, `adjust`, `close` (`preview:operate`); `preview.list`, `subscribePreviewEvents`, `subscribeDiscoveredLocalServers` (read). Tabs belong to the environment and stream to other devices ([docs][browser-docs]) | preview / read | Docs, Source |
| Simulators and emulators | `device.list`, `detail`, `subscribeDeviceState` (read); `device.open`, `close`, `shutdown`, `action` (**operate**); `device.configure` (`settings:write`) ([docs][devices-docs]) | read / operate | Docs, Source |
| SnapShots | A desktop-app feature that attaches a capture of the current window to a draft ([docs][snapshot-docs]). An outside program sees it only as a chat attachment. | none | Docs |

### Server, providers, settings

| Capability | Call | Scope | Evidence |
| --- | --- | --- | --- |
| Providers, models, environment capabilities | `server.getConfig`, `subscribeServerConfig`, `server.refreshProviders` | read | Live |
| Host load (used by load balancing) | `server.getHostResources` | read | Source |
| Settings, provider instances | `server.updateSettings`; provider instances also need `providers:manage` | `settings:write` | Live: refused for the bridge; the all-scopes setup session used it to add the scripted provider |
| Updates, restarts | `server.updateServer`, `server.signalProcess` | `environment:maintain` | Source |
| Diagnostics, usage | `server.getTraceDiagnostics`, `getUsageSummary` and others | `diagnostics:read` | Source |

### Scheduled tasks and webhooks

Scheduled tasks run a prompt on an interval, at a time, or on each webhook request ([schema][scheduled-schema]; [docs][webhook-docs]). Over the client protocol: `scheduledTasks.subscribe` (read); `upsert`, `setEnabled`, `delete`, `runNow`, `rotateWebhookToken` and the delivery log (operate). Over MCP: `schedule_task`, `list_scheduled_tasks`, `delete_scheduled_task`, `run_scheduled_task_now`.

**Webhooks only flow into T3.** A webhook task starts a run when another service calls its URL. A public URL needs T3 Connect; **Hold webhooks while offline** makes the relay store request bodies for up to 24 hours ([relay docs][connect-internals]). I found no outbound webhook for thread events in the contracts, settings or server. Push notifications and Live Activities come from **Publish agent activity**: the server signs thread activity and sends it to T3's relay for T3's mobile app ([AgentAwarenessRelay.ts][awareness]; [mobile notifications][mobile-docs]). Other programs cannot subscribe to that feed. (Docs, Source)

### Plain HTTP

The server also answers authenticated HTTP GETs that need the `x-t3-orchestration-protocol: 2` header ([routes][http-routes]):

| Route | Returns | Evidence |
| --- | --- | --- |
| `/api/orchestration/shell` | the shell snapshot | Live: 200 with the bridge's bearer |
| `/api/orchestration/threads/:threadId` | the thread projection | Source |
| `/api/orchestration/threads/:threadId/transcript` | `{threadId, title, updatedAt, items}` of projected turn items ([schema][transcript]) | Live: 200, item types `user_message`, `assistant_message`, `command_execution`, `approval_request`, `checkpoint`, `run_interrupt_request`, `run_interrupt_result` |
| `/api/orchestration/threads/:threadId/bounded` and `/history` | a bounded window and older pages | Source |

### Auth and access

**Scopes.** There are 16 grantable scopes ([auth.ts, lines 31–67][scopes]): `orchestration:read`, `orchestration:operate`, `settings:write`, `providers:manage`, `environment:maintain`, `preview:operate`, `diagnostics:read`, `terminal:read`, `terminal:operate`, `filesystem:read`, `filesystem:write`, `source-control:write`, `access:read`, `access:write`, `relay:read`, `relay:write`. A pairing token or issued session without `--scope` gets all of them ([remote access docs, lines 375–416][scope-docs]).

**`orchestration:operate` is broad.** Besides launching, messaging, answering and stopping, it covers `device.open` and `device.action` (driving a simulator), scheduled tasks and their webhook URLs, `secrets.answerRequest`, `forceStopThread`, `projects.mutate`, `agentSessions.import`, `mcpApps.callTool` and `shell.openInEditor` ([RpcAuthorization.ts][rpc-scopes]). The bridge must only forward the calls it means to make; it should never pass arbitrary RPCs through from the room.

**Pairing and sessions.** A pairing token (`t3 auth pairing create --scope … --ttl 5m`) is exchanged at `POST /oauth/token` for a bearer session. That session lasts **30 days** by default ([SessionStore.ts, line 429][session-ttl]), and a plain bearer session has no refresh. DPoP clients, such as T3's own apps on T3 Connect, renew theirs. Live: the bridge-style exchange returned a session expiring 2026-12-04. `t3 auth session issue --ttl 400d` issued a 400-day session without complaint, so T3 does not cap the TTL for issued sessions.

**Authorized clients and "Create link".** **Settings → Sharing & access** lists client sessions (`subscribeAuthAccess`, `access:read`), creates pairing links (`/api/auth/pairing-token`, `access:write`) and revokes clients (`/api/auth/clients/revoke`, `access:write`). From a terminal: `t3 auth session list`, `t3 auth session revoke`. Live, both checked against an open bridge socket:

| How revoked | New connections | Already-open socket |
| --- | --- | --- |
| `POST /api/auth/clients/revoke` (what Settings uses) | refused | closed 4 ms later |
| `t3 auth session revoke` on the host | refused (HTTP 401 on the socket ticket) | still answered `server.getConfig` 30 seconds later |

The CLI result is a hypothesis to confirm: the CLI writes the revocation from its own process, so the running server's in-memory invalidation never hears about it. The test is the same check after restarting the server, and reading how `t3 auth session revoke` reaches the store. **Confirmed on 2026-11-04** (ADR 0021, `packages/bridge/scripts/t3-live-check.ts`): in source, `apps/server/src/cli/auth.ts` runs `EnvironmentAuth.layerRuntime` inside the CLI process, so `SessionStore.revoke` publishes the removal on that process's own PubSub, and the server's `awaitInvalidation` for the open socket never wakes. Live, 15 seconds after a CLI revoke a thread launched over the open socket still reported Working while a new socket got HTTP 401; after the server restarted, the bridge's reconnect was refused.

**Supervised and Full access.** These are access levels for MCP clients and linked environments, not for client sessions ([auth.ts, lines 403–424][mcp-access]):

| Access | UI label | Scopes the session gets | Threads it starts or steers may run at most |
| --- | --- | --- | --- |
| `read-only` | Read only | `orchestration:read` | (none) |
| `approval-required` | Supervised | read, operate | Supervised |
| `auto-accept-edits` | Auto-accept edits | read, operate | Auto-accept edits |
| `auto` | Auto | read, operate | Auto |
| `full-access` | Full access | read, operate, `settings:write`, `source-control:write` | Full access |

The access level also caps the runtime mode of work the client starts, and a linked environment's calls carry the calling agent's own modes in a `T3-Mode-Limit` header, which only narrows ([remote internals, lines 86–96][peer-links]). The four runtime modes mean: Supervised asks before commands and file changes; Auto-accept edits approves edits; Auto uses the provider's automatic review; Full access never asks ([permission modes][permission-docs]). An MCP session is refused everywhere except `/mcp` ([EnvironmentAuth.ts, lines 612–619][mcp-audience]).

### Environments, linking and the relay

| Way in | What it is | Can a program use it without our bridge on that machine? | Evidence |
| --- | --- | --- | --- |
| Local | the server on `127.0.0.1` | Only from that machine | Live |
| LAN or tailnet | `t3 serve --lan` or **Network access**; a pairing code is the only lock ([docs][lan-docs]) | Yes, with a pairing token, over plain HTTP unless HTTPS is set up | Docs |
| Tailscale HTTPS | `t3 serve --tailscale-serve` or `t3 pair --tailscale`, giving `https://machine.tailnet.ts.net/` | Yes, from the same tailnet | Docs |
| SSH | the desktop app starts or reuses a server over SSH and forwards its port | It is the desktop app's own flow | Docs |
| T3 Connect | Clerk identity; the relay asks the environment to mint a one-time credential bound to the client's DPoP key; the client then talks to the environment directly through a per-machine Cloudflare tunnel hostname; the relay itself forwards only webhooks ([internals][connect-internals]). Three machines per account, more with a T3 Chat plan ([docs][connect-docs]) | Only by signing in as the machine owner's T3 account; no third-party client flow is documented. Not tested: it needs Julio's account | Docs, Source |
| Outside MCP client | OAuth at `/mcp` with a pairing code and an access level; 30-day session ([docs][outside-docs]) | **Yes.** Live: a Node script registered at `/oauth/mcp/register`, posted the pairing code with `approval-required` to `/oauth/mcp/decision`, exchanged the code with PKCE at `/oauth/mcp/token`, and got `scope: "orchestration:read orchestration:operate"`, `expires_in: 2592000`. It needs `https` or `localhost` to sign in | Live |
| Linked environment | the same OAuth flow, made by another T3 server, with `software_id: "t3code-peer-link"` and redirect `http://127.0.0.1/t3code-peer-link` ([PeerLinks.ts][peer-source]). Labs beta on both machines. Below Full access, work a link starts can change only threads with the same link origin, not projects, settings or scheduled tasks, and skips project setup scripts ([internals][peer-links]) | A program could claim that software id, but gains only the fence; nothing a plain MCP client lacks | Docs, Source |
| Load balancing | a client-side preference that picks a machine for new threads using `server.getHostResources` ([docs][balance-docs]) | Not a server feature; any client can read host load with read scope | Docs, Source |
| Guest links | unchanged since the earlier research: Labs plus T3 Connect, 24 hours, one browser, cannot answer the agent ([docs][guest-docs]) | No | Docs |
| Thread links | `https://app.t3.codes/threads/<environmentId>/<threadId>` opens the thread in the person's own T3 Code ([MCP docs, lines 400–420][thread-links]) | Usable as our "Open in T3 Code" link | Live: MCP returned one |

### The MCP server

At this build `tools/list` returned **68 tools** to an outside client (Live): `create_threads`, `delegate_task`, `delete_scheduled_task`, `device_close`, `device_list`, `device_open`, `device_screenshot`, `html_preview`, `html_render`, `link_pull_request`, `link_pull_requests`, `list_scheduled_tasks`, `list_thread_pull_requests`, `orchestrator_capabilities`, `preview_act`, `preview_dialog`, `preview_evaluate`, `preview_navigate`, `preview_open`, `preview_recording_start`, `preview_recording_stop`, `preview_resize`, `preview_set_appearance`, `preview_snapshot`, `preview_status`, `preview_wait_for`, `read_pull_request_guide`, `request_secret`, `run_scheduled_task_now`, `schedule_task`, `t3_attachment_discard`, `t3_attachment_prepare_upload`, `t3_background_wait`, `t3_environment_preferences_update`, `t3_environment_read`, `t3_pending_request`, `t3_preview_close`, `t3_preview_list`, `t3_project_clone`, `t3_project_create`, `t3_project_delete`, `t3_project_list`, `t3_project_read`, `t3_project_update`, `t3_queue`, `t3_thread_configure`, `t3_thread_interrupt`, `t3_thread_launch`, `t3_thread_list`, `t3_thread_organize`, `t3_thread_read`, `t3_thread_search`, `t3_thread_send`, `t3_thread_send_attachments`, `t3_thread_transfer`, `t3_thread_update`, `t3_thread_wait`, `t3_workflow_stop`, `t3_worktree_handoff`, `t3_worktree_list`, `t3_worktree_status`, `task_cancel`, `task_status`, `unlink_pull_request`, `unlink_pull_requests`, `unwatch_pull_request`, `watch_pull_request`, `write_pull_request_guides`.

Agents running inside T3 also see `t3_environment_link`, `t3_environment_links` and `t3_environment_unlink`, which exist in source ([tools.ts, line 324][env-link-tool]) but were not in the outside client's list.

What matters for us:

- **Read and send work.** Live: `t3_thread_read` with `view: "activity"` returned the thread and its item types; `t3_thread_send` with `mode: "auto"` started run 4 (`delivery: "started"`).
- **Approvals cannot be answered.** `t3_pending_request` handles questions only ([tools.ts, lines 127–145][pending-tool]). Live: it returned `requestIds: []` while the socket showed a pending `command` request with a `live` capability.
- **Tools that act as the calling thread refuse outside clients.** Live: `delegate_task` failed with `thread_credential_required` ([McpInvocationContext.ts, line 220][thread-credential]).
- **No push.** `t3_thread_wait` is a bounded wait, not a feed.
- **Attribution.** The MCP message was stored as `createdBy: "agent"`, `creationSource: "mcp"`. Messages sent over the socket were stored as `createdBy: "user"`, `creationSource: "web"`, the server's default ([ws.ts, lines 1999–2030][dispatch-handler]). Neither records which person sent it.

### The CLI

`t3 --help` lists `serve`, `app`, `pair`, `auth`, `environment`, `browser`, `project`, `thread`, `up`, `status`, `service`, `update`, `uninstall`, `theme`, `trace`, `doctor`, `policy`, `triage` and `connect`. The ones an integration would use:

| Command | Does |
| --- | --- |
| `t3 thread list / start / send / show` | Start, message and read threads on the running server. `send` never interrupts; `--wait` exits 2 when the agent waits for an answer |
| `t3 auth pairing create / list / revoke` | One-time pairing tokens, with `--scope`, `--ttl`, `--label` |
| `t3 auth session issue / list / revoke` | Bearer sessions directly, with `--scope`, `--ttl`, `--token-only` |
| `t3 pair [--scope] [--tailscale]` | A pairing link and QR code for a running server |
| `t3 environment link <url> --pairing-code … --access …` / `list` / `unlink` | Linked environments |
| `t3 connect login / link / publish [--disable] / status / unlink / logout` | T3 Connect, and publishing agent activity |
| `t3 up [--connect] [--lan] [--yes]`, `t3 status --json`, `t3 service …` | Remote access and the background service |
| `t3 project add / remove / rename` | Projects |

There is still no CLI command to answer an approval or a question.

### New since `47f2c8d`

From the release notes for [4093](https://github.com/pingdotgg/t3code/releases/tag/v0.1.7-nightly.20261102.4093) through [4179](https://github.com/pingdotgg/t3code/releases/tag/v0.1.8-nightly.20261104.4179), and the contracts diff:

- **Secret requests** (4179): an agent asks for a login, token or pairing code in a card instead of chat. The shell reports the card as a pending `user_input` whose id is the card's turn item id, not a runtime request id ([ProjectionStore.ts, lines 1481–1505][pending-summary]). **Link requests** (`t3_environment_link` cards) are reported the same way.
- **Shareable thread links**, **child approvals answered from the parent conversation**, **one-time schedules**, **managed policies** and **Kiro** ([v0.1.7](https://github.com/pingdotgg/t3code/releases/tag/v0.1.7)).
- **Tool output images** and **Claude model discovery** ([4165](https://github.com/pingdotgg/t3code/releases/tag/v0.1.8-nightly.20261104.4165)).
- Contracts: `sourceControl.star`; `server.refreshProviders` now needs only read; a turn capability `activeSteeringAcceptsAttachments`; a `clientCapabilities` socket parameter for secret references in settings. The orchestration protocol did not change.

## Comparison with our integration

| T3 capability | Bridge today |
| --- | --- |
| Pairing with read + operate, bearer session in `bridge.json` | Used |
| `subscribeShell`, `getThreadProjection` (requests and archive/delete only), `launchThread`, `thread.stop` / `run.interrupt`, `runtime-request.respond` accept/decline | Used ([adapter](../packages/bridge/src/adapters/t3code.ts)) |
| `subscribeThread`, transcript, diffs, command output | Not used: the run panel says "Its conversation stays in T3 Code" ([RunPanel.tsx](../apps/desktop/src/renderer/views/RunPanel.tsx)) |
| `message.dispatch` (follow-ups, queue, steer) | Not used |
| Question answers, `thread.user-input.dismiss` | Not used: questions show "Answer it in T3 Code" |
| Worktree launches, model and mode changes, rollback, fork | Not used |
| MCP, T3 Connect, linked environments, guest links | Not used, and not needed for the plan below |

**The bridge's adapter passed a live run against this build.** The real `T3CodeAdapter` from `packages/bridge`, given the two-scope session, launched a thread for a room run (`uplink-room-<runId>`), reported `working → waiting → working → done`, showed the approval as `{kind: "approval", text: "echo uplink-probe", action: "echo uplink-probe"}`, answered `stale_prompt` to a wrong prompt id, sent Allow, and answered `no_pending_approval` to a second Allow. The README's "Not verified live: Waiting with a real question or approval, and an approval answered" is half closed: approvals are now verified live, questions are not.

### Earlier conclusions that are now outdated

In [t3code-waiting-and-thread-view.md](t3code-waiting-and-thread-view.md):

1. "Unverified live: an approval's allow/deny round trip, … client-protocol connection/subscriptions": verified live on 2026-11-04, both by script and through the bridge's adapter.
2. "Concrete bridge and start_thread recommendation" (polling, `start_thread` always failing, `t3_thread_launch` first): done differently. The bridge now uses the client protocol for discovery, launch, stop and approvals.
3. #12 still holds (no single-thread embed; guest links unchanged; reuse MIT code), with two additions: the bridge's existing scopes already cover a live thread view, so no second pairing is needed, and T3 now offers a thread link for an "Open in T3 Code" button.
4. Still true: MCP cannot answer approvals, and an MCP token cannot be used for the client protocol.

### Problems the live tests found in our bridge

These are follow-ups, not part of this research PR.

1. **The T3 session expires after 30 days and the bridge does not notice.** `t3-pair` saves the token but not `expires_in` ([t3client.ts](../packages/bridge/src/adapters/t3client.ts)). After expiry, every reconnect fails with `t3_auth` and the adapter retries every 5 seconds, reporting unfinished threads Unknown, with nothing telling the person to pair again. Fix: save the expiry, warn ahead of it, and report an expired pairing as its own machine state. On a machine where `t3` is local, the bridge could mint a fresh session itself.
2. **The README's revocation advice leaves a connected bridge working.** It says to revoke with `t3 auth session revoke`; live, that refused new connections but left the open socket serving requests. Settings → Sharing & access closed it at once. Fix the README to name Settings first, and say that a CLI revoke takes effect when the bridge next reconnects.
3. **Secret and link cards read as Working.** The shell's pending `user_input` id for those cards is not in `runtimeRequests`, so `promptFor` finds nothing ([t3code.ts, lines 269–275](../packages/bridge/src/adapters/t3code.ts#L269-L275)) and `refresh` reports the run's status ([lines 360–372](../packages/bridge/src/adapters/t3code.ts#L360-L372)), which is `running`. The person is never told the agent waits for them. Fix: when the pending id matches a `secret_request` or `link_request` turn item, report Waiting with "Answer it in T3 Code" and no buttons. Never carry a secret through the room.

## Plan

### What full integration means

1. **A live thread view** in the run panel: messages as they stream, tool calls with their status, approvals and questions with their outcome, plans, errors, and a per-turn diff on request.
2. **A message box** for the driver, sending follow-ups into the thread.
3. **Questions answered from the room**, as approvals already are.
4. **Open in T3 Code** through the thread link.
5. Later, as needed: queue and steer controls, model changes, worktree launches, rollback.

### Keep going through the bridge

| Route | Why not, or why |
| --- | --- |
| **Bridge (recommended)** | It already holds the right session on the machine, gets pushed events, can answer approvals, works with no T3 Connect or tailnet, and is where room roles and the driver are enforced today. The token never leaves the machine. |
| Room as an outside MCP client | The token would live in the cloud. MCP cannot answer approvals or push events. It needs an `https` route to every machine (T3 Connect or Tailscale), and messages would show as sent by an agent. |
| Each viewer connects to T3 directly | Every teammate would need their own pairing per machine; T3 grants a whole environment, not one run, and knows nothing of the room's roles. |
| Embed T3's web app or guest links | Unchanged from #12: no single-thread embed, cookie and origin limits, guest links expire in 24 hours and cannot answer. |

### Data flow

- **Which threads.** The room tells the bridge when someone opens a thread run (`watch_thread`, `unwatch_thread`), as it tracks terminal watchers. The bridge also follows every room run that is Working or Waiting, so the Inbox and notifications see new items without anyone watching.
- **What crosses.** The bridge subscribes with `subscribeThread`, keeps `afterSequence` for reconnects, and turns T3's turn items into a small room shape: message (role, text), tool call (title, kind, status, command, exit code), file change (path, kind), approval or question (text, outcome), plan, error, and checkpoint (turn number, files changed). Batches go up seq-numbered, like `terminal_output`. Command output and diffs are fetched only when a viewer expands a row (`subscribeCommandOutput`, `getTurnDiff`), with a size cap.
- **What the room keeps.** A bounded window per run, like `terminalOutput`, so the panel still shows the conversation while the machine is offline. The window size waits on experiment 1.
- **Images.** T3's signed asset URLs are bearer credentials ([environment auth docs][asset-urls]). The bridge would fetch the bytes and store them in the room; it never forwards a T3 URL.

### The message box

- A new room-to-bridge message, `send_thread_message {threadRef, messageId, text, from}`. The bridge accepts it only from the thread's current driver, as it does terminal input, and otherwise answers `input_rejected` (`not_driver`).
- The bridge dispatches `message.dispatch` with `commandId` and `messageId` derived from the room's message id, so a redelivered message is not sent twice. An idle thread gets `start_immediately`; a busy one gets `queue_after_active`, which matches `t3 thread send` ("nothing is interrupted"). Steering comes later, after experiment 2.
- T3 stores the message as `createdBy: "user"`, `creationSource: "web"` with no sender name, so the room records who sent it.
- Attachments come later, through `attachments.createUploadUrl`.

### Access and the driver

The glossary already makes the **Driver** "whoever is steering a thread, terminal or shared browser", but **Access** (Watch, Suggest, Drive, Open) is defined only for terminals and shared browsers. Threads need it too. Proposed, as a glossary change and an ADR before building:

| Room access on a thread run | Sees the thread | Message box | Approvals and questions | Stop |
| --- | --- | --- | --- | --- |
| Watch | yes | no | no | the driver only |
| Suggest | yes | proposes a message; the driver sends it, like a terminal suggestion | the driver only | the driver only |
| Drive | yes | the driver; others ask for the wheel | the driver | the driver |
| Open | yes | whoever takes the wheel, one at a time | the wheel holder | the wheel holder |

T3's own levels sit underneath and do not map one-to-one. The bridge is a single T3 client with read and operate; every room person acts through it, so the room's access decides who may do what, and the machine's most open access caps it as for terminals. T3's runtime mode (Supervised through Full access) decides what the agent may do without asking. The bridge launches at Supervised (`approval-required`) and should not change a thread's mode from the room until we decide who may. Linked-environment access levels are T3-to-T3 and play no part.

### Security

- **Tokens.** The T3 session stays in `bridge.json` on the machine, as now. Nothing in this plan sends it anywhere.
- **Least privilege.** Keep exactly `orchestration:read` and `orchestration:operate`. The view needs only read; diffs come from `getTurnDiff` under read, so `filesystem:read` stays off. Because operate is broad, the bridge keeps an allowlist of the RPCs and command types it sends: `launchThread`, `subscribeShell`, `subscribeThread`, `getThreadProjection`, `getTurnDiff`, `subscribeCommandOutput`, and `dispatchCommand` for `message.dispatch`, `runtime-request.respond`, `thread.user-input.dismiss`, `thread.stop`, `run.interrupt`. Nothing else, and never a pass-through.
- **Content.** A transcript holds code and whatever the agent printed, which is what terminal output already carries. It goes only to team members who may see the run, with bounded retention. Secret cards are never answered from the room.
- **Expiry and revocation.** Fix problems 1 and 2 above.

### What to reuse from T3 (MIT)

T3's [license][license] allows copying with the notice kept. The client packages are private and depend on Effect, many `@t3tools/*` providers and `@pierre/diffs` ([client-runtime package.json][runtime-package]), and `MessagesTimeline.tsx` is 1,701 lines on top of them ([source][timeline]). Copying the timeline whole would pull in most of T3's web app.

- **Copy types, not schemas.** Plain TypeScript types for the turn items, projection and stream items, pinned to a commit in a header, as `t3client.ts` already does for frames.
- **Copy small logic.** The timeline's grouping logic (`MessagesTimeline.logic.ts`), the terminal-output append helper in `packages/shared` (it keeps cursor and color escapes), and the tool-name presentation (`t3McpToolPresentation.ts`).
- **Build our own view** in the desktop app's components and styles, which also keeps it within our UI rules.
- **Keep the scripted ACP agent** from this research as a bridge test fixture, so a live T3 check runs with no provider login.

### Effort

My estimates, for one engineer or agent, in working days:

| Piece | Days |
| --- | --- |
| Protocol: `watch_thread`, `unwatch_thread`, `thread_items`, `send_thread_message`, structured questions in `answer_prompt` | 0.5 |
| Bridge: subscribe per followed run, normalize, batch, resume after reconnect; send message; answer questions | 2 |
| Room backend: thread items table with retention, queries, message mutation with the driver check | 1.5 |
| Desktop: timeline in the run panel, message box, question form, Open in T3 Code | 2.5 |
| Fixes 1 to 3 above | 1 |
| Live end-to-end check with the scripted ACP provider, plus the glossary change and ADR for thread access | 1 |
| **Total** | **about 8.5** |

### Open experiments

1. **Transcript size.** How many items and bytes does a long real Claude Code or Codex thread produce? Measure `subscribeThread` on an isolated server with a signed-in provider, then set the room's window.
2. **Steering.** Does `message.dispatch` with `deliveryIntent: "auto"` steer a running Claude or Codex turn the way T3's composer does, and how do queued messages appear? Needs a signed-in provider; the scripted agent has no steering.
3. **Questions.** Done with the scripted agent (ADR 0023): an ACP v1 agent can ask with `elicitation/create` (form mode), which T3 Code shows as a question; answered from the room through the bridge with `runtime-request.respond {answers}`, the agent got `{"action":"accept","content":{"rounding":"Half up"}}`. A real question from Codex or Claude is still to see.
4. **CLI revocation.** Done (see Auth and access): the CLI revokes from its own process. Whether to report it upstream is open.
5. **Session renewal.** Should the bridge re-mint its session with the local `t3` before the 30 days end, and with what TTL?
6. **Bounded history.** Use `acceptBoundedSnapshot` and the history pages for long threads instead of whole projections.

## Live results (selected)

```text
# isolated server, bridge-style session with only orchestration:read + orchestration:operate
launched uplink-probe-1793817712552
approval 1: kind "command", responseCapability "live"; turn item prompt "echo uplink-probe"
accept -> {sequence}; run 1 completed; agent: "Approval outcome: allow."
message.dispatch "Probe 2: a follow-up from Uplink Room. Go SLOW." start_immediately -> run 2 started
run.interrupt -> run 2 interrupted
message.dispatch "Probe 3 …" -> approval 2 -> decline -> run 3 completed; agent: "Approval outcome: deny."
second answer to a resolved request -> OrchestrationV2DispatchCommandError
getTurnDiff 0..1 -> "diff --git a/uplink-probe.txt b/uplink-probe.txt … new file mode 100644"
projects.readFile     -> refused: missing required scope: filesystem:read
terminal.open         -> refused: missing required scope: terminal:operate
server.updateSettings -> refused: missing required scope: settings:write
guestShare.create     -> refused: missing required scope: access:write
peerLinks.list        -> refused: missing required scope: access:read

# shell entries while an approval was held open for 4 s
running, pendingRuntimeRequest {kind: "command", blocking: true}
after the answer: waiting (no request), then completed

# bridge's own T3CodeAdapter
states reported: working → waiting → working → done
wrong promptId -> stale_prompt; allow -> ok; allow again -> no_pending_approval

# outside MCP client (Node script, OAuth with a pairing code, access approval-required)
token: scope "orchestration:read orchestration:operate", expires_in 2592000
initialize: {"name":"T3 Code","version":"0.1.8-nightly.20261104.4179"}; tools/list: 68
t3_thread_send -> run 4, delivery "started"
t3_pending_request list -> {"requestIds":[]}   (socket: one pending "command" request, capability "live")
delegate_task -> thread_credential_required

# revocation of the bridge session with its socket open
POST /api/auth/clients/revoke -> {"revoked":true}; socket closed 4 ms later
t3 auth session revoke        -> reconnect HTTP 401; open socket still answered 30 s later
```

[protocol-version]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/contracts/src/environment.ts#L13-L21
[acp-local]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/provider-acp-registry/src/settings.ts#L8-L70
[rpc-scopes]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/apps/server/src/auth/RpcAuthorization.ts#L40-L213
[client-scopes]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/contracts/src/clientRpcPermissions.ts#L17-L73
[ws-methods]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/contracts/src/orchestrationV2.ts#L3574-L3595
[commands]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/contracts/src/orchestrationV2.ts#L2895-L3372
[projection]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/contracts/src/orchestrationV2.ts#L2011-L2036
[thread-stream]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/contracts/src/orchestrationV2.ts#L3884-L3907
[subscribe-thread-input]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/contracts/src/orchestrationV2.ts#L3773-L3784
[command-output]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/contracts/src/orchestrationV2.ts#L3604-L3614
[launch-input]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/contracts/src/orchestrationV2.ts#L3632-L3651
[message-dispatch]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/contracts/src/orchestrationV2.ts#L3146-L3186
[client-send]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/client-runtime/src/operations/commands.ts#L733-L777
[run-interrupt]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/contracts/src/orchestrationV2.ts#L3226-L3234
[thread-stop]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/contracts/src/orchestrationV2.ts#L2896-L2907
[respond]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/contracts/src/orchestrationV2.ts#L3275-L3291
[rollback]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/contracts/src/orchestrationV2.ts#L3291-L3299
[secret-item]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/contracts/src/orchestrationV2.ts#L1549-L1596
[browser-docs]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/docs/user/remote-access.md#L239-L264
[devices-docs]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/docs/user/devices.md#L1-L30
[snapshot-docs]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/docs/user/snap-shot.md#L1-L22
[scheduled-schema]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/contracts/src/scheduledTask.ts#L158-L215
[webhook-docs]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/docs/user/project-settings.md#L97-L163
[connect-internals]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/docs/internals/t3-connect.md#L1-L72
[awareness]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/apps/server/src/relay/AgentAwarenessRelay.ts#L1-L60
[mobile-docs]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/docs/user/mobile-notifications.md#L1-L11
[http-routes]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/contracts/src/environmentHttp.ts#L683-L725
[transcript]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/contracts/src/orchestrationV2.ts#L2039-L2045
[scopes]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/contracts/src/auth.ts#L31-L67
[scope-docs]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/docs/user/remote-access.md#L375-L416
[session-ttl]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/apps/server/src/auth/SessionStore.ts#L429
[mcp-access]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/contracts/src/auth.ts#L403-L424
[peer-links]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/docs/internals/remote.md#L70-L140
[permission-docs]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/docs/user/permission-modes.md#L8-L24
[mcp-audience]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/apps/server/src/auth/EnvironmentAuth.ts#L612-L619
[lan-docs]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/docs/user/remote-access.md#L67-L196
[connect-docs]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/docs/user/remote-access.md#L6-L65
[outside-docs]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/docs/user/outside-agents.md#L1-L121
[peer-source]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/apps/server/src/peer/PeerLinks.ts#L45-L250
[balance-docs]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/docs/user/remote-access.md#L152-L168
[guest-docs]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/docs/user/guest-links.md#L1-L36
[thread-links]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/docs/orchestration-v2/orchestrator-mcp-server.md#L400-L420
[env-link-tool]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/apps/server/src/mcp/toolkits/orchestrator/tools.ts#L324-L330
[pending-tool]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/apps/server/src/mcp/toolkits/thread/tools.ts#L127-L145
[thread-credential]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/apps/server/src/mcp/McpInvocationContext.ts#L220
[dispatch-handler]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/apps/server/src/ws.ts#L1999-L2030
[pending-summary]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/apps/server/src/orchestration-v2/ProjectionStore.ts#L1481-L1505
[asset-urls]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/docs/internals/environment-auth.md#L135-L148
[license]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/LICENSE
[runtime-package]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/packages/client-runtime/package.json
[timeline]: https://github.com/pingdotgg/t3code/blob/9e85538535c8553901351112ab02dd1dd62db5ee/apps/web/src/components/chat/MessagesTimeline.tsx
