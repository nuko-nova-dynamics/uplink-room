# Research notes

Compiled on 2026-11-01 from the planning session and the research agents' reports (`agent-reports/`). The sources listed were the ones read during the session. Prices, versions and betas change quickly, so check them again before relying on them.

## What we build and what we connect to

Uplink Room is the team layer: people and roles, channels and calls, projects and runs, a waiting-on-you inbox, and one view of every agent. We don't build our own agent harness. Agents come in through the tools that already run them.

| Layer | What it is | Ours? |
|---|---|---|
| Uplink Room | People, channels, calls, projects, tasks and runs, inbox, and a bridge on each machine | Build it |
| Control planes | T3 Code (threads, terminals, worktrees, browser tabs), terminal tools (herdr, tmux, cmux, Rex), Cua Spaces (shared desktops), agent gateways (OpenClaw, Hermes) | Connect to them |
| Agents | Claude Code, Codex, Grok Build, Cursor, OpenCode, Antigravity, Hermes Agent, OpenClaw | People bring their own subscriptions |
| Models | Claude, GPT, Grok, Gemini, open models | |

Grok Bot can't join yet. It's a closed app (beta since Aug 11, 2026), and no third-party API was found. Grok's coding agent, Grok Build, joins through T3 Code.

## Stack

- **Desktop:** Electron, chosen over Tauri.
- **Backend and data:** Convex Cloud in US East (N. Virginia). Not self-hosted.
- **Voice, video and screen share:** LiveKit Cloud, with Krisp noise cancellation and the nearest edge. No Scale plan or region pinning needed.
- **Shared browsers:** Hyperbeam, started on demand. Agents use T3 Code's browser tabs instead, which people can watch and take over.
- **Sign-in:** Clerk.
- **Apps in messages:** a separate-origin sandboxed iframe for MCP Apps HTML.
- **Files:** PDF.js, Tiptap, and Excalidraw (MIT) for canvases. Pinned at pdfjs-dist 6.4.299 (Apache-2.0), Tiptap 3.32.0 (MIT editor and extensions only; tiptap.dev lists its Collaboration and Comments as paid), and @excalidraw/excalidraw 0.18.1 (MIT). Spec #9, ADR 0010.

tldraw doesn't publish a price ("value-based pricing"). It has a 100-day trial and a startup discount, and its free hobby license is for non-commercial use with a "made with tldraw" watermark. A Hacker News comment from Sep 2025 reported about $6,000 a year for a 10-person startup; that's a secondary source. Sources: tldraw.dev/pricing, tldraw.dev/community/license.

## Region and latency

Measured round trips from WonderNetwork:

- Quito to Miami: 49 ms
- Quito to New York: 77 ms
- Quito to São Paulo: 127 ms
- Miami to New York: 35 ms

US East serves both Miami and Guayaquil well.

## Monthly cost to start

About $0 to $75 a month for Convex, LiveKit, Hyperbeam and Clerk. T3 Code is $0. Cua Spaces is $0 on the free plan or $30 a seat on Teams. Machines are extra. The itemized table is on the concept page.

## T3 Code

Sources: github.com/pingdotgg/t3code (README, docs/user/remote-access.md, outside-agents.md, faq.md, guest-links.md) and t3.codes.

- MIT licensed. It describes itself as an "agent harness control surface".
- Providers: Codex, Claude, Cursor, Grok Build, OpenCode, Antigravity, and any ACP provider.
- It runs on each person's own subscriptions. The FAQ says this stays within the terms of Claude Code, Codex and Antigravity, and that "A separate work account is fine."
- One server per machine (`t3 serve`, `t3 connect`, `t3 pair`), reachable over Tailscale, SSH or T3 Connect. It can manage Linux and Apple Silicon machines over SSH.
- T3 Connect is free for now: 3 machines per account, 10 with T3 Chat Pro, 100 with Premier.
- MCP server at `https://<env>/mcp`, with OAuth and pairing codes. Access is read only, supervised, or full. Clients can read projects and threads, and start, message and stop threads.
- Guest links (beta): a guest follows one thread live, the owner approves each guest message, and links last 24 hours.
- Linked environments (beta): 30-day links between machines, with access modes.
- It can balance new threads across machines. Agent browser tabs support take-over.

