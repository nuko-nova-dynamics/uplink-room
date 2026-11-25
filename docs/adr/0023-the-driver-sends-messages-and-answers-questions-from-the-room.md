---
status: accepted
---

# A thread's driver sends it messages and answers its questions from the room, and the room records who sent what

The thread view gets a message box (ADR 0022). Only the thread's driver sends a message (`threads.send`), as only a terminal's driver types; on a Suggest or more open thread, teammates propose messages and the driver sends them, edited or not, as a terminal's suggested commands work. The bridge checks the driver again and dispatches T3 Code's `message.dispatch`: an idle thread starts a turn with it, and a busy one takes it after the turn in progress. The driver can stop the turn in progress. A T3 Code question is answered from the room the way an approval is (ADR 0005): its driver, the task's owner or an admin answers, and the room sends the answer as the driver's.

We chose to queue a message behind a busy turn rather than steer the turn with it, as T3 Code's own composer can. Whether steering works the same way for every harness wasn't verified (research experiment 2), and a queued message never interrupts work someone else started. Amended by ADR 0026: a message from another run or agent is added to the turn in progress (`steer_active`) instead of waiting behind it. T3 Code records every message sent over the bridge's socket as the user's, with no name, so the room keeps its own record (`threadMessages`) and its activity log says who sent what.

## Consequences

- A thread item sent from the room names its message (`uplink-room:<id>`), so the room adds who sent it to the item (`threads.items`, `sentBy`); messages typed in T3 Code itself show no name. A queued message shows as sent once that item comes back completed, which T3 Code does when the message's own turn starts.
- Agents send messages with the `terminals.drive` scope (ADR 0021) and answer questions with `approvals.answer` (ADR 0005).
- Secrets and link requests are still answered only in T3 Code.
- Attachments can't be sent from the room yet.
- An older bridge doesn't take these messages: the room sends them only where the bridge named `thread_messages` and `thread_questions` (ADR 0021), and its thread view says to update Uplink Room there.
