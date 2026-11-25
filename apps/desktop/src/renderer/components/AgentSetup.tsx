import "./agentWork.css";
import { useState, type ReactNode } from "react";
import { Button } from "@ui-sdk/react/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import type { BridgeCli, BridgeCliInstall, ToolCli } from "../../main/bridgeCliSpec";
import {
  MCP_HARNESS_LABELS,
  SKILL_TARGET_LABELS,
  type McpHarness,
  type SkillTarget,
} from "../../main/agentSetupSpec";
import type { AgentSetupView } from "../lib/agentSetup";
import type { BridgeCliView } from "../lib/bridgeCli";
import { CopyButton } from "./Copy";
import { Icon } from "./Icon";

/**
 * Settings, Command line, on this computer (ADR 0042): `uplink` and `uplink-mcp` in a terminal, the
 * `uplink` skill in Claude Code and Codex, and `uplink-mcp` in an agent. Rows with the setup's
 * permission rows' anatomy: icon, what it is, its state, the one thing to do.
 */

const path = (value: string | undefined) => <span className="cli-path">{value}</span>;
const names = (tools: ToolCli[]) => tools.map((t) => t.name).join(" and ");

function label(t: ToolCli): string {
  if (t.state === "ours") return t.relativeFirst ? "Depends on the folder" : "On PATH";
  return { missing: "Not on PATH", stale: "Another copy", other: "Something else" }[t.state];
}

/** What is there now for one command, before what the app can do about it. */
function what(t: ToolCli): ReactNode {
  if (t.state === "stale") {
    return t.runs ? (
      <>
        <span className="mono">{t.name}</span> runs another copy of Uplink Room: {path(t.target)}
        .{" "}
      </>
    ) : (
      <>{path(t.found)} links to a copy of Uplink Room that's gone. </>
    );
  }
  if (t.state === "other") {
    if (t.runs) {
      return (
        <>
          <span className="mono">{t.name}</span> runs another program: {path(t.target ?? t.found)}
          .{" "}
        </>
      );
    }
    return t.target ? (
      <>
        {path(t.found)} links to {path(t.target)}, which isn't Uplink Room's.{" "}
      </>
    ) : (
      <>Something that doesn't run is at {path(t.found)}. </>
    );
  }
  return null;
}

function describe(status: BridgeCli, tools: ToolCli[]): ReactNode {
  const off = tools.filter((t) => t.state !== "ours" || t.relativeFirst);
  if (!off.length) {
    return status.platform === "win32" ? (
      <>
        New terminals run this app's <span className="mono">uplink</span> and{" "}
        <span className="mono">uplink-mcp</span>. A terminal opened before needs reopening.
      </>
    ) : (
      <>
        New terminals run this app's <span className="mono">uplink</span> and{" "}
        <span className="mono">uplink-mcp</span>, linked from{" "}
        {path((tools[0]?.found ?? "").replace(/\/[^/]*$/, ""))}.
      </>
    );
  }
  const first = off[0]!;
  if (first.state === "ours") {
    return (
      <>
        A new terminal finds this app's <span className="mono">{names(off)}</span>, but your PATH
        looks in a folder relative to the terminal's first, so what runs depends on where you are.
      </>
    );
  }
  const install: BridgeCliInstall | undefined = first.install;
  if (!install) return what(first);
  if (install.kind === "link") {
    // Everything Add to PATH will link, the bridge included, so the sentence says the whole step.
    const linking = [{ name: "uplink-bridge", ...status }, ...tools].filter(
      (c) => c.state !== "ours" && c.install?.kind === "link",
    );
    const folder = install.at.slice(0, install.at.lastIndexOf("/"));
    const list = linking
      .map((c) => c.name)
      .join(linking.length > 2 ? ", " : " and ")
      .replace(/, ([^,]*)$/, " and $1");
    const admin = linking.some((c) => c.install?.kind === "link" && c.install.admin)
      ? ", and macOS asks for an administrator's password."
      : ".";
    return install.replaces ? (
      <>
        {what(first)}The app points <span className="mono">{list}</span> in {path(folder)} at its
        own instead{admin}
      </>
    ) : (
      <>
        {what(first)}Add them to run <span className="mono">uplink login</span>,{" "}
        <span className="mono">uplink join</span> and <span className="mono">uplink pair</span> from
        any terminal. The app links <span className="mono">{list}</span> in {path(folder)} to its
        own{admin}
      </>
    );
  }
  if (install.kind === "user-path") {
    return (
      <>
        {what(first)}Add them to run <span className="mono">uplink</span> from any terminal. The app
        puts its bin folder first in your PATH; then open a new terminal.
      </>
    );
  }
  switch (install.why) {
    case "appimage":
      return (
        <>
          An AppImage can't go on PATH: its path changes on every launch. Install the .deb instead.
        </>
      );
    case "package":
      return (
        <>
          {what(first)}
          {first.state === "missing"
            ? `The .deb links /usr/bin/${names(off)} when it installs, and ${off.length > 1 ? "they aren't" : "it isn't"} there now. To add ${off.length > 1 ? "them" : "it"} in /usr/local/bin, run:`
            : "To use this app's, remove that one, then run:"}
        </>
      );
    case "shadowed":
      return (
        <>
          {what(first)}
          {status.platform === "win32"
            ? "That one is in the system PATH, which comes first, and changing it needs an administrator."
            : "That one comes earlier on your PATH than /usr/local/bin, so the app can't put its own first."}
        </>
      );
    case "occupied":
      return (
        <>{what(first)}The app doesn't replace what isn't its own. Remove it, then Add to PATH.</>
      );
    case "folder-not-on-path":
      return (
        <>
          {what(first)}Your terminal's PATH doesn't include /usr/local/bin, where the app would link
          them.
        </>
      );
  }
}

