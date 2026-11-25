import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { BridgeCli } from "../../main/bridgeCliSpec";
import { desktop } from "./desktop";

/**
 * `uplink-bridge` on PATH, as Setup, Settings and the pairing dialog show it (main/bridgeCli.ts).
 * The gym provides a simulated one through `BridgeCliContext`.
 */
export type BridgeCliApi = {
  /**
   * The command that runs the bridge the installed app carries, by its launcher's full path; null
   * when there's none (a development build). Known without probing PATH, so linking this computer
   * never waits on, or disappears with, that probe.
   */
  bundled: () => Promise<string | null>;
  /** What a new terminal runs for `uplink-bridge`; null outside the installed app. */
  read: () => Promise<BridgeCli | null>;
  /** Puts this app's launcher on PATH and answers what a new terminal runs now. */
  install: () => Promise<BridgeCli>;
};

export const desktopBridgeCli: BridgeCliApi = {
  bundled: async () => {
    const command = await desktop.bridgeCommand?.();
    // main answers plain `uplink-bridge` when there's no launcher (main/bridge.ts).
    return command && command !== "uplink-bridge" ? command : null;
  },
  read: async () => (await desktop.bridgeCli?.()) ?? null,
  install: async () => {
    if (!desktop.installBridgeCli) throw new Error("Only the installed app carries the bridge.");
    return desktop.installBridgeCli();
  },
};

export const BridgeCliContext = createContext<BridgeCliApi>(desktopBridgeCli);

export type BridgeCliView = {
  /** The bundled bridge's command (full path); undefined while asking, null when the app carries none. */
  bundled: string | null | undefined;
  /** Undefined while reading; null outside the installed app, or when it couldn't be read (see `error`). */
  status: BridgeCli | null | undefined;
  busy: boolean;
  error: string | null;
  install: () => Promise<void>;
  /** Reads it again, as after a failed check. */
  refresh: () => void;
};

/**
 * Reads it when shown and again whenever the window comes back to the front, since the person may
 * have changed it in a terminal meanwhile. Nothing changes until `install`, which only a click calls.
 */
export function useBridgeCli(): BridgeCliView {
  const api = useContext(BridgeCliContext);
  const [bundled, setBundled] = useState<string | null | undefined>(undefined);
  const [status, setStatus] = useState<BridgeCli | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  const read = useCallback(() => {
    void api.read().then(
      (next) => {
        if (!live.current) return;
        setStatus(next);
        setError(null);
      },
      (failure: unknown) => {
        if (!live.current) return;
        setStatus(null);
        setError(`Couldn't check uplink-bridge on PATH: ${failure instanceof Error ? failure.message : String(failure)}`);
      },
    );
  }, [api]);
  useEffect(() => {
    live.current = true;
    void api.bundled().then(
      (command) => live.current && setBundled(command),
      () => live.current && setBundled(null),
    );
    read();
    window.addEventListener("focus", read);
    return () => {
      live.current = false;
      window.removeEventListener("focus", read);
    };
  }, [api, read]);
  const install = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.install());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }, [api]);
  const refresh = useCallback(() => {
    setStatus(undefined);
    setError(null);
    read();
  }, [read]);
  return { bundled, status, busy, error, install, refresh };
}
