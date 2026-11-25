/**
 * Settings… in the macOS app menu (Command-comma), for whichever home the window shows: a team's
 * Shell or the home of someone in no team. Each passes what opening its Settings means.
 */
import { useEffect } from "react";
import { desktop } from "./desktop";

export function useSettingsMenu(openSettings: () => void): void {
  // Settings… in the app menu opens the same place as the gear.
  useEffect(() => desktop.onOpenSettings?.(openSettings), [openSettings]);
  // Settings… chosen with no window open: this window was opened for it.
  useEffect(() => {
    void desktop.takeOpenSettings?.().then((pending) => pending && openSettings());
  }, [openSettings]);
}
