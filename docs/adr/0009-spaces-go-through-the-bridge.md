---
status: accepted
---

# A Space's screen reaches the room only through the bridge on its machine

The bridge on a Space's machine holds the Space's `cua-spacesd` token. It mints each viewer's Cua viewer ticket itself, at that person's access: view-only for everyone except the driver. Each viewer reaches the Space only through the bridge's Space gateway, which can cut that person's connection at once. Agents drive a Space through the Room API, and the bridge runs their actions. We chose this over sharing Spaces through Cua's relay with Cua's viewer and editor roles. That route needs a cua.ai account and a Teams seat ($30 a month) for every viewer, and Cua, not the room, would decide who may type. Our way, the same access levels, driver and wheel rules as terminals (ADR 0002) apply, and no Cua account or plan is needed.

## Consequences

- A teammate sees a Space only when their computer can reach its machine: on the same network or over Tailscale. Reaching it from anywhere else (a self-hosted `cua-relay`, or LiveKit) is a later decision.
- Cua has no call that revokes a single viewer ticket, and an attached video socket outlives its ticket. So the gateway is what enforces the wheel: when the driver changes, the bridge closes the old driver's connections and that person reopens the Space as a viewer.
- A viewer ticket passes through the room to reach its viewer. It lasts 5 minutes, works only for that person's view, and only the viewer can read it from the Room API.
- We load the viewer page each `cua-spacesd` serves and call `cua-spacesd` through Cua's MIT CLI, and copy no FSL-1.1-MIT code. If Uplink Room is ever sold with shared desktops built in, Cua's licence needs another look (`research/cua-spaces.md`, Licence).
- An agent on the Space's own machine can still drive the Space with Cua's own MCP server, around the room, just as a person at that machine can use its keyboard. The bridge can't stop that; the person the machine belongs to decides who runs agents there.
