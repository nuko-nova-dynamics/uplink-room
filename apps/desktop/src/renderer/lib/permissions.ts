import { useCallback, useEffect, useState } from "react";
import type { PermissionKind, PermissionsState } from "../../main/permissionsSpec";
import { desktop } from "./desktop";

/**
 * What the setup's permissions step and Settings, Setup talk to: the main process
 * (main/permissions.ts) in the app, a simulation in the gym (gym/), so a denied or never-asked
 * state can be shown without changing this computer's settings.
 */
export type PermissionsApi = {
  read(): Promise<PermissionsState | null>;
  ask(kind: "microphone" | "camera"): Promise<PermissionsState | null>;
  open(kind: PermissionKind): Promise<void>;
  /** Starts dragging the app itself, for System Settings' Screen Recording list. */
  drag(): void;
  testNotification(): Promise<void>;
};

export const desktopPermissions: PermissionsApi = {
  read: async () => (await desktop.permissions?.()) ?? null,
  ask: async (kind) => (await desktop.askPermission?.(kind)) ?? null,
  open: async (kind) => desktop.openPermission?.(kind),
  drag: () => desktop.dragApp?.(),
  testNotification: async () => desktop.testNotification?.(),
};

/** The permissions' states, read again whenever the window comes back to the front (after System Settings). */
export function usePermissions(api: PermissionsApi) {
  const [state, setState] = useState<PermissionsState | null>(null);
  const refresh = useCallback(() => {
    void api.read().then(setState);
  }, [api]);
  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refresh]);
  return { state, setState, refresh };
}
