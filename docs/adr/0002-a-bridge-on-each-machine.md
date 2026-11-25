---
status: accepted
---

# Uplink Room ships a bridge on each machine

Some teammates work in plain terminals, tmux, cmux, herdr or Rex, not T3 Code. So Uplink Room ships a bridge on each machine. It shares that machine's terminals with the room and drives the tools through their own CLIs and hooks. The bridge never runs an agent itself, so ADR 0001 still holds. We chose this over requiring T3 Code everywhere and using its terminals.

## Consequences

- We now own software that holds a shell on people's machines, so its security is ours. Access levels, slots and profiles (see `GLOSSARY.md`) exist to keep the person a machine belongs to in control.
- Any terminal can be shared as plain screen output from day one. Knowing that a run is waiting needs an adapter per tool: herdr (`hc events`), tmux control mode, cmux's socket, the Rex CLI, T3 Code's MCP server, or Claude Code's hooks.
- Open experiments: whether the bridge can reuse herdr, sshx or T3 Code's terminal code instead of writing terminal sharing from scratch, and whether each harness can keep a profile's logins apart from the machine setup on one machine.
