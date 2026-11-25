import { useUsageData } from "../../lib/analytics";
import { OnOff } from "./Notifications";

/** Settings, Privacy: "Share usage data" (lib/analytics.ts, docs/analytics.md). */
export function Privacy() {
  const [on, setOn, available] = useUsageData();
  return (
    <>
      <div className="pane-title">
        <h2>Privacy</h2>
      </div>
      <div className="panel">
        <div className="panel-section privacy-copy">
          <span className="label" id="usage-label">
            Share usage data
          </span>
          <OnOff
            labelledBy="usage-label"
            on={available && on}
            disabled={!available}
            onChange={setOn}
          />
          <span className="hint">
            Tells Nuko Nova which parts of Uplink Room get used: signing in, starting runs, joining
            calls, answering approvals, opening the Inbox, files, Spaces and shared browsers. Events
            carry your member and team IDs, and the kind of thing you did, such as the harness a run
            used.
          </span>
          <span className="hint">
            Never your name or email, and never what's in messages, terminals, transcripts,
            documents or web addresses. Screen recordings of a session hide all text and typing, and
            leave out terminals, files, Spaces and shared browsers entirely.
          </span>
          <span className="hint">Off stops all of it, on this computer, right away.</span>
          {!available ? (
            <span className="hint">This build of the app sends no usage data.</span>
          ) : null}
        </div>
      </div>
    </>
  );
}
