import { canCheckNow, canRestart, type UpdateState } from "../../../main/updateSpec";
import { agoText } from "../../lib/format";
import type { LoginItemState } from "../../../main/loginItemSpec";
import { checkForUpdates, restartToUpdate, useOpenAtLogin, useUpdates } from "../../lib/updates";
import { UpdateReadyView } from "../../components/UpdateReady";
import { OnOff } from "./Notifications";

/**
 * Settings, Updates: the running version, "Check for updates", where the next version stands
 * (main/updates.ts), and "Open at login" (main/loginItem.ts).
 */
export function Updates() {
  const state = useUpdates();
  const [login, setLogin] = useOpenAtLogin();
  return (
    <UpdatesView
      state={state}
      onCheck={checkForUpdates}
      onRestart={restartToUpdate}
      openAtLogin={login}
      onOpenAtLogin={setLogin}
    />
  );
}

/** The pane for any state; update-harness.tsx renders it with sample data. */
export function UpdatesView({
  state,
  onCheck,
  onRestart,
  openAtLogin = null,
  onOpenAtLogin = () => {},
}: {
  state: UpdateState | null;
  onCheck: () => Promise<unknown>;
  onRestart: () => Promise<boolean>;
  openAtLogin?: LoginItemState | null;
  onOpenAtLogin?: (on: boolean) => void;
}) {
  return (
    <>
      <div className="pane-title">
        <h2>Updates</h2>
      </div>
      <div className="panel updates-panel">
        <div className="panel-section">
          <span className="label">Version</span>
          <span className="update-version">
            {state?.version ?? "Unknown"}
            {state?.channel === "test" ? <span className="tag">Test build</span> : null}
          </span>
        </div>
        <div className="panel-section">
          <div className="row-flex update-actions">
            {state && canRestart(state) ? (
              <UpdateReadyView placement="settings" state={state} onRestart={onRestart} />
            ) : (
              <>
                <button
                  className="btn"
                  type="button"
                  disabled={!state || !canCheckNow(state)}
                  onClick={() => void onCheck()}
                >
                  {state?.phase === "checking" ? "Checking" : "Check for updates"}
                </button>
                <span className="hint" role="status">
                  {state ? status(state) : "This build of the app doesn't update itself."}
                </span>
              </>
            )}
          </div>
          {state && state.phase !== "off" ? (
            <span className="hint update-note">
              Uplink Room checks when it opens and every 4 hours, and downloads new versions in the
              background. A downloaded update installs when you restart or quit. If you don't, the
              app restarts for it on its own once nobody has used this computer for 30 minutes or
              the screen is locked, and opens again. It never restarts during a call, or while
              terminals run on this computer.
            </span>
          ) : null}
        </div>
      </div>
      {openAtLogin?.supported ? (
        <div className="panel updates-panel">
          <div className="panel-section">
            <span className="label" id="open-at-login-label">
              Open at login
            </span>
            <OnOff
              labelledBy="open-at-login-label"
              on={openAtLogin.on}
              onChange={onOpenAtLogin}
            />
            <span className="hint">
              Opens Uplink Room when you log in to this computer, so you're in the room and its
              bridge is running without opening the app yourself.
            </span>
            {openAtLogin.needsApproval ? (
              <span className="hint">
                macOS needs your OK first: allow Uplink Room in System Settings, General, Login
                Items.
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function status(state: UpdateState): string {
  const checked = state.checkedAt ? ` Checked ${agoText(state.checkedAt)}.` : "";
  switch (state.phase) {
    case "off":
      if (state.off === "development")
        return "This is a development build, so it doesn't update itself.";
      if (state.off === "linux-package")
        return "This install doesn't update itself. Get new versions from uplinkroom.com/download.";
      if (state.off === "turned-off")
        return "Updates are turned off on this computer (UPLINK_NO_UPDATES).";
      return "This version belongs to no release channel, so it doesn't update itself.";
    case "idle":
      return state.checkedAt ? `You have the latest version.${checked}` : "Not checked yet.";
    case "checking":
      return "Checking for a new version.";
    case "downloading":
      return `Downloading version ${state.next ?? ""}${state.percent ? `, ${state.percent}%` : ""}.`;
    case "preparing":
      return `Checking version ${state.next ?? ""} before it can install.`;
    case "ready":
      return state.inCall
        ? `Version ${state.next ?? ""} is ready. You can restart for it after your call.`
        : `Version ${state.next ?? ""} is ready.`;
    case "failed":
      if (state.failure === "signature")
        return `The last update wasn't signed by Nuko Nova, so it wasn't installed.${checked}`;
      if (state.failure === "channel")
        return `The last update was for another release channel, so it wasn't installed.${checked}`;
      return `The last check or download didn't finish. Try again.${checked}`;
  }
}
