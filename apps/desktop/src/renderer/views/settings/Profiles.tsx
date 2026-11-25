import { useState } from "react";
import { api, type MachineRow } from "../../lib/api";
import { DAY, span, timeLeft } from "../../lib/format";
import { useAct, useRoomQuery, useSession } from "../../lib/session";
import { Button } from "@ui-sdk/react/button";
import { Checkbox } from "@ui-sdk/react/checkbox";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { SegmentedControl, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Icon } from "../../components/Icon";
import { Dialog } from "../../components/Dialog";
import { Empty } from "../../components/Empty";

const KEEP_CHOICES = [
  { ms: DAY, label: "1 day" },
  { ms: 7 * DAY, label: "7 days" },
  { ms: 30 * DAY, label: "30 days" },
];

export function Profiles() {
  const profiles = useRoomQuery(api.profiles.mine, {});
  const remove = useAct(api.profiles.remove, {
    success: "Profile deleted. The bridge removes it from the machine.",
  });
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className="pane-title">
        <h2>Your profiles</h2>
        <button className="btn primary" type="button" onClick={() => setCreating(true)}>
          <Icon name="plus" /> New profile
        </button>
      </div>
      <p className="muted" style={{ maxWidth: 640 }}>
        A profile is your own logins, settings and skills on one machine, kept apart from the
        machine setup. It exists only on the machine where you made it, and the bridge deletes it
        when it expires.
      </p>
      <div className="panel">
        {profiles && profiles.length === 0 ? (
          <Empty>You have no profiles, so terminals use each machine's setup.</Empty>
        ) : null}
        {(profiles?.length ?? 0) > 0 ? (
          <table className="table profiles-table">
            <thead>
              <tr>
                <th>Profile</th>
                <th>Machine</th>
                <th>Status</th>
                <th>Kept</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {profiles!.map((p) => (
                <tr key={p.profileId}>
                  <td>{p.name}</td>
                  <td className="mono">{p.machine?.name ?? "Gone"}</td>
                  <td>{p.status === "creating" ? "Being made" : "Ready"}</td>
                  <td className="muted">{timeLeft(p.expiresAt)}</td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="btn shell-danger"
                      type="button"
                      onClick={() => void remove({ profileId: p.profileId })}
                    >
                      <Icon name="trash" /> Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
      {creating ? <CreateProfile onClose={() => setCreating(false)} /> : null}
    </>
  );
}

function CreateProfile({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const machines = useRoomQuery(api.machines.list, {});
  const create = useAct(api.profiles.create, { success: "Profile is being made" });
  const [machineId, setMachineId] = useState("");
  const [name, setName] = useState("");
  const [keepMs, setKeepMs] = useState(7 * DAY);
  const [accepted, setAccepted] = useState(false);

  const machine: MachineRow | undefined = machines?.find((m) => m.machineId === machineId);
  const owner = machine?.belongsTo.kind === "person" ? machine.belongsTo.member : undefined;
  const readable = owner !== undefined && owner.memberId !== session.me.memberId;
  const longest = machine?.longestProfileMs ?? 0;
  // Before a machine is chosen the usual lengths show (the machine's limit then caps the pick); a
  // machine that keeps profiles for less than a day offers just its limit.
  const allowed = KEEP_CHOICES.filter((c) => c.ms <= longest);
  const choices = !machine
    ? KEEP_CHOICES
    : allowed.length > 0 || longest <= 0
      ? allowed
      : [{ ms: longest, label: span(longest) }];
  const keep = Math.min(keepMs, longest || keepMs);
  const blocked = machine && longest <= 0 ? "This machine doesn't allow profiles." : null;

  const submit = async () => {
    if (!machine) return;
    const made = await create({
      machineId: machine.machineId,
      name,
      keepForMs: keep,
      ...(readable ? { acceptReadableByOwner: true } : {}),
    });
    if (made !== undefined) onClose();
  };
  const whose = (m: MachineRow) =>
    m.belongsTo.kind === "team"
      ? "team machine"
      : m.belongsTo.member.memberId === session.me.memberId
        ? "yours"
        : `${m.belongsTo.member.name}'s`;
  const machineItems = (machines ?? []).map((m) => ({
    value: m.machineId as string,
    label: `${m.name} (${whose(m)})`,
  }));

  return (
    <Dialog
      title="New profile"
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <Button
            className="btn primary"
            disabled={!machine || !name.trim() || Boolean(blocked) || (readable && !accepted)}
            onClick={submit}
          >
            Make profile
          </Button>
        </>
      }
    >
      <Field className="field">
        <FieldLabel className="label">Machine</FieldLabel>
        <Select
          value={machineId || null}
          placeholder="Choose a machine"
          items={machineItems}
          onValueChange={(value) => {
            if (!value) return;
            setMachineId(value);
            setAccepted(false);
          }}
        >
          <SelectTrigger id="profile-machine" className="select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="pop">
            {machineItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
                <SelectItemIndicator>
                  <Icon name="check" size={14} />
                </SelectItemIndicator>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {blocked ? (
          <FieldDescription className="hint amber-text">{blocked}</FieldDescription>
        ) : null}
        {!machineId ? (
          <FieldDescription className="hint">Choose a machine to make a profile.</FieldDescription>
        ) : null}
      </Field>
      <Field className="field">
        <FieldLabel className="label">Name</FieldLabel>
        <Input
          id="profile-name"
          className="input"
          placeholder="My Claude login"
          value={name}
          onValueChange={setName}
        />
      </Field>
      <div className="field">
        <span className="label">Keep it for</span>
        <SegmentedControl
          className="seg"
          aria-label="How long to keep the profile"
          style={{ alignSelf: "flex-start" }}
          value={String(keep)}
          onValueChange={(value) => {
            if (value) setKeepMs(Number(value));
          }}
        >
          {choices.map((c) => (
            <SegmentedControlItem key={c.ms} value={String(c.ms)}>
              <span className="seg-label">{c.label}</span>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        <span className="hint">
          {machine ? `${machine.name} keeps profiles for at most ${span(longest)}. ` : ""}
          The bridge deletes the profile when time is up, with your logins in it.
        </span>
      </div>
      {readable && owner ? (
        <div className="note warn" role="alert">
          <b>{owner.name} can read everything in this profile, including your logins.</b> The
          machine belongs to {owner.name}, so anything you sign in to or store on it is readable by
          them. Make a profile here only if you are fine with that.
          <label
            className="row-flex"
            style={{ marginTop: 8, cursor: "pointer", alignItems: "flex-start" }}
          >
            <Checkbox
              checked={accepted}
              onCheckedChange={(checked) => setAccepted(checked === true)}
            />
            <span>I understand that {owner.name} can read my logins in this profile.</span>
          </label>
        </div>
      ) : null}
    </Dialog>
  );
}
