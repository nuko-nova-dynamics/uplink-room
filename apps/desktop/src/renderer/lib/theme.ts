import { useCallback, useEffect, useState } from "react";
import { setSoundsEnabled } from "./sound";

export type Theme = "dark" | "light";
export type Density = "compact" | "default" | "spacious";

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    if (value && (allowed as readonly string[]).includes(value)) return value as T;
  } catch {
    // Storage can be unavailable; the defaults are fine.
  }
  return fallback;
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore.
  }
}

function useSwitch(key: string) {
  const [on, setOn] = useState(() => read(key, ["on", "off"], "on") === "on");
  const set = useCallback(
    (value: boolean) => {
      write(key, value ? "on" : "off");
      setOn(value);
    },
    [key],
  );
  return [on, set] as const;
}

/**
 * Dark first. The theme, row density, sounds and system notifications are
 * remembered on this machine. Sounds and notifications start on.
 */
export function usePreferences() {
  const [theme, setThemeState] = useState<Theme>(() =>
    read("uplink.theme", ["dark", "light"], "dark"),
  );
  const [density, setDensityState] = useState<Density>(() =>
    read("uplink.density", ["compact", "default", "spacious"], "compact"),
  );
  const [sounds, setSounds] = useSwitch("uplink.sounds");
  const [notifications, setNotifications] = useSwitch("uplink.notifications");
  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    document.documentElement.dataset["density"] = density;
  }, [theme, density]);
  useEffect(() => setSoundsEnabled(sounds), [sounds]);
  const setTheme = useCallback((value: Theme) => {
    write("uplink.theme", value);
    setThemeState(value);
  }, []);
  const setDensity = useCallback((value: Density) => {
    write("uplink.density", value);
    setDensityState(value);
  }, []);
  return {
    theme,
    setTheme,
    density,
    setDensity,
    sounds,
    setSounds,
    notifications,
    setNotifications,
  };
}

export type Preferences = ReturnType<typeof usePreferences>;

/** Onboarding is shown once on each computer, the first time a team opens. */
export function onboarded(): boolean {
  return read("uplink.onboarded", ["yes", "no"], "no") === "yes";
}
export function markOnboarded() {
  write("uplink.onboarded", "yes");
}

export function rememberTeam(teamId: string | null) {
  if (teamId) write("uplink.team", teamId);
}
export function lastTeam(): string | null {
  try {
    return localStorage.getItem("uplink.team");
  } catch {
    return null;
  }
}
