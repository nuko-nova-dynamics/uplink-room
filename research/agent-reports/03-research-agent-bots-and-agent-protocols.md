# Research agent bots and agent protocols

Research agent report from 2026-10-30. The brief it was given is at the end.

Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)
agentId: a6f1e7fff71ee9249 (internal ID - do not mention to user. Use SendMessage with to: 'a6f1e7fff71ee9249', summary: '<5-10 word recap>' to continue this agent.)
The agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.
Do not duplicate this agent's work — avoid working with the same files or topics it is using.
output_file: /private/tmp/claude-501/-Users-judiazm--t3-scratch-2026-10-30-what-do-we-need-to-d0f27124/e51cb0a9-e76e-4efa-bb62-dcbc132ad75c/tasks/a6f1e7fff71ee9249.output
Do NOT Read or tail this file via the shell tool — it is the full subagent JSONL transcript and reading it will overflow your context. If the user asks for progress, say the agent is still running; you'll get a completion notification.

## Brief

You are doing web research for a product concept. Today is 2026-10-30. Your training data is older than today, so treat everything you remember as a hypothesis and verify it on current primary sources (official docs, GitHub repos, official blogs, spec sites). Use the Firecrawl tools (mcp__firecrawl__firecrawl_search, mcp__firecrawl__firecrawl_scrape) or WebSearch/WebFetch. Search each name exactly as given plus likely spellings. Do not write any files; just return your findings.

Context: a small team is designing an internal "Discord for the agentic era" (Electron app, Convex Cloud backend). Agents should be members of the workspace like people: they join channels, get @mentioned, post messages and interactive HTML, use tools. The founder wants third-party and open-source agents to plug in, and named these (spelling from voice dictation, so resolve them): "Ermess agents" (probably Hermes Agent from Nous Research), "Claude bot" (probably Clawdbot, the open-source personal assistant later renamed Moltbot / OpenClaw), "Grogbot" (probably something Grok/xAI related, find what fits).

Research these questions:
1. Clawdbot / Moltbot / OpenClaw: what it is now, current name, license, architecture (gateway, which chat apps it connects to, skills), how it would connect to a custom chat app, and any security incidents or warnings.
2. Hermes Agent (Nous Research): what it is, license, capabilities, how it connects to chat platforms.
3. The Grok/xAI candidate: what "Grokbot" or a Grok agent for teams could mean today (xAI API agent tools, Grok in X/Telegram, any Grok agent framework). Say clearly what you found and how confident you are.
4. How established tools host agents as teammates: Linear's agent platform (agent sessions / Agent Interaction guidelines), Slack's AI apps and agent APIs, Claude in Slack, Codex or Cursor in Slack/Linear, GitHub's Agent HQ or Copilot coding agent assignment. What patterns do they share (identity, permissions, activity/status updates, handoff to humans)?
5. Interop protocols an agent-friendly chat app should support: MCP (latest spec version and date, MCP Apps extension), A2A (Agent2Agent, governance and current version), Zed's Agent Client Protocol (ACP), AG-UI. One or two lines each on what it is for and whether it matters here.

Return at most 900 words, organized by the five questions. For every factual claim include the source URL and mark it "primary" (opened official page) or "secondary" (snippet/third party). End with a short recommendation: which protocols to support first so any agent (Claude, Codex, OpenClaw, Hermes, Grok) can join a channel, and list what you could not verify.
