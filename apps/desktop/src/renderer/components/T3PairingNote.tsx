import "./agentWork.css";
import type { T3Pairing } from "../lib/work";
import { T3_PAIR_COMMAND, t3PairingText } from "../lib/work";
import { Cmd } from "./Cmd";

/**
 * What a machine's T3 Code pairing means for its threads (ADR 0021), with the command that pairs
 * it again. The bridge pairs by itself, so this shows only when that failed. Nothing when the pairing works and isn't ending soon, or when `onlyNeedsYou` is set and
 * it only warns.
 */
export function T3PairingNote({
  t3,
  machineName,
  now,
  onlyNeedsYou = false,
  withChip = false,
  plain = false,
}: {
  t3: T3Pairing | undefined;
  machineName: string;
  now: number;
  onlyNeedsYou?: boolean;
  withChip?: boolean;
  /** A line of text instead of a boxed note, inside a panel that is already a box. */
  plain?: boolean;
}) {
  const text = t3PairingText(t3, now);
  if (!text || (onlyNeedsYou && !text.needsYou)) return null;
  return (
    <div className={`t3-pairing-note work-ui ${plain ? "t3-pairing-line" : "note"}`}>
      {withChip ? <b>{text.chip}. </b> : null}
      {text.why}
      {text.before ? ` ${text.before}` : null}
      {text.pairAgain ? (
        <>
          {" "}
          {text.before ? "Or on" : "On"} <span className="mono">{machineName}</span>, run{" "}
          <Cmd text={T3_PAIR_COMMAND} />.
        </>
      ) : null}
      {text.after ? ` ${text.after}` : null}
    </div>
  );
}
