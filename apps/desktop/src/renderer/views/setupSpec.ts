/**
 * What the setup's "Link this computer" step shows (views/Setup.tsx). A computer that is already
 * linked shows its pairing and moves on: pairing again stops its running terminals, deletes the
 * profiles and threads saved on it, and gives it a new identity in the room, so replacing it is a
 * separate action that asks first.
 */
export type PairView = "checking" | "linked" | "confirm-replace" | "form" | "unknown" | "unavailable";

/** This computer's current link as setup shows it. "unknown": the pairing couldn't be read, which is not unpaired. */
export type LinkState = { status: "unpaired" } | { status: "paired"; name: string } | { status: "unknown"; error: string };

export function pairView(o: {
  /** The installed app carries the bridge; a development build doesn't. */
  available: boolean;
  /** This computer's current pairing, undefined while reading. */
  current: LinkState | undefined;
  /** Linked during this run of the setup. */
  linkedNow: boolean;
  /** The person asked to replace the current pairing, and whether they confirmed it. */
  replace: "no" | "asked" | "confirmed";
}): PairView {
  if (!o.available) return "unavailable";
  if (o.linkedNow) return "linked";
  if (o.current === undefined) return "checking";
  if (o.current.status === "unknown") return "unknown";
  if (o.current.status === "unpaired") return "form";
  if (o.replace === "asked") return "confirm-replace";
  return o.replace === "confirmed" ? "form" : "linked";
}

/** What Tab cycles through in the setup dialog: the device pickers' selects too. */
export const TRAP_TARGETS =
  "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex='0']";

export function trapTargets(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TRAP_TARGETS)];
}

/**
 * Where Tab goes inside the setup dialog, or null to let the browser move focus. Focus starts on the
 * dialog itself when it opens and on each new step: Shift+Tab from there wraps to the last control
 * instead of leaving the dialog, as it does from the first control.
 */
export function trapMove(dialog: HTMLElement, active: Element | null, shift: boolean): HTMLElement | null {
  const all = trapTargets(dialog);
  const first = all[0];
  const last = all[all.length - 1];
  if (!first || !last) return null;
  const outside = !active || !dialog.contains(active);
  if (shift) return active === first || active === dialog || outside ? last : null;
  return active === last || outside ? first : null;
}
