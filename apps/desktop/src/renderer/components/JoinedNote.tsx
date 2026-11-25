import { Cmd } from "./Cmd";

/**
 * A joined run has chat only (ADR 0032): its session joined the room by itself with uplink join,
 * so there is no terminal, thread or machine to open. Said once, in place of an empty panel.
 */
export function JoinedNote({ finished }: { finished: boolean }) {
  return (
    <p className="joined-note">
      This session joined by itself with <Cmd text="uplink join" />.{" "}
      {finished
        ? "It had chat only: no terminal or thread to open here."
        : "It has chat only: there's no terminal or thread to open here, so message it instead."}
    </p>
  );
}
