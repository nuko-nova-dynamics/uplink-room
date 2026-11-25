# Calls: local setup

Calls (spec #5, ADRs 0007 and 0008) need a LiveKit server. Production uses LiveKit Cloud; development uses LiveKit's open-source server with its documented dev keys (`devkey` / `secret`).

## Joins, identities and the lease

- **Each `calls.join` is its own participation** (one per join, so one per device) and returns a `participationId`. `calls.leave`, `calls.heartbeat` (every 20 seconds) and `calls.updateMedia` take that id and act on that join only, so a slow or stale leave can never remove a newer join, on the same device or another. A member is in the call while any of their joins is live; each join expires on its own after 60 quiet seconds. The call ends when no person has a live join.
- **`calls.join` with `callId`** joins only that call and fails with a conflict once it has ended, instead of starting a new one. Agents answering an invite pass it.
- **A member on two devices shows once**, with the devices' media together: the camera or a screen if any device has it on, muted only if every device is muted.
- **LiveKit identities name one join**: `<member id>.<participation id>`. A member on two devices therefore never knocks the other out of the room (LiveKit disconnects a duplicate identity). Clients take the member id from the part before the dot; a webhook ends exactly the join its identity names.
- **One process per agent takes calls.** `calls.claimLease({ holder })` claims or renews the agent's call lease (45 seconds; renew about every 15) and returns `held: false` while another process holds an unexpired one. `calls.releaseLease({ holder })` gives it up. The Notetaker watches invites only while it holds the lease, so a restart that overlaps the old process can't make two copies join and write notes; the newer one takes over once the old one releases the lease or stops renewing it. `claimLease` also returns `leaseMs`, and the holder times the lease on its own clock from when it sent the claim, 5 seconds short. It starts no join once that time has passed, and stops watching invites when a renewal fails after it, so a process cut off from the room can't join a call alongside the one that took over. Each join belongs to the lease it started under: if that lease is lost (or lost and won back) before the join is set up, the Notetaker leaves that join and disconnects from LiveKit, since another process may have joined the call meanwhile.
- **A Notetaker that takes over finishes what the old one left.** `calls.unfinished` lists the calls the agent joined when asked in the last day and isn't in any more: live ones (`ended: false`), which it joins again, and ended ones with a transcript whose notes aren't complete (`ended: true`), for which it writes the notes and proposes tasks. Notes are complete once `calls.propose` has run after the call ended, even with no tasks, so a call with notes but no proposals is still unfinished. Each process does this once per call, unless it lost the lease while writing them: then it tries again once it holds the lease again. Proposal keys make a repeat harmless, and posting notes again replaces them. Stopping disconnects from its calls at once, then waits for these notes and proposals, renewing the lease (and taking no new calls) until they're written; then it releases the lease. If the lease is lost meanwhile, it doesn't write them, and the process holding the lease does.

## Staying in a call

The call belongs to the app, not to a view (`apps/desktop/src/renderer/lib/call.tsx`, `callSession.ts`). It stays through moving to Settings, other channels, the Inbox and direct messages, the window hidden, minimized or behind other windows, and the computer sleeping briefly.

- **Presence doesn't wait for media.** The heartbeat starts as soon as `calls.join` returns, before LiveKit connects or the microphone starts. In 0.2.0 to 0.2.2 it started only after the microphone, and Krisp's start never settled under the app's content security policy (below), so no heartbeat ever ran and the room dropped every join at 60 seconds ("Call ended · 1 min").
- **A failed beat is tried again** after 2, 4, then every 8 seconds, inside the room's 60 second window, instead of at the next 20 second beat. Only the network and other passing errors (a session still signing in after sleep) are retried.
- **Out of the call for good.** A beat the room refuses with `not_found` (the person left or was removed from the call's private channel; the backend checks access before it checks whether the join ended) or `forbidden` (not their join, or they left the team) ends the call here at once: LiveKit disconnects, capture stops, and the app says "You're no longer in this channel's call." It doesn't wait for LiveKit's own removal, which can be late. The same happens when the call is gone from `calls.live` for this person (it ended, or they can't see its channel); when it's listed without them (the room dropped the join after a sleep), the app beats at once instead, and a refused beat joins again.
- **Catching up.** When the computer resumes or unlocks (Electron's `powerMonitor`, forwarded to the window), the network comes back, or the window shows again, the app beats at once. A beat that runs more than 5 seconds late is logged.
- **Joining again.** When the room says the join is gone (the heartbeat's conflict, after a sleep longer than the window) or LiveKit disconnects for a reason that isn't final (a signal close, a timeout, a server shutdown), the app joins the same channel again. What the person chose (muted, camera on) lives outside any room (`callMedia.ts`), so the new room's microphone goes out muted if it was, and the camera comes back; a screen share needs the picker again. Final reasons (you left, removed from the team, the room closed) end the call. At most 4 joins on its own in 5 minutes. A rejoin holds its own generation: a Leave or a switch to another channel while it's still closing the old room stops it, and once it's joining, its usual checks undo whatever it opened.
- **No throttling.** The main window has `backgroundThrottling: false`: Chromium otherwise slows a background page's timers, down to one wake-up a minute after five minutes hidden.
- **The call outlives its view.** An `AppCall` per signed-in member holds the session, media and LiveKit room outside React, and plays the call's sound from its own element. A CallProvider unmounting (the team chooser, the window showing a splash while its session reconnects) leaves the call joined for 2 minutes in case one mounts again, but with no mute or Leave on screen nothing keeps capturing: the microphone is muted and the camera and any share stopped at once, and they come back as the person left them when the dock does. The stop doesn't wait for a lane or a reconnect: during LiveKit's full reconnect the camera is muted, stopped and unpublished, so LiveKit's republish neither restarts nor sends it, and a camera or share still opening sees the suspension and stops its track. Another team or signing out ends the call at once. A view that crashes shows an error in its place, and the sidebar and dock stay.
- **A refused session after sleep.** The Clerk token has expired after a sleep and the network may still be waking, so a token fetch that fails is tried again four times, and a Convex session refused while Clerk still has one is handed over again, every 2 seconds at first and at most every 30.

## Call quality

Issue #87 and ADR 0017. What each choice publishes is in `apps/desktop/src/renderer/lib/callQuality.ts`; which choices a team's limit allows is in `packages/backend/convex/lib/callQuality.ts`, which the app imports too.

- **A channel's voice quality** is on its row (`channels.callQuality`, absent means Standard), set with `channels.setCallQuality`: by admins in a team channel, by any member in a private channel or direct message. `channels.list` returns `callQuality` (what calls use, after the team's limit) and `callQualityChosen`; `calls.join` returns `callQuality` too, so an agent's LiveKit client can publish with it. Standard is Opus mono up to 48 kbps, High mono up to 96 kbps, Music stereo at 128 kbps without DTX or RED, with noise suppression, Krisp and auto gain off and echo cancellation on. A change reaches every app in the call through the `channels.list` subscription, and each republishes its microphone (unpublish, then a new track with the new capture settings), muted if it was.
- **The team's limit** is `teams.callQualityLimit` (`standard`, `high`, absent or `none`), set with `teams.setCallQualityLimit` by admins and returned by `teams.settings`. It caps the voice quality (a channel set higher keeps its choice and calls use the best the limit allows), the share choices the app offers, and the camera (720p under Standard). Lowering it lowers a running share or camera in each app at once. The share and camera caps are the app's: LiveKit has no grant that limits a publisher's bitrate.
- **Screen shares** publish VP9 as rid simulcast with `L1T3` per layer (a full-size and a half-size layer), with VP8 as LiveKit's backup codec. Each choice is a `VideoPreset` (size, frame rate, bitrate) and a content hint. Capture asks 10% above the choice's frame rate, because Chromium delivers about 0.92 of what it's asked; the encoding's `maxFramerate` holds what is sent. The share's sound is captured in stereo with noise suppression and auto gain off and published as Opus stereo at 128 kbps. Another quality mid-share is a new share of the same screen or window.
- **60 fps on Windows**: since Chromium 151, Windows 11 24H2 and later capture through Windows Graphics Capture, which delivers a frame at most every 16 ms by default, so a display above 60 Hz gives fewer than 60 fps (about 48 at 144 Hz, 53 at 160; Chromium issue 565075148, open in Chromium 156). The picker says so on Windows when the display picked runs faster than 60 Hz and the arithmetic comes out under 60.
- **The viewer's Stream quality**: Auto leaves the layer to adaptive stream (the tile's size) and dynacast; Low calls `setVideoQuality(VideoQuality.LOW)` on the share's publication, so LiveKit sends the half-size layer whatever the tile's size. Expand lets the shared screen fill the channel, so adaptive stream asks for the full layer.
- **Changing media mid-call** (`apps/desktop/src/renderer/lib/callMedia.ts`): the microphone, camera and share each keep what the person wants (muted, on, the share and its quality) apart from what is published, and replace one at a time in lanes that belong to one call, so a device open that never settles holds up nothing after it. What is applied is read from the room's publications. Changes wait while the call's first microphone starts and while LiveKit republishes after a full reconnect; then one pass reconciles, leaving at most one publication per source, and startup publishes a microphone only if the room has none. A replacement checks after every device open and publish that its room is still the call's and nothing overtook it; a track it no longer wants is stopped, never published, and a replacement's device open gives up after 30 seconds. A mute or an off pressed mid-replacement holds on the new track, and only the newest camera request can turn the camera off on failure. A mute goes on at once, never behind a device still opening; an unmute waits its turn in the microphone's lane, reads the wish again after every wait, and opens a device it needs (one picked while muted) while still muted. So a Mute pressed while that device opens is never undone: LiveKit's own unmute would open it and then turn the sound on. A failed microphone replacement puts the old quality back; if that fails too, unmuting opens one again. Stopping a share tells the room at once.
- **Per computer**: the last share quality (`uplink.shareQuality`) and the camera quality (`uplink.cameraQuality`, 720p or 1080p at 30 fps) are kept in the app's local storage.

## Get `livekit-server`

LiveKit's releases ship Linux and Windows binaries only, so on a Mac build the tagged source with Go (no Homebrew needed):

```sh
mkdir -p ~/.local/opt/livekit-server-1.13.11 && cd ~/.local/opt/livekit-server-1.13.11
git clone --depth 1 --branch v1.13.11 https://github.com/livekit/livekit.git src
cd src && go build -o ../livekit-server ./cmd/server
../livekit-server --version   # livekit-server version 1.13.11
```

`go install …@v1.13.11` doesn't work: the module's `go.mod` has replace directives.

## Run it

Keep every socket on loopback. `--bind` covers only the HTTP port: by default LiveKit also binds its media UDP port on every network interface and its ICE/TCP port on all addresses. On a Mac with the firewall on, that makes macOS ask whether `livekit-server` may accept incoming connections. This config turns ICE/TCP off and binds UDP to 127.0.0.1 alone:

```sh
~/.local/opt/livekit-server-1.13.11/livekit-server --dev --bind 127.0.0.1 --node-ip 127.0.0.1 --config-body $'rtc:\n  tcp_port: 0\n  enable_loopback_candidate: true\n  use_external_ip: false\n  ips:\n    includes:\n      - 127.0.0.1/32\n'
```

Check it with `lsof -nP -a -p $(pgrep -f livekit-server) -i`: only `127.0.0.1` addresses should appear. It listens on `ws://127.0.0.1:7880`. To have it send webhooks to a local Convex backend (optional; without them the heartbeat drops a join within a minute), add to the same config:

```yaml
webhook:
  api_key: devkey
  urls:
    - http://127.0.0.1:3211/livekit/webhook
```

## Point the backend at it

The Convex backend reads three variables from its environment. For a local backend (`pnpm --filter @uplink-room/backend dev`, `CONVEX_AGENT_MODE=anonymous`):

```sh
cd packages/backend
npx convex env set LIVEKIT_URL ws://127.0.0.1:7880
npx convex env set LIVEKIT_API_KEY devkey
npx convex env set LIVEKIT_API_SECRET secret
```

A cloud dev deployment can mint tokens for `ws://127.0.0.1:7880` too (the app connects to LiveKit directly), but it can't receive the local server's webhooks. Without the three variables, `calls.join` answers "Calls aren't set up on this deployment" and the rest of the room works as before.

## Production

- A LiveKit Cloud project on the free Build plan: 5,000 WebRTC minutes a month, 100 concurrent connections, Krisp noise cancellation.
- On the production Convex deployment: `LIVEKIT_URL` (`wss://<project>.livekit.cloud`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
- In LiveKit Cloud, Settings → Webhooks: a webhook to `https://<deployment>.convex.site/livekit/webhook`, signed with that API key.
- The Notetaker on a team machine: see `packages/notetaker/README.md`.

## The desktop app against it

Chromium's WebRTC leaves out loopback candidates, so an unpackaged app only reaches a server on 127.0.0.1 with `UPLINK_LOCAL_LIVEKIT=1` (it adds `--allow-loopback-in-peer-connection`; packaged builds never do). Binding the server to all interfaces instead would also work, but on a Mac with the firewall on that asks whether `livekit-server` may accept incoming connections.

`UPLINK_FAKE_MEDIA=1` makes the app publish a synthetic microphone, camera and screen (an oscillator and canvases) instead of opening real devices, and list sample windows in the screen picker without asking macOS for screen access. It implies `UPLINK_LOCAL_LIVEKIT=1`. Tests and screenshot scripts use it so they never ask the OS for the microphone, camera or screen.

## The smoke check

`apps/desktop/scripts/call-smoke.ts` runs the whole flow against the local backend and server: a fresh team, a second person speaking a `say` recording through a scripted LiveKit participant, the app joining with synthetic media, the real Notetaker joining when asked, screen share through the picker, the call ending, call notes and proposed tasks, accepting one, and the transcript. It takes the call screenshots (23 to 28) in dark and light.

```sh
pnpm --filter @uplink-room/desktop build
cd apps/desktop
node scripts/signin.ts && node scripts/signin.ts .shots-profile-2 second   # once
WHISPER_MODEL=~/.local/share/uplink-room/whisper/ggml-base.bin node scripts/call-smoke.ts
```

The script serves the renderer on 5174, or 5173 when another checkout's run holds 5174 (`scripts/lib.ts`). It runs with `UPLINK_QUIET=1` like every script, so the join and leave cues play muted; it checks they play with Sounds on and stay silent with Sounds off.

It also kills a second client of Ana's without leaving while that join keeps heartbeating, and checks that LiveKit's `participant_left` webhook ends that join (and only that one).

### Against a cloud deployment and LiveKit Cloud

Point `apps/desktop/.env.local` at the deployment (`VITE_CONVEX_URL=https://<name>.convex.cloud`), rebuild, sign the two test people in on it, and pass the LiveKit API secret on stdin. The script never puts it in the environment, so the app and the Notetaker don't see it:

```sh
npx convex env get LIVEKIT_API_SECRET | LIVEKIT_API_KEY=<key> \
  WHISPER_MODEL=~/.local/share/uplink-room/whisper/ggml-base.bin node scripts/call-smoke.ts --livekit-secret-stdin
```

With the secret, it lists the call's room from LiveKit's API (who is in it, their tracks and audio features). The team it makes is named "Call check (test data)", and it revokes the Notetaker's key at the end. The API can't delete teams or agents, so those stay on the deployment.

Krisp can't be checked with synthetic media. Its processor sets `noiseSuppression`, `voiceIsolation` and `sampleRate` constraints on the microphone track, which a WebAudio track can't satisfy, so the app enables Krisp only on a microphone device. Chromium's virtual microphone (`--use-fake-device-for-media-stream`) is one, so the soak below checks it: on LiveKit Cloud, LiveKit's API lists `TF_ENHANCED_NOISE_CANCELLATION` (5) in each microphone's `audio_features`, beside 2, 3 and 4 (auto gain, echo cancellation, noise suppression).

Two things Krisp needs from the app:

- **`'wasm-unsafe-eval'` in `script-src`** (`apps/desktop/src/main/csp.ts`). Krisp runs its code from a 5.4 MB `blob:` script that compiles WebAssembly; without it Chromium throws `CompileError: WebAssembly.Module(): … 'unsafe-eval' is not an allowed source of script` (Sentry UPLINK-ROOM-DESKTOP-3, frame `blob:…:1928:5267973`), and Krisp's enable step never settles. It allows WebAssembly only, never JavaScript `eval`.
- **Telling LiveKit it's on.** livekit-client 2.23 reports feature 5 when the processed track fires `enable-lk-krisp-noise-filter`. `@livekit/krisp-noise-filter` 0.4.5 carries its own copy of livekit-client and never fires it, so the app does, once Krisp says it's enabled.

Each Krisp step is logged (`[renderer:krisp]`, `docs/logs.md`), and the call settings popover says whether it's on and why not. Each step has a time limit, Krisp's `init` included (LiveKit runs it holding the track's lock and keeps the processor only once it succeeds, so a hang would hold every later device switch). On a failure, a timeout or a Krisp that doesn't turn on, the app takes the processor off the track if LiveKit has it, destroys it either way, and applies `noiseSuppression`, `echoCancellation` and `autoGainControl` back on the capture, which Krisp can turn off before it fails. A setup given up on can't attach later: an init still waiting for the track's lock then fails at once, and one that was already running and finishes late is taken off again, with the settings put back. Krisp is never waited for: it can't hold up a join.

Built apps use React's production build, which never runs StrictMode's extra mount. To run the check against React's development build, start Vite's dev server for the renderer on 5173 or 5174 (with the renderer settings from `electron.vite.config.ts`) and pass `UPLINK_RENDERER_URL=http://localhost:5173`.

## The soak

`apps/desktop/scripts/call-soak.ts` keeps two copies of the built app in one call on a cloud dev deployment for 30 minutes, through LiveKit Cloud. It serves the app from `uplink-room://app`, as the installed app does, so the main process's content security policy applies, and it uses Chromium's fake devices, so no real microphone or camera opens. Person A moves between the call's channel, the Inbox, Settings → Calls and Diagnostics, another channel and a direct message; then the window is minimized for 10 minutes, hidden for 4, and moved around again. Person B stays in the call's channel.

Every 5 seconds it reads both joins' `lastSeenAt` and `leftAt` (`npx convex data callParticipations`), each window's RTCPeerConnection states, and the received audio from WebRTC stats. It reports, per person: joins and dropped joins, disconnects (a connection leaving `connected`), missed heartbeats (`lastSeenAt` standing still for more than 30 seconds), audio gaps (a 5 second interval with no audio packets, or more than 100 ms of concealed sound), and LiveKit's audio features for each microphone.

```sh
pnpm --filter @uplink-room/desktop build
cd apps/desktop
npx convex env get LIVEKIT_API_SECRET | LIVEKIT_API_KEY=<key> node scripts/call-soak.ts --livekit-secret-stdin
```

`--plan join --minutes 2` only joins and waits; `--joins 2` joins twice in one session; `--app <folder>` runs another build. Results go to `apps/desktop/.soak/<label>.json`. The two test people (`uplink-soak-a+clerk_test@example.com`, `uplink-soak-b+…`) and their team, "Call soak (test data)", stay on the deployment for the next run.

