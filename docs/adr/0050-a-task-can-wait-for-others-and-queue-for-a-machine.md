---
status: accepted
---

# A task can wait for others and queue for a machine

Vercel Board (2026-11-18, [Tasks](https://vercel.com/docs/board/concepts/tasks)) gives a team of agents a queue: a lead agent writes a plan of tasks, a task can wait for others (`--needs`), and a pool of workers claims ready tasks under a lease that expires if a worker stalls. Vercel says its v0 software factory runs on it. ADR 0026 left "file claims and a shared task list" out of scope. Uplink Room already has the pool: a machine's slots, and the bridge that starts runs on it. What it lacked was a way to say "start this when that is done, on that machine, when there's room".

## Decisions

- **A task can need other tasks** (`tasks.needs`, at most 20): `tasks.create` and `tasks.update` take `needs`, and a task can't need itself or a task that already waits for it (the room walks the chain and refuses a loop). A needed task is done when it is closed (`tasks.keepRun`).
- **A task can be queued for a machine** (`tasks.queue`, a `taskQueue` row): the harness, terminal or thread, folder, repo, prompt, command, access and permission mode a `runs.start` would take. Queuing runs the same checks a start would now, so a queue that can never start is refused at once. `tasks.unqueue` takes it out; queuing again moves it. Only whoever queued it, or its owner, can take it out or move it.
- **The room starts a queued task when it is ready:** every task it needs is closed, whoever queued it may still start runs there, the machine is online and not stopping, and it has room (a free slot for a terminal, unless the machine is the starter's own; nothing for a thread). Only to an online machine, because a start waiting in an offline bridge's outbox would run later without the room checking again who may start it; a stopped cloud machine is woken for its queue instead. It starts as whoever queued it, with the rights they have then: a person while still in the team, an agent with the same key, still unrevoked. The run is an ordinary run, and starting deletes the row.
- **Oldest first, one at a time, per machine.** `tasks.dispatchQueue` does nothing while a start is under way on the machine, wherever its row is. Otherwise it reads the queue in order, 100 rows per transaction, going on in a new one when none of them is ready, and hands the first ready task to `tasks.startQueued`, which checks again, starts it, and looks at the queue again. A start that fails rolls back alone; its row, still marked as starting a minute later, is marked stuck and skipped, so it never blocks the tasks behind it. The room calls dispatch when a task is queued there, when a terminal that used a slot ends there, and for every machine with a queue when a task in the team closes; a cron calls it for every queue each minute, so a slot freed some other way, or a machine back online, is noticed within a minute.
- **A start the machine would refuse waits, with the reason on the task's card** (`queued.lastRefusal`), such as a personal machine whose person narrowed who may start runs (ADR 0025).
- **`tasks.createMany` makes a plan in one call,** up to 25 tasks, all or none, each naming what it needs by another item's key or an existing task id, and optionally its queue.
- **The task card shows `needs` (each with `closed`) and `queued`,** in the API and the app's task panel.

## Considered options

- **Board's claims and leases.** A worker claims a ready task for up to 5 minutes and renews it. Uplink Room's runs already have owners, drivers and heartbeats from the bridge, and a run that dies ends its terminal, so a second lease would duplicate them.
- **Readiness from runs instead of closed tasks.** A run can be done and still not be the run the owner keeps; closing is the owner's statement that the work is done.

## Consequences

- A failed queued run leaves the task open and out of the queue: its owner reads the run and queues it again, or starts a run by hand.
- Waiting is only for queued tasks: a task with `needs` that isn't queued can still be started by hand at any time.
