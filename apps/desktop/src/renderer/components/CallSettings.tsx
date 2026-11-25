import "./calls.css";
/**
 * The call dock's call settings (DESIGN.md "Calls"): the microphone with its level, the speaker
 * with a test sound, the camera and its quality, and whether Krisp noise cancellation is on.
 *
 * The same popover is the camera's preview: turning the camera on opens your own picture first,
 * mirrored, with the camera picker and the quality. "Turn on camera" publishes it; "Cancel" stops
 * the preview without publishing anything.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import {
  createPopoverController,
  Popover,
  PopoverContent,
  PopoverTitle,
  type PopoverController,
} from "@ui-sdk/react/popover";
import { SegmentedControl, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import { useCall } from "../lib/call";
import { fakeMedia } from "../lib/desktop";
import {
  CAMERA_QUALITIES,
  cameraAllowed,
  effectiveCamera,
  type CameraQuality,
} from "../lib/callQuality";
import { deviceFor, useCameraPreview, useDevices, useSavedDevice } from "../lib/devices";
import { useCallQualityLimit } from "./CallQuality";
import { CameraPicture, DevicePicker, MicLevel, SpeakerTest } from "./Devices";

const KRISP_LINE = {
  on: "Krisp noise cancellation is on.",
  starting: "Krisp noise cancellation is starting.",
};

/** Why noise cancellation is what it is, in one line. */
function krispLine(state: string, why: string): string {
  if (state === "on" || state === "starting") return KRISP_LINE[state];
  if (why === "Music voice quality")
    return "Krisp is off for Music voice quality: it would damage music.";
  if (why === "not LiveKit Cloud")
    return "Krisp runs on LiveKit Cloud only. The browser's noise suppression is on.";
  if (why === "not in a call") return "Krisp turns on when you join a call.";
  if (why === "synthetic media")
    return "Krisp needs a microphone device; this window uses synthetic media.";
  return "Krisp couldn't start, so the browser's noise suppression is on.";
}

/** Which of the call settings popover's two faces is open: the devices, or the camera's preview. */
export type CallPanel = "settings" | "camera";
export type CallPanelController = PopoverController<CallPanel>;
export const createCallPanel = () => createPopoverController<CallPanel>();

/**
 * The call settings popover, opened through `controller` with "settings" or "camera" as its
 * payload. It rises above `anchor` (the dock, or the call bar's controls), or drops below it near
 * the window's top, and scrolls when the window is too short for it.
 */
export function CallSettings({
  controller,
  anchor,
}: {
  controller: CallPanelController;
  anchor: () => Element | null | undefined;
}) {
  return (
    <Popover controller={controller}>
      <PopoverContent<CallPanel>
        className="pop call-settings"
        side="top"
        sideOffset={6}
        collisionPadding={14}
        anchor={{
          getBoundingClientRect: () => anchor()?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0),
        }}
      >
        {(state) => (
          <CallSettingsBody mode={state.payload ?? "settings"} onClose={() => controller.close()} />
        )}
      </PopoverContent>
    </Popover>
  );
}

function CallSettingsBody({ mode, onClose }: { mode: CallPanel; onClose: () => void }) {
  const call = useCall();
  const box = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  // The popover scrolls in a short window: say there is more below.
  useLayoutEffect(() => {
    const popover = box.current?.closest<HTMLElement>('[data-slot="popover-content"]');
    if (!popover) return;
    const fit = () => setScrolls(popover.scrollHeight > popover.clientHeight + 1);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(popover);
    return () => observer.disconnect();
  }, [mode, call.camera]);
  const limit = useCallQualityLimit();
  const quality = effectiveCamera(call.cameraQuality, limit);
  const { devices: cameras } = useDevices("videoinput");
  const [cameraChoice] = useSavedDevice("videoinput");
  const camera = deviceFor("videoinput", cameras, cameraChoice).id;
  const size = quality === "1080p" ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };
  // The preview runs only while the camera is off and this is the camera's popover.
  const preview = useCameraPreview({
    deviceId: camera,
    ...size,
    enabled: mode === "camera" && !call.camera,
  });
  return (
    <div ref={box} className="call-settings-body">
      <PopoverTitle className="sr-only">
        {mode === "camera" ? "Camera preview" : "Call settings"}
      </PopoverTitle>
      {mode === "camera" ? (
        <div className="call-settings-group">
          <div className="camera-frame">
            {call.camera && call.selfCamera ? (
              <CameraPicture track={call.selfCamera} mirror={!fakeMedia} />
            ) : (
              <CameraPicture stream={preview.stream} mirror={!fakeMedia} />
            )}
            {preview.starting ? (
              <span className="camera-frame-note">Opening the camera…</span>
            ) : null}
            {preview.error ? <span className="camera-frame-note">{preview.error}</span> : null}
          </div>
          <span className="hint">Only you see this until you turn the camera on.</span>
        </div>
      ) : (
        <>
          <Field className="call-settings-group">
            <FieldLabel className="label">Microphone</FieldLabel>
            <DevicePicker kind="audioinput" id="call-mic" />
            <MicLevel source={call.micTrack} label="Your microphone's level" />
            <span className="hint">
              {call.muted
                ? "You're muted: the room hears nothing."
                : krispLine(call.krisp.state, call.krisp.why)}
            </span>
          </Field>
          <div className="sep" />
          <Field className="call-settings-group">
            <FieldLabel className="label">Speaker</FieldLabel>
            <DevicePicker kind="audiooutput" id="call-speaker" />
            <div>
              <SpeakerTest />
            </div>
          </Field>
          <div className="sep" />
        </>
      )}
      <Field className="call-settings-group">
        <FieldLabel className="label">Camera</FieldLabel>
        <DevicePicker kind="videoinput" id="call-camera" />
        <SegmentedControl
          className="seg"
          aria-label="Camera quality"
          style={{ alignSelf: "flex-start" }}
          value={quality}
          onValueChange={(q) => {
            if (q) void call.setCameraQuality(q as CameraQuality);
          }}
        >
          {CAMERA_QUALITIES.map((q) => (
            <SegmentedControlItem key={q} value={q} disabled={!cameraAllowed(q, limit)}>
              <span className="call-quality-label">{q}</span>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </Field>
      {mode === "camera" ? (
        <div className="call-settings-foot">
          <button className="btn" type="button" onClick={onClose}>
            {call.camera ? "Close" : "Cancel"}
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={!call.camera && (preview.starting || Boolean(preview.error))}
            onClick={() => {
              void call.toggleCamera();
              onClose();
            }}
          >
            {call.camera ? "Turn off camera" : "Turn on camera"}
          </button>
        </div>
      ) : null}
      {scrolls ? <div className="call-settings-scroll-cue">Scroll for more settings</div> : null}
    </div>
  );
}
