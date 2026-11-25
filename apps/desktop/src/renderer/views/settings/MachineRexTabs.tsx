import "../../components/agentWork.css";
import { useState } from "react";
import { api, type Access, type Id, type MachineRow } from "../../lib/api";
import { ACCESS_LEVELS, ACCESS_META, accessRank } from "../../lib/format";
import { useAct, useRoomQuery } from "../../lib/session";
import { Button } from "@ui-sdk/react/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Tip } from "../../components/Tip";
import { Icon } from "../../components/Icon";
import type { Nav } from "../../Shell";

const ACCESS_ICON = { watch: "eye", suggest: "suggest", drive: "wheel", open: "open" } as const;

/**
 * The Rex tabs this machine's bridge can share (ADR 0019): tabs opened through Uplink Room, whose
 * program runs on the bridge's own pty inside the tab. Shown only to whoever the machine belongs to
 * (an admin, for a team machine), since unshared tabs' names and folders are theirs.
 */
export function MachineRexTabs({ machine, nav }: { machine: MachineRow; nav: Nav }) {
  const found = useRoomQuery(api.rex.found, { machineId: machine.machineId });
  const terminals = useRoomQuery(api.terminals.list, { machineId: machine.machineId });
  const share = useAct(api.rex.share, { success: "Rex tab shared" });
  const [access, setAccess] = useState<Access>("watch");
  const allowed = ACCESS_LEVELS.filter(
    (level) => accessRank(level) <= accessRank(machine.mostOpenAccess),
  );
  const level = allowed.includes(access) ? access : allowed[0]!;

  return (
    <div className="panel-section machine-rex-tabs work-ui">
      <span className="label">Rex tabs</span>
      {found && !found.running ? (
        <span className="muted">
          Rex isn't running on this machine, so it has no tabs to share.
        </span>
      ) : found && found.tabs.length === 0 ? (
        <span className="muted">
          No tabs opened through Uplink Room yet. To open one you can share, run{" "}
          <code>uplink-bridge rex-open -- claude</code> on this machine, or start a run In Rex.
        </span>
      ) : null}
      {(found?.tabs.length ?? 0) > 0 ? (
        <div className="rex-tab-list">
          {(found?.tabs ?? []).map((tab) => {
            const live = tab.terminalId
              ? terminals?.find((t) => t.terminalId === tab.terminalId)
              : undefined;
            return tab.shared && tab.terminalId ? (
              <button
                key={tab.tabRef}
                type="button"
                className="term-row"
                onClick={() => nav.openTerminal(tab.terminalId as Id<"terminals">)}
              >
                <span className="truncate">{tab.title}</span>
                <span className="sub">
                  <span>In {tab.session || "Rex"}</span>
                  {tab.kind === "run" ? <span>a run from the room</span> : null}
                  {live?.driver ? <span>controlled by {live.driver.name}</span> : null}
                </span>
                {live ? (
                  <span className={`chip access ${live.loweredFrom ? "amber" : ""}`}>
                    <Icon name={ACCESS_ICON[live.access]} size={14} />
                    <span className="control-label">
                      {live.loweredFrom
                        ? `${ACCESS_META[live.access].label}, was ${ACCESS_META[live.loweredFrom].label}`
                        : ACCESS_META[live.access].label}
                    </span>
                  </span>
                ) : null}
              </button>
            ) : (
              <div key={tab.tabRef} className="term-row">
                <span className="truncate">{tab.title}</span>
                <span className="sub">
                  <span>In {tab.session || "Rex"}</span>
                  {tab.command !== tab.title ? (
                    <span className="mono truncate">{tab.command}</span>
                  ) : null}
                </span>
                <span className="row-flex access">
                  <Select
                    items={allowed.map((option) => ({
                      value: option,
                      label: ACCESS_META[option].label,
                    }))}
                    value={level}
                    disabled={machine.sharingStopped}
                    onValueChange={(value) => {
                      if (value) setAccess(value as Access);
                    }}
                  >
                    <SelectTrigger className="select" aria-label={`Access for ${tab.title}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="pop">
                      {allowed.map((option) => (
                        <SelectItem key={option} value={option}>
                          {ACCESS_META[option].label}
                          <SelectItemIndicator>
                            <Icon name="check" size={14} />
                          </SelectItemIndicator>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Tip
                    label={
                      machine.sharingStopped
                        ? "Sharing is stopped on this machine."
                        : "Share this tab with the room"
                    }
                  >
                    <Button
                      className="btn"
                      disabled={machine.sharingStopped}
                      focusableWhenDisabled
                      onClick={async () => {
                        const terminalId = await share({
                          machineId: machine.machineId,
                          tabRef: tab.tabRef,
                          access: level,
                        });
                        if (terminalId) nav.openTerminal(terminalId as Id<"terminals">);
                      }}
                    >
                      <span className="control-label">Share</span>
                    </Button>
                  </Tip>
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
      {found && found.otherTabs > 0 ? (
        <span className="hint">
          {found.otherTabs === 1 ? "1 other tab" : `${found.otherTabs} other tabs`} in Rex{" "}
          {found.otherTabs === 1 ? "was" : "were"} opened there directly. Rex can't stream those to
          the room, so only tabs opened through Uplink Room can be shared.
        </span>
      ) : null}
    </div>
  );
}
