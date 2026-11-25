import { useEffect, useState } from "react";
import { copyText } from "../../lib/clipboard";
import { callDiagnostics } from "../../lib/call";
import { desktop, type MainDiagnostics } from "../../lib/desktop";
import { format, recentLines } from "../../lib/log";
import { useToast } from "../../lib/session";

/**
 * Settings, Diagnostics (docs/logs.md): the logs folder, and a short summary to paste into a bug
 * report. Neither holds secrets or content: log lines are scrubbed as they're written, and the
 * summary is versions, the call's state and the recent warnings and errors.
 */
export function Diagnostics() {
  const toast = useToast();
  const [main, setMain] = useState<MainDiagnostics | null>(null);
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    void desktop
      .diagnostics?.()
      .then(setMain)
      .catch(() => {});
  }, []);
  const available = Boolean(desktop.openLogs);
  return (
    <>
      <div className="pane-title">
        <h2>Diagnostics</h2>
      </div>
      <div className="panel">
        <div className="panel-section">
          <div className="settings-copy">
            <span className="label">Logs</span>
            <span className="hint">
              Uplink Room writes what it does to a log on this computer: starting, signing in, its
              connection to your team, each step of a call, updates, shared browsers and Spaces, and
              the bridge's own log beside it. It never writes messages, terminal text, names, tokens
              or web addresses with secrets in them.
            </span>
            {main ? <span className="diagnostics-path cli-path">{main.logsDir}</span> : null}
            <div className="device-row-actions">
              <button
                className="btn"
                type="button"
                disabled={!available}
                onClick={async () => {
                  try {
                    const opened = await desktop.openLogs?.();
                    setFeedback(
                      opened ? "Opened the logs folder." : "Couldn't open the logs folder.",
                    );
                  } catch {
                    setFeedback("Couldn't open the logs folder.");
                  }
                }}
              >
                Open logs folder
              </button>
              <button
                className="btn"
                type="button"
                onClick={async () => {
                  try {
                    await copyText(await diagnosticsText());
                    setFeedback("Copied the diagnostics.");
                    toast.show("Copied the diagnostics.", true);
                  } catch {
                    setFeedback("Couldn't copy the diagnostics.");
                    toast.show("Couldn't copy the diagnostics.");
                  }
                }}
              >
                Copy diagnostics
              </button>
            </div>
            {feedback ? (
              <span className="hint" role="status">
                {feedback}
              </span>
            ) : null}
            <span className="hint">
              Copy diagnostics copies the app and system versions, the call's state and the last
              warnings and errors, for a bug report.
            </span>
            {!available ? (
              <span className="hint">This build of the app has no logs folder.</span>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

/** The summary "Copy diagnostics" copies: plain text, scrubbed. */
export async function diagnosticsText(): Promise<string> {
  const main = await desktop.diagnostics?.().catch(() => null);
  const call = callDiagnostics();
  const windowLines = recentLines()
    .filter((line) => line.level === "warn" || line.level === "error")
    .slice(-30)
    .map(
      (line) =>
        `${new Date(line.at).toISOString()} ${line.level.toUpperCase()} [renderer:${line.scope}] ${format(line)}`,
    );
  return [
    "Uplink Room diagnostics",
    main
      ? `App ${main.version}${main.packaged ? "" : " (development)"}, Electron ${main.electron}, Chrome ${main.chrome}, ${main.platform} ${main.osVersion} ${main.arch}, up ${Math.round(main.uptimeSeconds / 60)} min`
      : "App: (the main process didn't answer)",
    main ? `Logs: ${main.logsDir}` : "",
    `Call: ${Object.entries(call)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}`,
    "",
    "Recent warnings and errors (app):",
    ...(main?.recent.length ? main.recent : ["(none)"]),
    "",
    "Recent warnings and errors (window, since it opened):",
    ...(windowLines.length ? windowLines : ["(none)"]),
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}
