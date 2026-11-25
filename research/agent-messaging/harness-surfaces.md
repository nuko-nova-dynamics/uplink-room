# How each harness and hosted assistant receives and sends messages

Research for the room's agent-to-agent messaging: Julio's Claude Code run and a teammate's run on another machine, or any of our agents, coordinating through Uplink Room while they work. Checked on 2026-11-05 against official docs, official repos and release notes. Each claim names its source. Where only a search summary was seen, the text says "the summary suggests".

Terms used below:

- **Receive while working**: a message from outside reaches the agent's model during a turn that is already running, without stopping it.
- **Receive while idle**: a message from outside starts a new turn in a session that finished its last one.
- **Send out**: the agent itself can deliver a message to something outside its own session.
- **Relay**: the room's code on the machine (the bridge, ADR 0002) or in the backend (the A2A worker, ADR 0012) that carries a message to the agent.

## Answers

1. **No product lets two different people's agents message each other directly.** Claude Code's cross-session messaging, Codex subagents, Muse Code's session messaging, T3 Code's thread tools and Claude Code agent teams all stop at one person's account, and most stop at one machine. Grok Bot is the only one with documented messages between agents of different people, and only through shared Bots in Slack. Julio's run and a teammate's run can coordinate only through a relay such as the room.
2. **Three harnesses expose a documented way for an outside process to put a message into a running turn:** Codex (`turn/steer` on the app server, which the interactive CLI now shares by default), T3 Code (`message.dispatch` with `steer_active`, already in `research/t3code-capabilities.md`), and Hermes (`busy_input_mode: steer`). Claude Code reaches the same result with a `PostToolUse` hook that returns `additionalContext`, which lands next to each tool result.
3. **Waking an idle session is documented for Claude Code (channels, `asyncRewake` hooks, mods), Codex (`codex queue`, `turn/start`), T3 Code, Hermes and Grok Bot (routine webhooks).** It is not documented for Grok Build, Muse Code from outside, ChatGPT dots, Meta Muse or Claude Duet.
4. **The hosted assistants (dots, Grok Bot, Meta Muse, Claude Duet) have no public API for sending them a message.** Their documented inbound doors are chat apps (Slack, Teams, WhatsApp, iMessage), email (Grok Bot) and webhooks (Grok Bot routines). All four can call out through connectors (MCP or API), so each can reach the Room API as a tool.
5. **A2A 1.0 push notifications work only if the room exposes a public https webhook**, and an agent can call the room as an A2A client only if the room serves an Agent Card, which ADR 0012 deferred. Hermes is ready for both: it sends push notifications and has an `a2a_call` tool.
6. **MCP has no agent-to-agent messaging standard yet.** The 2026-08-22 roadmap lists "server-initiated events (webhooks and channels)" as planned work. Claude Code's channels are a Claude Code extension of MCP, not part of the spec.

## Summary table

"Stability" uses each vendor's own label. "Documented" means the page carries no preview or experimental label in the parts read.