## Cua Spaces

Sources: cua.ai/pricing, cua.ai/docs/spaces.

- License: FSL-1.1-MIT. You can use and change it for anything except a competing product, and each release becomes MIT two years after it ships. Cua Driver and Lume are MIT.
- Cua doesn't rent computers. You bring a Mac, an office PC, or VMs in AWS, GCP or Modal. Cua Cloud and Fleets ended on 18 Oct 2026.
- Viewer and editor roles. Each person and each agent gets its own cursor. Teleport moves a signed-in app session into a Space.
- Claude Code, Codex and Cursor can drive it.
- Pricing:
  - Free: 2 live sessions and 20 remote hours a month through the relay. Use on the local network doesn't count.
  - Pro: $18 a month or $180 a year, with 5 sessions and 200 hours.
  - Teams: $30 a seat a month or $300 a seat a year.
- The license only matters if Uplink Room is ever sold with shared desktops built in.
- Sharing through Cua (viewer and editor) needs Teams and a cua.ai account for every viewer, and only relay use counts toward the plan. A Space reached directly, on the same network or over Tailscale, needs no account. Details: [cua-spaces.md](cua-spaces.md).

## Protocols

- **MCP:** spec version 2026-07-28. MCP Apps put `ui://` HTML in sandboxed iframes.
- **A2A 1.0:** OpenClaw serves it at `/a2a/v1`, with a bearer token per peer. Hermes speaks it too.
- **ACP:** stdio only today.

## Cloud computers for agents

- **Daytona:** $0.0504 per vCPU-hour and $0.0162 per GiB-hour, about $0.17 an hour for 2 vCPU and 4 GB. Windows costs $0.0858 per vCPU-hour. New accounts get $200 of free compute.
- **E2B:** Hobby is free with $100 of credits; Pro is $150 a month.
- **OSWorld 2.0:** 108 long tasks. The best score on the 2026-10-15 leaderboard was 44.33%, by Claude Opus 5.

More options (Kernel, Steel, Orgo, Morph, Modal, Vercel Sandbox and others) are in `agent-reports/02-research-computer-use-agents-and-vms.md` and `sources/computers-and-browsers/`.

## Competitors

- **Slack** (Dreamforce 2026): code channels and Surfaces.
- **Claude Tag** (Jun 23, 2026): Slack only, one Claude per channel.
- **Grok Bot** (Aug 11, 2026): beta, a closed app with its own cloud computer and group chats.
- **Amp:** multiplayer threads, plus a Space with voice, video and screen share.
- **Buzz** (Block): open-source developer preview.
- **Ando:** raised $20M, according to TechCrunch via a third party.
- **Vercel Board** (2026-11-18, experimental, free for now): a headless message board for agents on a Vercel team, used from `vercel board` and `@vercel/board`: channels, threads, labels, a task queue with claims, leases and dependencies, two-way sync with Slack, GitHub and Linear, and watchers that wake a deployment. It carries messages about the work, not the work: no terminals, threads, approvals or calls. ADRs 0049 to 0051 took its channel limits on agent keys, its waiting and queued tasks, and its pull request state; the room also took idempotency keys, `runs.changes` and reminders. Sources: vercel.com/blog/introducing-vercel-board, vercel.com/docs/board.

Each of these pushes one company's agent or one company's chat. Uplink Room sits a layer above them.

## Board ideas (projects)

- Each task's runs go through T3 Code threads, terminals, Spaces or agent conversations.
- Status comes from the runs' state, so nobody drags cards.
- Every task has an owner (a person); every run has a driver (a person or an agent).
- One task can have runs by several agents, side by side.
- A waiting-on-you inbox, routed to each run's driver.
- Triage by talking: turn a call into cards.

## Open experiments

