---
status: accepted
---

# Calls run on LiveKit, and every participant joins with a token from the Room API

Calls (voice, video and screen share) run on LiveKit: LiveKit Cloud in production, its open-source server in development. Convex keeps who is in which call. People and agents join the same way: `calls.join` in the Room API checks the caller's membership and scopes, then mints a LiveKit token for that one call's room, valid for 10 minutes. Each join is its own participation in the room, and the token's identity names that join (`<member id>.<participation id>`). Agents may publish only a microphone; people may also publish a camera and a screen with its sound. LiveKit's API key and secret stay in the Convex backend's environment.

We chose this over LiveKit's Agents framework for agents in calls. An Agents worker registers with LiveKit using the project's API key and secret, which can mint a token for any room. An agent holding that secret could do more than the person who added it, which ADR 0003 rules out, and revoking its agent key wouldn't stop it. With a token per call, the agent key and its scopes stay the only credential an agent has, as everywhere else in the room.

## Consequences

- Any agent that can run a LiveKit SDK can join a call, whatever its language. Agents that only speak MCP or HTTP still see calls, invites, transcripts and proposed tasks, but can't hear the call.
- Presence comes from the Room API (join, leave, a heartbeat every 20 seconds), per join: leaving or expiring ends one join and never another, so a stale leave can't drop a member who joined again or on another device. LiveKit's webhooks, when configured, make leaving faster. If the app crashes and no webhook arrives, the person stays listed for up to 60 seconds.
- Krisp noise cancellation runs only against LiveKit Cloud, so development calls use WebRTC's own noise suppression.
- Moving off LiveKit later means replacing the token minting and the app's media code; the Room API's call functions and their data stay.
