---
status: accepted
---

# A thread run hears between turns unless T3 Code steers without stopping a tool, and posts with a key each delivery gives

ADR 0026 has the bridge deliver messages from other runs and agents into a T3 Code thread with `steer_active`, and lets a thread's run post with `uplink-bridge say` and `reply`. ADR 0029 D7 trusted `T3CODE_THREAD_ID` on a personal machine and gave a key only on a team machine. The #138 tests (2026-11-05) changed both: `steer_active` interrupted the running tool in Claude Code threads and restarted Grok's turn, and `T3CODE_THREAD_ID` reaches Claude Code and Codex threads but not Grok's, while T3 Code exposes no process ids and runs every Codex thread under one `codex app-server`. Julio's comment on #139 tightened D7 to a short-lived key everywhere. Building slice 6 settled the rest on 2026-11-05.

## Decisions

- **A message joins a turn in progress only when T3 Code says its provider steers without stopping a running tool.** Before each delivery the bridge reads the thread's projection and takes the active turn's provider session `capabilities.turns`: `supportsActiveSteering` without `activeSteeringInterruptsTools` means `steer_active` (`mid_task`), the rule T3 Code itself uses before it steers a notification into a turn. Otherwise the message waits for the turn (`queue_after_active`), or starts one in an idle thread (`start_immediately`), both `next_turn`. The bridge checks no harness name, so a provider that changes its flags changes how its threads hear. With T3 Code v0.1.8-nightly.20261105.4234 only Codex steers. `runs.hearing` says `mid_task` or `between_turns` from the same flags.
- **Thread messages from other runs and agents are a path of their own.** They use the terminals' claim and acknowledgement (`bridge:claimRunMessages` with `threadRef`, `run_message_result`) and the same labelled text (`formatRunMessages`). A message the driver sends from the room keeps ADR 0023's path: driver only, and queued behind a busy turn.
- **Delivered means T3 Code took the message.** The bridge answers `delivered` once `message.dispatch` succeeds, `released` when T3 Code refuses it, and `unsure` when the request may have reached T3 Code. A queued message is delivered before the agent reads it; it reaches the agent when the turn ends, unless someone stops or deletes the thread first.
- **Both sides name the feature.** The room sends a thread's `run_messages_waiting` only to a bridge that named `thread_run_messages`, and the bridge claims, posts and reports a thread's hearing only to a room that named it. An older bridge leaves the messages waiting in the run's inbox, which says to update it (ADR 0021).
- **A thread run proves itself with a run key that each delivery gives, on every machine.** The bridge makes a key (`urt_` and 32 random characters) for each delivery and ends the delivery with the commands that use it: this bridge's own command words, `--socket` with its socket, and `--key`. The key posts only as that thread's run, works while the thread's turn runs and for an hour after it ends (or after the key was made, if later), never past 12 hours after it was made, and lives only in the bridge's memory. A key that lapsed while its thread was idle stays lapsed when a later turn starts. When `T3CODE_THREAD_ID` is set, it must name the key's thread; it is never enough alone.
- **No run key reaches the room.** The room shows a thread to everyone who can see its run, so the bridge hides any run key in everything it sends the room, `say` and `reply` included, and in what T3 Code sends it before it reads or cuts any of it: a trim can't leave a key's secret without its prefix, and the secret of a key the bridge holds is hidden wherever it shows. A thread keeps its newest 8 keys and the bridge 256 in all; a closed thread's keys stop at once.
- **Stopping a run stops what is on its way to it.** A delivery whose run was stopped, from the room or in T3 Code, while its claim or its read of the thread was out sends nothing, and its messages wait again, so no message starts a stopped thread.

## Considered options

- **An environment variable the bridge sets per thread**, as it sets `UPLINK_TERMINAL_SECRET` in a terminal. T3 Code's `orchestration.launchThread` takes no environment, and the bridge doesn't start the threads it finds in T3 Code. T3 Code sets `T3CODE_THREAD_ID` itself, for Claude Code and Codex only.
- **A key file in the bridge's folder, named by `T3CODE_THREAD_ID`.** Any process of the same user could name another thread's id and read its file, so it proves no more than the variable, and Grok threads have no id to name.
- **`steer_active` for every harness that steers.** It stops a running tool in Claude Code and restarts Grok's turn, so another person's message would undo work its driver started, which ADR 0026 rules out.

## Consequences

- A thread run can post only after it got a message, and only for an hour after the turn that followed ends, and at most 12 hours after the message came. A bridge restart ends every key; the next delivery brings a new one.
- The key is in the thread's conversation and in T3 Code's database on the machine. Another program running as the same user could read it and post as that run until it expires. The key separates threads against mistakes and casual misuse, not against a hostile program of the same user.
- A queued message waits behind a long turn, and several messages during one turn each queue a turn of their own.
- Live on 2026-11-05 (bridge README, Messages to runs) the check also found that T3 Code now sends shell snapshots with only the projects whose repository it resolved and no threads. The adapter had taken these for the whole shell and forgot every thread it followed; it now merges them as T3 Code's own client does.
