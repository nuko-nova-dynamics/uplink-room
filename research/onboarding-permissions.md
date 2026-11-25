# First-run onboarding and macOS permissions: how Codex, Hex and Claude do it

Research for the onboarding flow in the desktop app, checked on 2026-11-04. Each claim names the page or file it comes from. Where I only saw a secondary source, it says so.

## What Uplink Room needs

From this repo, not from the apps below:

| Permission | Used by | How macOS grants it |
| --- | --- | --- |
| Microphone | Calls (`lib/call.tsx`) | System prompt, `systemPreferences.askForMediaAccess("microphone")`. The prompt shows `NSMicrophoneUsageDescription` from `electron-builder.yml`. |
| Camera | Calls, when you turn the camera on | System prompt, `askForMediaAccess("camera")`, with `NSCameraUsageDescription`. |
| Screen Recording | Sharing a screen in a call (`main/media.ts`, `desktopCapturer`) | No request API. Opening the share picker lists the app, then the person switches it on in Privacy & Security, Screen & System Audio Recording, or drags the app in. |
| Notifications | Banners for Needs you, The wheel is yours, and a message for you (`main/notifications.ts`) | macOS asks the first time the signed app shows a notification. Electron has no call to read or request the setting: its `Notification` class offers `isSupported()` but no authorization status ([Electron Notification](https://www.electronjs.org/docs/latest/api/notification)). |
| Accessibility | Nothing | No feature synthesizes local keyboard or mouse input. Taking the wheel of a Space drives a remote Cua machine, and the bridge's terminals run through node-pty. So onboarding doesn't ask for it. |

Electron reads the media states with `systemPreferences.getMediaAccessStatus("microphone" | "camera" | "screen")`, which returns `not-determined`, `granted`, `denied`, `restricted` or `unknown`. `askForMediaAccess` resolves at once with the existing answer when access was already denied: "it must be changed through the preference pane; an alert will not pop up". A change made in System Settings after a denial needs the app restarted ([Electron systemPreferences](https://www.electronjs.org/docs/latest/api/system-preferences)).

## Hex (Kit Langton)

`github.com/kitlangton/Hex`, the Swift app, was archived on 2026-10-14; its README says "Hex has moved to anomalyco/hex", a Rust rewrite ([kitlangton/Hex](https://github.com/kitlangton/Hex)). The legacy README asks for "microphone and accessibility permissions", to record and to paste into any application. The current source is the clearest primary source of the three for the drag pattern.

From [`native/permission_guide.m`](https://github.com/anomalyco/hex/blob/9fe8ce64660314a3ae9e1dd181d247340c61dc73/native/permission_guide.m) and [`src/desktop/permission_guide.rs`](https://github.com/anomalyco/hex/blob/9fe8ce64660314a3ae9e1dd181d247340c61dc73/src/desktop/permission_guide.rs) at `9fe8ce6`:

- **Panes.** Accessibility, Microphone, System Audio Recording and Screen Recording, each opened with `x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_<Pane>`: `Privacy_Accessibility`, `Privacy_Microphone`, `Privacy_AudioCapture`, `Privacy_ScreenCapture`.
- **The drag tile.** After opening the pane, Hex shows a borderless floating panel that follows the System Settings window. It holds the instruction "Drag Hex into the Accessibility list above" and a tile drawn "as System Settings will list it: icon and name" (the app's icon from `NSWorkspace iconForFile:` at 32 px, its display name, a rounded 8 px plate). Dragging the tile starts an `NSDraggingSession` whose pasteboard item is the running `.app` bundle's URL, with a copy operation, so the drop is the same as dragging the app from Finder.
- **Microphone is not dragged.** "The Microphone list only holds apps that asked, so a refused microphone is switched on rather than dragged in." For it, the panel says "Switch on Hex in the Microphone list above" with no tile.
- **Development builds** have no bundle to drag, so they get the pane alone.
- **Motion.** The tile flies from the click to its place beside Settings, unless Reduce Motion is on.
- **Names change.** The list names come from one function: "Screen & System Audio Recording", "System Audio Recording Only", and on macOS 27 Accessibility is called "Device Control and Data Access".
- **Accessibility prompt.** `AXIsProcessTrustedWithOptions` with `kAXTrustedCheckOptionPrompt` registers the binary in the list and shows macOS's prompt.
- **Status.** The onboarding polls each permission and marks Accessibility "stale" while it waits for a restart ([`src/rune_ui/onboarding.rs`](https://github.com/anomalyco/hex/blob/9fe8ce64660314a3ae9e1dd181d247340c61dc73/src/rune_ui/onboarding.rs)).

## Codex (ChatGPT desktop app)

From OpenAI's [Computer Use docs](https://learn.chatgpt.com/docs/computer-use):

- Computer Use is a plugin: "Install the Computer Use plugin. On macOS, grant Screen Recording and Accessibility permissions when prompted."
- Two panes, each with a one-line reason: **Screen Recording** "so ChatGPT can see the target app", **Accessibility** "so ChatGPT can click, type, and navigate".
- The entry in System Settings is a separate helper: "check Screen Recording and Accessibility for Codex Computer Use". An [openai/codex issue](https://github.com/openai/codex/issues/18896) shows people enabling both `Codex` and `Codex Computer Use` in each list.
- System permissions are separate from per-app approvals, which live in Settings, Computer use, "Always-allowed apps".

I found no OpenAI page or screenshot that shows a drag tile. A Medium post describes "dragging Codex Computer Use into the allowed list under Screen Recording", which suggests one exists, but that is a secondary source.

## Claude (desktop app)

From Anthropic's [Claude Code Desktop docs](https://code.claude.com/docs/en/desktop#enable-computer-use) and the [Help Center article on computer use](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork):

- Computer use is off by default and turned on in Settings (Capabilities, or This computer, System).
- Two panes, each with a one-line reason: **Accessibility** "lets Claude click, type, and scroll", **Screen Recording** "lets Claude see what's on your screen".
- "The Settings page shows the current status of each permission. If either is denied, click the badge to open the relevant System Settings pane." The [CLI docs](https://code.claude.com/docs/en/computer-use) add that the prompt has links to each pane and a **Try again**, and that "macOS may require you to restart Claude Code after granting Screen Recording".
- Quick entry asks for Screen recording, Accessibility and Speech recognition ([Help Center](https://support.claude.com/en/articles/12626668-use-quick-entry-with-claude-desktop-on-mac)).

I found no Anthropic page that shows a drag tile.

## What the onboarding takes from them

1. **Only what a feature uses.** All three ask for exactly the panes their feature needs, each with one line on what it is for. Uplink Room asks for Microphone, Camera, Screen Recording and Notifications, and not Accessibility.
2. **Live status per permission**, as Claude's Settings page does, re-read when the app comes back to the front (Hex polls).
3. **A system prompt where macOS has one** (Microphone, Camera), and the exact pane where it doesn't, or after a denial, with the `com.apple.settings.PrivacySecurity.extension?Privacy_*` links Hex uses.
4. **The drag tile only where the list takes drops.** Screen Recording does; Microphone and Camera don't (Hex's rule), so after a denial they get "Switch on Uplink Room in the list" instead. The tile is the app's icon and name, as System Settings lists it, and dragging it hands macOS the `.app` bundle, like Hex's `NSDraggingSession`. In Electron that is `webContents.startDrag({ file, icon })` with the bundle's path.
5. **Say when a restart is needed**: after Screen Recording is switched on, and after a denial is reversed.
6. **No tile in development**: an unpackaged run is Electron's own app, so the tile would name the wrong thing. It shows the pane link alone, as Hex does.
