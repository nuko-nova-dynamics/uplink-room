# Research agent-native projects, files, collab

Research agent report from 2026-10-30. The brief it was given is at the end.

Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)
agentId: a2e217980fd5ca1ec (internal ID - do not mention to user. Use SendMessage with to: 'a2e217980fd5ca1ec', summary: '<5-10 word recap>' to continue this agent.)
The agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.
Do not duplicate this agent's work — avoid working with the same files or topics it is using.
output_file: /private/tmp/claude-501/-Users-judiazm--t3-scratch-2026-10-30-what-do-we-need-to-d0f27124/e51cb0a9-e76e-4efa-bb62-dcbc132ad75c/tasks/a2e217980fd5ca1ec.output
Do NOT Read or tail this file via the shell tool — it is the full subagent JSONL transcript and reading it will overflow your context. If the user asks for progress, say the agent is still running; you'll get a completion notification.

## Brief

You are doing web research for a product concept. Today is 2026-10-30. Your training data is older than today, so treat everything you remember as a hypothesis and verify it on current primary sources (official docs, GitHub repos, changelogs, npm). Use the Firecrawl tools (mcp__firecrawl__firecrawl_search, mcp__firecrawl__firecrawl_scrape) or WebSearch/WebFetch. Do not write any files; just return your findings.

Context: a small team is designing an internal "Discord for the agentic era" (Electron app, Convex Cloud backend). Beyond channels they want projects (for example a game-development project) with a work board, but they do NOT want a Linear or Monday clone; they want ideas that only make sense when AI agents do much of the work. They also want files (PDFs, images, docs) viewable and editable together inside the app.

Research these questions:
1. What existing tools do for agents in project management today: Linear (agents, agent sessions, triage), GitHub (Agent HQ / mission control, Copilot coding agent from issues), Notion agents, Monday.com and Asana AI agents/teammates. What is genuinely new in each, versus a chatbot bolted on?
2. Boards built for coding agents: Vibe Kanban, Conductor, Terragon, Sculptor (Imbue), Claude Squad, Crystal, and any newer ones. What do their boards/cards represent (task, worktree, agent run?), and what ideas could be borrowed?
3. Convex building blocks: Convex Agent component, Workflow component, presence component, ProseMirror/Tiptap/BlockNote sync component, file storage limits, and anything else on convex.dev/components that fits (realtime collaboration, rate limiting, crons). Note current package names and whether they are official.
4. Collaborative files and canvases embeddable in an Electron/React app: PDF.js / react-pdf for viewing and annotation, Yjs / Liveblocks / Tiptap collaboration, tldraw (check its current license and pricing for internal use), Excalidraw, and any agent-aware canvas (for example tldraw's agent starter kit or "make real").

Return at most 900 words, organized by the four questions. For every factual claim include the source URL and mark it "primary" (opened official page) or "secondary" (snippet/third party). End with 5 concrete ideas for an agent-native project space that are NOT a kanban clone, each grounded in something you found, and list what you could not verify.