1. **Live thread view (answered, #12):** reuse selected MIT timeline/client code behind the bridge. The full web client has no documented single-thread embed; cross-site cookies complicate iframes. Guest links stream one thread but expire after 24 hours and cannot answer approvals. See [findings and verification limits](t3code-waiting-and-thread-view.md#12-embed-or-reuse). Re-checked on 2026-11-04: the bridge's existing scopes already allow a live thread view and follow-up messages (verified live), so the next build is a thread view and message box through the bridge. See [T3 Code capabilities and the integration plan](t3code-capabilities.md#plan).
2. **Waiting state (answered, #13):** MCP read exposes pending requests and question answers, but list status can remain running during input requests. Approval answers and live subscriptions need the client protocol, which the bridge now uses to launch, follow, stop and answer approvals; approvals were verified live on 2026-11-04. See [findings and scratch-probe evidence](t3code-waiting-and-thread-view.md#13-what-each-interface-exposes) and [the re-check](t3code-capabilities.md#comparison-with-our-integration).
3. **Shared subscriptions (source review answered, #11; product decision pending):** Anthropic, OpenAI and xAI prohibit making personal accounts available to teammates; a shared work login is not a substitute for named seats. Subscription proxies do not override upstream terms. Cursor's current AUP and older staff guidance need clarification. Antigravity's consumer terms/FAQ restrict third-party access and CLI wrapping, independently of teammate sharing. OpenCode's local software license is separate from each model entitlement. Recommend each person's own login or assigned seat, entitlement checks when passing the wheel, and warnings/caps only as supporting controls. Use authorized team API billing for a deliberately shared service, subject to provider/product restrictions. See [the terms, exact quotes, effective-date qualifications and options](harness-terms.md). Profiles remain subject to #18's caveats; a person still decides the product policy.
4. **Spaces (answered, #6):** a Space can be shown inside our app. Every `cua-spacesd` serves an HTML5 viewer at `/viewer/` that takes a scoped viewer ticket and works behind a gateway path, so the bridge on the Space's machine mints a ticket per person (view-only except for the driver) and serves the page through its Space gateway, with no Cua account (ADR 0009). Verified live against a local Linux Space with `cua` 0.10.0. Daytona is possible but unproven: Cua's MIT `cua-contrib` has a Daytona provider (Linux containers on amd64, `cua` built with `--features contrib`) and Cua lists its desktop as "not measured". See [the findings](cua-spaces.md).
5. **Bridge reuse (answered, #14):** keep the bridge's own node-pty base, in TypeScript. herdr (Apache-2.0) stays an adapter: building on it adds a second daemon per machine, its public API gives text snapshots rather than a raw stream, and slots, drivers and profiles would still be the bridge's. sshx (MIT) is ruled out: its server decides who types, anyone with the write link can type, and self-hosting isn't supported. From T3 Code (MIT), port its replay clean-up, not its terminal module, which also runs on node-pty. Two Windows node-pty kill problems came out of this: killing a recycled pid 5 seconds later (#34, patched by PR #41) and the shell's children surviving a stop (#43). See [the findings and experiments](bridge-terminal-base.md).
6. **Profiles (answered, #18):** Claude Code (`CLAUDE_CONFIG_DIR`) and OpenCode (XDG folders, plus `XDG_STATE_HOME` and external skills off) keep a profile's login apart, with caveats. Codex keeps the login apart but still imports machine skills, Grok Build still sees machine skills, plugins and MCP servers, and Cursor's macOS login lives in the Keychain whatever the folder, so those three offer only the machine setup for now. Antigravity isn't installed here. See [the findings](profile-logins.md).
7. **Live co-typing in docs (#9):** can `@convex-dev/prosemirror-sync` (0.2.7, Apache-2.0, peer `@tiptap/core` ^3.10.7) carry live typing in a doc while agents keep reading and writing Markdown? It stores ProseMirror steps and snapshots and can change a doc on the server with `transform`; the test is whether `@tiptap/markdown` can turn an agent's Markdown into a transform there, inside Convex's runtime, and whether convex-test can run the component. Until then, docs save whole with a version check (ADR 0010).

## Risks

- Young dependencies (T3 Code, Cua Spaces and A2A are all new).
- Cua's license if Uplink Room is ever sold.
- Security: agents with terminals on shared machines, and a bridge that holds a shell on people's machines.
- Slack and Buzz moving into the same space.
