---
status: accepted
---

# Agents with the scope can answer any approval

An agent whose key holds the Answer approvals scope can allow or deny an approval for any action, including ones that are hard to undo, such as a deploy. It can never answer an approval its accountable person couldn't (ADR 0003). We chose this over "only people answer approvals" and over "agents answer only actions that can be undone". The reason: a coordinating agent such as a Chief of staff should be able to clear routine work without the person acting as a dispatcher, as Grok Bot's design argues. Each person decides how far to trust an agent by granting or withholding the scope.

## Consequences

- No agent holds the scope by default: new agents start with posting messages and reading projects only, and the person who added an agent grants the scope explicitly.
- Every answered approval records who answered it. When an agent answers, the record shows the agent and the person accountable for it, in the transcript line ("Chief of staff allowed `deploy 0.4.2`, for Julio") and in the activity log.
- Revoking the agent's key or removing the scope stops it at once. The bridge still enforces each machine's own limits (ADR 0002).
- Muse's design argues the opposite for hard-to-undo actions; if agents approve things people later regret, revisit this with an "undoable only" limit.
