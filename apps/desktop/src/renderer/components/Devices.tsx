/**
 * Device pickers (docs/devices.md), built on lib/devices.ts: the call settings popover and
 * Settings, Calls use them, and onboarding can too. Each is a plain control in the app's own
 * styles (`.select`, `.btn`), with no call logic of its own.
 *
 *  - `DevicePicker`: a kind's devices, saved on this computer when one is picked.
 *  - `MicLevel`: a microphone's level as one bar, from a track or by opening the device.
 *  - `SpeakerTest`: "Play test sound" on the chosen speaker.
 *  - `CameraPicture`: a camera stream, mirrored like a mirror.
 */
import { useEffect, useRef, useState } from "react";
import { Meter } from "@ui-sdk/react/meter";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import {
  KIND_LABEL,
  useDevices,
  useMicLevel,
  useSavedDevice,
  useTestSound,
  type DeviceKind,
} from "../lib/devices";
import { Icon } from "./Icon";
import { Tip } from "./Tip";
import "./remaining.css";
import "./devices.css";

/** A kind's devices as a select, with "System default" first. Picking one saves it for this computer. */
export function DevicePicker({
  kind,
  id,
  onPicked,
}: {
  kind: DeviceKind;
  id: string;
  onPicked?: (deviceId: string) => void;
}) {
  const { devices, labelled, ready } = useDevices(kind);
  const [chosen, choose] = useSavedDevice(kind);
  // A saved device that isn't plugged in stays listed, so the choice isn't silently lost.
  const missing = ready && !devices.some((d) => d.id === chosen);
  const options = missing ? [...devices, { id: chosen, label: "Not connected" }] : devices;
  const shown = options.find((d) => d.id === chosen)?.label ?? "System default";
  return (
    <>
      <div className="device-picker">
        <Select
          value={options.some((d) => d.id === chosen) ? chosen : null}
          items={options.map((device) => ({ value: device.id, label: device.label }))}
          placeholder="System default"
          onValueChange={(next) => {
            if (typeof next !== "string") return;
            choose(next);
            onPicked?.(next);
          }}
        >
          <Tip label={shown}>
            <SelectTrigger id={id} className="select device-select" aria-label={KIND_LABEL[kind]}>
              <SelectValue className="truncate" />
            </SelectTrigger>
          </Tip>
          <SelectContent className="pop device-list" sideOffset={4} collisionPadding={8}>
            {options.map((device) => (
              <SelectItem key={device.id} value={device.id} label={device.label}>
                <span className="device-option-label">{device.label}</span>
                <SelectItemIndicator>
                  <Icon name="check" size={14} />
                </SelectItemIndicator>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {missing ? (
        <span className="hint device-hint">
          The {KIND_LABEL[kind].toLowerCase()} you chose isn't connected, so calls use the system
          default until it's back.
        </span>
      ) : null}
      {ready && !labelled && kind !== "audiooutput" ? (
        <span className="hint device-hint">
          Device names show once Uplink Room has used the {KIND_LABEL[kind].toLowerCase()}.
        </span>
      ) : null}
    </>
  );
}

/**
 * A microphone's level: one bar that fills as you speak. `source` is the call's microphone track,
 * a device id to open just for this meter, or null to show it at rest.
 */
export function MicLevel({
  source,
  label = "Microphone level",
}: {
  source: MediaStreamTrack | string | null;
  label?: string;
}) {
  const { level, error } = useMicLevel(source);
  if (error)
    return (
      <span className="hint device-error">
        <Icon name="alert" size={14} />
        {error}
      </span>
    );
  // The bar scales rather than resizes, so it follows the sound without laying the row out again.
  return (
    <Meter className="mic-level" aria-label={label} value={Math.round(level * 100)}>
      <span style={{ transform: `scaleX(${level})` }} />
    </Meter>
  );
}

/** Plays a short sound on the chosen speaker. */
export function SpeakerTest({ compact = false }: { compact?: boolean }) {
  const [speaker] = useSavedDevice("audiooutput");
  const { playing, play } = useTestSound(speaker);
  return (
    <button
      className={`btn speaker-test ${compact ? "small" : ""}`}
      type="button"
      disabled={playing}
      onClick={play}
    >
      <Icon name="volume" size={14} /> {playing ? "Playing" : "Play test sound"}
    </button>
  );
}

/** A camera's picture, mirrored as people expect to see themselves. */
export function CameraPicture({
  stream,
  track,
  mirror = true,
}: {
  stream?: MediaStream | null;
  track?: { attach(el: HTMLVideoElement): void; detach(el: HTMLVideoElement): void } | null;
  mirror?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    setPlaying(false);
    setFailed(false);
    if (track) {
      track.attach(element);
      return () => track.detach(element);
    }
    element.srcObject = stream ?? null;
    return () => {
      element.srcObject = null;
    };
  }, [stream, track]);
  const label = failed
    ? "Camera unavailable"
    : stream || track
      ? "Connecting camera…"
      : "Camera off";
  return (
    <div className="camera-picture" aria-busy={Boolean((stream || track) && !playing && !failed)}>
      <video
        ref={ref}
        className={mirror ? "mirror" : ""}
        muted
        playsInline
        autoPlay
        onPlaying={() => {
          setPlaying(true);
          setFailed(false);
        }}
        onWaiting={() => setPlaying(false)}
        onEmptied={() => setPlaying(false)}
        onError={() => {
          setFailed(true);
          setPlaying(false);
        }}
      />
      {!playing ? (
        <span className="camera-placeholder" role="status">
          <Icon name={failed ? "alert" : stream || track ? "working" : "camera-off"} size={14} />
          <span>{label}</span>
        </span>
      ) : null}
    </div>
  );
}
