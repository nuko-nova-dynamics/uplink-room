import { useState } from "react";
import { api, type Access, type MachineRow } from "../../lib/api";
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
const OS_LABEL: Record<string, string> = { linux: "Linux", macos: "macOS", windows: "Windows" };

/**
 * The Cua Spaces the machine's bridge found (spec #6): shared ones open, the rest can be shared by
 * whoever the machine belongs to (an admin, for a team machine).
 */
export function MachineSpaces({
  machine,
  canChange,
  nav,
}: {
  machine: MachineRow;
  canChange: boolean;
  nav: Nav;
}) {
  const found = useRoomQuery(api.spaces.found, { machineId: machine.machineId });
  const shared = useRoomQuery(api.spaces.list, { machineId: machine.machineId });
  const share = useAct(api.spaces.share, { success: "Space shared" });
  const [access, setAccess] = useState<Access>("watch");
  const allowed = ACCESS_LEVELS.filter(
    (level) => accessRank(level) <= accessRank(machine.mostOpenAccess),
  );

  return (
    <div className="panel-section">
      <span className="label">Spaces</span>
      {found && found.length === 0 ? (
        <span className="faint">
          No Cua Spaces found here. Spaces made with Cua on this machine show up here.
        </span>
      ) : null}
      {(found ?? []).map((space) => {
        const live = shared?.find((s) => s.spaceId === space.spaceId);
        return live ? (
          <button
            key={space.spaceRef}
            type="button"
            className="term-row"
            onClick={() => nav.openSpace(live.spaceId)}
          >
            <span className="truncate">{space.name}</span>
            <span className="sub">
              <span>{OS_LABEL[space.os ?? ""] ?? "Desktop"}</span>
              {space.state !== "running" ? (
                <span>{space.state === "suspended" ? "Suspended" : "Stopped"}</span>
              ) : null}
              {live.driver ? <span>controlled by {live.driver.name}</span> : null}
              <span>shared by {live.sharedBy.name}</span>
            </span>
            <span className={`chip access ${live.loweredFrom ? "amber" : ""}`}>
              <Icon name={ACCESS_ICON[live.access]} size={14} />
              {live.loweredFrom
                ? `${ACCESS_META[live.access].label}, was ${ACCESS_META[live.loweredFrom].label}`
                : ACCESS_META[live.access].label}
            </span>
          </button>
        ) : (
          <div key={space.spaceRef} className="term-row">
            <span className="truncate">{space.name}</span>
            <span className="sub">
              <span>{OS_LABEL[space.os ?? ""] ?? "Desktop"}</span>
              {space.state !== "running" ? (
                <span>{space.state === "suspended" ? "Suspended" : "Stopped"}</span>
              ) : null}
              <span>{space.spaceRef}</span>
            </span>
            <span className="row-flex access">
              <Select
                items={allowed.map((level) => ({ value: level, label: ACCESS_META[level].label }))}
                value={allowed.includes(access) ? access : allowed[0]}
                disabled={!canChange || machine.sharingStopped}
                onValueChange={(value) => {
                  if (value) setAccess(value as Access);
                }}
              >
                <SelectTrigger className="select" aria-label={`Access for ${space.name}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="pop">
                  {allowed.map((level) => (
                    <SelectItem key={level} value={level}>
                      {ACCESS_META[level].label}
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
                    : canChange
                      ? "Share this Space with the room"
                      : "Only whoever this machine belongs to can share its Spaces."
                }
              >
                <Button
                  className="btn small"
                  disabled={!canChange || machine.sharingStopped}
                  focusableWhenDisabled
                  onClick={async () => {
                    const spaceId = await share({
                      machineId: machine.machineId,
                      spaceRef: space.spaceRef,
                      access: allowed.includes(access) ? access : allowed[0]!,
                    });
                    if (spaceId) nav.openSpace(spaceId);
                  }}
                >
                  Share
                </Button>
              </Tip>
            </span>
          </div>
        );
      })}
    </div>
  );
}
