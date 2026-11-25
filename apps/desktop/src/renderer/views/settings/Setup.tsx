import { usePermissions, type PermissionsApi } from "../../lib/permissions";
import { useBridgeCli } from "../../lib/bridgeCli";
import { BridgeCliRow } from "../../components/BridgeCli";
import { PermissionList } from "../Setup";

/**
 * Settings, Setup: this computer's permissions as they stand now, `uplink-bridge` in a terminal, and
 * the first-run setup again.
 */
export function SetupSettings({ permissions, onRunSetup }: { permissions: PermissionsApi; onRunSetup?: (() => void) | undefined }) {
  const perms = usePermissions(permissions);
  const cli = useBridgeCli();
  const mac = perms.state?.platform === "darwin";
  return (
    <>
      <div className="pane-title">
        <h2>Setup</h2>
        {onRunSetup ? (
          <button className="btn" type="button" onClick={onRunSetup}>
            Run setup again
          </button>
        ) : null}
      </div>
      <div className="panel">
        <div className="panel-section">
          <span className="label">Permissions on this {mac ? "Mac" : "computer"}</span>
          {mac || perms.state === null ? (
            <PermissionList api={permissions} state={perms.state} onState={perms.setState} />
          ) : (
            <p className="hint">This computer doesn't ask for permissions. Calls use the devices you pick in a call.</p>
          )}
        </div>
        {cli.status !== null || cli.error ? (
          <div className="panel-section">
            <span className="label">The bridge on this {mac ? "Mac" : "computer"}</span>
            <BridgeCliRow cli={cli} />
          </div>
        ) : null}
      </div>
    </>
  );
}
