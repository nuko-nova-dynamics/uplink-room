import "../../components/calls.css";
import { useState } from "react";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { SegmentedControl, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import { PickOne, PickOneItem } from "../../components/PickOne";
import { Toggle } from "@ui-sdk/react/toggle";
import { api } from "../../lib/api";
import { deviceFor, useCameraPreview, useDevices, useSavedDevice } from "../../lib/devices";
import { CameraPicture, DevicePicker, MicLevel, SpeakerTest } from "../../components/Devices";
import { useCall } from "../../lib/call";
import { fakeMedia } from "../../lib/desktop";
import { aboveLimit } from "../../components/CallQuality";
import {
  CALL_QUALITY_LIMITS,
  CAMERA_QUALITIES,
  cameraAllowed,
  effectiveCamera,
  LIMIT_LABEL,
  type CallQualityLimit,
  type CameraQuality,
} from "../../lib/callQuality";
import { useAct, useRoomQuery, useSession } from "../../lib/session";

const LIMIT_HINT: Record<CallQualityLimit, string> = {
  standard: "Voice at Standard (48 kbps). Screen shares at Sharp (1080p, 15 fps). Cameras at 720p.",
  high: "Voice up to High (96 kbps). Screen shares up to Balanced (1080p, 30 fps) and Smooth (720p, 60 fps).",
  none: "Everything: Music voice (128 kbps, stereo), and Smooth HD (1080p, 60 fps) and Source screen shares, up to 4K at 30 or 60 fps.",
};

/**
 * Call settings (issue #87): this computer's microphone, speaker and camera (docs/devices.md) and
 * the camera's quality, and for the team the highest call quality it allows. LiveKit Cloud bills by
 * bandwidth, so admins can cap every channel's voice quality and the screen share choices.
 */
export function Calls() {
  const session = useSession();
  const call = useCall();
  const settings = useRoomQuery(api.teams.settings, {});
  const setLimit = useAct(api.teams.setCallQualityLimit, { success: "Saved." });
  const limit = settings?.callQualityLimit ?? "none";
  const camera = effectiveCamera(call.cameraQuality, limit);
  const cameraAbove = CAMERA_QUALITIES.filter((q) => !cameraAllowed(q, limit));
  return (
    <div className="calls-settings">
      <div className="pane-title">
        <h2>Calls</h2>
      </div>
      <div className="panel">
        <Devices />
        <div className="panel-section">
          <div className="settings-copy">
            <span className="label" id="camera-quality-label">
              Camera quality
            </span>
            <SegmentedControl
              className="seg"
              aria-labelledby="camera-quality-label"
              style={{ alignSelf: "flex-start" }}
              value={camera}
              onValueChange={(quality) => {
                if (quality) void call.setCameraQuality(quality as CameraQuality);
              }}
            >
              {CAMERA_QUALITIES.map((quality) => (
                <SegmentedControlItem
                  key={quality}
                  value={quality}
                  disabled={!cameraAllowed(quality, limit)}
                >
                  <span className="call-quality-label">{quality}</span>
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
            <span className="hint">
              Your camera at 30 fps, on this computer. 1080p sends about twice as much as 720p. A
              camera that's on changes at once.
            </span>
            {cameraAbove.length ? (
              <span className="hint">{aboveLimit(cameraAbove, limit)}</span>
            ) : null}
          </div>
        </div>
        <div className="panel-section">
          <div className="settings-copy">
            <span className="label" id="limit-label">
              Highest call quality allowed
            </span>
            <PickOne<CallQualityLimit>
              className="seg"
              aria-labelledby="limit-label"
              style={{ alignSelf: "flex-start" }}
              value={limit}
              onPick={(value) => void setLimit({ limit: value })}
            >
              {CALL_QUALITY_LIMITS.map((value) => (
                <PickOneItem key={value} value={value} disabled={!session.isAdmin || !settings}>
                  <span className="call-quality-label">{LIMIT_LABEL[value]}</span>
                </PickOneItem>
              ))}
            </PickOne>
            <span className="hint">{LIMIT_HINT[limit]}</span>
            <span className="hint">
              For the whole team. LiveKit Cloud bills calls by bandwidth, so this caps every
              channel's voice quality, the screen share choices and cameras. Higher choices show as
              unavailable, and a share or camera above a new limit is lowered at once.
            </span>
            {session.isAdmin ? null : <span className="hint">Only admins can change this.</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * This computer's devices, used by every call and switched at once in one. The microphone's meter
 * and the camera's preview open the device only when asked (or show the call's own while you're
 * in one), so opening Settings never turns on the microphone or camera by itself.
 */
function Devices() {
  const call = useCall();
  const inCall = call.status !== "idle";
  const [testing, setTesting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const { devices: mics } = useDevices("audioinput");
  const [micChoice] = useSavedDevice("audioinput");
  const { devices: cameras } = useDevices("videoinput");
  const [cameraChoice] = useSavedDevice("videoinput");
  const micSource = inCall
    ? call.micTrack
    : testing
      ? deviceFor("audioinput", mics, micChoice).id
      : null;
  const preview = useCameraPreview({
    deviceId: deviceFor("videoinput", cameras, cameraChoice).id,
    width: 1280,
    height: 720,
    enabled: previewing && !call.camera,
  });
  return (
    <div className="panel-section">
      <Field className="device-row">
        <FieldLabel className="label">Microphone</FieldLabel>
        <DevicePicker kind="audioinput" id="settings-mic" />
        <div className="device-row-actions calls-mic-test">
          {inCall ? (
            <span className="hint">The meter shows your call's microphone.</span>
          ) : (
            <Toggle className="btn" pressed={testing} onPressedChange={setTesting}>
              {testing ? "Stop testing" : "Test microphone"}
            </Toggle>
          )}
          {inCall || testing ? (
            <MicLevel source={micSource} label="Your microphone's level" />
          ) : null}
        </div>
      </Field>
      <Field className="device-row">
        <FieldLabel className="label">Speaker</FieldLabel>
        <DevicePicker kind="audiooutput" id="settings-speaker" />
        <div className="device-row-actions">
          <SpeakerTest compact={false} />
        </div>
      </Field>
      <Field className="device-row">
        <FieldLabel className="label">Camera</FieldLabel>
        <DevicePicker kind="videoinput" id="settings-camera" />
        {previewing || call.camera ? (
          <div className="camera-frame">
            {call.camera && call.selfCamera ? (
              <CameraPicture track={call.selfCamera} mirror={!fakeMedia} />
            ) : (
              <CameraPicture stream={preview.stream} mirror={!fakeMedia} />
            )}
            {preview.error ? <span className="camera-frame-note">{preview.error}</span> : null}
          </div>
        ) : null}
        <div className="device-row-actions">
          {call.camera ? (
            <span className="hint">Your camera is on in the call.</span>
          ) : (
            <Toggle className="btn" pressed={previewing} onPressedChange={setPreviewing}>
              {previewing ? "Stop preview" : "Preview camera"}
            </Toggle>
          )}
        </div>
      </Field>
      <div className="settings-copy">
        <span className="hint">
          Kept on this computer. System default follows the device your computer picks, such as a
          headset when you plug it in. A call in progress switches at once.
        </span>
      </div>
    </div>
  );
}
