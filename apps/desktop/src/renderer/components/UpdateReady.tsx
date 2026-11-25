import "./remaining.css";
import { useEffect, useState } from "react";
import { Button } from "@ui-sdk/react/button";
import { Tip } from "./Tip";
import { canRestart, type UpdateState } from "../../main/updateSpec";
import { restartToUpdate, useUpdates } from "../lib/updates";

/**
 * "Restart to update": shown once an update has downloaded, at the bottom of the sidebar (where the
 * call dock sits during a call) and on the sign-in screen. It never shows during a call. If nobody
 * clicks it, the app restarts on its own once nobody is at the computer (main/updateSpec.ts).
 */
export function UpdateReady({ placement }: { placement: "sidebar" | "gate" }) {
  const state = useUpdates();
  return <UpdateReadyView placement={placement} state={state} onRestart={restartToUpdate} />;
}

/** The prompt itself, for any state; update-harness.tsx renders it with sample data. */
export function UpdateReadyView({
  placement,
  state,
  onRestart,
}: {
  placement: "sidebar" | "gate" | "settings";
  state: UpdateState | null;
  onRestart: () => Promise<boolean>;
}) {
  const [restarting, setRestarting] = useState(false);
  // "Restarting" lasts only while a restart can still happen: not after a failure, nor once a call
  // starts (main then holds the restart back).
  const restartable = state ? canRestart(state) : false;
  useEffect(() => {
    if (!restartable) setRestarting(false);
  }, [restartable]);
  if (!state || !canRestart(state)) return null;
  return (
    <section className={`update-ready update-ready-${placement}`} aria-label="Update">
      <span className="update-ready-text" role={placement === "settings" ? "status" : undefined}>
        Version {state.next} is ready{placement === "settings" ? "." : ""}
      </span>
      {/* Pending while main restarts, and still Restarting after: the app is closing. */}
      <Tip label="Uplink Room closes, installs the update and opens again.">
        <Button
          className={placement === "settings" ? "btn primary" : "btn"}
          disabled={restarting}
          focusableWhenDisabled
          onClick={async () => {
            if (await onRestart()) setRestarting(true);
          }}
        >
          {(button) => (button.pending || restarting ? "Restarting" : "Restart to update")}
        </Button>
      </Tip>
    </section>
  );
}
