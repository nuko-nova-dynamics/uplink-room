import type { ReactNode } from "react";
import { Button } from "@ui-sdk/react/button";
import type { BridgeCli } from "../../main/bridgeCliSpec";
import type { BridgeCliView } from "../lib/bridgeCli";
import { CopyButton } from "./Copy";
import { Icon } from "./Icon";

/**
 * `uplink-bridge` in a terminal on this computer (main/bridgeCli.ts): what a new terminal runs, and
 * the one thing to do about it. One row with the setup's permission rows' anatomy, shown in Setup's
 * link step, in Settings, Setup, and for this computer in Link a machine.
 */
function statusLabel(s: BridgeCli): string {
  if (s.state === "ours") return s.relativeFirst ? "Depends on the folder" : "On PATH";
  return { missing: "Not on PATH", stale: "Another copy", other: "Something else" }[s.state];
}

const path = (value: string | undefined) => (
  <span className="cli-path" title={value}>
    {value}
  </span>
);

/** What is there now, in one sentence, before what the app can do about it. */
function what(s: BridgeCli): ReactNode {
  if (s.state === "stale") {
    return s.runs ? (
      <>It runs another copy of Uplink Room: {path(s.target)}. </>
    ) : (
      <>
        {path(s.found)} links to a copy of Uplink Room that's gone: {path(s.target)}.{" "}
      </>
    );
  }
  if (s.state === "other") {
    if (s.runs) return <>It runs another install: {path(s.target ?? s.found)}. </>;
    return s.target ? (
      <>
        {path(s.found)} links to {path(s.target)}, which isn't Uplink Room's.{" "}
      </>
    ) : (
      <>Something that doesn't run is at {path(s.found)}. </>
    );
  }
  return null;
}

/** Add to PATH links `uplink` and `uplink-mcp` in the same step, where they aren't there yet (ADR 0042). */
function besides(s: BridgeCli): ReactNode {
  const more = (s.tools ?? [])
    .filter((t) => t.state !== "ours" && t.install?.kind === "link")
    .map((t) => t.name);
  return more.length ? (
    <>
      , with{" "}
      {more.map((name, index) => (
        <span key={name}>
          {index ? " and " : ""}
          <span className="mono">{name}</span>
        </span>
      ))}{" "}
      beside it
    </>
  ) : null;
}

function describe(s: BridgeCli): ReactNode {
  if (s.state === "ours") {
    if (s.relativeFirst) {
      return (
        <>
          A new terminal finds this app's bridge at {path(s.found)}, but your PATH looks in a folder
          relative to the terminal's first, so what uplink-bridge runs depends on where you are.
          Commands here use the full path.
        </>
      );
    }
    return s.platform === "win32" ? (
      "New terminals run this app's bridge. A terminal opened before needs reopening."
    ) : (
      <>A new terminal runs this app's bridge, linked from {path(s.found)}.</>
    );
  }
  const install = s.install;
  if (!install) return what(s);
  if (install.kind === "link") {
    const admin = install.admin ? ", and macOS asks for an administrator's password." : ".";
    return install.replaces ? (
      <>
        {what(s)}
        The app points {path(install.at)} at its own bridge instead{admin}
      </>
    ) : (
      <>
        {what(s)}
        {s.state === "missing" ? "Add it to run the bridge from any terminal. " : ""}The app adds{" "}
        {path(install.at)}, linked to its bridge{besides(s)}
        {admin}
      </>
    );
  }
  if (install.kind === "user-path") {
    return (
      <>
        {what(s)}
        {s.state === "missing" ? "Add it to run the bridge from any terminal. " : ""}The app puts
        its bin folder first in your PATH; then open a new terminal.
      </>
    );
  }
  switch (install.why) {
    case "appimage":
      return (
        <>
          {what(s)}An AppImage can't go on PATH: its path changes on every launch. Install the .deb
          instead, or install the bridge with npm as Link a machine shows for another machine.
        </>
      );
    case "package":
      return (
        <>
          {what(s)}
          {s.state === "missing"
            ? "The .deb links /usr/bin/uplink-bridge when it installs, and it isn't there now. To add one in /usr/local/bin, run:"
            : "To use this app's, remove that one, then run:"}
        </>
      );
    case "shadowed":
      return (
        <>
          {what(s)}
          {s.platform === "win32"
            ? "That one is in the system PATH, which comes first, and changing it needs an administrator."
            : "That one comes earlier on your PATH than /usr/local/bin, so the app can't put its own first."}
        </>
      );
    case "occupied":
      return <>{what(s)}The app doesn't replace what isn't its own. Remove it, then Add to PATH.</>;
    case "folder-not-on-path":
      return (
        <>
          {what(s)}Your terminal's PATH doesn't include /usr/local/bin, where the app would link it.
        </>
      );
  }
}

export function BridgeCliRow({ cli }: { cli: BridgeCliView }) {
  const { status, busy, error, install, refresh } = cli;
  // Outside the installed app there's no launcher to put anywhere.
  if (status === null && !error) return null;
  const action = status?.install && status.install.kind !== "none" ? status.install : null;
  const manual = status?.install?.kind === "none" ? status.install.manual : undefined;
  const ours = status?.state === "ours" && !status.relativeFirst;
  return (
    <ul
      className="setup-perms cli-row"
      aria-label="uplink-bridge in a terminal"
      aria-busy={status === undefined}
    >
      <li className="setup-perm" data-state={status?.state ?? (error ? "error" : "unknown")}>
        <span className="setup-perm-icon">
          <Icon name="terminal" />
        </span>
        <span className="setup-perm-text">
          <b>
            <span className="mono">uplink-bridge</span> in a terminal
          </b>
          <span className="muted">
            {status
              ? describe(status)
              : status === undefined
                ? "Checking what a new terminal runs…"
                : error}
          </span>
        </span>
        {status ? (
          <span className="setup-side">
            <span className={`setup-status${ours ? " status-granted" : ""}`}>
              {ours ? <Icon name="check" /> : null}
              {statusLabel(status)}
            </span>
            {action ? (
              <Button className="btn" disabled={busy} focusableWhenDisabled onClick={() => install()}>
                {(state) =>
                  busy || state.pending
                    ? "Adding…"
                    : status.state === "missing"
                      ? "Add to PATH"
                      : "Use this app's"
                }
              </Button>
            ) : null}
          </span>
        ) : status === null ? (
          <span className="setup-side">
            <button className="btn" type="button" onClick={refresh}>
              Check again
            </button>
          </span>
        ) : null}
        {manual ? (
          <span className="setup-perm-extra cli-manual">
            <code className="cmd-box">{manual}</code>
            <CopyButton text={manual} />
          </span>
        ) : null}
        {status && error ? (
          <span className="setup-perm-extra setup-error" role="alert">
            {error}
          </span>
        ) : null}
      </li>
    </ul>
  );
}
