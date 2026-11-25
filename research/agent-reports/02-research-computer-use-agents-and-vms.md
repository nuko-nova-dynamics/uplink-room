# Research computer-use agents and VMs

Research agent report from 2026-10-30. The brief it was given is at the end.

Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)
agentId: ac79e7119afedd4cc (internal ID - do not mention to user. Use SendMessage with to: 'ac79e7119afedd4cc', summary: '<5-10 word recap>' to continue this agent.)
The agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.
Do not duplicate this agent's work — avoid working with the same files or topics it is using.
output_file: /private/tmp/claude-501/-Users-judiazm--t3-scratch-2026-10-30-what-do-we-need-to-d0f27124/e51cb0a9-e76e-4efa-bb62-dcbc132ad75c/tasks/ac79e7119afedd4cc.output
Do NOT Read or tail this file via the shell tool — it is the full subagent JSONL transcript and reading it will overflow your context. If the user asks for progress, say the agent is still running; you'll get a completion notification.

## Brief

You are doing web research for a product concept. Today is 2026-10-30. Your training data is older than today, so treat everything you remember as a hypothesis and verify it on current primary sources (official docs, pricing pages, GitHub repos, changelogs). Use the Firecrawl tools (mcp__firecrawl__firecrawl_search, mcp__firecrawl__firecrawl_scrape) or WebSearch/WebFetch. Do not write any files; just return your findings.

Context: a small team (Miami + Guayaquil, Ecuador) is designing an internal "Discord for the agentic era" (Electron desktop app, Convex Cloud backend, LiveKit for calls, Hyperbeam for shared browsers). They want AI agents to have their own computers (cloud VMs with a full desktop) that agents operate with computer use, while humans in a channel watch live and can take over the mouse and keyboard. Infrastructure should run on demand (not always on) and near US East.

Research these questions:
1. Computer-use models today: Anthropic's computer use tool (current tool version, which Claude models support it), OpenAI's computer-use model / CUA and how it is offered now (Responses API, ChatGPT agent, Codex computer use), Google Gemini computer use. Current OSWorld or OSWorld-Verified top scores and the human baseline, to judge maturity. Cite dates.
2. "Cua" (trycua, github.com/trycua/cua): what it is, license, which OSes it can run (macOS, Linux, Windows VMs), its cloud offering and pricing, its agent SDK, how humans view the desktop. The user called it "research CUA", so also check if there is a research project by that name.
3. Cloud desktop/sandbox providers that give an agent a full desktop: E2B Desktop Sandbox, Daytona, Modal Sandboxes, Vercel Sandbox, Morph Cloud (snapshots/branching), Scrapybara, Orgo, Kernel, Steel, Browserbase, any newer ones. For each: OS (Linux/Windows/macOS), whether they stream the desktop to a human (VNC, noVNC, WebRTC) and allow takeover, snapshot/fork/pause support, per-hour or per-second price, US East region.
4. Can a human and an agent share control of the same VM safely? Any products that already do "agent drives, human watches and takes over" in a team setting.

Return at most 900 words, organized by the four questions, plus a compact comparison table for question 3 (provider, OS, live view, takeover, snapshot, price, region). For every factual claim include the source URL and mark it "primary" (opened official page) or "secondary" (snippet/third party). End with your recommendation for (a) Linux desktops and (b) macOS/Windows desktops for this team, and list what you could not verify.
