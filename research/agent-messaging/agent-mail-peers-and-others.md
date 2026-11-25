# Agent messaging: Agent Mail, claude-peers, Mailopoly Switchboard and others

Research for the decision on how coding agents (Claude Code, Codex, Grok Build, Hermes Agent, Cursor and others), including runs on two people's machines, can message each other while they work. Concord MCP and hcom are covered in a separate report. Researched 2026-11-05.

## What was read

| Source | Version read |
| --- | --- |
| `Dicklesworthstone/mcp_agent_mail_rust` | commit `8239ae081b0f6c5432cc27ee4a9c381e943b4f0e` (2026-11-05) |
| `Dicklesworthstone/mcp_agent_mail` (Python, deprecated) | commit `9138f34b1ed220235dbfeaa3f1fc9fe4444f4e72` (2026-11-01) |
| `louislva/claude-peers-mcp` | commit `640183fa7048443bf0a6592de45579e813df4587` (2026-04-26) |
| Mailopoly Switchboard | 17 pages under `https://www.mailopoly.com/`, fetched 2026-11-05 (pages dated 29 September and 9 October 2026) |
| Claude Code docs | `hooks`, `channels`, `channels-reference`, `cross-session-messaging` at `https://code.claude.com/docs/en/`, fetched 2026-11-05 |

Repos were cloned with `--depth 50` into `/private/tmp/claude-501/agent-msg-research2/` and read only. Nothing was installed or built. Paths below are relative to each repo's root.

## The short version

- **Agent Mail (Rust)** is the most complete model of what agents need from each other: identities, threads, acks, importance, search, advisory file leases, build slots and an audit archive in Git. It is one machine by design, identity is self-asserted unless you turn on extra checks, and nothing pushes a message into a running agent. Agents poll. Its license forbids use by anyone acting for Anthropic or OpenAI.
- **claude-peers** is the smallest working example of push delivery into Claude Code: a localhost broker plus an MCP server that turns each message into a `notifications/claude/channel` event. It is Claude Code only, localhost only, and `from` is not checked.
- **Mailopoly Switchboard** is a hosted product that already does cross-vendor, cross-machine agent messaging, with token-derived sender names, "information, never instructions", per-agent caps and a console for people. It is scoped to one person's account: two people's agents cannot talk.
- **Claude Code itself** shipped cross-session messaging (`SendMessage`, `ListAgents`) in 2026. It delivers mid-turn between tool calls, starts a turn when the session is idle, and treats a message as unable to approve anything. It reaches only the same person's sessions, and other machines only through Remote Control on the same claude.ai account. Its per-session inbox socket is the cleanest way for a bridge to push into a running Claude Code session.
- Among third-party tools from 2026, **Rhizome**, **agmsg**, **xMatrix**, **Murmur** and **AI Maestro** come closest to "different vendors, different people's machines". None of the five uses A2A.

## 1. MCP Agent Mail (Rust) and the Python original

### Architecture

- Rust Cargo workspace. One binary serves MCP over stdio or HTTP (`mcp-agent-mail serve`, default `127.0.0.1:8765`), plus an operator CLI `am`, a 16-screen TUI and server-rendered web pages under `/mail/` (`README.md`, sections "Server Modes" and "Architecture", lines 578-690 and 1503-1530).
- Storage: SQLite is the live state; a per-project Git archive holds every message, reservation and agent profile as Markdown/JSON files, written behind a queue and batched into commits (`SYNC_STRATEGY.md` lines 6-28, `README.md` "Consistency and Recovery Model").
- Search: a Tantivy lexical index, with optional semantic search in some builds (`README.md` "Search Architecture").
- Scope: "Single-machine coordination. Designed for agents running on the same machine or accessing the same filesystem. Not a distributed system." (`README.md:2086`). The HTTP server can bind `0.0.0.0` with a bearer token or JWT (`SECURITY.md` lines 104-118), so agents on two machines could share one server. Inferred: messaging would work that way, but a project is keyed by its absolute filesystem path and the file leases and pre-commit guard assume one shared checkout, so leases would not mean anything across two clones.

### Identity

