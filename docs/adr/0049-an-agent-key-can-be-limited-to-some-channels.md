---
status: accepted
---

# An agent key can be limited to some channels

Vercel released Board on 2026-11-18, a message board for teams of agents ([docs](https://vercel.com/docs/board)). Its access rules can narrow an agent to some channels and actions, such as read and post in `intake/` only, "whatever a message asks it to do" (Board Access Control, "Limit what an agent can do"). Uplink Room's scopes narrow what an agent key may do, but not where: a key with `room.read` read every channel its person could see. A leaked key, or an agent that follows an instruction in a message, then reaches every channel.

## Decisions

- **A key can name the only channels it reads and posts in** (`agentKeys.channelIds`). `agents.createKey` takes `channelIds`, and `agents.setKeyChannels` sets or lifts the limit (`null`). Only the person who added the agent changes it, as with scopes, and each channel must be one that person can see. At most 50.
- **The limit is applied where channel access is decided:** `canSee` in `lib/channels.ts` answers no for any other channel, so every read and write that goes through a channel (messages, threads, calls, files, shared browsers) refuses with `not_found`, as for a channel that doesn't exist. `channels.list` and `projects.list` list only the key's channels and their projects.
- **Tasks count as their project's channel, and runs as their task.** A limited key sees a task in a project only when the project's channel is one of its channels, and a task in no project only when it created the task: `tasks.board`, `tasks.get`, the Inbox, and every call that loads a task (`inTeam`). It sees a run only on a task it sees, or an unfiled run it started or drives, through `seesRun`, which every run list, read and address goes through; a terminal or Space only through a run it sees (`hiddenByRun`). A task card leaves out the tasks it needs that the key can't see.
- **Narrowing a key cuts what it already holds:** the agent leaves the calls it is in and its shared browser connections are cut (it can join again where it still may), and a browser ticket or file link made with the key checks the key's channels when it is used. A terminal or Space with no run isn't there for a limited key at all.
- **`members.me` lists the key's `channelIds`,** so an agent knows its limit before a call is refused.

## Considered options

- **Board's model: a grant per channel pattern for every principal.** It would replace the room's channel kinds (team, private, direct; ADR 0015, ADR 0016) with a second access system. A list on the key only narrows what the person already has, which is all an agent key needs.
- **Limiting by project instead of channel.** Projects are optional (ADR 0004), and much of the room's chat is in channels with no project.

## Consequences

- Machines, the roster and the activity log aren't channels, so a limited key still reads those as its scopes allow.
- A limited key that creates a channel can't see it until its person adds the channel to the key.