/** `uplink` and `uplink-mcp` in a terminal. Add to PATH is the same step as Setup's: all three commands. */
export function ToolsRow({ cli }: { cli: BridgeCliView }) {
  const { status, busy, error, install, refresh } = cli;
  const tools = status?.tools ?? [];
  const off = tools.filter((t) => t.state !== "ours" || t.relativeFirst);
  const action =
    [status, ...tools].some(
      (c) => c && c.state !== "ours" && c.install && c.install.kind !== "none",
    ) && off.length > 0;
  const manual = off
    .flatMap((t) => (t.install?.kind === "none" && t.install.manual ? [t.install.manual] : []))
    .join("\n");
  const shown = off[0] ?? tools[0];
  return (
    <li
      className="setup-perm work-ui agent-setup-row"
      data-state={shown?.state ?? (error ? "error" : "unknown")}
    >
      <span className="setup-perm-icon">
        <Icon name="terminal" />
      </span>
      <span className="setup-perm-text">
        <b>
          <span className="mono">uplink</span> and <span className="mono">uplink-mcp</span> in a
          terminal
        </b>
        <span className="muted">
          {status
            ? describe(status, tools)
            : status === undefined
              ? "Checking what a new terminal runs…"
              : error}
        </span>
      </span>
      {status && shown ? (
        <span className="setup-side">
          <span className={`setup-status${off.length ? "" : " status-granted"}`}>
            {off.length ? null : <Icon name="check" />}
            {label(shown)}
          </span>
          {action ? (
            // Pending while the app links them.
            <Button className="btn" onClick={() => install()}>
              <span className="control-label">
                {busy ? "Adding…" : shown.state === "missing" ? "Add to PATH" : "Use this app's"}
              </span>
            </Button>
          ) : null}
        </span>
      ) : status === null ? (
        <span className="setup-side">
          <button className="btn" type="button" onClick={refresh}>
            <span className="control-label">Check again</span>
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
  );
}

/** The `uplink` skill in one harness's personal skills folder. */
export function SkillRow({ target, agents }: { target: SkillTarget; agents: AgentSetupView }) {
  const skill = agents.setup?.skills[target];
  if (!skill) return null;
  const name = SKILL_TARGET_LABELS[target];
  const busy = agents.busy === target;
  const current = skill.state === "current";
  return (
    <li className="setup-perm work-ui agent-setup-row" data-state={skill.state}>
      <span className="setup-perm-icon">
        <Icon name="doc" />
      </span>
      <span className="setup-perm-text">
        <b>
          The <span className="mono">uplink</span> skill in {name}
        </b>
        <span className="muted">
          Teaches {name} to join the room, pair with other people's agents and answer their messages
          with <span className="mono">uplink</span>.{" "}
          {current ? (
            <>In {path(skill.path)}.</>
          ) : skill.state === "outdated" ? (
            <>The copy in {path(skill.path)} is from an earlier version.</>
          ) : (
            <>The app copies it to {path(skill.path)}.</>
          )}
        </span>
      </span>
      <span className="setup-side">
        <span className={`setup-status${current ? " status-granted" : ""}`}>
          {current ? <Icon name="check" /> : null}
          {current ? "Installed" : skill.state === "outdated" ? "Earlier version" : "Not installed"}
        </span>
        {current ? null : (
          // Pending while this one installs, and disabled while another row's work runs.
          <Button
            className="btn"
            disabled={agents.busy !== null && !busy}
            onClick={() => agents.installSkill(target)}
          >
            <span className="control-label">
              {busy ? "Installing…" : skill.state === "outdated" ? "Update" : "Install"}
            </span>
          </Button>
        )}
      </span>
      {agents.error?.row === target ? (
        <span className="setup-perm-extra setup-error" role="alert">
          {agents.error.message}
        </span>
      ) : null}
    </li>
  );
}

const HARNESSES: McpHarness[] = ["claude", "codex", "hermes"];

/** `uplink-mcp` in an agent, through the agent's own `mcp add`. */
export function McpRow({ agents }: { agents: AgentSetupView }) {
  const [harness, setHarness] = useState<McpHarness>("claude");
  if (!agents.setup) return null;
  const busy = agents.busy === "mcp";
  return (
    <li
      className="setup-perm work-ui agent-setup-row"
      data-state={agents.added ? "added" : "unknown"}
    >
      <span className="setup-perm-icon">
        <Icon name="link" />
      </span>
      <span className="setup-perm-text">
        <b>
          <span className="mono">uplink-mcp</span> in an agent
        </b>
        <span className="muted">
          Gives the agent every Room API function as a tool, acting as you after{" "}
          <span className="mono">uplink login</span>. The app runs the agent's own{" "}
          <span className="mono">mcp add</span>, replacing an earlier server named{" "}
          <span className="mono">uplink</span>.
        </span>
      </span>
      <span className="setup-side">
        <span className="select-wrap">
          <Select
            items={HARNESSES.map((h) => ({ value: h, label: MCP_HARNESS_LABELS[h] }))}
            value={harness}
            disabled={busy}
            onValueChange={(next) => setHarness(next as McpHarness)}
          >
            <SelectTrigger className="input" aria-label="Agent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="pop">
              {HARNESSES.map((h) => (
                <SelectItem key={h} value={h}>
                  <span className="grow">{MCP_HARNESS_LABELS[h]}</span>
                  <SelectItemIndicator>
                    <Icon name="check" />
                  </SelectItemIndicator>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Icon name="chevron-down" size={14} />
        </span>
        <Button
          className="btn"
          disabled={agents.busy !== null && !busy}
          onClick={() => agents.addMcp(harness)}
        >
          <span className="control-label">{busy ? "Adding…" : "Add"}</span>
        </Button>
      </span>
      {agents.added ? (
        <span className="setup-perm-extra agent-added">
          <span className="setup-status status-granted">
            <Icon name="check" />
            Added to {MCP_HARNESS_LABELS[agents.added.harness]}. A session started from now on has
            it.
          </span>
          <span className="cli-manual">
            <code className="cmd-box">{agents.added.command}</code>
            <CopyButton text={agents.added.command} />
          </span>
        </span>
      ) : null}
      {agents.error?.row === "mcp" ? (
        <span className="setup-perm-extra setup-error" role="alert">
          {agents.error.message}
        </span>
      ) : null}
    </li>
  );
}