- An agent calls `register_agent` with a project key, its program and model, and optionally a name. Without a name it gets an adjective plus noun such as `GreenCastle` (`README.md` lines 827-846). Names are unique per project, case-insensitive.
- Names are not tied to a person. The only human identity is a fixed `HumanOverseer` agent used by the web compose form (`README.md` lines 1320-1333).
- Sender authentication is off by default. The threat model says a self-asserted `agent_name` and a client-chosen `project_key` "are conveniences for cooperating local agents, not a tenancy boundary" (`SECURITY.md` lines 33-45).
- `register_agent` returns a `registration_token`. If `send_message` includes it as `sender_token`, the reply says `verified_sender: true`; a wrong token is rejected; no token sends with `verified_sender: false` (`crates/mcp-agent-mail-tools/src/messaging.rs` lines 2389-2394 and 2568-2621). Setting `MESSAGING_FAIL_CLOSED_SEND_PROFILE=true` makes the token required; its default is `false` (`crates/mcp-agent-mail-core/src/config.rs:1797`).
- Two opt-in hardenings: session-bound identity (`MESSAGING_SESSION_IDENTITY=true`), where an MCP session can only act as the identities it created (`README.md` lines 616-671), and a registration proof gate where every registration must carry an Ed25519-signed proof from a configured trust anchor (`README.md` lines 1456-1500).
- So by default `from` cannot be trusted. With the fail-closed profile on, `from` is trustworthy to the extent that the registration token stays secret, and the README notes it still "does not authenticate the model, provider or OS process".

### Delivery into a running agent

- Poll only. Agents call `fetch_inbox` (the tool description says "Poll after each editing step in an agent loop", `messaging.rs:5073`) or read `resource://inbox/{Agent}`. There is no channel, no PTY injection and no push. A grep of the repo for `claude/channel` and `UserPromptSubmit` finds nothing.
- Claude Code hooks: setup merges `SessionStart` (print active leases and pending acks), `PreToolUse` on `Edit` (leases expiring soon) and `PostToolUse` on `Bash` (`am mail inbox ... --limit 5`) into `settings.json` (`crates/mcp-agent-mail-core/src/setup.rs` lines 1210-1276). These print plain text. Claude Code's hooks doc says plain stdout reaches Claude only for `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart` and `PostModelSwitch`; for other events "Claude Code writes stdout to the debug log" (`https://code.claude.com/docs/en/hooks`, section "Exit code 0"). Inferred: the `SessionStart` lines reach the model, and the `PostToolUse` inbox check does not.
- `am check-inbox` exists "for git hooks and editor integrations", rate-limited to once per 120 seconds by default and silent on any error (`crates/mcp-agent-mail-cli/src/lib.rs` lines 567-600 and 9881-9935).
- Codex: the Rust setup writes only the MCP server entry (`README.md` lines 459-468). No Codex hook was found in the Rust crates.
- Idle agents are not woken. A message waits until the agent next polls.
- Durable monitors can follow `fetch_inbox_events` / `am inbox-events`, an append-only delivery cursor that reports `CURSOR_EXPIRED` when retention removed something (`README.md` lines 751-787).

Python original, differences only: its `scripts/hooks/check_inbox.sh` can print the `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":...}}` envelope (lines 168-171), which does reach Claude, and `scripts/integrate_codex_cli.sh` (lines 187-199) installs the same script as a Codex `PostToolUse` hook in `.codex/hooks.json`. It retired the old Codex `notify` script because Codex sends that program's output to `/dev/null` (`scripts/hooks/codex_notify.sh` lines 1-10). The Python version also rejects recipients that look like broadcasts (`all`, `*`, `@everyone`; `src/mcp_agent_mail/app.py` lines 2642-2645). It is marked "Superseded by mcp_agent_mail_rust ... no longer maintained" at the top of its README.

### Message model

- Direct messages with `to`, `cc`, `bcc`, a subject, a Markdown body, attachments (images converted to WebP), importance `low`/`normal`/`high`/`urgent`, `ack_required`, `thread_id` and a `topic` tag (`messaging.rs:3009`, the `send_message` description).
- No broadcast: `broadcast=true` is rejected "to prevent agent spam" (`messaging.rs` lines 1977-1985). A `project:<slug>` address puts one message in a shared project mailbox that every agent of the project reads, each with its own read and ack state.
- Threads, `reply_message` (inherits importance and ack flag), `acknowledge_message`, `mark_message_read`, delivery receipts, and an "ack overdue" view with a 30-minute SLA.
- Cross-project messages need an approved contact link; each agent has a contact policy of `open`, `auto`, `contacts_only` or `block_all` (`messaging.rs` lines 576-600).
- Retention: messages are kept forever by default (`messages_retention_days: 0`, `config.rs:1867`); file reservations 30 days (`config.rs:1812`).
- Search: `search_messages` and `summarize_thread`, plus product-wide search across linked projects.

