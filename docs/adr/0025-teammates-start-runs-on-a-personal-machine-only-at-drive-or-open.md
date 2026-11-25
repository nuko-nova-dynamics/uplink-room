---
status: accepted
---

# Teammates start runs on a personal machine only at Drive or Open

Until now a machine's most open access limited only what other people could do inside a terminal or thread. Any teammate could start a terminal, thread or Rex tab on someone's personal machine in a free slot, whatever its level, and drove it, because whoever starts a terminal drives it. The people the machines belong to read the level the other way. Julio started a Claude Code run on Axel's machine, set to Suggest, and drove it with a full keyboard; both of them had read Suggest as "teammates may only suggest here". Julio decided on 2026-11-04 that this reading is the rule.

So on a personal machine the level now also decides who may start work there:

- The person it belongs to, and their agents, start terminals, threads and Rex tabs there at any level. Their own terminals use no slot; their agents' terminals use one, as before. At Watch or Suggest their agents don't start work there from a private channel or direct message the person isn't in: nobody may drive it there (see below), so `runs.start` refuses it with `forbidden`.
- Teammates, and agents acting for them over the Room API or MCP, start runs there only at Drive or Open, each terminal in a free slot. At Watch or Suggest `runs.start` refuses them with `forbidden` and says whose runs the machine takes. They still watch or suggest in what its person shares, as Access allows.
- Lowering the machine to Watch or Suggest makes its person the driver of every terminal and thread there that someone else drives, Rex runs included (they are terminals), before the work drops to the new level. Nothing is stopped. A run from a private channel or direct message its person isn't in is left with nobody driving instead (ADR 0016), even when an agent of theirs drives it: that rule is checked first. While the machine stays below Drive, a teammate who started a terminal or thread there can't take its wheel back; once it's raised, the usual rule (ADR 0021) returns it to them.
- The rule holds wherever someone drives, not only when the machine is lowered. While a personal machine is below Drive, the room takes typing, resizing, a thread's messages and interrupts, sending a suggestion, answering a wheel request, and answering an approval or question as the driver only from its person and their agents, and passes the wheel only to them, whatever the terminal's or thread's own level. A teammate's wheel left there from before this rule, or by any path that skipped the handoff, has no keyboard. When someone leaves a private channel, or is removed from it, its runs on such a machine go only to someone in it who may drive there, never back to a teammate; with nobody who may, nobody drives.
- A team machine belongs to the whole team, so anyone on the team starts runs there at any level, as before, and its level only limits what others do in a terminal or thread.

Runs from before this rule are handed over the next time the machine's bridge registers (it starts, after an update or a restart) or reports a lower limit, and again once a new bridge process says it takes a thread's new driver (`bridge_features` with `thread_driver`), since registering forgets the last process's features. We chose that over a one-time migration: the refusals above hold from the deploy on, a register ends every terminal of the previous bridge process anyway, and nobody has to remember to run anything. Until then the person can take the wheel themselves.

We chose this over keeping the old meaning and explaining it better, because the two people who used it both read it the other way, and nothing in Settings said otherwise. We also considered a separate "teammates may start runs" switch beside the access level, and rejected it: a machine at Suggest that still took teammates' runs would hand each of them a keyboard, since whoever starts a run drives it, so the two settings would contradict each other.

## Consequences

- Personal machines start at Suggest, so a newly linked personal machine takes no teammate's runs until its person sets it to Drive or Open. Settings → Machines says what teammates can do at each level, and Start a run shows such a machine as off with the reason.
- The bridge checks too, against the machine's own limit: while that is below Drive it refuses a room's terminal (a run In Rex included) or thread for anyone but its person or their agent (`terminal_start_failed` or `thread_start_failed` with `owner_only`), and below Drive it takes its person as a terminal's or thread's new driver. The room sends `accountable`, the person an agent acts for, with each start. The room's check is the primary one; an older bridge ignores `accountable` and keeps working.
- An older bridge refuses the person as the new driver of a terminal that was already below Drive (`driver_change_rejected`). The room still refuses the teammate's typing, so that terminal has no working keyboard until it ends or the bridge is updated. A bridge that doesn't take a thread's new driver (`thread_driver`, ADR 0021) keeps the thread's driver, as when someone leaves a private channel.
- The task's owner and admins can still answer a run's approvals there (ADR 0005). What changed is who drives.
- Shared Spaces don't change: only the person a machine belongs to shares them already (ADR 0009).
