import { useEffect, useRef, useState } from "react";
import { Button } from "@ui-sdk/react/button";
import { Dialog as UiDialog, DialogContent } from "@ui-sdk/react/dialog";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { Toggle } from "@ui-sdk/react/toggle";
import { LinkMascot } from "../characters/LinkMascot";
import { Icon } from "../components/Icon";
import type { IconName } from "../lib/states";
import { pairView, type LinkState, type PairView } from "./setupSpec";
import { usePermissions, type PermissionsApi } from "../lib/permissions";
import { deviceFor, useCameraPreview, useDevices, useSavedDevice } from "../lib/devices";
import { fakeMedia } from "../lib/desktop";
import { CameraPicture, DevicePicker, MicLevel, SpeakerTest } from "../components/Devices";
import { BridgeCliRow } from "../components/BridgeCli";
import { useBridgeCli } from "../lib/bridgeCli";
import {
  actionFor,
  PERMISSION_KINDS,
  setupSteps,
  type PermissionKind,
  type PermissionsState,
  type PermissionStatus,
} from "../../main/permissionsSpec";

/**
 * The first-run setup (DESIGN.md, Onboarding), shown once on each computer and again from
 * Settings, Setup: welcome, the macOS permissions the app uses, linking this computer's bridge,
 * and done. Each step past the welcome can be skipped. Windows and Linux skip the permissions step.
 * The devices step uses the shared device module (lib/devices.ts, components/Devices.tsx): nothing
 * opens the microphone or camera until you ask to test it.
 */
export type PairApi = {
  /** True in the installed app, which carries the bridge. */
  available: boolean;
  /** This computer's current pairing, undefined while reading. "unknown" when it couldn't be read. */
  current: LinkState | undefined;
  /**
   * Makes a pairing code and pairs this computer with it. `replace` is true only after the person
   * confirmed replacing the current pairing; without it, main refuses to replace one.
   */
  pair(name: string, options: { replace: boolean }): Promise<void>;
  /** Reads this computer's pairing again. Setup calls it each time it opens. */
  refresh?: () => void | Promise<void>;
};

type Step = ReturnType<typeof setupSteps>[number];

