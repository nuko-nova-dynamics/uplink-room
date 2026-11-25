# Microphones, speakers and cameras

`apps/desktop/src/renderer/lib/devices.ts` is the one place the desktop app lists devices, keeps the person's choice and opens a device outside a call. Calls, the call settings popover and Settings → Calls use it; onboarding, or anything else that needs a device, should too, without device code of its own. The pickers built on it are in `components/Devices.tsx`.

## The API

```ts
import {
  DEFAULT_DEVICE,        // "default": follows the system's default device
  listDevices,           // (kind) => Promise<{ devices: DeviceOption[]; labelled: boolean }>
  useDevices,            // (kind) => { devices, labelled, ready, refresh }, kept up to date
  onDevicesChange,       // (listener) => stop: a device plugged in or unplugged
  savedDevice,           // (kind) => the id chosen on this computer, or DEFAULT_DEVICE
  saveDevice,            // (kind, id): remembers it; a call in progress switches at once
  useSavedDevice,        // (kind) => [id, set]
  onSavedDeviceChange,   // (listener) => stop
  deviceFor,             // (kind, devices, choice?) => { id, missing }: the system default while the chosen one is unplugged
  deviceConstraint,      // (kind, id) => a getUserMedia device constraint
  useMicLevel,           // (track | deviceId | null) => { level: 0..1, error }
  useCameraPreview,      // ({ deviceId, width, height, enabled }) => { stream, error, starting }
  playTestSound,         // (outputId) => Promise<void>
  useTestSound,          // (outputId) => { playing, play }
  deviceError,           // (error, "microphone" | "camera") => what to tell the person
} from "../lib/devices";

import { DevicePicker, MicLevel, SpeakerTest, CameraPicture } from "../components/Devices";
```

`kind` is `"audioinput"`, `"audiooutput"` or `"videoinput"`. A `DeviceOption` is `{ id, label, groupId }`; the list starts with the system default ("System default (MacBook Pro Microphone)"; for a camera, "First camera").

- `<DevicePicker kind id />` is a `.select` of a kind's devices. Picking one saves it. A saved device that isn't plugged in stays listed as not connected, with a line saying calls use the system default until it's back.
- `<MicLevel source />` is one bar that fills with the microphone's level. Pass the call's microphone track, or a device id to open just for the meter (it's stopped when the meter goes), or `null`.
- `<SpeakerTest />` plays three short notes on the chosen speaker.
- `<CameraPicture stream />` or `<CameraPicture track />` shows a camera, mirrored by default.

Nothing in the module opens a device until a meter, preview or test is shown, so a screen with pickers never turns the microphone or camera on by itself. Under `UPLINK_FAKE_MEDIA=1` the lists hold sample devices, the meter moves on its own and the preview is drawn.

## In a call

`lib/call.tsx` opens the microphone and camera on the device `deviceFor` gives, and moves the call when a choice changes or a device is plugged in or unplugged:

- **Another microphone or camera chosen:** `CallMedia.setInputDevice` runs `LocalTrack.setDeviceId` in that kind's lane (`lib/callMedia.ts`), so a switch waits behind a voice or camera quality change instead of racing it. The publication, its mute and Krisp stay.
- **Another speaker chosen:** `Room.switchActiveDevice("audiooutput", id)`, and the call's audio elements get the sink too.
- **The chosen device unplugged:** the call moves to the system default and says so; when it's plugged back in, the call moves back. A device is checked against what's plugged in before it's opened, so a saved microphone that's gone opens the default (said once) instead of failing the join; an exact device constraint is used only for a device that's there.
- **A switch that fails** (a busy or broken device): LiveKit stops the old capture before it opens the new one, so the app opens the previous device again (or the system default if that's gone too), says it couldn't switch, and puts the person's previous choice back in the picker. It puts it back only while the failed device is still the choice and no newer switch was asked for, so a device picked meanwhile stays picked.
- **Picked while muted:** LiveKit only notes the device and would open it inside the next unmute; the app opens it at once, still muted, so a device that won't open fails now and an unmute never waits on one.
- **Picked while a device opens:** a pick made while the call's first microphone or camera is still opening is applied once it's published.
- **Picked during a switch:** a switch still on its way counts as where the call is headed, so picking the device the call had (back to the default before the switch to USB finished) moves the call back; and when the newest switch for a kind finishes, the call follows the saved choice if it moved on meanwhile.
- **"Default" chosen and the system default changes** (a headset plugged in): Chromium leaves a track opened on `default` on the old device, so the microphone is opened on the default again.

Choices are kept per computer in local storage: `uplink.device.audioinput`, `uplink.device.audiooutput`, `uplink.device.videoinput`. A missing key is the system default.

## The camera's preview

Turning the camera on from the call dock opens its preview first: your picture mirrored, the camera picker and the quality (720p or 1080p, within the team's limit). **Turn on camera** publishes; **Cancel** stops the preview without publishing. Settings → Calls has **Preview camera** and **Test microphone** for before a call. While your camera is on, the dock shows it, mirrored.