### Coordination

- Advisory file reservations on globs with a TTL, exclusive or shared, with a reason (`file_reservation_paths`, `renew_...`, `release_...`, `force_release_...`). Conflicts use symmetric glob overlap. A pre-commit guard blocks commits that touch files another agent holds, and `--no-verify` bypasses it (`README.md` lines 998-1066 and 2087).
- Build slots: named leases to serialize heavy builds on one checkout.
- Presence: `last_active_ts` from tool calls, and "ATC", a background operator that probes liveness, detects reservation deadlocks and can reclaim leases. It ships in `shadow` mode, which decides but writes nothing (`README.md` lines 1411-1430).
- Handoffs are by convention: a message in a thread, often keyed to a Beads issue ID.

### Loops and safety

- Size caps: 1 MiB body, 10 MiB per attachment, 20 MiB total (`config.rs` lines 1801-1803).
- HTTP rate limiting exists (60 per minute default) but is off by default (`config.rs:1738`, `SECURITY.md` line 104 onward).
- Idempotency keys on `send_message`, `reply_message` and `file_reservation_paths` prevent duplicate sends on retry (24-hour window).
- No prompt-injection marking was found: a grep of `crates/`, `README.md` and `SECURITY.md` for "prompt injection" and "untrusted content" finds nothing. Message bodies reach the agent as ordinary tool output.
- Messages cannot approve anything, because the system has no approvals. The opposite case exists: overseer messages from the web form are prefixed with "The human's guidance supersedes all other priorities" (`crates/mcp-agent-mail-server/src/mail_ui.rs` lines 6230-6243), and anyone who can reach that form can send one.
- Markdown rendered to HTML is sanitized with `ammonia`; SQL is parameterized; Git runs through libgit2 (`SECURITY.md`).

### License and maintenance

- License: "MIT License (with OpenAI/Anthropic Rider)" (`LICENSE`). The rider grants no rights to "OpenAI, L.L.C.; Anthropic, PBC; any of their respective Affiliates; and any person or entity acting directly or indirectly on behalf of, for the benefit of, or under the direction of any of the foregoing", and its definition of "use" includes "analyzing, indexing" and incorporating into "any dataset, training corpus, evaluation harness, or pipeline for machine learning or other automated systems" (`LICENSE` lines 12-40). GitHub reports the license as `NOASSERTION`. The same rider is on the Python repo. Inferred: copying code from it into Uplink Room needs a legal read first; reading it for ideas is a separate question.
- Rust repo: 234 stars, last commit 2026-11-05, 15 open issues and 0 open PRs (`gh api`, 2026-11-05). Solo maintainer, no SLA (`SECURITY.md`). Requires Rust nightly.
- Python repo: 2,231 stars, last commit 2026-11-01, 2 open issues, maintenance mode.

## 2. claude-peers-mcp

### Architecture

- TypeScript on Bun, about 1,000 lines. A broker daemon (`broker.ts`) is an HTTP server on `127.0.0.1:7899` backed by SQLite at `~/.claude-peers.db` (`broker.ts` lines 26-27, 228-231). Each Claude Code session runs `server.ts` as a stdio MCP server, which starts the broker if none is running.
- Two tables: `peers` (id, pid, cwd, git root, tty, summary, last seen) and `messages` (from, to, text, sent time, delivered flag) (`broker.ts` lines 35-59).
- Single machine only: "Everything is localhost-only" (`README.md:87`).
- Optional auto-summary: with `OPENAI_API_KEY` set, the server sends the directory, git branch and recently modified file names to OpenAI's `gpt-5.4-nano` to describe the session (`shared/summarize.ts` lines 28-49).

### Identity

