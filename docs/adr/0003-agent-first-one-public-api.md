---
status: accepted
---

# Uplink Room is agent-first: one public API

Every action a person can take in Uplink Room is a function in one public API, the Room API. It's offered as an MCP server, over HTTP, and through a command-line tool, and the desktop app uses the same functions, so no action is app-only. Agents act through agent keys. Each key carries the agent's role and can be narrowed with scopes. Every agent is added by a person, who is accountable for it, and an agent can do at most what that person can. Agents can be admins, including over team machine settings. We chose this over building the app first and adding a bot API later, as Discord does, because agents are team members, not add-ons.

## Consequences

- Every function is a versioned public contract from day one.
- An admin agent's key is as powerful as an admin, including the power to open a team machine's terminals. Scopes, the record of who did what, and revoking keys are the safeguards. The bridge still enforces each machine's limits locally (ADR 0002).