export function Setup({
  me,
  team,
  permissions,
  pair,
  initialStep,
  onDone,
}: {
  me: string;
  team: string;
  permissions: PermissionsApi;
  pair: PairApi;
  initialStep?: Step | undefined;
  onDone: () => void;
}) {
  const perms = usePermissions(permissions);
  const platform =
    perms.state?.platform ?? (navigator.platform.startsWith("Mac") ? "darwin" : "other");
  const steps = setupSteps(platform, true);
  // The current step is kept by name, not by position: the step list changes once the permissions
  // platform is known (macOS adds the Permissions step), and a saved position would then point at
  // the wrong step. A step this platform doesn't have falls back to the first.
  const [current, setCurrent] = useState<Step>(initialStep ?? "welcome");
  const index = Math.max(0, steps.indexOf(current));
  const setIndex = (i: number) => setCurrent(steps[Math.max(0, Math.min(i, steps.length - 1))]!);
  const [linked, setLinked] = useState<string | null>(null);
  const step = steps[index]!;
  const last = index >= steps.length - 1;
  const forward = () => (last ? onDone() : setIndex(index + 1));
  const dialog = useRef<HTMLDivElement>(null);
  // Each step starts with focus on the dialog itself, so no control shows a ring before a key is
  // pressed; from there Tab goes to its first control and Shift+Tab to its last.
  useEffect(() => dialog.current?.focus(), [index]);
  // Each time setup opens, read the pairing again: it may have changed since the app started.
  const refreshPairing = pair.refresh;
  useEffect(() => {
    void refreshPairing?.();
  }, [refreshPairing]);
  const done = useRef(onDone);
  done.current = onDone;

  const first = me.split(/\s+/)[0] ?? me;
  const statuses = perms.state?.statuses;
  const allAllowed = statuses
    ? (["microphone", "camera", "screen"] as const).every((k) => statuses[k] === "granted")
    : false;
  // Skip is offered while there's something left to do on the step; Continue once there isn't.
  const [replace, setReplace] = useState<"no" | "asked" | "confirmed">("no");
  const pv = pairView({
    available: pair.available,
    current: pair.current,
    linkedNow: Boolean(linked),
    replace,
  });
  /** The pairing this computer already had, as read (not assumed) when setup opened. */
  const existing = pair.current?.status === "paired" ? pair.current.name : null;
  const pairing =
    step === "pair" && (pv === "form" || pv === "confirm-replace" || pv === "unknown");
  const pending = (step === "permissions" && !allAllowed) || pairing;
  const showContinue = !pairing;
  // Link's face follows the step: happy when it's all done, blocked when linking failed, calm otherwise.
  const [pairFailed, setPairFailed] = useState(false);
  const [pairBusy, setPairBusy] = useState(false);
  // Link is calm on every step (its antenna glows only when something needs you), and blocked when linking fails.
  const mood = step === "pair" && pairFailed && !linked ? "failed" : "idle";
  // A modal on UI SDK's Dialog: the window behind it is inert, Tab stays inside, and Escape closes it.
  // Its content is the dimmed full-window `.overlay`, with the `.onboarding` box inside.
  return (
    <UiDialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        // Setup stays open until its caller unmounts it.
        details.cancel();
        done.current();
      }}
    >
      <DialogContent
        ref={dialog}
        className="overlay onboarding-overlay"
        aria-labelledby="setup-title"
        initialFocus="content"
        finalFocus="none"
      >
        <div className="onboarding setup" data-step={step}>
          <div className="ob-link">
            <LinkMascot size={150} state={mood} lively reacts={false} />
          </div>
          <div className="ob-main">
            {step === "welcome" ? (
              <>
                <h2 id="setup-title">Hi {first}, I'm Link.</h2>
                <p>
                  Welcome to <b>{team}</b>. I'll get this computer ready for calls and for your team's
                  agents. It takes a minute, and you can change any of it later in Settings, Setup.
                </p>
                <ol className="setup-plan">
                  {steps.slice(1, -1).map((s) => (
                    <li key={s}>
                      <Icon
                        name={s === "devices" ? "mic" : s === "permissions" ? "lock" : "machine"}
                      />
                      {s === "devices"
                        ? "Pick your microphone, speaker and camera"
                        : s === "permissions"
                          ? "Allow the microphone, camera, screen sharing and banners"
                          : "Link this computer's bridge"}
                    </li>
                  ))}
                </ol>
              </>
            ) : step === "devices" ? (
              <DevicesStep />
            ) : step === "permissions" ? (
              <>
                <h2 id="setup-title">What I need on this Mac</h2>
                <p>Calls and banners use these four. I'll never ask for anything else.</p>
                <PermissionList api={permissions} state={perms.state} onState={perms.setState} />
              </>
            ) : step === "pair" ? (
              <PairStep
                me={first}
                pair={pair}
                view={pv}
                replaceConfirmed={replace === "confirmed"}
                linked={linked}
                onReplace={setReplace}
                onLinked={setLinked}
                onFailed={setPairFailed}
                onBusy={setPairBusy}
              />
            ) : (
              <DoneStep state={perms.state} linked={linked ?? existing} platform={platform} />
            )}
            <div className="ob-nav">
              <div className="ob-dots" aria-label={`Step ${index + 1} of ${steps.length}`}>
                {steps.map((s, i) => (
                  <i key={s} className={i === index ? "on" : ""} />
                ))}
              </div>
              {index > 0 ? (
                <button className="btn" type="button" onClick={() => setIndex(index - 1)}>
                  Back
                </button>
              ) : null}
              {pending ? (
                <button className="btn" type="button" onClick={forward}>
                  Skip for now
                </button>
              ) : null}
              {showContinue ? (
                <button className="btn primary" type="button" onClick={forward}>
                  {last ? "Open my Inbox" : step === "welcome" ? "Get started" : "Continue"}
                </button>
              ) : pv === "form" ? (
                // The form's own submit runs the link, so its busy flag disables this; it keeps focus.
                <Button
                  className="btn primary"
                  type="submit"
                  form="setup-pair-form"
                  disabled={pairBusy}
                  focusableWhenDisabled
                >
                  {pairBusy ? "Linking" : pairFailed ? "Try again" : "Link this computer"}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </DialogContent>
    </UiDialog>
  );
}

