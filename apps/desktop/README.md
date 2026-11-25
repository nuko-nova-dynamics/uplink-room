# Uplink Room desktop app

The Electron app for Uplink Room: the Inbox, project boards and the task panel, shared terminals, machine settings, agents, members and channels. Every action goes through the Room API (`packages/backend`, ADR 0003); the app has no endpoints of its own. UI copy uses `GLOSSARY.md`, and the look follows `DESIGN.md`.

## Run it

```sh
pnpm --filter @uplink-room/backend dev     # local Convex backend (CONVEX_AGENT_MODE=anonymous if it asks to log in)
pnpm --filter @uplink-room/backend logs    # its function logs for 30 s (--for <seconds>, then convex logs options)
unset ELECTRON_RUN_AS_NODE                 # Electron runs as plain Node when this is set
pnpm --filter @uplink-room/desktop dev     # electron-vite dev, renderer on http://localhost
```

`.env.local` holds `VITE_CONVEX_URL` and `VITE_CLERK_PUBLISHABLE_KEY` (see `.env.example`). The dev server always uses port 5173, because the Clerk instance only accepts allowlisted origins (see Auth). Unpackaged runs keep their data in `Uplink Room (development)` under the OS's app-data folder, apart from the installed app's.

## Install

Released installers are at https://uplinkroom.com/download, and installed apps update themselves from the same site (below, and `docs/releases.md`). The Package workflow (Actions → Package → Run workflow) also builds them as workflow artifacts.

| OS | File | Install |
| --- | --- | --- |
| macOS (Apple silicon or Intel) | `Uplink-Room-<version>-mac-arm64.dmg` or `-x64.dmg` (also as `.zip`) | Open the dmg and drag Uplink Room to Applications. Builds signed with the Developer ID and notarized open without a warning. |
| Windows x64 or Arm | `Uplink-Room-Setup-<version>-x64.exe` or `-arm64.exe` | Run it. It installs for the current user, in `%LOCALAPPDATA%\Programs\Uplink Room`. It isn't code-signed yet, so SmartScreen asks first: More info → Run anyway. |
| Linux x64 (Debian, Ubuntu) | `Uplink-Room-<version>-linux-amd64.deb` | `sudo apt install ./Uplink-Room-<version>-linux-amd64.deb`. It installs to `/opt/Uplink Room` and registers the `uplink-room://` link handler. |
| Linux x64 (any) | `Uplink-Room-<version>-linux-x86_64.AppImage` | `chmod +x` it and run it. AppImages need FUSE 2 (`sudo apt install libfuse2t64` on Ubuntu 24.04). |

Packaged builds talk to the production Convex deployment and the Clerk "Uplink Room" production instance on `uplinkroom.com` (`.env.release`, ADR 0014). The app carries the bridge: Settings → Machines → Link a machine → Link this computer pairs the computer, and the app runs the bridge while it's open. See `packages/bridge/README.md` for the `uplink-bridge` launcher and headless machines.

Packaged builds also send product analytics to PostHog (`VITE_POSTHOG_KEY` in `.env.release`), which people can turn off in Settings → Privacy → Share usage data. Development and test builds send none. See `docs/analytics.md` for what is sent and what never is.

## Updates

Installed builds update themselves with electron-updater (`src/main/updates.ts`, rules in `src/main/updateSpec.ts`): a check at launch and every 4 hours, a background download, then **Restart to update** in the sidebar and on the sign-in screen, never during a call and never on its own. Settings, Updates shows the version and **Check for updates**. The feed is `https://uplinkroom.com/updates/<channel>/`: `latest` for `0.2.0`, `test` for `0.2.1-test.1`. Test-channel builds keep their data in `Uplink Room (test)`. Development builds and `UPLINK_NO_UPDATES=1` never check; a `.deb` install gets new versions from the download page. `docs/releases.md` covers channels and how to cut a release (`pnpm release:mac`, then a `v*` tag for Windows and Linux).

## Package it

