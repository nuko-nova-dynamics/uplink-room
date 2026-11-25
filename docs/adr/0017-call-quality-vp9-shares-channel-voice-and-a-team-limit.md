---
status: accepted
---

# Call quality: VP9 screen shares with a VP8 backup, voice quality per channel, and a team limit

Calls used to send what livekit-client 2.23.0 sends by default: Opus mono up to 48 kbps, a 720p camera, and screen shares at 1080p and 15 fps in VP8. Issue #87 asked for choices like Discord's: a channel's voice quality, a screen share's quality picked when sharing starts (with 60 fps at 720p, 1080p and the source's own size), a camera quality per person, a way for a viewer to force the low layer, and a team limit, since LiveKit Cloud bills by bandwidth.

## Decisions

**Screen shares publish VP9, with VP8 as LiveKit's backup codec.** LiveKit's docs list VP9 and AV1 side by side, both with SVC, and recommend neither for screen sharing (docs.livekit.io, "Codecs and more"). Neither has a hardware encoder on a Mac: Apple lists AV1 decode, not encode, in every Apple Silicon Media Engine through M5 Pro and Max, and Chromium encodes VP9 with libvpx. Encoding the same 1080p60 capture at the same bitrate in Electron 45 on an M3 Max, AV1 (libaom) used 97 to 107% of a core and VP9 (libvpx) 75 to 79%, against 23% for capture alone: AV1's encode costs about half again as much. AV1 in Chromium has also had receive-side trouble lately: livekit-client 2.23.0 works around Chrome 152 no longer decoding AV1 without the dependency descriptor (`negotiateDependencyDescriptor`). VP9 decodes in every Chromium. A viewer that can't decode VP9 gets VP8 from LiveKit's backup codec.

**As rid simulcast of single-layer VP9 (`L1T3`), not multi-layer SVC.** livekit-client 2.23.0 publishes VP9 as simulcast when `simulcast` is on, the scalability mode is `L1Tx` and the server is newer than 1.13.6. That gives two layers, full size and half size, so adaptive stream, dynacast and the viewer's Low can pick one, and it leaves the content hint alone. In multi-layer SVC mode livekit-client forces `motion` on every screen share and drops it to `L1T3`, because Chrome's screen-content path is limited there; with simulcast the measured Sharp share kept `detail` and ran at 15 fps.

**Each share choice is a `VideoPreset` with a bitrate from one rule.** LiveKit's screen share presets stop at 1080p and 30 fps. Each choice takes LiveKit's VP8 preset for its size at 30 fps (`ScreenSharePresets.h1080fps15` 2.5 Mbps, `h1080fps30` 5, `h720fps30` 2, `VideoPresets.h2160` 8), times 1.5 at 60 fps (twice the frames, each changing less from the last), times 0.85 for VP9, the factor livekit-client applies itself when it picks a VP9 bitrate:

| Choice | Capture cap | Frame rate | Top layer cap | Content hint |
|---|---|---|---|---|
| Sharp | 1920×1080 | 15 | 2.1 Mbps | detail |
| Balanced (default) | 1920×1080 | 30 | 4.3 Mbps | detail |
| Smooth | 1280×720 | 60 | 2.6 Mbps | motion |
| Smooth HD | 1920×1080 | 60 | 6.4 Mbps | motion |
| Source | 3840×2160 | 30 | 6.8 Mbps | detail |
| Source at 60 | 3840×2160 | 60 | 10.2 Mbps | motion |

Balanced hints `detail`: most shares are code, documents and apps, where blurred text costs more than a dropped frame.

**Capture asks 10% above the frame rate.** Chromium's screen capture delivered about 0.92 of the rate asked on this team's Mac (Electron 45, Chromium 156, macOS 27.2, 75 Hz and 100 Hz displays): asking 60 gave 52.7 to 56 fps, asking 66 gave 61, a higher `max` with the same `ideal` changed nothing, and asking 120 gave the content's full 100. So `getDisplayMedia` asks for 17, 33 or 66 fps, and each encoding's `maxFramerate` (15, 30 or 60) holds what is sent. Giving the encoder the same headroom at 60 was tried and dropped: it didn't raise a short Smooth share, and it let Source at 60 send 62.

**What the choices sent on LiveKit Cloud** (2026-11-03, sharer and viewer on the M3 Max, a 1920×1080 window shared, the viewer's tile expanded; sharer CPU is its app's whole process tree, where 100% is one core and 17 to 18% is the call with no share):

