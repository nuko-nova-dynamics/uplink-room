# Logs and diagnostics

The desktop app writes what it does to a log on the computer it runs on, so a problem can be followed after the fact. Error reports (`docs/error-reports.md`) carry the same lines as breadcrumbs.

## Where

| Run | Folder |
|---|---|
| The installed app | `app.getPath("logs")`: `~/Library/Logs/Uplink Room` on macOS, `%APPDATA%\Uplink Room\logs` on Windows, `~/.config/Uplink Room/logs` on Linux |
| Development, test-channel builds (`0.2.3-test.1`), and any run with `--user-data-dir` | `<that run's data folder>/logs`, so they never mix with the installed app's |

The folder holds:

- `uplink-room.log`: the app's own log, newest last. It rotates at 5 MB into `uplink-room.log.1` … `.4`.
- `bridge.log`: the output of the bridge that ships inside the app (`apps/desktop/src/main/bridge.ts`), written through the same rotating writer as it arrives, so it rotates at 5 MB while the bridge runs. A bridge someone runs by hand with `uplink-bridge run` logs to its terminal instead.

Settings → Diagnostics has **Open logs folder** and **Copy diagnostics**. The second copies the app, Electron, Chrome and OS versions, the call's state (heartbeats, rejoins, Krisp on or off and why, which devices are chosen), and the recent warnings and errors from both processes.

## A line

```
2026-11-04T05:42:35.636Z INFO  [renderer:call] livekit connected join=p576qtyj
```

Time (UTC), level, scope, a fixed message from the app's code, then fields. `[renderer:…]` lines come from the window, forwarded to the main process (`renderer/lib/log.ts` → IPC `uplink:log` → `main/log.ts`); the rest are the main process's. Levels: `debug` (off unless `UPLINK_LOG_LEVEL=debug`), `info`, `warn`, `error`. Unpackaged runs also print each line to the terminal; `UPLINK_LOG_STDOUT=0` stops that.

## What's logged

| Scope | What |
|---|---|
| `app`, `window`, `power` | Starting and quitting, the window shown, hidden, minimized, focused, its process gone; the computer suspending, resuming, locking and unlocking |
| `auth`, `convex` | Signing in and out, Convex accepting or refusing the session and the app handing it over again, the Convex socket connecting and dropping |
| `call` | Joining, the room's join, LiveKit connecting, the microphone starting, heartbeats (one info line every 15 beats, each failure and recovery), the room dropping a join and the app joining again, catching up after sleep, leaving |
| `call.livekit` | Connection states, reconnects and disconnect reasons, tracks published and unpublished, subscriptions, people joining and leaving, connection quality, device errors |
| `call.media` | The microphone, camera and screen share published, voice quality and team limit changes, device switches |
| `krisp` | Starting, on (and whether LiveKit was told), off or failed and why |
| `devices` | Devices plugged in or unplugged, a device chosen (which kind, and "default" or "a device", never its name), the speaker test, camera previews |
| `updates`, `bridge`, `space` | The updater's phases and failures, the bundled bridge starting and exiting, Space views forwarded and closed |
| `uncaught`, `view`, `blob` | The window's uncaught errors and rejections, a view that crashed, which bundle made each script blob (debug) |

## What's never logged

The log follows the error-report rules, enforced in `apps/desktop/src/main/logFile.ts` and `renderer/lib/log.ts` (tests: `logFile.test.ts`):

- Messages are fixed texts from the app. Fields are ids, counts, states and reasons.
- Every string goes through the shared redaction (`packages/bridge/src/telemetry/scrub.ts`): JWTs, the room's secrets (`urk_…`, `ubt_…`, `uri_…` and the rest), pairing codes, long hex or base64 runs, emails, URL query strings and fragments, and quoted text.
- Field names that can only hold content or secrets (`token`, `secret`, `password`, `body`, `text`, `content`, `message`, `email`, `name` and a few more) are written as `[refused]`, so a mistake in a caller drops the value.
- The home folder is `~` in any path.
- A line has at most 20 fields (the rest are counted as `fieldsDropped=`), objects in a field are followed 2 levels deep, each value is cut to 120 characters, and a whole line to 8 KB. A file never passes its 5 MB, even for one oversized line, which is cut with `…[cut]`.
- An error is its type and a safe message: an engine error's message, a library message on the safe list as its template, or `(message not sent)` with nothing derived from the message (see `docs/error-reports.md`). The window's lines can't make templates (it doesn't know the environment's values), so there a safe message is kept only when it has nothing to template.
- No device names, call notes, message bodies, terminal text, document contents or invite tokens.