const PERMISSION_META: Record<PermissionKind, { label: string; icon: IconName; why: string }> = {
  microphone: { label: "Microphone", icon: "mic", why: "So people hear you in calls." },
  camera: { label: "Camera", icon: "camera", why: "When you turn your camera on in a call." },
  screen: {
    label: "Screen Recording",
    icon: "screen",
    why: "When you share your screen in a call.",
  },
  notifications: { label: "Notifications", icon: "bell", why: "Banners when something needs you." },
};

const STATUS_LABEL: Record<PermissionStatus, string> = {
  granted: "Allowed",
  denied: "Off",
  "not-determined": "Not asked yet",
  restricted: "Managed by your organization",
  unknown: "Not tested yet",
};

/** Each permission with its state, what it is for, and the one thing to do about it. */
export function PermissionList({
  api,
  state,
  onState,
}: {
  api: PermissionsApi;
  state: PermissionsState | null;
  onState: (state: PermissionsState | null) => void;
}) {
  const [opened, setOpened] = useState<PermissionKind | null>(null);
  const [tested, setTested] = useState(false);
  if (!state) return <div className="setup-perms" aria-busy="true" />;
  return (
    <ul className="setup-perms" aria-label="Permissions">
      {PERMISSION_KINDS.map((kind) => {
        const meta = PERMISSION_META[kind];
        const status = kind === "notifications" && tested ? "unknown" : state.statuses[kind];
        const action = actionFor(kind, status);
        return (
          <li key={kind} className="setup-perm" data-kind={kind} data-status={status}>
            <span className="setup-perm-icon">
              <Icon name={meta.icon} />
            </span>
            <span className="setup-perm-text">
              <b>{meta.label}</b>
              <span className="muted">
                {action === "switch-on" && opened === kind
                  ? "Switch it on there, then reopen the app."
                  : meta.why}
              </span>
            </span>
            <span className="setup-side">
              <span className={`setup-status status-${status}`}>
                {status === "granted" ? (
                  <Icon name="check" />
                ) : status === "denied" ? (
                  <Icon name="x" />
                ) : null}
                {kind === "notifications" && tested ? "Sent. Look for it" : STATUS_LABEL[status]}
              </span>
              {action === "ask" ? (
                <button
                  className="btn"
                  type="button"
                  onClick={async () =>
                    onState((await api.ask(kind as "microphone" | "camera")) ?? state)
                  }
                >
                  Allow
                </button>
              ) : action === "list" || action === "switch-on" ? (
                <button
                  className="btn"
                  type="button"
                  aria-label={`Open ${meta.label} in System Settings`}
                  onClick={async () => {
                    setOpened(kind);
                    await api.open(kind);
                  }}
                >
                  System Settings
                </button>
              ) : action === "test" ? (
                <button
                  className="btn"
                  type="button"
                  onClick={async () => {
                    setTested(true);
                    await api.testNotification();
                  }}
                >
                  Send a test
                </button>
              ) : null}
            </span>
            {kind === "screen" && status !== "granted" ? (
              <span className="setup-perm-extra setup-drag-row">
                {state.packaged ? (
                  <span
                    className="setup-tile"
                    draggable
                    role="img"
                    aria-label={`${state.appName}, drag into the Screen Recording list`}
                    title="Drag into the list in System Settings"
                    onDragStart={(event) => {
                      event.preventDefault();
                      api.drag();
                    }}
                  >
                    <span className="app-icon" aria-hidden="true">
                      <LinkMascot size={22} reacts={false} />
                    </span>
                    {state.appName}
                  </span>
                ) : null}
                <span className="hint">
                  {opened === "screen"
                    ? state.packaged
                      ? "Drag it into the list, or switch it on there. Then reopen the app."
                      : "Switch it on in the list, then reopen the app."
                    : state.packaged
                      ? "Open System Settings, then drag this into the list."
                      : "Open System Settings, then switch it on in the list."}
                </span>
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function PairStep({
  me,
  pair,
  view,
  replaceConfirmed,
  linked,
  onReplace,
  onLinked,
  onFailed,
  onBusy,
}: {
  me: string;
  pair: PairApi;
  view: PairView;
  replaceConfirmed: boolean;
  linked: string | null;
  onReplace: (replace: "no" | "asked" | "confirmed") => void;
  onLinked: (name: string) => void;
  onFailed: (failed: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [name, setName] = useState(
    `${me}'s ${navigator.platform.startsWith("Mac") ? "Mac" : "computer"}`,
  );
  const [error, setError] = useState<string | null>(null);
  // `uplink-bridge` in a terminal: shown here, changed only by its own button.
  const cli = useBridgeCli();
  return (
    <>
      <h2 id="setup-title">Can I link this computer?</h2>
      <p>
        Then your team's agents can run terminals here, inside limits you set. I run its bridge
        while the app is open, and you can stop sharing any time in Settings, Machines.
      </p>
      {view === "checking" ? (
        <p className="hint setup-pair">Checking whether this computer is linked…</p>
      ) : view === "linked" && linked ? (
        <p className="setup-linked" role="status">
          <Icon name="check" /> {linked} is linked. Its bridge is running.
        </p>
      ) : view === "linked" ? (
        <div className="setup-pair">
          <p className="setup-linked" role="status">
            <Icon name="check" /> This computer is linked as{" "}
            {pair.current?.status === "paired" ? pair.current.name : "a machine"}. Its bridge is
            running.
          </p>
          <button className="btn" type="button" onClick={() => onReplace("asked")}>
            Replace this pairing…
          </button>
        </div>
      ) : view === "unknown" ? (
        <div className="note warn setup-replace" role="alert">
          <p>
            Couldn't check this computer's link
            {pair.current?.status === "unknown"
              ? ` (${pair.current.error.replace(/\.$/, "")})`
              : ""}
            . It may already be linked, and linking it again would replace that pairing, so check
            again first.
          </p>
          <div className="row-flex">
            <button className="btn" type="button" onClick={() => void pair.refresh?.()}>
              Retry
            </button>
          </div>
        </div>
      ) : view === "confirm-replace" ? (
        <div className="note warn setup-replace" role="alert">
          <p>
            Replace this computer's pairing with{" "}
            {pair.current?.status === "paired" ? pair.current.name : "its machine"}? Linking it
            again stops its running terminals, deletes the profiles and threads saved on it, and
            gives it a new identity in the room. Teammates can't reach it until it's linked again.
          </p>
          <div className="row-flex">
            <button className="btn" type="button" onClick={() => onReplace("no")}>
              Keep this pairing
            </button>
            <button
              className="btn shell-danger"
              type="button"
              onClick={() => onReplace("confirmed")}
            >
              Replace pairing
            </button>
          </div>
        </div>
      ) : view === "form" ? (
        // The field is the form itself, so the label, box and hint keep the form's own layout.
        <Field
          render={
            <form
              id="setup-pair-form"
              className="field setup-pair"
              onSubmit={async (event) => {
                event.preventDefault();
                if (!name.trim()) return;
                onBusy(true);
                setError(null);
                try {
                  await pair.pair(name.trim(), { replace: replaceConfirmed });
                  onFailed(false);
                  onLinked(name.trim());
                } catch (failure) {
                  setError(failure instanceof Error ? failure.message : "Something went wrong.");
                  onFailed(true);
                } finally {
                  onBusy(false);
                }
              }}
            />
          }
        >
          <FieldLabel className="label">Name it</FieldLabel>
          <Input id="setup-machine" className="input" value={name} onValueChange={setName} />
          <FieldDescription className="hint" render={<span />}>
            Teammates see this name in the Roster and on its terminals.
          </FieldDescription>
        </Field>
      ) : (
        <p className="note">
          The installed app carries the bridge. Link a computer later from Settings, Machines.
        </p>
      )}
      {error && !linked ? (
        <p className="note setup-error-note" role="alert">
          <Icon name="alert" />
          <span>
            This computer isn't linked:{" "}
            {error.charAt(0).toLowerCase() + error.slice(1).replace(/\.$/, "")}. Try again, or skip
            and link it later in Settings, Machines.
          </span>
        </p>
      ) : null}
      {view === "unavailable" ? null : <BridgeCliRow cli={cli} />}
    </>
  );
}

function DoneStep({
  state,
  linked,
  platform,
}: {
  state: PermissionsState | null;
  linked: string | null;
  platform: string;
}) {
  const media = ["microphone", "camera", "screen"] as const;
  const allowed = state ? media.filter((k) => state.statuses[k] === "granted").length : 0;
  const everything = (platform !== "darwin" || allowed === media.length) && linked !== null;
  return (
    <>
      <h2 id="setup-title">{everything ? "You're all set" : "That's it for now"}</h2>
      <ul className="setup-summary">
        {platform === "darwin" ? (
          <li className={allowed === media.length ? "set" : ""}>
            <Icon name={allowed === media.length ? "check" : "clock"} />
            {allowed === media.length
              ? "Calls can use the microphone, camera and screen."
              : `${allowed} of ${media.length} call permissions allowed. I'll ask again when a call needs the rest.`}
          </li>
        ) : null}
        <li className={linked ? "set" : ""}>
          <Icon name={linked ? "check" : "clock"} />
          {linked
            ? `This computer is linked as ${linked}.`
            : "This computer isn't linked. Link it any time in Settings, Machines."}
        </li>
      </ul>
      <h3 className="setup-subhead">Three things work differently here</h3>
      <ul className="setup-ideas">
        <li>
          <Icon name="inbox" />
          <span>
            <b>Your Inbox</b> holds what needs you, what's working and what's done.
          </span>
        </li>
        <li>
          <Icon name="user" />
          <span>
            <b>The roster</b> shows each agent and what it's doing.
          </span>
        </li>
        <li>
          <Icon name="wheel" />
          <span>
            <b>Control</b> passes between people: one person is in control of an agent at a time.
          </span>
        </li>
      </ul>
    </>
  );
}

/**
 * The microphone, speaker and camera calls use on this computer, saved here as Settings, Calls saves
 * them. The level meter and the camera's picture start only when you ask: opening a device is what
 * makes macOS ask for it.
 */
function DevicesStep() {
  const [testing, setTesting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [micChoice] = useSavedDevice("audioinput");
  const { devices: mics } = useDevices("audioinput");
  const mic = deviceFor("audioinput", mics, micChoice).id;
  const [cameraChoice] = useSavedDevice("videoinput");
  const { devices: cameras } = useDevices("videoinput");
  const camera = deviceFor("videoinput", cameras, cameraChoice).id;
  const preview = useCameraPreview({
    deviceId: camera,
    width: 640,
    height: 360,
    enabled: previewing,
  });
  return (
    <>
      <h2 id="setup-title">How should I hear and see you?</h2>
      <p>
        Pick what calls use on this computer. You can change it in any call, or in Settings, Calls.
      </p>
      <div className="setup-devices">
        <div className="setup-device">
          <label className="label" htmlFor="setup-mic">
            Microphone
          </label>
          <div className="setup-device-row">
            <DevicePicker kind="audioinput" id="setup-mic" />
            <Toggle className="btn" pressed={testing} onPressedChange={setTesting}>
              {testing ? "Stop test" : "Test"}
            </Toggle>
          </div>
          {testing ? (
            <MicLevel source={mic} label="Your microphone's level" />
          ) : (
            <span className="hint">Test it, then speak: the bar moves with your voice.</span>
          )}
        </div>
        <div className="setup-device">
          <label className="label" htmlFor="setup-speaker">
            Speaker
          </label>
          <div className="setup-device-row">
            <DevicePicker kind="audiooutput" id="setup-speaker" />
            <SpeakerTest compact={false} />
          </div>
        </div>
        <div className="setup-device">
          <label className="label" htmlFor="setup-camera">
            Camera
          </label>
          <div className="setup-device-row">
            <DevicePicker kind="videoinput" id="setup-camera" />
            <Toggle className="btn" pressed={previewing} onPressedChange={setPreviewing}>
              {previewing ? "Stop preview" : "Preview"}
            </Toggle>
          </div>
          {previewing ? (
            <div className="camera-frame setup-camera">
              <CameraPicture stream={preview.stream} mirror={!fakeMedia} />
              {preview.starting ? (
                <span className="camera-frame-note">Opening the camera…</span>
              ) : null}
              {preview.error ? <span className="camera-frame-note">{preview.error}</span> : null}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
