---
status: accepted
---

# A thread's items reach the room through its bridge, while someone has it open, and the room keeps a bounded window

The thread view shows a T3 Code thread's messages, tool calls, plans, requests and diffs in the room (`research/t3code-capabilities.md`, Plan). The bridge follows a thread over T3 Code's `orchestration.subscribeThread`, on the socket and pairing it already holds (ADR 0021), only while someone in the room has the thread open (`threads.watch`, like a terminal's watchers). It turns T3 Code's turn items into the room's own small item shape (`ThreadItem` in `@uplink-room/protocol`), each cut to a fixed size, and sends them in batches. The room keeps a thread's newest 300 items; older ones come back from the bridge on request and go together 30 minutes after the last page, and a turn's full diff comes on request too, for a day. When the bridge follows a thread again, its first batch replaces what the room kept, older pages included, since turns rolled back meanwhile sent no removals. Amended by ADR 0045: the bridge follows only a thread launched for a room run or picked on its machine; the room's view of any other thread waits, and nothing is read for it, until someone there picks it.

We chose this over storing every thread's whole history in the room, and over following every Working thread whether anyone looks. A long thread runs to thousands of items and megabytes of tool output; Convex documents stop at 1 MiB and a function reads at most 16 MiB. A thread nobody opens costs the bridge and the room nothing, and T3 Code remains where a thread's full history lives. We chose a shape of our own over T3 Code's types because T3 Code's contracts are unpublished and change often; the bridge is the one place that knows them.

## Consequences

- The room shows a thread as it last saw it while its machine is offline, and someone who opens it later first sees the window the room kept, then the thread as T3 Code has it now.
- Attachments show by name and size only. T3 Code's links to a file are bearer credentials, and the bridge never sends one to the room. Copying the files into the room's storage is a later decision.
- A thread run's items are as private as the run: someone who can't see the run's direct message or private channel can't read them (ADR 0015, ADR 0016).
- Older items are asked for by the oldest item the room keeps. The bridge answers first from what it holds, then from T3 Code's history route, naming that item in T3 Code's cursor (whose fields are read in T3 Code's source, `threadHistoryPaging.ts`), and falls back to reading the whole thread once if T3 Code refuses the cursor.
- A room or bridge from before this sends and asks for none of it: the room asks only a bridge that named `thread_view`, and the bridge sends only to a room that named it (ADR 0021).
- Two rules are copied from T3 Code's MIT source with its notice: which turn items show (a rolled-back run's don't) and their order (by ordinal), and how a thread's link escapes its ids. "Open in T3 Code" uses T3 Code's hosted link, `https://app.t3.codes/threads/<environmentId>/<threadId>`, which opens the desktop app, the mobile app or the web.
