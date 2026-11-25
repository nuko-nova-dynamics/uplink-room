---
status: accepted
---

# Direct messages are channels only their members can see, and one helper decides channel access

Until now every channel was open to the whole team. A direct message is the first place where a team member can be refused a channel. Spec #63 decided it for the team to leave Discord, on 2026-11-03.

A direct message is a channel (`kind: "direct"`) with a fixed set of 2 to 10 members, people or agents, kept in `channelMembers`. It has no name and no project. Opening one with the same members as an existing one opens that one (`memberKey`, the sorted member ids). Everything a channel has works in it: messages, replies, reactions, attachments, pins, calls and shared browsers. An A2A agent in a direct message gets each message as a run, as a mention does (ADR 0012).

Whether a member may see a channel is decided in one place, `convex/lib/channels.ts`: a team channel is open to the team, and a direct message only to its members. Every Room API function that takes a channel, a message, a call, an attachment, a shared browser or saved logins reaches it through that helper, directly or through `inTeam`. Someone who can't see a direct message gets `not_found`, the same answer as for one that doesn't exist, so even its existence isn't given away. Private team channels and channel permissions (#64) are a change to that helper.

We chose a kind of channel over a separate conversation table, so calls, browsers, pins and everything later built on channels work in direct messages with no second path, and so there is exactly one access check to get right.

## Consequences

- An agent's key reads and posts only in the direct messages its agent is in. The person accountable for an agent doesn't see the agent's direct messages unless they are in them too.
- Removing a member from the team removes them from every direct message. A direct message keeps its other members and its key, so opening one with the remaining members later starts a new one.
- A run sent from a direct message is still a team run: it shows in the Inbox, the roster and `runs.list`. Its title says only "Direct message from Ana", and for anyone outside the direct message the run's texts (what was sent, the agent's question and answer, its artifacts and failure reason) are left out (`private: true`).
- Search (`messages.search`) runs on a Convex search index, which filters only by equality, so it drops results from direct messages the caller isn't in after the search, through the same helper, and reads further until a page is full. It looks through the 1,000 best matches at most (Convex scans at most 1,024 per search query).
- Messages addressed to a member (a direct message, a mention, @everyone, a reply to their message, or any message in a channel they set to all) now get a desktop banner and a sound, following the Banners and Sounds settings. DESIGN.md's Notifications section changes with this: a message is addressed to you, so it interrupts like what needs you, but it never borrows amber.
- Unread counts stay cheap: each message gets the next `seq` in its channel, and the channel keeps its last one, so `channels.list` reads one channel row and one read row per channel, whatever the channel's size, inside Convex's per-function limits (32,000 documents scanned, 16 MiB read).
- Attachments use the upload flow of project files (spec #9). Images and PDFs show in the app; any other file is served only by `GET /attachments/<token>/<name>` with `Content-Disposition: attachment`, `nosniff` and a CSP that runs nothing. As with project files, anyone holding an attachment's link can download it; the token is random and only members who can see the message get it, and deleting the message makes the link stop working.
- Link previews fetch pages any member chooses, so the backend fetches them under strict rules (`convex/lib/linkPreview.ts`): http or https on ports 80 and 443 only, never this deployment or a private, loopback, link-local, metadata or reserved address (checked before each request, after every redirect, at most 3, and by the socket as it connects, through ADR 0012's `guardedFetch`), at most 1 MB of HTML in 5 seconds, only Open Graph, Twitter card and `<title>` tags read as plain text, and the image (at most 5 MB, PNG, JPEG, GIF or WebP by its bytes, never SVG) copied into Convex storage. The app never fetches a linked page; it loads the image from Convex. An admin can turn previews off for the team.
