# Research agentic coding tools and multiplayer

Research agent report from 2026-10-30. The brief it was given is at the end.

Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)
agentId: aa2e8ea2d07abb5de (internal ID - do not mention to user. Use SendMessage with to: 'aa2e8ea2d07abb5de', summary: '<5-10 word recap>' to continue this agent.)
The agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.
Do not duplicate this agent's work — avoid working with the same files or topics it is using.
output_file: /private/tmp/claude-501/-Users-judiazm--t3-scratch-2026-10-30-what-do-we-need-to-d0f27124/e51cb0a9-e76e-4efa-bb62-dcbc132ad75c/tasks/aa2e8ea2d07abb5de.output
Do NOT Read or tail this file via the shell tool — it is the full subagent JSONL transcript and reading it will overflow your context. If the user asks for progress, say the agent is still running; you'll get a completion notification.

## Brief

You are doing web research for a product concept. Today is 2026-10-30. Your training data is older than today, so treat everything you remember as a hypothesis and verify it on current primary sources (official docs, GitHub repos, changelogs, official blogs). Use the Firecrawl tools (mcp__firecrawl__firecrawl_search, mcp__firecrawl__firecrawl_scrape) or WebSearch/WebFetch. Search each product by the exact name given. Do not write any files; just return your findings.

Context: a small team (Miami + Guayaquil, Ecuador) is designing an internal "Discord for the agentic era": channels, voice/video (LiveKit), shared browsers, HTML apps in messages, AI agents as members, backend on Convex Cloud, Electron desktop client. They now want coding agents and terminals inside the workspace, and several people looking at and steering the same agent thread at the same time.

Research these questions:
1. T3 Code: what it is, who makes it, license, whether it is open source, how it drives Claude Code and Codex (protocols/SDKs it uses), whether its parts could be embedded or reused in another app. Check its GitHub repo.
2. Claude Code today: Claude Agent SDK (TypeScript/Python), headless/streaming JSON mode, Claude Code on the web / remote sessions, session sharing or "teleport", hooks. What would it take to run Claude Code sessions on a server and stream them to several viewers?
3. OpenAI Codex today: Codex CLI, the Codex app-server (JSON-RPC protocol used by IDE extensions), Codex SDK, Codex cloud tasks. Same question: how to host sessions and stream them to a UI.
4. Other agent harnesses with a client/server split or shareable sessions: OpenCode (server mode, share links), Amp (thread sharing), Cursor background agents / Cursor in Slack, Zed's Agent Client Protocol (ACP) and which agents implement it, Factory, Devin. Note which ones let multiple humans watch or steer one live agent session.
5. Shared/collaborative terminals that could be embedded in an Electron/web app: xterm.js, sshx, tmate, ttyd, Warp session sharing, VS Code Live Share terminals. License, how sharing works (WebSocket? E2E encryption?), whether a web viewer exists.

Return at most 900 words, organized by the five questions. For every factual claim include the source URL. Mark each claim as "primary" (official docs/repo/blog you opened) or "secondary" (search snippet, third-party article). Include version numbers and dates when you find them. End with a short list of the 5 most useful building blocks for this product and why, and anything you could not verify.
