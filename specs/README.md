# TLA+ models

Models of the room's moving parts that tests reach poorly: processes that start and stop each other, and scheduled work that Convex retries. TLC, the TLA+ model checker, explores every order the steps can happen in and reports the first that breaks a rule, with the steps that got there.

```sh
pnpm specs                # every model
pnpm specs BridgeQuit     # the configs whose names start with BridgeQuit
```

TLC needs Java 11 or later (`JAVA_HOME`, or `java` on PATH). `scripts/specs.mjs` downloads TLC 1.7.4 once, checks its SHA-256 and keeps it in `~/.cache/uplink-room/tla`. CI checks the models on Linux (`.github/workflows/ci.yml`).

| Model | What it covers | Came from |
| --- | --- | --- |
| `BridgeQuit.tla` | The app and its bridge as the app quits or dies, with the pipe the bridge logs to | UPLINK-ROOM-BRIDGE-3: the app's bridge crashed on a log line during its shutdown, after the app had gone |
| `MachineOnline.tla` | `markSeen` and `checkOnline`, which mark a machine offline after 90 s with no word from its bridge, with Convex rerunning a run that failed | UPLINK-ROOM-BACKEND-H: 93 of Convex's internal errors in `checkOnline` in 6 seconds |
| `TaskQueue.tla` | `dispatchQueue` and `startQueued`, which start a machine's queued tasks one at a time when what they need is closed and a slot is free (ADR 0050) | The Board lessons' first review: a start that threw, inside a dispatch that started tasks itself, rolled back every dispatch and blocked the machine's queue |

## Configs

Each `<Model><Variant>.cfg` sets the model's constants and the rules to check, and its first line says what TLC must find:

- `\* expect: ok`: no rule breaks. This is the code as it is.
- `\* expect: violation <Invariant>` or `\* expect: violation temporal`: TLC must find that rule broken. Such a config keeps a known bug in the model (the code before a fix, or a fix not taken), which shows the model can catch it.

| Config | Expects | Why |
| --- | --- | --- |
| `BridgeQuit` | ok | The bridge handles its output closing (`onClosedOutput`), so it never crashes, and a quit always ends with it stopped. |
| `BridgeQuitBug` | `NoCrash` broken | The bridge before the fix. |
| `BridgeQuitWaiting` | `NoCrash` broken | An app that waits for its bridge to stop when it quits isn't enough: an app can die without quitting. |
| `MachineOnline` | ok | However often a run fails inside Convex, a quiet machine goes offline, and never before 90 s. |
| `MachineOnlineGivesUp` | `CheckComing` broken | A `checkOnline` that fails for good (a bug in it) leaves an online machine with no check coming, so it would show online until its bridge spoke again. |
| `TaskQueue` | ok | A start that throws is marked stuck and the tasks behind it still start, never past the slots, never twice, and never before what they need is closed. |
| `TaskQueueInline` | `Progress` broken (temporal) | The first design: `dispatchQueue` started tasks itself, so a start that threw rolled the whole dispatch back, every minute, and the tasks behind it never started. |

## When to add one

When an error report, or a change, involves two things that can happen in either order: a process and the one that started it, a scheduled function and the mutation that reschedules it, a client and a reconnect. Model only what decides the order; leave the rest out. Add the bug as its own config that expects the violation, so the model is shown to catch it, then the fixed config that expects `ok`.
