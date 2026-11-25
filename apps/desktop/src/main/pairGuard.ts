/**
 * The main process's check before it pairs this computer. Pairing again replaces the current
 * pairing: the bridge forgets its pairing files, which stops its terminals and deletes its saved
 * profiles and threads (packages/bridge/src/cli.ts, forgetPairingFiles). So a computer that is
 * already linked is paired again only when the request says `replace: true`, which only setup's
 * confirmation sends. A renderer with stale pairing state can't replace a pairing by accident.
 */
export type PairRequest = { code: string; replace: boolean };

/**
 * This computer's pairing as bridge.json says. "unknown" when the file exists but can't be read or
 * parsed: that is not the same as unpaired, so nothing offers to link (and replace) it.
 */
export type PairingOnDisk =
  | { status: "unpaired" }
  | { status: "paired"; machineId: string | null }
  | { status: "unknown"; error: string };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Reads the pairing with `read` (bridge.json's text). Only a missing file or a config with no token is unpaired. */
export function readPairing(read: () => string): PairingOnDisk {
  let text: string;
  try {
    text = read();
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return { status: "unpaired" };
    return { status: "unknown", error: messageOf(error) };
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch (error) {
    return { status: "unknown", error: `bridge.json isn't valid JSON (${messageOf(error)})` };
  }
  if (typeof config !== "object" || config === null) return { status: "unknown", error: "bridge.json isn't a config" };
  const { token, machineId } = config as { token?: unknown; machineId?: unknown };
  if (typeof token !== "string" || !token) return { status: "unpaired" };
  return { status: "paired", machineId: typeof machineId === "string" ? machineId : null };
}

export const ALREADY_LINKED =
  "This computer is already linked. To replace its pairing, open Settings, Setup, choose Run setup again, then Replace this pairing.";

/** The renderer's request, or null when it isn't one. `replace` is true only when sent as true. */
export function parsePairRequest(value: unknown): PairRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const { code, replace } = value as { code?: unknown; replace?: unknown };
  if (typeof code !== "string") return null;
  return { code, replace: replace === true };
}

export const CANT_CHECK =
  "Couldn't check whether this computer is already linked, so it wasn't linked again. Check again from setup's link step.";

/** Why this request must not pair the computer, or null when it may: a pairing that exists or can't be read needs replace. */
export function pairRefusal(request: PairRequest, current: PairingOnDisk): string | null {
  if (current.status === "unpaired" || request.replace) return null;
  return current.status === "paired" ? ALREADY_LINKED : CANT_CHECK;
}
