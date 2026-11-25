import { useCallback, useEffect, useRef, useState } from "react";
import type { PairingOnDisk } from "../../main/pairGuard";

/** This computer's pairing as main reads it from bridge.json. A failed read is "unknown", never unpaired. */
export type Pairing = PairingOnDisk;

/**
 * This computer's pairing, read again on `refresh()` and after every link attempt, so a setup
 * opened later in the same session never shows the link form for a computer that is linked.
 * While a read is out, `pairing` is undefined ("checking"); an older read never overwrites a newer one.
 */
export function usePairing({
  read,
  makeCode,
  link,
}: {
  read: (() => Promise<Pairing | null>) | undefined;
  makeCode: (name: string) => Promise<string | undefined>;
  link: ((code: string, options: { replace: boolean }) => Promise<void>) | undefined;
}) {
  const [pairing, setPairing] = useState<Pairing | undefined>(undefined);
  const latest = useRef(0);
  const refresh = useCallback(async () => {
    const n = ++latest.current;
    setPairing(undefined);
    let next: Pairing;
    try {
      next = read ? ((await read()) ?? { status: "unknown", error: "The app didn't answer" }) : { status: "unpaired" };
    } catch (error) {
      next = { status: "unknown", error: error instanceof Error ? error.message : String(error) };
    }
    if (n === latest.current) setPairing(next);
  }, [read]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const pair = useCallback(
    async (name: string, options: { replace: boolean }) => {
      if (!link) throw new Error("Pairing from the app needs the installed app");
      try {
        const code = await makeCode(name);
        if (!code) throw new Error("Couldn't make a pairing code.");
        await link(code, options);
      } finally {
        await refresh();
      }
    },
    [link, makeCode, refresh],
  );
  return { pairing, refresh, pair };
}
