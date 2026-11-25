---
status: accepted
---

# A T3 Code thread is shared only when someone on its machine picks it

Amends ADR 0021 and ADR 0022 for threads the room didn't launch.

Until now a paired bridge reported every thread of the T3 Code project it watched (`UPLINK_T3_PROJECT`, or the folder it ran in): each thread's title and state went to the room, its approvals and questions reached Needs you, and anyone who opened it in the room read its conversation. Pairing a machine, or choosing a project, shared threads its person never meant to share, including ones made later. A stopgap on 2026-11-06 reported only threads launched from the room and thread ids listed in `UPLINK_T3_THREADS`, which took a restart and an id copied by hand.

## Decisions

**Every thread T3 Code has is private until someone on its machine picks it.** Pairing, choosing a project, or making a thread in T3 Code shares nothing. Threads launched for room runs stay shared, as before: the room made them, and only the room or T3 Code ends them. Subagents and side chats are never shared on their own, and archived or deleted threads aren't offered.

**The list to pick from stays on the machine.** The bridge reads it from its own T3 Code session and answers it only on its local socket (`t3-threads`): the app's main process asks for it for Settings, Machines, on that machine's own entry, and `uplink-bridge t3-threads` prints it. The room never gets the title, state or anything else of a thread nobody picked. The T3 Code session stays in the bridge; the app's renderer gets titles, projects and states only.

**The choice is saved on the machine, for one pairing and one T3 Code environment.** `t3-threads.json`, in the bridge's folder, names the machine, the team and T3 Code's `environmentId` with the picked thread ids. Pairing again deletes it, a bridge running for another pairing deletes it unread, and one picked while T3 Code was another environment shares nothing until someone picks again. A save names the revision of the list it was made from and the environment it saw, so a save from an older list, or across a change of environment, is refused.

**A change takes effect at once, without a restart.** A new share waits until the choice is saved, so the bridge never shares on a choice it would forget. A stop takes effect before the save: if the save fails, the stop holds until the bridge restarts, and the person is told so and can try again.

**Stopping closes every way the room had to the thread, and leaves its work alone.** The bridge stops reporting it, ends its follow, drops reads on their way (a prompt, its history, a diff) and refuses the room's watch, history, diff, answers, messages, mode changes, stops and run messages for it, without claiming the messages that wait. The room's run of it goes Unknown, unless it already finished, and hears `thread_closed`, so it takes no more messages (ADR 0026). Nothing is sent to T3 Code: the thread keeps running there. What the room already has of it, its run and the items it showed, stays in the room; the app says so rather than calling it erased. If the thread is picked again, the room's view that was left open is followed again.

## Consequences

- The room needed no change: it already takes a run that goes Unknown and `thread_closed`.
- A machine whose bridge isn't paired with T3 Code (it polls `t3 thread list`) shares no thread it found, since that list names no environment to check a saved choice against.
- A thread T3 Code no longer lists (archived, deleted, or past its list of older settled threads) stays picked, and is shared again if it comes back; the list shows it as such, so it can be stopped.
- Anyone using the machine's own app can pick, as anyone there can already run the bridge's commands. The room's own settings for the machine are unchanged.
- `UPLINK_T3_THREADS` is gone; `UPLINK_T3_PROJECT` still picks where room launches go.