| Choice | Top layer sent | Viewer received | Sharer CPU |
|---|---|---|---|
| Sharp | 1864×1078, 14.9 fps, 1.2 to 1.8 Mbps | 14.6 to 14.9 fps | 42 to 58% |
| Balanced | 1864×1078, 29.8 fps, 3.5 Mbps | 28.6 fps | 88% |
| Smooth | 1242×718, 60.1 fps, 2.6 Mbps | 58.2 fps | 64% |
| Smooth HD | 1864×1078, 59.8 fps, 6.4 Mbps | 57.5 fps | 100% |
| Source | 1920×1112 (the window's own size), 29.8 fps, 4.9 Mbps | 29.1 fps | 82% |
| Source at 60 | 1920×1112, 60.2 fps, 7.7 Mbps | 58.1 fps | 87% |

The 60 fps rows are a still page with moving squares; Balanced and Source at 30 are an animation that recolors every pixel every frame, a worst case, and Sharp was measured with both (1.2 Mbps and 42% for the page, 1.8 Mbps and 58% for the animation). The worst case sent Smooth at 53 fps (using all of its 2.6 Mbps) and Smooth HD at 40 to 57 fps (with 4.5 to 6.3 Mbps of the link's estimate): libvpx drops frames when a picture needs more bits than it has, and the share goes on, as issue #87 asks. Each layer is VP9 `L1T3`; the low layer is half size.

**On Windows, 60 fps can't hold on a display faster than 60 Hz.** Since Chromium 151, Windows 11 24H2 and later capture through Windows Graphics Capture, whose default `MinUpdateInterval` of 16 ms makes frames land on every second or third refresh: about 48 fps at 144 Hz, 53 at 160, 55 at 165 (Chromium issue 565075148, open with pending changes in Chromium 156, which Electron 45 uses). The picker says so on Windows for the display picked. A 60 Hz display, or one at 120 or 240 Hz, still gets 60.

**Voice quality lives on the channel, through the Room API.** `channels.setCallQuality` (ADR 0003) sets it, so agents, the CLI and MCP can too; admins choose in team channels and any member in a private channel or direct message. Music is LiveKit's `musicHighQualityStereo` preset (128 kbps) with stereo forced and DTX and RED off, captured in stereo with noise suppression, Krisp and auto gain off and echo cancellation kept, so a call never hears itself. A change reaches every app through its `channels.list` subscription and each republishes its microphone. A share's own sound is captured and published the same way as Music, whatever the channel's voice quality. Measured on LiveKit Cloud with Chromium's fake microphone: Music sent 128 kbps with `stereo=1`, and LiveKit listed the track as stereo with STEREO, NO_DTX and ECHO_CANCELLATION and without NOISE_SUPPRESSION or AUTO_GAIN_CONTROL; Standard listed AUTO_GAIN_CONTROL, ECHO_CANCELLATION and NOISE_SUPPRESSION.

**The team limit is one setting with three steps.** `standard` allows Standard voice, Sharp shares and a 720p camera; `high` adds High voice, Smooth, Balanced and a 1080p camera; `none` (the default) allows everything. The room refuses a voice quality above the limit and caps a channel chosen higher; the app shows share and camera choices above it as unavailable with the reason, and lowers a running share or camera when the limit drops. LiveKit has no grant that caps a publisher's bitrate, so the share and camera limits are the app's to keep.

**Media changes run in order, against what the person wants now.** `CallMedia` (the app's `lib/callMedia.ts`) keeps each kind's wish (muted, camera on, the share and its quality) apart from what is published, and replaces one at a time. Its lanes belong to one call, what is applied is read from the room's publications, and changes wait for the call's first microphone and for LiveKit's republish after a full reconnect, then reconcile to at most one publication per source. After each device open and publish it checks that the call's room is the same one and that the wish still holds, and stops a track that is no longer wanted instead of publishing it. A failed microphone replacement puts back the quality that worked; if that fails too, unmuting opens a microphone again (PR #89's review).

**The rest stays in the app.** The last share quality and the camera quality (720p or 1080p at 30 fps, LiveKit's `h720` and `h1080` presets) are kept on each computer, like the theme and sounds. A viewer's Low calls `setVideoQuality(VideoQuality.LOW)` on the share's publication; Auto sets it back, so adaptive stream picks by the tile's size again. Measured: Low took an expanded viewer from 1920×1112 to the 960×556 layer; Auto brought 1920×1112 back within 5 seconds in two runs, and in one earlier run was still on the low layer 14 seconds later. Another quality mid-share is a new share of the same screen or window: LiveKit has no public way to change a published track's capture and encodings.

## Consequences

- A team on Standard or High can still have channels set to Music; their calls use the best the limit allows, and go back to Music when the limit goes up.
- Agents that publish audio read `callQuality` from `calls.join` or `channels.list`; nothing forces them to use it.
- A viewer whose client can't decode VP9 makes LiveKit ask the sharer for VP8 as well, which costs the sharer a second encode.
- When Chromium fixes issue 565075148, the Windows note can go; `windowsCaptureFps` in the app's `lib/callQuality.ts` is the one place it's worked out.