| Product and surface | Receive while working | Receive while idle | Send out | Auth model | Stability | Source |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code: agent teams (mailbox files, `SendMessage`) | Yes, teammate to teammate, delivered automatically | Yes; messaging a stopped in-process teammate brings it back | Yes, to teammates and lead by name; idle notifications to the lead | Same OS user, same session; files under `~/.claude/teams/` | Experimental, off by default (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), since v2.1.32 (2026-02-05) | [agent-teams](https://code.claude.com/docs/en/agent-teams.md) |
| Claude Code: cross-session messaging (`ListAgents`, `SendMessage`, inbox socket) | Yes, between tool calls | Yes, starts a new turn | Yes, to the same user's sessions on this machine (socket) or other machines and cloud (Remote Control) | Socket limited to the OS user; per-session token; cross-machine needs claude.ai sign-in, same account | Documented, on by default since v2.1.224 (2026-08-07) | [cross-session-messaging](https://code.claude.com/docs/en/cross-session-messaging.md) |
| Claude Code: channels (`claude/channel`) | Queued; "delivered together on the next turn" when busy | Yes | Yes, through the channel's own reply tool | Anthropic auth; sender allowlist in the channel; `--channels` opt-in per session; org `channelsEnabled` | Research preview since v2.1.80 (2026-03-19) | [channels](https://code.claude.com/docs/en/channels.md), [channels-reference](https://code.claude.com/docs/en/channels-reference.md) |
| Claude Code: hooks | Yes, `additionalContext` from `PostToolUse` and similar sits next to the tool result | Yes, `asyncRewake` hook exiting 2 wakes Claude | Yes, any hook can call out; `Stop`, `Notification` carry state | Runs as the user; project hooks need folder trust | Documented | [hooks](https://code.claude.com/docs/en/hooks.md) |
| Claude Code: mods | Not documented | Yes, `$.prompt.submit` waits until idle and starts a turn | Yes, `$.session.send`, `$.http.fetch` | Same permissions as the user | Documented, parts need v2.1.304 | [mods API](https://code.claude.com/docs/en/plugins/mods/api.md) |
| Codex: subagents (`spawn_agent`, `send_message`, `followup_task`, `wait_agent`) | Yes, inside one session; `send_message` is "delivered promptly" | Yes, `followup_task` triggers a turn if the agent is idle | Parent and children only | Same session | Default on in current releases | [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md), [multi_agents_spec.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs) |
| Codex: app server (`turn/steer`, `thread/inject_items`, `turn/start`) | Yes, `turn/steer` | Yes, `turn/start` | Through hooks or MCP tools, not the app server | stdio or Unix socket (local); WebSocket with capability or signed bearer token | Experimental, "isn't supported for production workloads" | [app-server](https://learn.chatgpt.com/docs/app-server.md), [mcp-server removal](https://learn.chatgpt.com/docs/mcp-server.md) |
| Codex: `codex queue` | Queues for the next turn | Yes, with `--resume` | No | Local daemon, or `--remote` with a token | Stable, since 0.149.0 (2026-08-20) | [developer commands](https://learn.chatgpt.com/docs/developer-commands.md), [release 0.149.0](https://github.com/openai/codex/releases/tag/rust-v0.149.0) |
| Codex: hooks | Yes, sync `PostToolUse` `additionalContext`; async hooks deliver at the next safe point | No: "finishing a background hook doesn't start a new turn" | Yes | Runs as the user; non-managed hooks must be trusted | Documented, on by default | [hooks](https://learn.chatgpt.com/docs/hooks.md) |
| ChatGPT: subagents (ChatGPT Work) | Parent routes follow-ups; web view is read-only | Not documented | Parent only | Hosted | Eligible accounts | [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md) |
| ChatGPT: dots | "You can keep talking to it while it works" in ChatGPT; Slack, Teams, texting | Yes, through the same channels | Slack, Teams, ChatGPT, texting to its owner; plugins (MCP); delegates to Work and Codex | Owner's ChatGPT account; Slack and Teams connected per dot | Rolling out gradually; texting in beta | [dots](https://learn.chatgpt.com/docs/dots.md), [message your dot](https://learn.chatgpt.com/docs/dots/channels.md) |
| Grok Bot | Group chats, Bot-to-Bot async messages; no outside API found | Routine triggers: webhook, email, Slack, GitHub, Linear, Sentry, PagerDuty | Bot-to-Bot handoffs, email from its own address, Slack, MCP and apps | Webhook bearer key per routine; Slack shared Bot needs linked accounts | Documented | [chat and collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration.md), [routines](https://docs.x.ai/grok-bot/skills-routines-and-automations.md), [computer and apps](https://docs.x.ai/grok-bot/computer-and-apps.md) |
| Grok Build | None documented: hooks other than `PreToolUse` ignore stdout | Headless `grok -p --resume <id>` or ACP `session/prompt` | Command or HTTP hooks (`Stop`, `Notification`), MCP tools | Local; ACP authenticates with cached login or `XAI_API_KEY` | Documented | [hooks](https://docs.x.ai/build/features/hooks.md), [headless and ACP](https://docs.x.ai/build/cli/headless-scripting.md) |
| Meta Muse | None documented | None documented (Muse app and WhatsApp only) | Connectors: API or MCP | OAuth account linking | Connector developer preview | [Meta AI Connectors](https://dev.meta.ai/products/connectors), [connector guidelines](https://platform.muse.ai/docs), [launch post](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) |
| Muse Code | Peer messages "steer the active turn", local only; `PostToolBatch` hooks can "add context" | Peer messages wake an idle session by default; `muse exec --session-id` | Peer messages to own local sessions; MCP tools | Same user, same macOS or Linux machine; approval prompt per sender | Documented, behind a rollout gate | [session messaging](https://dev.meta.ai/docs/muse-code/session-messaging.md), [extending](https://dev.meta.ai/docs/muse-code/extending.md) |
| Hermes Agent | A2A tasks go into the live session; gateway `busy_input_mode: steer` injects after the next tool call (default `interrupt`) | Yes, A2A and every platform adapter | `a2a_call` and four more A2A tools; push notifications; 27 platform adapters; MCP client | A2A per-peer bearer tokens, trusted-peer list; HMAC-signed pushes | Shipped plugin, v0.22.7 (2026-11-03) | [A2A plugin README](https://github.com/NousResearch/hermes-agent/blob/v0.22.7/plugins/platforms/a2a/README.md), [messaging docs](https://github.com/NousResearch/hermes-agent/blob/v0.22.7/website/docs/user-guide/messaging/index.md) |
| Claude Duet | None documented | None documented; it checks connected accounts "at set intervals" | Connectors from the Claude account; emails with approval | Owner's Claude account | Research preview since 2026-10-21; US, Pro, Max, Ultra, waitlist | [get started](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet), [announcement](https://claude.com/resources/articles/claude-duet) |
| T3 Code | Yes, `message.dispatch` with `steer_active`; MCP `t3_thread_send` | Yes, `start_immediately`, `queue_after_active` | Agents in T3 threads have `t3_thread_send`, `t3_queue`, `delegate_task` | Bridge pairing with `orchestration:operate`; MCP OAuth, 30 days | Nightly; no change since 4179 | `research/t3code-capabilities.md`, [release 4218](https://github.com/pingdotgg/t3code/releases/tag/v0.1.8-nightly.20261105.4218) |
| A2A 1.0 protocol | `SendMessage` with `taskId` continues an open task | Same, or a new task in the context | Push notifications to a client webhook | Agent Card security schemes; push webhook auth from the config | Stable; v1.0.0 (2026-03-12), v1.0.1 latest (2026-05-28) | [spec v1.0.0](https://github.com/a2aproject/A2A/blob/v1.0.0/docs/specification.md) |
| MCP | No standard; roadmap item | No standard; roadmap item | Tools only | OAuth per spec | 2026-07-28 spec; roadmap 2026-08-22 | [roadmap post](https://blog.modelcontextprotocol.io/posts/mcp-roadmap/) |

## 1. Claude Code

Current release: 2.1.318, published 2026-11-03 (`npm view @anthropic-ai/claude-code`).

### Agent teams

- Off unless `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set. Added in v2.1.32 (2026-02-05) as "research preview agent teams" (changelog).
- One session is the lead for its lifetime. Teammates are separate Claude Code instances. Any agent messages any other by name with `SendMessage`. To reach everyone, the sender sends one message per recipient.
- **Mailbox**: one JSON file per agent at `~/.claude/teams/{team-name}/inboxes/{agent-name}.json`. Claude Code validates every entry on read and removes entries that don't match its format. A message counts as sent only when the write to the recipient's file succeeds. The docs don't publish the entry format.
- **Team config**: `~/.claude/teams/{team-name}/config.json`, with a `members` array (name, agent ID, agent type; the lead is `team-lead`). The team name is `session-` plus the first eight characters of the session ID. The docs say not to edit or pre-author it, and Claude Code removes the directory when the session ends. Tasks live in `~/.claude/tasks/{team-name}/`.
- **Idle notifications**: "when a teammate finishes and stops, it automatically notifies the lead and includes its final answer". A teammate that dies on an API error reports that it failed.
- Hooks for teams: `TeammateIdle`, `TaskCreated`, `TaskCompleted`, each blocking with exit code 2.
- Limits that matter for the room: one team per session, "You can't ... share a team across sessions", no nested teams, no resume of in-process teammates.

For the room: a team is private to one session on one machine. Writing into mailbox files from outside would rely on an unpublished format that Claude Code deletes on mismatch. Not a relay surface.

### Cross-session messaging

- On by default from v2.1.224 (2026-08-07) on macOS and Linux, v2.1.234 on native Windows.
- **Delivery**: "The receiving Claude reads the message between tool calls during an active turn, so a running tool is never interrupted. When the receiving session is idle, Claude Code starts a new turn with the message."
- **Reach**: "your" sessions only. Same machine goes over a per-session Unix socket (named pipe on Windows), never through Anthropic. Other machines and cloud sessions go through Anthropic servers over Remote Control, from v2.1.225, and need a claude.ai sign-in; API keys and Bedrock-style providers can't reach other machines. A teammate's session on another account is not reachable.
- **Trust**: the receiver is told the message came from another session. It can't approve prompts, can't change configuration, and slash commands in it arrive as text.
- **Inbound controls**: `crossSessionInbound` is `accept`, `hold` or `refuse`. With no value set, a session that prompts for permissions accepts, and a bypass-mode session holds for approval. Held messages expire after `dialogExpiry` (5 minutes); at most 100 are held; at most 50 accepted messages queue for Claude. Same-machine messages are capped near 1,048,576 characters. `isolatePeerMachines: true` asks before anything leaves the machine.
- **Idle notice**: `SendMessage` with `notify_when_idle` asks a local session to send one notice when it next goes idle or exits (v2.1.236; dropped after 12 hours).
- **The socket**: Claude Code exports `CLAUDE_CODE_MESSAGING_SOCKET` (the path) and `CLAUDE_CODE_MESSAGING_TOKEN` to hooks and Bash. The docs say this section is for "when you want a script or hook to post into a session". The only documented line format is the optional first line `{"type":"auth","token":"<token>"}` (required on Windows). The connection must send a complete line within 30 seconds. **The message line itself is not documented.** Messages from the session's own child processes are delivered by default; other local processes are treated as asserting no permission class, so a bypass-mode session holds them.
- `claude -p` workers bind a socket too; `--bare` sessions do not.

### Channels

- Research preview, added in v2.1.80 (2026-03-19); permission relay added in v2.1.81 (2026-03-20). The flags don't appear in `claude --help`.
- A channel is an MCP server that Claude Code spawns over **stdio** and that declares `capabilities.experimental['claude/channel']: {}`. It pushes `notifications/claude/channel` with `params: { content: string, meta?: Record<string,string> }`. Meta keys must be letters, digits and underscores; other keys are dropped silently. The model sees `<channel source="name" key="value">content</channel>`.
- **Busy behavior**: "Events queue into the session and are processed in order. If several notifications arrive while Claude is busy, they're delivered together on the next turn." So a channel wakes an idle session but does not inject mid-turn. No acknowledgment reaches the server, and a blocked channel drops events silently.
- **Reply**: a two-way channel adds `capabilities.tools: {}` and its own reply tool, described in `instructions`.
- **Permission relay**: declare `claude/channel/permission: {}`. Claude Code sends `notifications/claude/channel/permission_request` with `request_id` (five letters a to z without l), `tool_name`, `description`, `input_preview`. The server answers `notifications/claude/channel/permission` with `{ request_id, behavior: "allow" | "deny" }`.
- **Gating**: the session must be started with `--channels plugin:<name>@<marketplace>`. During the preview only plugins on Anthropic's allowlist register, or on an org's `allowedChannelPlugins` (Team and Enterprise managed settings). A custom channel otherwise needs `--dangerously-load-development-channels server:<name>`, which asks for confirmation and is ignored under `-p` and the Agent SDK. claude.ai Team and Enterprise orgs also need `channelsEnabled: true`. Not available on Bedrock, Google Cloud or Foundry.
- **Gotcha**: on the v2 MCP client runtime (default from v2.1.232 when flags are fetched), "a channel server that negotiates MCP protocol revision 2026-07-28 can't deliver channel messages". Keep the channel server on an earlier revision, or set `MCP_PROTOCOL_NEGOTIATION=legacy` ([mcp docs](https://code.claude.com/docs/en/mcp.md)).

### Hooks that inject context or wake a session

- `additionalContext` in `hookSpecificOutput` goes into the conversation as a system reminder. Placement: for `PreToolUse`, `PostToolUse`, `PostToolUseFailure` and `PostToolBatch`, "next to the tool result"; for `UserPromptSubmit`, alongside the prompt; for `Stop`, at the end of the turn, and the conversation continues. Values over 10,000 characters go to a file with a 2,000-character preview. The docs advise writing it as facts, since imperative "system" text can trip prompt-injection defenses.
- **Stop**: `{"decision":"block","reason":"..."}` keeps Claude working with the reason. Claude Code overrides the ninth block in a row (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` raises it). Stop input carries `last_assistant_message`, `background_tasks` and `session_crons`.
- **`asyncRewake: true`** on a command hook: "runs in the background and wakes Claude on exit code 2". Its stderr, or stdout if stderr is empty, reaches Claude as a system reminder, and it "wakes Claude immediately even when the session is idle". Unlike plain `async`, its `timeout` is enforced (600 seconds by default). A plain `async` hook's output waits for the next user interaction when the session is idle.
- **Notification** matchers useful for sending state out: `permission_prompt` (about 6 seconds after a prompt opens), `idle_prompt` (about 60 seconds after Claude finished), `agent_needs_input`, `agent_completed`.

### Mods

The mods API ([api](https://code.claude.com/docs/en/plugins/mods/api.md)) gives a plugin `$.session.send({ to, text })` (the same delivery as `SendMessage`), `session.receive` and `session.send` events, `$.clock.every(ms, fn)` timers that run between turns, `$.http.fetch`, and `$.prompt.submit({ text })`, which "waits until the session is idle and then starts a new turn". A mod could poll the room and start turns with no extra process. I did not check whether mods carry a preview label.

## 2. Codex

Current stable: 0.166.0 (2026-10-29); alphas up to 0.168.0-alpha.3 on 2026-11-05 (GitHub releases).

### Subagents

The docs describe the communication as orchestrated by the parent: "ChatGPT or Codex handles orchestration across agents, including spawning new subagents, routing follow-up instructions, waiting for results, and closing agent threads." Users "ask Codex directly to steer a running subagent". The docs don't name the tools. The source (`codex-rs/core/src/tools/handlers/multi_agents_spec.rs`) defines, for the current version: `spawn_agent`; `send_message` ("The message will be delivered promptly. Does not trigger a new turn."); `followup_task` ("trigger a turn if it is idle. If the target is already running, deliver the task promptly at message boundaries while sampling, or after the pending tool call completes."); `wait_agent` ("Wait for a mailbox update from any live agent"); `list_agents`; `interrupt_agent`. The older version used `send_input`, `resume_agent` and `close_agent`. Settings live under `[agents]` (`enabled`, `max_concurrent_threads_per_session`, `default_subagent_model`). Everything stays inside one session.

### Hooks

On by default (`[features].hooks`, old alias `codex_hooks`). Events: `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreModelRequest`, `PostModelRequest`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `Stop`, `Interrupt`.

- `PostToolUse` and `UserPromptSubmit` return `hookSpecificOutput.additionalContext`, added as developer context (default limit 2,500 tokens, `additionalContextLimit` changes it).
- `PostToolUse` `decision: "block"` replaces the tool result with the feedback and continues.
- `Stop` `decision: "block"` "automatically creates a new continuation prompt that acts as a new user prompt, using your `reason` as that prompt text".
- Background (`async: true`) hooks: output is delivered at the next safe point of an active turn; "If no turn is active, Codex waits until the next user turn. Finishing a background hook doesn't start a new turn." There is no equivalent of Claude Code's `asyncRewake`.

### App server

JSON-RPC 2.0 without the `jsonrpc` field, over stdio (JSONL, default), a Unix socket (`--listen unix://` for Codex's default control socket), or WebSocket (`--listen ws://IP:PORT`, "experimental and unsupported"; auth `--ws-auth capability-token --ws-token-file PATH` or `signed-bearer-token`). The removal page says "The app-server command is experimental and isn't supported for production workloads."

Methods an outside process can use on a thread:

- `thread/resume {threadId}` then `turn/start {threadId, input}` to start a turn on an idle thread.
- `turn/steer {threadId, input, expectedTurnId}` "to append more user input to the active in-flight turn". It fails with no active turn, and `expectedTurnId` must match.
- `thread/inject_items {threadId, items}` appends Responses API items to history "without starting a user turn".
- `turn/interrupt`, `thread/loaded/list`, `thread/status/changed` (for example `activeFlags: ["waitingOnApproval"]`).

**The interactive CLI now shares one background server.** `codex` connects to a local daemon unless started with `--no-daemon` ("Run the interactive CLI without the shared background server"). Automatic daemon startup became the default in 0.157.0 (2026-09-25, PR #47179). In source, the daemon socket is `$CODEX_HOME/app-server-control/app-server-control.sock` (`codex-rs/app-server-transport/src/transport/mod.rs`, `codex-rs/app-server-daemon/src/lib.rs`). So a relay on the same machine can, in principle, reach the thread a person is typing in. Experiment 1 below tests that.

### `codex queue`, `codex exec resume`, and the removed MCP server

- `codex queue --thread <SESSION_ID or exact name> --message "..."` queues a text message for an existing session; `--resume` also resumes it if it isn't loaded (needs the local daemon or `--remote`). Marked stable. Added in 0.149.0 (2026-08-20); `--resume` in 0.166.0.
- `codex exec resume --last "..."` or `codex exec resume <SESSION_ID> "..."` continues a finished non-interactive run.
- `codex mcp-server` and the `codex-mcp-server` binary are removed: "The deprecated `codex mcp-server` entry point is no longer available" in 0.154.0 (2026-09-09). The docs point integrations to the app server. Codex still works as an MCP client (`codex mcp`).
- `codex remote-control` (experimental) runs the daemon with remote control and prints a short-lived pairing code.

## 3. ChatGPT

### Subagents

In ChatGPT Work, subagents run in ChatGPT's hosted environment. The user asks for delegation, or Ultra delegates on its own. "The web sidebar reports subagent activity; it doesn't provide controls to stop or steer an individual subagent." The parent routes follow-ups and collects results ([subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md)). No outside access.

### Dots

- An always-on cloud agent with its own computer and browser, one per person, handle like `@yourname-dot`. Rolling out gradually.
- **Inbound**: the ChatGPT apps and desktop web, voice calls, Slack (DM, or a mention in a thread of a channel it was added to), Microsoft Teams, texting by iMessage or RCS (beta, Pro, US, one to one, only its owner can text it), and iOS Shortcuts. "By default, your dot responds to you in Slack. You can instruct it to engage with others." Monitoring a channel needs an explicit instruction and schedule.
- **Outbound**: messages its owner in ChatGPT, Slack, Teams or text; uses plugins, which package MCP servers; creates cloud threads, local Work or Codex tasks on a connected computer, continues existing local Codex tasks, and uses Codex cloud environments ([tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory.md)). The admin guide says Compliance API records include "connected-app MCP calls and results".
- **API**: none documented for messaging a dot. The only dot-related APIs are the Enterprise Analytics API (`client_id = DOTS`) and the Compliance API, both read-only for admins ([admin guide](https://learn.chatgpt.com/docs/enterprise/dots-admin-guide.md)).
- While working: "You can keep talking to it while it works", and it decides "when to pause and wake up to continue work". The docs don't say whether a Slack message reaches a task already running.

## 4. Grok Bot and Grok Build

### Grok Bot

- **Group chats**: two to six Bots plus the user. "Bots can post into the group and pass work among themselves." A Bot can send "an asynchronous message to another Bot. The receiving Bot wakes, handles the request, and can reply later." There is no switch to stop Bots messaging each other. Handoff messages are text only. Billing and plans point to cursor.com.
- **Across people**: a personal Bot in your own chat can message other Bots for you. A shared Bot in a Slack channel or DM "can message other Bots" belonging to the teammate who mentioned it, and the reply lands in the same Slack thread. A shared Bot has its own Slack app and handle.
- **Routine triggers** (inbound from outside): a schedule, a Slack message, GitHub, Linear, Sentry or PagerDuty events, an email to the Bot's address, or a webhook. Webhook: the routine shows **POST to** (URL), **key**, and the header `Authorization: Bearer <key>`. The body is optional JSON that "the Bot receives ... with the routine instruction". "A `200` response means Grok Bot accepted the call and started a run, not that the Bot has finished."
- **Email**: one address per user at `mail.grokbot.com`, with plus aliases. Bots receive, read, search and send mail from it, and a routine can run when mail arrives.
- **MCP**: a Bot "can also add an MCP server that isn't in the catalog, by URL or by a command that runs on its computer". Custom MCP connectors must be reachable from the public internet; xAI documents tunnels for local servers ([tunneling](https://docs.x.ai/grok/connectors/custom-mcp-tunneling.md)).
- **API and A2A**: no public API to message a Bot, and no A2A, appear in xAI's docs index (`docs.x.ai/llms.txt`, read 2026-11-05).

### Grok Build

- **Hooks** in `~/.grok/hooks/*.json` or `<project>/.grok/hooks/*.json`. It also reads Claude Code's `.claude/settings.json` and Cursor's `.cursor/hooks.json`. `type` is `command` or `http` (POSTs the event to a URL). Events: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionDenied`, `Stop`, `StopFailure`, `Notification`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`. "`PreToolUse` ... the only blocking event"; "For passive events, stdout is ignored". So hooks can't inject context or keep a turn going. Default timeout 5 seconds.
- **Headless**: `grok -p "..." --output-format json|streaming-json`, `-r/--resume <id>`, `-c`, `-s/--session-id <uuid>` for a new named session.
- **ACP**: `grok agent stdio` speaks ACP JSON-RPC: `initialize`, `authenticate`, `session/new`, `session/prompt`, with output as `session/update` chunks.
- **MCP client**: `grok mcp add|list|remove|doctor`.
- No session-to-session messaging, no A2A, and no way to steer a running turn from outside are documented.

## 5. Meta Muse and Muse Code

### Meta Muse

- Reached in the Muse app "or directly in WhatsApp" ([launch post](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)).
- **Connectors**: "A connector turns your existing API into tools Meta AI can call." Onboarding by UI or MCP, OAuth account linking, in a developer preview where "connectors built during the preview aren't yet available to the public" ([Meta AI Connectors](https://dev.meta.ai/products/connectors)). The connector guidelines ask for "API or MCP documentation" ([platform.muse.ai/docs](https://platform.muse.ai/docs)). The Meta help center page on connectors rendered only through a search summary; the summary suggests users connect them under Settings, then Connectors.
- No API for sending Muse a message and no agent-to-agent feature appear in these pages.

### Muse Code

Meta's terminal coding agent. Latest changelog entry: 1.4.13 ([changelog](https://dev.meta.ai/docs/muse-code/changelog.md)).

- **Session messaging** ([page](https://dev.meta.ai/docs/muse-code/session-messaging.md)): sessions named with `/name`. The agent lists peers and sends on request. Delivery is "Steer the active turn" (default, "at its next safe model step"), "Queue for the next turn", or "Notify only". Wake options: stay idle, wake when idle (default), wake at a safe point. An unverified sender triggers an approval prompt (allow or block once or for the session; expires in 30 minutes). A message "cannot approve a tool call, grant user consent, change permissions, or present itself as direct user input". Scope: "eligible interactive sessions for the same user account on the same macOS or Linux machine", plain text up to 8,192 bytes, no cross-machine transport, behind a rollout gate. No outside socket or CLI to send a message is documented.
- **Hooks**: project `.muse/hooks.json`, user settings, managed file. Events include `PostToolBatch`, which "can block the batch with a reason, stop the turn, or add context", plus `Stop`, `Notification`, `UserPromptSubmit` and others. The output format for adding context isn't on the extending page.
- **MCP**: `mcp_servers` block in settings. **Headless**: `muse exec [--json] "..."`; continue with `muse exec --session-id <uuid> "..."`.

## 6. Hermes Agent

Release v0.22.7 (2026-11-03). Sources pinned to that tag.

- **A2A server** (`plugins/platforms/a2a`): enable under `gateway.platforms.a2a` (port 9900). Serves a v1.0 Agent Card at `/.well-known/agent-card.json` and JSON-RPC `message/send`, `message/stream`, `tasks/get|list|cancel|subscribe`, and push notification configs. Its README uses 0.3-style method names; ADR 0018 already covers how the room talks to it. "Incoming tasks are injected into your **live** agent session ... the same agent that's talking to you, with full memory." `tasks/cancel` "cannot abort the live session's in-flight turn" (DESIGN.md).
- **Push notifications**: inline in `message/send` (`configuration.taskPushNotificationConfig`) or by the create method. On a terminal state it POSTs a v1.0 `StreamResponse`, HMAC-SHA256 signed in `X-A2A-Signature`, with SSRF checks.
- **A2A client**: yes. Peers go under `a2a_agents` with URL and bearer token. The agent gets `a2a_discover(url)`, `a2a_call(agent, message, context_id?)`, `a2a_list()`, `a2a_history(context_id)` and `a2a_orchestrate(capability, message, mode?)`. Hermes can call another A2A agent, and would call the room if the room served A2A.
- **Auth**: no token means localhost only; `A2A_PEER_TOKENS="name:token,..."`, `A2A_TRUSTED_PEERS`, rate limit 60 per minute, `A2A_MAX_PINGPONG_TURNS` 5 (at most 20).
- **Platform adapters** at v0.22.7: a2a, bluebubbles, buzz, dingtalk, discord, email, feishu, google_chat, irc, line, matrix, mattermost, ntfy, photon, qqbot, raft, signal, simplex, slack, sms, teams, telegram, wecom, weixin, whatsapp, whatsapp_cloud, yuanbao. Plus webhooks and an OpenAI-compatible API server.
- **Busy sessions**: `display.busy_input_mode` is `interrupt` (default: "messaging a busy agent redirects its active turn"), `queue`, or `steer` ("injected into the current run via `/steer`, arriving at the agent after the next tool call. No interrupt, no new turn").
- **MCP client**: `mcp_servers` config, stdio and HTTP, with a catalog of approved servers.

## 7. Claude Duet

It exists. Anthropic opened a research preview on 2026-10-21 ([announcement](https://claude.com/resources/articles/claude-duet), `datePublished` 2026-10-21). It is a separate app (iOS, Android) for Pro, Max and Ultra in the US, by waitlist, not yet on Team or Enterprise. It runs on Claude Opus 5.5 in a cloud VM with its own browser, uses the Claude account's memory, skills and connectors, and has a main thread plus topic channels ([help article](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet)).

Messaging surfaces: the user types or speaks in the app. It "checks your accounts at set intervals, so something urgent can arrive between checks". Slack works "with limits". It can't text or call other people, and it sends email only with approval. No API, webhook or inbound integration is documented. It can call out through connectors, so a Room MCP connector would let it post to the room.

## 8. T3 Code

`research/t3code-capabilities.md` (pinned to nightly 4179) still holds. Releases since then (nightly 4192, 4205 and 4218 on 2026-11-04 and 2026-11-05, and stable v0.1.7 on 2026-11-04) add Claude MCP Apps, pending-question handling and history fixes, but no new thread-to-thread or outside-to-thread surface. The surfaces that exist:

- Client protocol `message.dispatch` with `dispatchMode` `start_immediately`, `queue_after_active`, `steer_active`, `restart_active` or `defer_start`, and `deliveryIntent` `auto`, `steer` or `restart`. The bridge already pairs with the needed scopes.
- MCP tools `t3_thread_send`, `t3_queue`, `t3_thread_wait`, `delegate_task`. Agents running inside T3 threads have these tools, so one thread can message another on the same server.
- Scheduled tasks can run on each webhook request.

## 9. A2A 1.0 and MCP

### A2A push notifications

- Spec v1.0.0 (tag 2026-03-12); latest release v1.0.1 (2026-05-28).
- A client registers a webhook with `CreateTaskPushNotificationConfig` or inline when sending. The agent then POSTs a `StreamResponse` (`task`, `message`, `statusUpdate` or `artifactUpdate`) with the authentication the config names (spec 4.3.3). Only agents whose card sets `capabilities.pushNotifications: true` support it.
- The spec tells agents to refuse private and localhost webhook URLs (13.2), so the room's webhook must be public https. ADR 0012 records that push "would need an address the agent calls back, so they wait with the inbound A2A server". I did not check which room endpoint would serve it.

### Can an agent call the room as a client?

Only if the room serves an Agent Card at `/.well-known/agent-card.json` and a JSON-RPC endpoint. ADR 0012 says "The room keeps no A2A server of its own". Hermes's `a2a_call` and `a2a_orchestrate` would work against it unchanged once it exists.

### MCP and agent-to-agent

The 2026-07-28 specification removed protocol sessions and the handshake, moved Tasks into an extension (SEP-2663), and replaced server-initiated requests with Multi Round-Trip Requests (SEP-2322). The roadmap published 2026-08-22 makes "Agentic messaging primitives" a priority, including "server-initiated events (webhooks and channels, so clients aren't left polling for results)" and a review across the Agents and Triggers and Events working groups ([roadmap post](https://blog.modelcontextprotocol.io/posts/mcp-roadmap/)). No agent-to-agent messaging is standardized yet.

## Best way for an outside relay to deliver a message mid-task

The relay is the bridge on the machine where the run lives (ADR 0002), except for Hermes and other A2A agents, which the backend worker reaches (ADR 0012), and the hosted assistants, which only accept messages through their chat apps or triggers. Each harness gets an inbox in the bridge (`uplink-bridge inbox`, a name for the purpose of this report) that hooks or tools read.

### Claude Code

1. **Mid-turn: a `PostToolUse` hook that returns `additionalContext`.** Documented and needs no preview flag. Each tool result picks up waiting room messages before the next model request, the same point where cross-session messages land.

   ```json
   {
     "hooks": {
       "PostToolUse": [
         { "matcher": "*", "hooks": [
           { "type": "command", "command": "uplink-bridge inbox claude --hook post-tool-use", "timeout": 5 }
         ] }
       ]
     }
   }
   ```

   The command reads the hook input on stdin (it carries `session_id`), takes this session's waiting messages, and prints nothing or:

   ```json
   {"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Room message from @ana in #payments (12:04 UTC): The migration on staging finished; tenant_id is the new column."}}
   ```

   Write it as facts with the sender named. The docs warn that text framed as system commands can trigger prompt-injection defenses.

2. **Idle: an `asyncRewake` hook, re-armed on `Stop`.** A `Stop` command hook with `"asyncRewake": true` long-polls the bridge, then exits 2 and prints the message on stderr when one arrives, which "wakes Claude immediately even when the session is idle". Its timeout is enforced (default 600 seconds), so it has to exit and be armed again; how is open (experiment 2). Fallbacks: a mod that polls with `$.clock.every` and calls `$.prompt.submit({ text })`, or a channel (next item).

3. **Channels when the session was started for them.** `claude --channels plugin:uplink-room@<marketplace>`, with the plugin on the org's `allowedChannelPlugins` (Team or Enterprise), or `--dangerously-load-development-channels server:uplink-room` interactively. The bridge's channel server pushes `notifications/claude/channel` with `meta: { from, place, message_id }` and declares `claude/channel/permission` so approvals can be answered from the room. Channels don't inject mid-turn (they queue to the next turn), and the server must not negotiate MCP revision 2026-07-28 (or set `MCP_PROTOCOL_NEGOTIATION=legacy`).

4. **Not recommended yet: writing to `CLAUDE_CODE_MESSAGING_SOCKET`.** It is the documented peer inbox, and own-child posts are delivered by default, but the message line format isn't published. Test it before relying on it (experiment 3).

**Send out:** a Room MCP server (the Room API, ADR 0003) for deliberate posts; a `Stop` hook posting `last_assistant_message`; `Notification` with `idle_prompt` and `permission_prompt` for state.

**Julio's run and a teammate's run**: Julio's Claude calls the Room MCP tool to post in the task's channel or to the teammate's run. The room sends it to the teammate's bridge, and the teammate's `PostToolUse` hook (mid-turn) or `asyncRewake` hook (idle) delivers it. Cross-session messaging can't do this because it only reaches the sender's own account.

### Codex

1. **Mid-turn: `turn/steer` on the shared app server.** Connect to the local daemon's socket (WebSocket handshake over `unix://`; in source, `$CODEX_HOME/app-server-control/app-server-control.sock`), `initialize`, `thread/resume {threadId}`, read the active turn id from turn events or `thread/status/changed`, then:

   ```json
   { "method": "turn/steer", "id": 7, "params": {
     "threadId": "thr_123",
     "input": [ { "type": "text", "text": "Room message from @ana: staging migration finished." } ],
     "expectedTurnId": "turn_456" } }
   ```

   This reaches a person's interactive `codex` only when it runs on the daemon, the default since 0.157.0; `--no-daemon` sessions are out of reach. The app server is labeled experimental.

2. **Queue for the next turn (ADR 0023's default), stable CLI**:

   ```bash
   codex queue --thread <SESSION_ID> --message "Room message from @ana: staging migration finished." --resume
   ```

3. **Without the daemon: a synchronous `PostToolUse` hook** returning `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"..."}}`, as for Claude Code. Codex can't wake an idle session from a hook.

4. **Finished `codex exec` runs**: `codex exec resume <SESSION_ID> "..."`.

**Send out:** `Stop` hook (has `last_assistant_message`), Room MCP server via `codex mcp add`.

### T3 Code threads

Keep ADR 0023: the bridge dispatches `message.dispatch` with `queue_after_active` on a busy thread and `start_immediately` on an idle one. For true mid-turn delivery, `dispatchMode: "steer_active"`; whether that steers Claude and Codex threads the same way is still experiment 2 in `research/t3code-capabilities.md`.

### Hermes Agent

A2A from the backend, as ADR 0012 and 0024 already do: `SendMessage` with the conversation's `contextId` and the open `taskId`. Whether `display.busy_input_mode: steer` also governs A2A messages to a busy session is untested (experiment 4). For results without polling, register push: `configuration.taskPushNotificationConfig` pointing at a room HTTP action with a per-config token. **Send out:** Hermes calls `a2a_call` once the room serves A2A; until then it posts through the Room API with its agent key, over MCP.

### Grok Build

No documented mid-turn path. Between turns, the bridge owns the session through ACP (`grok agent stdio`, then `session/prompt`) or runs `grok -p "..." --resume <id> --output-format streaming-json`. **Send out:** an `http` hook on `Stop` and `Notification` POSTs to the bridge, and the Room MCP server via `grok mcp add`.

### Muse Code

Mid-turn: a `PostToolBatch` hook in `.muse/hooks.json` that "add[s] context". The output schema isn't published (experiment 5). Between runs: `muse exec --session-id <uuid> "..."`. Session messaging can't be driven from outside. **Send out:** Room MCP server in `mcp_servers`.

### Grok Bot

Not mid-task. To start work, POST to a routine webhook:

```bash
curl -X POST "$GROK_ROUTINE_URL" -H "Authorization: Bearer $GROK_ROUTINE_KEY" \
  -H "Content-Type: application/json" -d '{"from":"@ana","place":"#payments","text":"..."}'
```

`200` means a run started. Alternatives: email to the Bot's `mail.grokbot.com` address with an email-triggered routine, or a shared Bot mentioned in a Slack thread. **Send out:** add the Room MCP server by URL (public https), or Slack.

### ChatGPT dots

Not mid-task, and no API. The official inbound door for a relay is Slack: add the dot to a channel, tell it to engage with others and what to watch, and have the room's Slack identity post in that thread. **Send out:** install a plugin that wraps the Room MCP server (Plugin Creator plus Sites, or a self-hosted MCP server).

### Meta Muse and Claude Duet

No inbound path a relay can use. Both can call the room if it's offered as a connector: a Meta AI connector (developer preview, API or MCP onboarding), or a Claude connector (Duet uses the account's connectors). Duet checks accounts "at set intervals", so even a Slack or Gmail message reaches it hours late.

## Open experiments

Each is a hypothesis until the test runs.

1. **Codex daemon reachability.** With an interactive `codex` running on the default daemon, connect a script to `$CODEX_HOME/app-server-control/app-server-control.sock`, `thread/resume` the same thread, and send `turn/steer` during a turn. Confirm the TUI shows the steered input and the model acts on it. Also check whether a second client's `thread/resume` disturbs the TUI.
2. **Claude Code idle wake loop.** A `Stop` hook with `asyncRewake: true` that waits up to 590 seconds and exits 0 without a message: does the session stay idle and can anything re-arm the wait without a turn? Compare with a mod that polls every 15 seconds and calls `$.prompt.submit`, and measure token cost while idle.
3. **Claude Code inbox socket line format.** From a Bash child of the session, connect to `$CLAUDE_CODE_MESSAGING_SOCKET`, send the auth line, then candidate message lines, and read `--debug` logs. Then try from the bridge process (not a child) and confirm a default-mode session delivers it and a bypass-mode session holds it.
4. **Hermes busy mode over A2A.** Set `display.busy_input_mode: steer`, start a long A2A task, send a second message in the same context, and check whether it lands after the next tool call or becomes its own task (ADR 0024 saw Hermes give every message a new task).
5. **Muse Code `PostToolBatch` context.** Write a hook that prints candidate JSON (the Claude Code shape first, since Muse Code uses the same event names), and check whether the model sees the text.
6. **Channel on the v2 MCP runtime.** Build the bridge's channel server on MCP SDK 1.x, start Claude Code v2.1.318 with `--dangerously-load-development-channels server:uplink-room`, and confirm events register without `MCP_PROTOCOL_NEGOTIATION=legacy`.

## Sources read

Claude Code (code.claude.com, raw `.md`, 2026-11-05): agent-teams, cross-session-messaging, channels, channels-reference, hooks, mcp, env-vars, errors, plugins/mods/api, changelog; npm registry for versions and dates.
Codex and ChatGPT (learn.chatgpt.com, 2026-11-05): agent-configuration/subagents, hooks, app-server, mcp-server, non-interactive-mode, developer-commands, cli/reference, dots, dots/channels, dots/computers-and-apps, dots/tasks-and-memory, enterprise/dots-admin-guide, extend/mcp, plugins; openai/codex releases and source files named above.
xAI (docs.x.ai, 2026-11-05): llms.txt, grok-bot/overview, chat-and-collaboration, shared-bots, computer-and-apps, skills-routines-and-automations, faq, grok/connectors/custom-mcp-tunneling, build/features/hooks, sessions, subagents, cli/headless-scripting, cli/reference.
Meta (2026-11-05): dev.meta.ai/llms.txt, docs/muse-code, muse-code/session-messaging, muse-code/extending, muse-code/changelog, products/connectors, platform.muse.ai/docs, about.fb.com Muse launch post; the meta.com help center page only as a search summary.
Anthropic Claude Duet: support.claude.com article 17631495, claude.com/resources/articles/claude-duet.
Hermes: NousResearch/hermes-agent at v0.22.7, `plugins/platforms/a2a/README.md`, `DESIGN.md`, `website/docs/user-guide/messaging/index.md`, `website/docs/user-guide/features/mcp.md`.
T3 Code: pingdotgg/t3code release notes 4165 to 4218 and v0.1.7.
A2A: a2aproject/A2A `docs/specification.md` at v1.0.0; releases list.
MCP: blog.modelcontextprotocol.io roadmap post (2026-08-22).
