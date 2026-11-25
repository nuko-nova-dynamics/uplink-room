import { useEffect, useState } from "react";
import type { UpdateState } from "../../main/updateSpec";
import type { LoginItemState } from "../../main/loginItemSpec";
import { desktop } from "./desktop";

/** The app's update state from the main process (main/updates.ts), kept current. Null outside the app. */
export function useUpdates(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let live = true;
    void desktop.updateState?.().then((current) => {
      if (live && current) setState(current);
    });
    const stop = desktop.onUpdateState?.((next) => setState(next));
    return () => {
      live = false;
      stop?.();
    };
  }, []);
  return state;
}

export async function checkForUpdates(): Promise<UpdateState | null> {
  return (await desktop.checkForUpdates?.()) ?? null;
}

/** False when the main process refused (nothing ready, or a call started). */
export async function restartToUpdate(): Promise<boolean> {
  return (await desktop.restartToUpdate?.()) ?? false;
}

/** Tells the main process whether this person is in a call, which holds the restart prompt back. */
export function reportInCall(inCall: boolean): void {
  void desktop.setInCall?.(inCall);
}

/** "Open at login" (main/loginItem.ts) and its switch. Null outside the app, or until main answers. */
export function useOpenAtLogin(): [LoginItemState | null, (on: boolean) => void] {
  const [state, setState] = useState<LoginItemState | null>(null);
  useEffect(() => {
    let live = true;
    void desktop.openAtLogin?.().then((current) => {
      if (live && current) setState(current);
    });
    return () => {
      live = false;
    };
  }, []);
  const set = (on: boolean) => {
    void desktop.setOpenAtLogin?.(on).then((next) => {
      if (next) setState(next);
    });
  };
  return [state, set];
}