[electron-builder](https://www.electron.build/v26/) 26 packages the app (`electron-builder.yml`). It was chosen over Electron Forge because Forge needs pnpm's `node-linker=hoisted` for the whole repo and its Vite plugin (experimental) would replace electron-vite, while electron-builder takes electron-vite's output as is and builds dmg, zip, NSIS, AppImage and deb from one config, with notarization built in.

```sh
unset ELECTRON_RUN_AS_NODE
pnpm --filter @uplink-room/desktop dist        # builds for release (.env.release), then packages for this OS into dist/
pnpm --filter @uplink-room/desktop icon        # re-renders build/icon.png from design/link-rig.js
pnpm --filter @uplink-room/desktop icon notification   # re-renders build/notification.png, the banner icon
```

- **macOS** sets `NSUserNotificationAlertStyle: alert` in Info.plist, which Electron needs to show a banner's second button (Allow beside Open).
- **macOS** signs with the Developer ID Application certificate in the keychain and notarizes when `APPLE_API_KEY` (path of an App Store Connect `.p8`), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` are set; without them it skips notarization with a warning. electron-builder notarizes only the app, so `scripts/notarize-dmg.cjs` (its `afterAllArtifactBuild` hook) then signs each dmg with the same Developer ID, notarizes it and staples the ticket. Signing also matters for sign-in: Clerk keeps the session encrypted with safeStorage, which needs the signed app's Keychain identity, so an unsigned build signs people out on every launch.
- **Windows** packages from macOS with `pnpm exec electron-builder --win` (node-pty ships Windows binaries), or on a Windows machine. Installers aren't signed; there's no Windows certificate yet.
- **Linux** must be packaged on Linux (`pnpm exec electron-builder --linux`): electron-builder builds AppImages only there, and node-pty has no Linux prebuild, so `pnpm install` compiles it (`python3`, `make`, `g++`).

Only node-pty is packed as a real module (`package.json` `dependencies`); main and preload bundle everything else, and the bridge is bundled to `out/main/bridge.js`. node-pty is unpacked from the asar archive, because its native files and helpers must be real files. The Electron fuses keep Run-as-Node on, since the bridge runs on the app's own binary that way, and turn off `NODE_OPTIONS` and `--inspect`, encrypt cookies, and make Electron load the app only from an asar archive whose integrity it checks.

The icon is Link's face close up on a graphite tile (DESIGN.md Brand, design round 7 option b), rendered by `scripts/make-icon.cjs` from the code-built rig at 1024 px; electron-builder makes the `.icns`, `.ico` and Linux sizes from it. The same script renders `build/notification.png` (Link, waiting), which ships in the resources folder for Windows and Linux banners. The menu-bar glyph isn't used yet, since the app has no tray item.

## Layout

| Path            | What it holds                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/`     | Main process: the window, Clerk's Electron bridge, the `uplink-room://app` scheme that serves the built renderer, the `uplink-frame://` scheme that serves the HTML frame (`frame.ts`), system notifications (`notifications.ts`, `notifySpec.ts`), and the bundled bridge (`bridge.ts`). |
| `src/preload/`  | A small preload: Clerk's token and OAuth bridge, the platform, two calls for pairing this computer, and the notification calls. The window uses `contextIsolation`, `sandbox` and no Node. |
| `src/renderer/` | The React app. `views/` has one file per screen, `components/MessageBody.tsx` is the message renderer, `characters/` wraps the design rig (`design/link-rig.js`, copied unchanged). |
| `e2e/`          | The isolation check (below).                                                                                                                                                        |
| `scripts/`      | Screenshot and sign-in helpers (below), and the icon renderer.                                                                                                                       |
| `resources/bin` | The launchers the packaged app ships in its resources folder: `uplink-bridge`, and `uplink` and `uplink-mcp`, which run the bundled Room API command-line tool and MCP server (ADR 0042). The `uplink` skill ships beside them in `resources/skills`, from `packages/room-client/skills`. |
| `build/`        | The app icon electron-builder packages.                                                                                                                                              |
| `screenshots/`  | Review screenshots, dark and light.                                                                                                                                                 |

## Error reports

Release builds report errors from the main process and the window to Sentry (`uplink-room-desktop`), scrubbed of terminal text, documents, messages, tokens and emails, with hidden source maps uploaded by the Package workflow. Development builds never report. See `docs/error-reports.md` for what a report holds, how to opt out (`UPLINK_NO_TELEMETRY=1`) and how to check it (`UPLINK_TELEMETRY_TEST=1`).

## Auth

Clerk signs people in with its Electron SDK, `@clerk/electron` (beta), and Convex checks the Clerk session token. The Clerk instance puts `aud: "convex"`, name, email and picture in its default session token, so the app gives Convex that token with no JWT template (`src/renderer/lib/auth.tsx`).

Two Clerk instances of the "Uplink Room" application sign people in (ADR 0014). Local runs and the scripts below use the development instance (`.env.local`); packaged builds use the production instance, whose Frontend API is `https://clerk.uplinkroom.com` (`.env.release`). The main process reads that host from the publishable key for the CSP. Production Convex accepts tokens from both until the development issuer is dropped.

The SDK sends Clerk an `Authorization` header instead of cookies, and Clerk accepts that only from origins in the instance's `allowed_origins`. On the development instance those are `uplink-room://app` (the packaged app), `http://localhost:5173` (the dev server) and `http://localhost:5174` (the scripts below). On the production instance it is `uplink-room://app` alone, and its redirect allowlist has `uplink-room://app/`. The Native API is on in both. The main process keeps the session token encrypted with Electron's safeStorage. On Linux, that protects it only when Electron finds a supported keyring (GNOME Keyring or KWallet); without one, safeStorage selects its `basic_text` backend, which encrypts with a hard-coded key while still reporting encryption as available. There the app keeps the session in memory only, deletes any copy an earlier launch wrote, and logs a warning, so you sign in again each time the app starts (`src/main/tokenStorage.ts`). In the packaged app the SDK also registers `uplink-room://` with the OS, so OAuth sign-in can finish in the system browser and return through a deep link; on Windows and Linux that makes the app single-instance. Google sign-in is on in development only, until production has its own Google OAuth client (ADR 0014); production signs in with email.

## Spaces

A Space view (spec #6, ADR 0009) loads Cua's own viewer page from the bridge's Space gateway in a frame. The main process forwards each view to its own loopback port (`src/main/spaceForward.ts`), using the first gateway address that answers, so the frame is a secure context (Cua's viewer needs one for WebCodecs) on an origin apart from the app's and every other Space's. The app's CSP allows frames from `http://127.0.0.1:*` for that reason. Cua's viewer page refuses every frame (`frame-ancestors 'none'`, `cua-spacesd` 0.10.0), so the main process rewrites that directive on its own forwards' subframe responses to the app's origin alone (`letAppFrame`). Machine settings list the Cua Spaces a machine's bridge found, with Share for whoever the machine belongs to.

## Onboarding, sound and notifications

These follow DESIGN.md's Onboarding, Sound and Notifications sections.

- **Setup** (`views/Setup.tsx`): the first-run setup, shown once on each computer the first time a team opens (`uplink.onboarded` in local storage) and again from Settings, Setup. Welcome, the microphone, speaker and camera (`lib/devices.ts`, `components/Devices.tsx`), the macOS permissions calls and banners use (`main/permissions.ts`: each one's live state, macOS's prompt where it has one, the exact System Settings pane, and a drag tile of the app for Screen Recording), linking this computer's bridge, and done. Windows and Linux skip the permissions step. Escape closes it. See `research/onboarding-permissions.md`.
- **Sound** (`lib/sound.ts`): the soft wood cues, synthesized as on the round 6 page until the final sound design lands. `components/Signals.tsx` watches the Room and plays Needs you (a run starts waiting on you), The wheel is yours (you become a terminal's driver), A message for you (spec #63) and Inbox zero; the Inbox plays Settled. Allowing an approval plays nothing. Calls play the join and leave cues with `playCue("join")` and `playCue("leave")`. Every Link on screen reacts to every cue, including the one beside the team name in the sidebar, whose antenna lights while something needs you.
- **Notifications** (`main/notifications.ts`): a system banner for Needs you, The wheel is yours, and a message for you (a direct message, a mention, @everyone, a reply, or any message in a channel set to all; spec #63), and only while the window isn't focused. `lib/messageSignals.ts` decides which messages from `messages.addressed` interrupt: none that were there when the app opened, and none in the channel you're looking at; opening a channel takes its message banners away, and clicking one opens the channel at the message. Allow is on the banner only for an approval that can be undone (the prompt's `hardToUndo` is unset); anything else shows Open. Clicking a banner opens its task or terminal. Each banner gets a short system id of its own (Windows refuses ids over 64 characters, and a run's key is longer), and main keeps the run and prompt it showed, so Allow answers exactly that approval. A Windows toast that timed out stays tracked until it's answered or the app removes it from Notification Center. Each mount of `Signals` is one session (one person in one team): its first snapshot tells main which keys are still live, so banners a reloaded page left behind go away, and signing out or opening another team takes that session's banners with it. Allow on a banner whose approval is gone opens the run and answers nothing, and a banner acts only in the session it belongs to, so one from a team you just left does nothing in the next. macOS shows banners only from the signed app, and its icon is always the app's; Windows needs the app's AppUserModelID, which the main process sets to `appId`; Linux shows buttons only when the notification server supports actions.
- Settings, Notifications turns sounds and banners off on this computer, plays each cue, and previews the banners from the same text the main process uses.

## Chat

Channels and direct messages (spec #63, ADR 0015) live in `views/ChannelView.tsx` and `components/chat/`. Messages load newest first through Convex's `usePaginatedQuery`, and older pages load as you scroll up; a link or banner opens the channel at a message with `messages.around`. The composer is one box: Enter sends and Shift+Enter makes a new line (⌘↵ also sends, and Enter inside a ``` block makes a new line), ↑ in the empty box edits your last message, and Escape there marks the channel read. A send clears the box at once and sends go out one after another, in order; one the room refuses comes back into the box. Its `@` autocomplete writes `@Name`, which `lib/chat.ts` turns into `<@memberId>` when sending. Consecutive messages from one person a few minutes apart read as one run (`lib/chat.ts` `continuesRun`), days get a separator, a channel with unread opens at its New divider, and a strip above the composer says what's unread below or in a thread. Threads with unread replies come from `messages.unreadThreads`, ten at a time, which reads each parent's kept `replyCount` and `lastReplySeq` and never a whole thread (threads from before parents kept them need the one-time `messages:backfillReplyMeta` run described in `packages/backend/convex/messages.ts`). A thread opens at the reply a navigation names, else at its first unread reply. The read point moves past a message only once every message and reply up to it has been on screen, in the list or the Replies panel (`lib/chat.ts` `readThrough`). Files dropped, pasted or picked upload at once through `messages.attachUrl`. Images show inline and open in a full-window viewer, PDFs open in the PDF frame below, and other files open their download link in the system browser. The emoji picker's names are a hand-written list (`components/chat/emoji.ts`, no library); the emoji you pick last are kept in local storage for the picker and the action bar's one-click reactions. Link previews come from the backend; the app loads only their copied images from Convex. Search is `views/SearchView.tsx`, opened from the sidebar's search box. Private channels (ADR 0016) are made from the Channels + (`components/chat/NewChannel.tsx`), and their members are managed from the header (`components/chat/ChannelMembers.tsx`); `components/chat/ChannelBoundary.tsx` replaces a channel you were removed from with a plain note.

## The message renderer

Markdown is parsed with `marked` and sanitized with `dompurify`. Mentions (`<@memberId>`, which Markdown leaves as escaped text) become `@Name` marks after sanitizing, with the name escaped. HTML renders in an iframe whose document comes from another origin (`uplink-frame://sandbox`) and which is sandboxed with `allow-scripts` only, so a posted page gets an opaque origin and can't read the app's storage, cookies or session.

## Project files

The Files tab of a project (spec #9, ADR 0010) has a viewer per kind and a rail of pinned comments (`src/renderer/components/files/`):

- **Docs** (`.md`) edit in Tiptap 3, which loads and saves Markdown. A doc saves on a pause in typing with the version it started from, and a refused save shows a choice between the two versions. A doc whose Markdown the editor can't keep (raw HTML, for example) opens as source.
- **Canvases** (`.excalidraw`) use Excalidraw 0.18. Only shapes whose version changed are sent, and other people's shapes are merged with `reconcileElements`. Excalidraw's fonts are copied into the build at `/excalidraw/fonts/` (`electron.vite.config.ts`), leaving out Xiaolai, the 12 MB CJK font.
- **PDFs** render with pdfjs-dist 6 in `pdf-frame.html`, served from `uplink-frame://sandbox/` like the HTML frame and sandboxed the same way. Its CSP has `connect-src 'none'`: the app downloads the PDF and posts the bytes in, and the PDF.js worker runs from a blob URL as a classic script, because a module worker from a blob URL doesn't start in an opaque-origin page. The frame scheme is CORS-enabled so the viewer's module scripts can load.
- **Images** render from downloaded bytes through a blob URL. Only raster types are kept.

## Isolation check

`pnpm --filter @uplink-room/desktop build && pnpm --filter @uplink-room/desktop test:isolation` runs the one integration check. It launches the built app, plants a secret in the app's localStorage and cookie, renders a hostile page through the real renderer, and fails unless the page ran and every read it tried was blocked. It runs once with the app on `uplink-room://` (storage) and once on an http origin (storage and cookie). It also renders a PDF through the real PDF frame and checks that the frame's origin is opaque, that its reads of storage, cookies and the parent fail, and that it can't fetch. It needs Electron, so CI's `pnpm test` skips it.

The same run checks the shared-browser frame (spec #7, ADR 0006). Hyperbeam's web SDK runs code it downloads, so it lives at `uplink-frame://browser/` (`src/main/browserFrame.ts`). The check fails unless that frame has its own origin, can't reach the app's window, storage or preload, and has its connection to Hyperbeam's fallback host blocked by its CSP.

## Calls

Calls (spec #5) run on LiveKit. `src/renderer/lib/call.tsx` holds the one LiveKit room for the whole app, so a call survives moving between views; `components/Call.tsx` has the call dock, the people in each call under its channel, the call stage and the screen picker; `components/CallTimeline.tsx` has the call events, proposed tasks and the transcript. `src/main/media.ts` gives the microphone and camera to the app's own frame only, and grants a screen share only for the source picked in the app's picker. Local setup, the dev flags (`UPLINK_LOCAL_LIVEKIT`, `UPLINK_FAKE_MEDIA`) and the smoke check (`scripts/call-smoke.ts`) are in `docs/calls.md`.

## UI gym

`src/renderer/gym/` renders every screen and state with sample data and no sign-in or backend: each route, empty, loading, error, in a call, long names, many channels, many members, and each setup step, with the permission states read from this computer ("live") or simulated (not asked, denied, allowed). Its data is query results recorded from a sample team on the development deployment (`gym/fixtures.json`), served by a stand-in Convex client. To run it:

```sh
pnpm --filter @uplink-room/desktop build
node scripts/gym.ts <out folder> [state ...]
```

For each state it saves the real window (traffic lights included on macOS) in dark and light at 1320 × 840 and 960 × 600, an H.264 video of hovering, focusing and clicking the chrome (the Inbox's also opens Settings from the app menu), and `impeccable detect --cdp` output. It runs with synthetic media (`UPLINK_FAKE_MEDIA=1`), so it never opens this computer's microphone or camera, and it never asks for a permission or opens System Settings.

## Screenshots

The spec leaves layout and rendering to screenshot review. To retake them:

```sh
pnpm --filter @uplink-room/desktop build
node scripts/signin.ts <folder>            # once: signs a throwaway test person in to the Clerk dev instance
FRESH=1 node scripts/screenshots.ts        # new team, seeds it through the Room API, captures dark and light
node scripts/join.ts                       # second test person joins by invite and looks around
node scripts/files-screenshots.ts          # project files with pinned comments (RESEED=1 starts its sample files over)
```

The shared-browser screens (`23` to `28`, with saved logins in `23`, `25` and `28`) come from a sample-data page in the built app and need no sign-in or backend: `node scripts/browser-shots.ts` after a build.

The Space view (spec #6) has its own harness page, `space-harness.html`, which renders the real view with sample data and no sign-in (the sample screen is a capture of Cua's viewer from the live check). `npx playwright test e2e/space.spec.ts` checks its access controls, and with `SPACE_SHOTS=1` it writes `screenshots/28-space-driving-*`, `29-space-watching-*` and `30-space-unreachable-*`, dark and light.

Scripted runs are quiet: `scripts/lib.ts` launches the app with `UPLINK_QUIET=1`, which mutes its audio and writes each banner it would show to `.shots-notifications.jsonl` instead of showing it, so a run never interrupts whoever's computer it runs on. `screenshots.ts` uses that log to check the banners after the seed's live events (`seed.ts` `later`), reads the last cue from the page, and checks which Roster characters move. The scripts serve the renderer on port 5174, or 5173 when another checkout's run holds 5174, since the Clerk instance allows only those two.

`signin.ts` uses Clerk's `+clerk_test` email (it sends no mail; the code is 424242) and keeps the session in `.shots-profile/` (git-ignored). The Clerk dev instance doesn't collect names, so give the test people names through Clerk's backend API if you want them in the pictures. `seed.ts` also plays a bridge's side, since no bridge runs against the local backend.
