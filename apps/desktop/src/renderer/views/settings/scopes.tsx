import { Checkbox } from "@ui-sdk/react/checkbox";

/**
 * The Room API's scopes as people read them, and the picker that grants them: on an agent key
 * (Settings, Agents) and when approving a remote connector (ADR 0031).
 */
/** The Room API's scopes (packages/backend/convex/lib/scopes.ts), in plain words. */
export const SCOPES: { id: string; label: string; detail: string }[] = [
  {
    id: "messages.post",
    label: "Post messages",
    detail: "In the channels it can see, and as replies",
  },
  { id: "room.read", label: "Read projects", detail: "Tasks, runs, files, channels and machines" },
  {
    id: "work.manage",
    label: "Manage work",
    detail: "Create projects, channels and tasks, and file runs",
  },
  {
    id: "runs.start",
    label: "Start runs",
    detail: "Start and stop agents on tasks, and make profiles",
  },
  {
    id: "terminals.drive",
    label: "Control terminals",
    detail: "Type, send suggestions, take control or hand off",
  },
  {
    id: "browsers.use",
    label: "Use shared browsers",
    detail: "Start, join and control them, which costs minutes",
  },
  {
    id: "spaces.drive",
    label: "Control Spaces",
    detail: "Click, type and take screenshots on a Space it controls",
  },
  {
    id: "approvals.answer",
    label: "Answer approvals",
    detail: "Allow or deny commands for others",
  },
  { id: "people.invite", label: "Invite people", detail: "Send invites and add agents" },
  {
    id: "pairs.join",
    label: "Join Pairs",
    detail: "With a pair code you give it, talk with people and runs outside the team",
  },
  {
    id: "machines.manage",
    label: "Change machine settings",
    detail: "Slots, access, profiles, link and unlink",
  },
  { id: "team.admin", label: "Team settings", detail: "Roles and members" },
];
export const DEFAULT_SCOPES = ["messages.post", "room.read"];

export function ScopePicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (scopes: string[]) => void;
}) {
  return (
    <div className="scope-grid">
      {SCOPES.map((scope) => (
        <label key={scope.id}>
          <Checkbox
            className="scope-checkbox"
            checked={value.includes(scope.id)}
            onCheckedChange={(checked) =>
              onChange(
                checked === true ? [...value, scope.id] : value.filter((s) => s !== scope.id),
              )
            }
          />
          <span>
            {scope.label}
            <small>{scope.detail}</small>
          </span>
        </label>
      ))}
    </div>
  );
}