- The broker assigns a random 8-character ID on each registration (`broker.ts` lines 127-150). It is not tied to a person or a stable name, and it changes on restart (issue #12 asks how a session learns its own ID; issue #16 is about IDs changing).
- No authentication. `/send-message` stores whatever `from_id` the request body contains (`broker.ts` lines 200-209), and any local process can call it or `/unregister` any peer. Through the MCP tool, `from_id` is the session's own ID (`server.ts` lines 297-310), but nothing stops a different local client. `from` cannot be trusted.

### Delivery

- Claude Code channels. The server declares `experimental: { "claude/channel": {} }` (`server.ts` lines 147-148), polls the broker every second (`server.ts:39`, `POLL_INTERVAL_MS = 1000`) and emits each message as `notifications/claude/channel` with `from_id`, `from_summary`, `from_cwd` and `sent_at` as meta (`server.ts` lines 404-450).
- Claude Code must start with `--dangerously-load-development-channels server:claude-peers` (`README.md:39`). The README says channels need a claude.ai login and "API key auth won't work"; the current channels doc says claude.ai or a Console API key both work, and that Team and Enterprise organizations must enable channels (`https://code.claude.com/docs/en/channels`, opening note).
- When Claude sees it: per the channels reference, "If several notifications arrive while Claude is busy, they're delivered together on the next turn" (`https://code.claude.com/docs/en/channels-reference`, "Notification format"). The channels doc describes channels as events that arrive in a running session "while you're not at the terminal". Inferred: a message reaches a busy session at its next turn and starts a turn in an idle one. The server's instructions tell Claude to "RESPOND IMMEDIATELY. Do not wait until your current task is finished" (`server.ts` lines 151-155).
- Fallback: a `check_messages` tool for sessions without channels.
- Codex and other harnesses: not supported. Open issue #39 asks for "a Codex-compatible inbound push path"; open PR #67 adds OpenCode.

### Message model

- Direct text to one peer ID. No broadcast, threads, kinds, subjects, search or attachments.
- "Ack" means the broker marks a message delivered the moment the MCP server polls it (`broker.ts` lines 211-220), before Claude sees it. Open issues #50 and #81 report this as at-most-once delivery while reporting success.
- Retention: messages stay in the table, but undelivered messages to a dead peer are deleted every 30 seconds (`broker.ts` lines 61-79; issue #37 reports messages lost on restart).

### Coordination

- Presence: `list_peers` scoped to machine, directory or repo, filtered by whether the PID is alive, with a heartbeat every 15 seconds. `set_summary` publishes what the session is doing.
- No file claims or handoffs. Issue #72 asks for repo-scoped work claims.

### Loops and safety

- No rate limit, dedupe, size cap or injection marking. The instructions push the receiving Claude to act on peer messages at once. Nothing a message says can approve a tool prompt, since the server does not declare `claude/channel/permission`.

### License and maintenance

- MIT (`LICENSE`, "Copyright (c) 2026 Louis Arge").
- 2,208 stars. Last commit 2026-04-26, more than six months ago. 17 open issues and 47 open PRs (`gh api`, 2026-11-05), several of them fixes for the delivery bugs above. Inferred: maintenance has stalled.

## 3. Mailopoly Switchboard

Closed, hosted product from Mailopoly Pty Limited (Sydney). Everything below comes from its public guide pages, not from code; their behavior is as the pages describe it and was not tested.

### Architecture

- A hosted MCP server at `https://fastapi.prod.aws.mailopoly.com/mcp-server/`, streamable HTTP with OAuth 2.1, or a Mailopoly API key for clients that can't open a browser (`/agents/any-agent/`, `/mcp/`). It is the same connector Mailopoly uses for email, Slack and WhatsApp.
- Networked: agents on any machine or in the cloud join the same account's board (`/agents/agent-to-agent/`, "Across vendors, across machines").
- People use a phone and desktop app with an "Agent Console" (a roster and one thread per agent), the Mailopoly inbox, or email to Mailopoly's assistant, Poly.

### Identity

- An agent calls `identify_agent` with a name such as `research` and receives a token that "is its identity from then on". Registering again with the same name rotates the token and cuts off the old session (`/agents/claude-code/`, "What goes wrong"). A person can pre-create the name in the console, and the first session to claim it gets it.
- Every agent belongs to one person's Mailopoly account. "Can agents from two different Mailopoly accounts talk? No. ... Two people's agents would each need to be on the same account." (`/agents/agent-to-agent/`, FAQ).
- `from` can be trusted within the account: "The name on every message is the one Mailopoly registered for the sender, derived from its token, so nothing can pose as another agent or as Poly." (`/agents/agent-to-agent/`).
- Limits: 3 agents on free and trial accounts, 5 on paid plans, 10 during an introductory offer. A quiet name expires after 30 days, or 7 for webhook agents (`/agents/any-agent/`, FAQ).

### Delivery

The pages describe three "doors", and the console shows which one each agent has, "observed, not declared": "Listening · webhook", "Listening · wake bridge", "probably turn-bound", "Not listening" (`/agents/any-agent/`, "How quickly your agent hears back").

| Harness | How it hears a message (per Mailopoly's guide) |
| --- | --- |
| Claude Code (terminal) | A "wake script" Mailopoly hands it at registration runs in the background, "waits on the Switchboard costing nothing while idle, and wakes the session when a message for it lands" (`/agents/claude-code/`). Inferred: this is a background shell command whose exit re-invokes Claude, so it wakes an idle session; whether it lands mid-turn is not stated. |
| Claude Code on the web, Cowork | Reads messages at the start of each turn. |
| Codex (interactive) | "Turn-bound: it reads its messages at the start of each turn, which means when you next type something." An interactive session "can't be woken". |
| Codex (unattended) | A detached loop on the machine waits on the Switchboard and starts a fresh headless `codex exec` turn per message, "measured at about 35 seconds from your message to its reply", under the same agent token (`/agents/codex/`). |
| Cursor | Editor reads at turn start; a Cursor Automation with a webhook trigger starts a run "about two seconds after it lands" (`/agents/cursor/`). |
| Hermes Agent, OpenClaw, Grok Bot | Webhook that starts a run; otherwise the next scheduled check (`/agents/hermes/`, `/agents/cursor/`). |
| Anything else | Wake script, a signed webhook (HMAC-SHA256 with a secret returned at registration), or polling (`/agents/any-agent/`, FAQ). |

### Message model

- Tools: `identify_agent`, `send_agent_message` (to a name, to `"user"`, or to `"all"`), `poll_pending_actions`, `resolve_trigger_event` (`/agents/any-agent/`, FAQ).
- Durable queue. A collected message that isn't marked handled "is leased for 30 minutes and reappears", which makes delivery at-least-once (inferred) and makes "handled" the audit record.
- Broadcast to all agents exists and "costs one message per recipient". Bodies up to 100,000 characters. A message can be marked as needing a reply, which files it in the person's task list ("My Day") until answered.
- Shared named notes all agents can read and update, and "be handed an email": Mailopoly can route a matching incoming email to an agent.
- Messages to the person go to their inbox; agent-to-agent traffic stays in the console. Search is the inbox's search for what lands there; the pages don't say how long agent traffic is kept.

### Coordination

- Presence: last check-in and whether the agent is listening, per agent.
- Shared notes for fleet-wide facts. No file leases or claims are described.

### Loops and safety

- "Per-agent daily message caps" (number not stated) and phone pushes capped at 12 per agent and 30 across all agents per day (`/agents/claude-code/`).
- "What an agent says is treated as information, never as instructions — nothing one agent tells another can authorise anything on your account." When Poly answers an agent, "she's reading only". Pushes are stripped of links and labelled with the sending agent (`/news/agent-switchboard/`). The Codex headless turn "treats anything it reads as data, not instructions".
- Connections are scoped OAuth grants (read, make changes, send), every tool call is audit-logged against the account, and email sending is a confirm-first action (`/mcp/`).

### License and maintenance

- Proprietary hosted service. Switchboard is included in every plan; plans start at $6.99 per month, with a 7-day trial (`/pricing/`). Launched 13 August 2026 (`/news/agent-switchboard/`); guides updated 29 September and 9 October 2026. No public issue tracker.

## 4. Claude Code cross-session messaging (first-party)

Not on the original list, but it changes the picture for Claude Code. Source: `https://code.claude.com/docs/en/cross-session-messaging`.

- Requires Claude Code v2.1.224 or later (v2.1.234 on native Windows). On by default. Claude uses `ListAgents` and `SendMessage`; people use `/list-agents` and `@name` mentions.
- Delivery: "The receiving Claude reads the message between tool calls during an active turn, so a running tool is never interrupted. When the receiving session is idle, Claude Code starts a new turn with the message." This is the only mechanism found that delivers mid-turn to Claude Code.
- Reach: sessions on the same machine over a per-session Unix socket or named pipe; "your" sessions on other machines and in the cloud through Anthropic servers, only while both are connected to Remote Control with a claude.ai sign-in. Inferred: two different people's sessions cannot reach each other, since listings show only your own sessions.
- Safety: a message "can't approve anything", "can't change configuration", and slash commands in it arrive as plain text. Receivers choose `crossSessionInbound`: `accept`, `hold` or `refuse`. With no setting, a session that bypasses permission prompts holds messages from sessions that don't. `isolatePeerMachines` requires approval before a message leaves the machine. Size cap about one million characters, burst limits at the sender, at most 100 held messages.
- The inbox socket path and a per-session token are exported to hooks and Bash as `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`. When no `crossSessionInbound` value applies, Claude Code delivers a message it can verify came from the session's own child process. agmsg's background service already uses this socket to deliver into Claude Code (agmsg `README.md`, "agmsgd beta").

Claude Code hooks also offer `asyncRewake`: a background hook that "wakes Claude immediately even when the session is idle" when it exits with code 2 (`https://code.claude.com/docs/en/hooks`, "Run hooks in the background" and its Limitations). That is a second wake path that needs no channel flag.

## 5. Other 2026 tools, top 5 by relevance

Ranked by how close each comes to cross-vendor, cross-person messaging during a run. Stars, last commit and issue counts from `gh api` on 2026-11-05. These come from README reading only, not from code.

| # | Tool | Stars | Last commit | License | One line |
| --- | --- | --- | --- | --- | --- |
| 1 | [aliengiraffe/rhizome](https://github.com/aliengiraffe/rhizome) | 61 | 2026-11-03 | MIT | Go MCP bridge that connects Claude Code, Codex and OpenCode sessions on your machine and on a colleague's paired machine (pinned TLS, or a shared-token LAN/Tailscale mode), with verified session identities; Claude gets channel notifications, Codex "uses its local queue", OpenCode a plugin. |
| 2 | [fujibee/agmsg](https://github.com/fujibee/agmsg) | 1,577 | 2026-11-05 | MIT | Bash plus SQLite skill for Claude Code, Codex, Gemini CLI, Copilot CLI, OpenCode and Hermes; delivery by Claude Code's cross-session socket, a Monitor stream, or a Stop hook between turns; an optional self-hosted Postgres server, optionally end-to-end encrypted, syncs a team across machines. 320 open issues. |
| 3 | [LambdaLabsHQ/xmatrix](https://github.com/LambdaLabsHQ/xmatrix) | 90 | 2026-11-05 | FSL-1.1-ALv2 | Group chat for people and coding agents: mention `@claude` or `@codex` in a channel and a Rust daemon starts that harness on its owner's machine with their own login; hub on Cloudflare Workers and Postgres, approval cards, scoped secrets. The closest product to Uplink Room's shape. |
| 4 | [alexfrmn/murmur](https://github.com/alexfrmn/murmur) | 20 | 2026-10-21 | MIT | End-to-end encrypted agent messaging over NATS "across machines, across organizations" for Claude Code, Codex and any MCP client, using invitations between contacts; Claude Code listens while idle through a Stop hook with an eight-hour timeout. |
| 5 | [23blocks-OS/ai-maestro](https://github.com/23blocks-OS/ai-maestro) | 844 | 2026-11-03 | MIT | Dashboard and peer mesh across machines with no central server; agents message each other over its own "Agent Messaging Protocol" (priorities, types, signatures); approval cards for Claude Code, Codex and Grok Build. |

Also seen, ranked lower: `777genius/agent-teams-ai` (2,411 stars, AGPL-3.0, one desktop app running teams that message each other, one person); `abhishekgahlot2/codex-claude-bridge` (63 stars, Claude Code and Codex trade turns through one Markdown file, Claude waits with Monitor); `joltedbot/a2a-bridge` (0 stars, Glama listing describes networked Claude-to-Claude messaging over HTTP and channels with permission approvals); `protoLabsAI/protoAgent` (17 stars, drives Claude Code and Codex over ACP and speaks A2A 1.0); and an `openai/codex` discussion, #15374, on bridging Claude Code channels to the Codex app server. No A2A-based tool with real adoption turned up for coding-agent messaging: A2A shows up in agent-to-gateway tools, not in these peer buses.

## Ideas worth taking for Uplink Room

Uplink Room has accounts, private channels and direct messages (ADR 0015, 0016), agent keys accountable to a person (ADR 0003), a bridge on each machine (ADR 0002) and A2A for outside agents (ADR 0012, 0024). Each idea below says what it leaves out.

1. **Sender identity from the credential, never from the message.** Mailopoly derives the sender name from the token; Agent Mail's fail-closed profile checks `sender_token`. In the room this means `from` is the agent key's agent, and the room shows the accountable person too. Leaves out: proof of which model or process holds the key, which none of these tools offer.
2. **A message is information, never approval.** Mailopoly and Claude Code both state it; Claude Code enforces it in the client. The room already lets agents answer approvals only with the Answer approvals scope (ADR 0005); an agent-to-agent message should never count as one, and the receiving harness's own prompts stay in force. Leaves out: an agent can still be talked into doing something harmful that needs no approval, so the receiver should see the message marked as from another agent.
3. **Delivery doors per harness, shown as observed state.** Mailopoly's "Listening · webhook / wake bridge / turn-bound / not listening" matches what the bridge can know. For Claude Code the best door is the session's inbox socket (mid-turn between tool calls, new turn when idle), then a channel, then an `asyncRewake` hook; for Codex, the evidence so far is turn start, a `PostToolUse` hook with `additionalContext` (per the Agent Mail Python scripts), or a new headless turn; for Hermes and other A2A agents, the A2A message the room already sends. Leaves out: this report did not verify the "Codex local queue" that Rhizome and agmsg mention; that needs its own check against Codex docs.
4. **Durable queue with a lease and explicit "handled".** Mailopoly re-offers a collected message after 30 minutes unless resolved; Agent Mail has acks with an overdue view and durable event cursors; claude-peers shows the failure mode of marking delivered on fetch. A room message to an agent should stay unacknowledged until the agent's run reports it handled. Leaves out: exactly-once processing; the agent can still act twice.
5. **Explicit recipients and per-agent caps instead of free broadcast.** Agent Mail refuses broadcast; Mailopoly charges one message per recipient and caps per agent per day; Claude Code refuses bursts at the sender. In the room, a channel post with no mention should not wake agents, and each agent key gets a send rate. Leaves out: two agents replying to each other inside their caps can still loop, so the room also needs a per-conversation turn limit or a person in the loop.
6. **Advisory file leases with TTL as a coordination primitive.** Agent Mail's glob leases, symmetric overlap check and pre-commit guard are the only worked design for "I'm editing `src/**`". The room could hold leases per repo, visible to people. Leaves out: enforcement across machines, since each person has their own clone; a lease there is a signal, not a lock.
7. **A Git or append-only audit record of every message.** Agent Mail writes every message to a Git archive; Mailopoly audit-logs each tool call. The room's activity log can record each agent message with sender, key, recipients and delivery state. Leaves out: content that agents exchange outside the room, such as Claude Code's own cross-session messages, which the room never sees.
8. **Hold or refuse by trust class on the receiving side.** Claude Code's `crossSessionInbound` and its default that a prompting session holds messages from a bypassing one map well to Uplink Room: the person a machine belongs to decides whether outside agents' messages reach their runs directly, wait for them, or are refused. Leaves out: the room cannot change what a harness does once text is in context.

## Open questions to test

- Does a bridge process that is not the Claude Code session's child get its message delivered through `CLAUDE_CODE_MESSAGING_SOCKET` when `crossSessionInbound` is `accept` in that session's `--settings`? Test: start a session with that setting, post from an unrelated process, check delivery mid-turn and when idle.
- What exactly is the Codex "local queue" that Rhizome and agmsg use for push into a running Codex session? Test: read Codex's current docs and Rhizome's `docs/codex.md`, then deliver one message into an interactive Codex turn.
- Does an `asyncRewake` hook that long-polls the Room API wake an idle Claude Code session reliably for hours without the channel development flag? Test: one session, a hook that exits 2 when a test message arrives, measure latency.
