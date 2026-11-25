import { useState } from "react";
import { useMutation } from "convex/react";
import { errorMessage } from "../../lib/errors";
import type { FunctionReturnType } from "convex/server";
import { api, type Id, type MemberRow } from "../../lib/api";
import { useAct, useRoomQuery, useSession, useSoftRoomQuery, useToast } from "../../lib/session";
import type { IconName } from "../../lib/states";
import { MemberFace } from "../../components/Faces";
import { Icon } from "../../components/Icon";
import { Dialog } from "../../components/Dialog";
import { CopyButton } from "../../components/Copy";
import { useNow } from "../../components/useNow";
import { Tip } from "../../components/Tip";
import { Button } from "@ui-sdk/react/button";
import { Checkbox } from "@ui-sdk/react/checkbox";
import { Field, FieldLabel } from "@ui-sdk/react/field";
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
import { OnOff } from "./Notifications";
import "./members.css";

type InviteRow = FunctionReturnType<typeof api.invites.list>[number];

/** A new token to hand out: from making, regenerating or resending an invite. */
type Made = {
  inviteId: Id<"invites">;
  email: string;
  token: string;
  url: string;
  expiresAt: number;
  /** Whether the room has an email on its way with the link. */
  emailed: boolean;
  /** Whether an email was asked for: when it was and `emailed` is false, the link must go by hand. */
  emailWanted: boolean;
};

const MINUTE = 60_000;

const ROLES: { value: "admin" | "member"; label: string }[] = [
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
];

function day(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function Members() {
  const session = useSession();
  const invites = useRoomQuery(api.invites.list, {});
  const setRole = useAct(api.members.setRole);
  const remove = useAct(api.members.remove, { success: "Removed from the team" });
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<MemberRow | null>(null);
  const [regenerated, setRegenerated] = useState<Made | null>(null);
  const [revoking, setRevoking] = useState<InviteRow | null>(null);

  return (
    <>
      <div className="pane-title">
        <h2>Members</h2>
        <Tip label="Only admins can invite people." disabled={session.isAdmin}>
          <Button
            className="btn primary"
            disabled={!session.isAdmin}
            focusableWhenDisabled
            onClick={() => setInviting(true)}
          >
            <Icon name="plus" /> Invite someone
          </Button>
        </Tip>
      </div>
      <div className="panel">
        <table className="table members-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Role</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {session.members.map((m) => (
              <tr key={m.memberId}>
                <td>
                  <span className="row-flex">
                    <MemberFace member={m} members={session.members} size={24} />
                    <span className="member-name" title={m.name}>
                      {m.name}
                      {m.memberId === session.me.memberId ? (
                        <span className="muted"> (you)</span>
                      ) : null}
                    </span>
                  </span>
                </td>
                <td className="muted">
                  {m.kind === "agent"
                    ? `Agent${m.addedBy ? `, added by ${m.addedBy.name}` : ""}`
                    : "Person"}
                </td>
                <td>
                  <Select
                    items={ROLES}
                    value={m.role}
                    disabled={!session.isAdmin}
                    onValueChange={(role) => {
                      if (role === "admin" || role === "member")
                        void setRole({ memberId: m.memberId, role });
                    }}
                  >
                    <SelectTrigger
                      className="select"
                      style={{ width: 120 }}
                      aria-label={`Role of ${m.name}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="pop">
                      {ROLES.map((role) => (
                        <SelectItem key={role.value} value={role.value}>
                          {role.label}
                          <SelectItemIndicator>
                            <Icon name="check" size={14} />
                          </SelectItemIndicator>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td style={{ textAlign: "right" }}>
                  <button
                    className="btn shell-danger"
                    type="button"
                    disabled={!session.isAdmin || m.memberId === session.me.memberId}
                    onClick={() => setRemoving(m)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!session.isAdmin ? (
        <div className="note">Only admins can invite people, change roles and remove members.</div>
      ) : null}

      {(invites?.length ?? 0) > 0 ? (
        <div className="field">
          <span className="label" id="waiting-invites">
            Waiting invites
          </span>
          <div className="panel">
            <ul className="invite-list" aria-labelledby="waiting-invites">
              {invites!.map((invite) => (
                <WaitingInvite
                  key={invite.inviteId}
                  invite={invite}
                  admin={session.isAdmin}
                  onRegenerated={setRegenerated}
                  onRevoke={setRevoking}
                />
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <InviteReminders />

      {inviting ? <InviteDialog onClose={() => setInviting(false)} /> : null}
      {regenerated ? (
        <Dialog
          title={
            regenerated.emailWanted && !regenerated.emailed
              ? `The new link for ${regenerated.email} wasn't emailed`
              : `New token for ${regenerated.email}`
          }
          onClose={() => setRegenerated(null)}
          footer={
            <button className="btn primary" type="button" onClick={() => setRegenerated(null)}>
              Done
            </button>
          }
        >
          <InviteResult made={regenerated} replaced />
        </Dialog>
      ) : null}
      {revoking ? <RevokeDialog invite={revoking} onClose={() => setRevoking(null)} /> : null}
      {removing ? (
        <Dialog
          title={`Remove ${removing.name}?`}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <button className="btn" type="button" onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button
                className="btn shell-danger solid"
                type="button"
                onClick={async () => {
                  await remove({ memberId: removing.memberId });
                  setRemoving(null);
                }}
              >
                Remove
              </button>
            </>
          }
        >
          <p>
            {removing.kind === "person"
              ? `${removing.name} loses access to the team, and the agents they added stop.`
              : `${removing.name} loses access to the team.`}
            <LeavingGitHub memberId={removing.memberId} />
          </p>
        </Dialog>
      ) : null}
    </>
  );
}

/**
 * The personal GitHub accounts a member connected, which members.remove disconnects (ADR 0020):
 * their repos leave the repo pickers. Organizations they connected stay with the team.
 */
function LeavingGitHub({ memberId }: { memberId: Id<"members"> }) {
  // Soft: GitHub not being set up, or not answering, leaves the dialog as it was.
  const github = useSoftRoomQuery(api.github.accounts, {});
  const theirs = (github?.accounts ?? [])
    .filter((a) => a.type === "User" && a.connectedById === memberId)
    .map((a) => a.login);
  if (theirs.length === 0) return null;
  return theirs.length === 1
    ? ` Their GitHub account ${theirs[0]} is disconnected, and its repos leave the repo pickers. The App stays installed on it until they uninstall it on GitHub.`
    : ` Their GitHub accounts ${theirs.join(", ")} are disconnected, and their repos leave the repo pickers. The App stays installed on them until they uninstall it on GitHub.`;
}

type Line = { text: string; icon: IconName; failed?: boolean };

function expiryLine(invite: InviteRow, now: number): Line {
  if (invite.expiresAt === null) return { text: "Doesn't expire", icon: "clock" };
  if (invite.expiresAt <= now)
    return { text: `Expired ${day(invite.expiresAt)}`, icon: "clock", failed: true };
  return { text: `Expires ${day(invite.expiresAt)}`, icon: "clock" };
}

/** Where the invite's latest email stands, or null when none was sent. */
function emailLine(invite: InviteRow): Line | null {
  const state = invite.emailState;
  if (!state)
    return invite.sendEmail
      ? { text: "No email sent", icon: "send" }
      : { text: "Not emailed: send the link yourself", icon: "link" };
  const what = state.kind === "reminder" ? "Reminder" : "Email";
  if (state.status === "sent") return { text: `${what} sent ${day(state.at)}`, icon: "tick" };
  if (state.status === "failed")
    return {
      text: `${what} failed: ${state.error ?? "unknown error"}`,
      icon: "alert",
      failed: true,
    };
  if (state.status === "skipped")
    return { text: `${what} not sent: ${state.error ?? "it no longer applied"}`, icon: "link" };
  return {
    text: state.error
      ? `Sending the ${what.toLowerCase()} again after an error: ${state.error}`
      : `Sending the ${what.toLowerCase()}`,
    icon: "send",
  };
}

function MetaLine({ line }: { line: Line }) {
  return (
    <span className={line.failed ? "invite-failed" : undefined}>
      <Icon name={line.icon} size={14} aria-hidden="true" />
      <span>{line.text}</span>
    </span>
  );
}

function WaitingInvite({
  invite,
  admin,
  onRegenerated,
  onRevoke,
}: {
  invite: InviteRow;
  admin: boolean;
  onRegenerated: (made: Made) => void;
  onRevoke: (invite: InviteRow) => void;
}) {
  const now = useNow(MINUTE);
  const toast = useToast();
  const link = useAct(api.invites.link);
  const resend = useAct(api.invites.resend);
  const regenerate = useAct(api.invites.regenerate);
  // The action running now; the other actions wait for it.
  const [busy, setBusy] = useState<"resend" | "regenerate" | null>(null);
  const expiry = expiryLine(invite, now);
  const email = emailLine(invite);
  const expired = invite.expiresAt !== null && invite.expiresAt <= now;
  const copyBlocked = !invite.canCopyLink
    ? "This invite's link can't be shown again. Regenerate the token for a new one."
    : expired
      ? "The link expired. Resend the email or regenerate the token for a new one."
      : undefined;

  return (
    <li className="invite-row">
      <div className="invite-main">
        <div className="invite-who">
          <span className="truncate">{invite.email}</span>
          <span className="tag">{invite.role === "admin" ? "Admin" : "Member"}</span>
        </div>
        <div className="invite-meta">
          <span>
            <span>
              Invited by {invite.invitedBy?.name ?? "someone who left"}, {day(invite.invitedAt)}
            </span>
          </span>
          <MetaLine line={expiry} />
          {email ? <MetaLine line={email} /> : null}
        </div>
      </div>
      {admin ? (
        <div
          className="invite-actions"
          role="group"
          aria-label={`Actions for the invite to ${invite.email}`}
        >
          <CopyButton
            label="Copy link"
            disabled={copyBlocked !== undefined}
            title={copyBlocked}
            text={async () => {
              const got = await link({ inviteId: invite.inviteId });
              if (!got) throw new Error("No link");
              return got.url;
            }}
          />
          <Button
            className="btn small"
            disabled={busy === "regenerate"}
            onClick={async () => {
              setBusy("resend");
              const made = await resend({ inviteId: invite.inviteId }).finally(() => setBusy(null));
              if (!made) return;
              // No email went out (none set up here, or the link can't be sealed): the new link is
              // the only way in now, so show it for sending by hand.
              if (made.emailed)
                toast.show(
                  `Emailing ${invite.email} a new link. The old one stopped working.`,
                  true,
                );
              else onRegenerated({ ...made, email: invite.email, emailWanted: true });
            }}
          >
            <Icon name="send" /> Resend email
          </Button>
          <Button
            className="btn small"
            disabled={busy === "resend"}
            onClick={async () => {
              setBusy("regenerate");
              const made = await regenerate({ inviteId: invite.inviteId }).finally(() =>
                setBusy(null),
              );
              if (made)
                onRegenerated({ ...made, email: invite.email, emailWanted: invite.sendEmail });
            }}
          >
            Regenerate token
          </Button>
          <button
            className="btn small shell-danger"
            type="button"
            disabled={busy !== null}
            onClick={() => onRevoke(invite)}
          >
            Revoke
          </button>
        </div>
      ) : null}
    </li>
  );
}

function RevokeDialog({ invite, onClose }: { invite: InviteRow; onClose: () => void }) {
  const revoke = useMutation(api.invites.revoke);
  const { teamId } = useSession();
  const toast = useToast();
  const [error, setError] = useState("");
  return (
    <Dialog
      title={`Revoke the invite to ${invite.email}?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <Button
            className="btn shell-danger solid"
            pendingAnnouncement="Revoking"
            onClick={async () => {
              setError("");
              try {
                await revoke({ teamId, inviteId: invite.inviteId });
                toast.show(`Revoked the invite to ${invite.email}`, true);
                onClose();
              } catch (cause) {
                setError(errorMessage(cause));
              }
            }}
          >
            {(state) => (state.pending ? "Revoking…" : "Revoke invite")}
          </Button>
        </>
      }
    >
      {error ? (
        <p className="invite-error" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      ) : null}
      <p>
        The link and token stop working at once, even if {invite.email} already has the email. You
        can invite them again later.
      </p>
    </Dialog>
  );
}

/** The team's invite reminders: one email 3 days in, for invites nobody accepted. */
function InviteReminders() {
  const session = useSession();
  const settings = useRoomQuery(api.teams.settings, {});
  const set = useAct(api.teams.setInviteReminders);
  const on = (settings?.inviteReminders ?? "on") === "on";
  return (
    <div className="panel">
      <div className="panel-section">
        <div className="settings-copy">
          <span className="label" id="invite-reminders">
            Invite reminders
          </span>
          <OnOff
            labelledBy="invite-reminders"
            on={on}
            disabled={!session.isAdmin || settings === undefined}
            onChange={(value) => void set({ inviteReminders: value ? "on" : "off" })}
          />
          <span className="hint">
            An invite nobody has accepted after 3 days gets one reminder email, never more.
            Revoking, regenerating or resending an invite turns its reminder off.
            {session.isAdmin ? "" : " Only admins can change this."}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Where a new invite's email stands, live. Nothing when none was queued and none is recorded. */
function EmailStatus({ inviteId, emailed }: { inviteId: Id<"invites">; emailed: boolean }) {
  const invites = useRoomQuery(api.invites.list, {});
  const state = invites?.find((i) => i.inviteId === inviteId)?.emailState;
  let line: Line;
  if (state?.status === "sent") line = { text: "Email sent", icon: "tick" };
  else if (state?.status === "skipped")
    line = {
      text: `The email wasn't sent: ${state.error ?? "it no longer applies"}`,
      icon: "link",
    };
  else if (state?.status === "failed")
    line = {
      text: `The email didn't go out: ${state.error ?? "unknown error"}. Copy the link and send it yourself.`,
      icon: "alert",
      failed: true,
    };
  else if (!state && !emailed) return null;
  else
    line = {
      text: state?.error
        ? `Sending the email again after an error: ${state.error}`
        : "Sending the email",
      icon: "send",
    };
  return (
    <p className={`invite-status${line.failed ? " invite-failed" : ""}`} role="status">
      <Icon name={line.icon} aria-hidden="true" /> {line.text}
    </p>
  );
}

/** The link and token of a new invite or a regenerated one, with copy buttons. */
function InviteResult({ made, replaced = false }: { made: Made; replaced?: boolean }) {
  const session = useSession();
  return (
    <>
      <p>
        {made.emailed
          ? `Uplink Room is emailing ${made.email} a link to join ${session.team.name}.`
          : made.emailWanted
            ? `The email didn't go out, so send ${made.email} this link to join ${session.team.name} yourself.`
            : `Send ${made.email} this link to join ${session.team.name}.`}{" "}
        {replaced ? "The old token stopped working. " : ""}
        It works once, until {day(made.expiresAt)}.
      </p>
      {made.emailed || made.emailWanted ? (
        <EmailStatus inviteId={made.inviteId} emailed={made.emailed} />
      ) : null}
      <div className="secret-box">{made.url}</div>
      <div className="row-flex">
        <CopyButton text={made.url} label="Copy link" primary />
        <CopyButton text={made.token} label="Copy token" />
      </div>
      <p className="hint">
        The token is the part after #. If the link doesn't open Uplink Room, they can paste the
        token where the app asks to join a team.
      </p>
    </>
  );
}

function InviteDialog({ onClose }: { onClose: () => void }) {
  const create = useMutation(api.invites.create);
  const { teamId } = useSession();
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [sendEmail, setSendEmail] = useState(true);
  const [made, setMade] = useState<Made | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (form: HTMLFormElement | null) => {
    if (busy || !form) return;
    if (!form.checkValidity()) {
      setError("Enter a valid email address.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await create({ teamId, email, role, sendEmail });
      setMade({ ...result, email: email.trim().toLowerCase(), emailWanted: sendEmail });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Invite someone"
      onClose={onClose}
      footer={
        made ? (
          <button className="btn primary" type="button" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button className="btn" type="button" onClick={onClose}>
              Cancel
            </button>
            <Button
              className="btn primary"
              type="submit"
              form="invite-form"
              disabled={!email.trim()}
              pendingAnnouncement="Sending"
              onClick={(event) => {
                // The press sends the invite itself, so the button shows it's busy. Enter in the
                // email field presses this button too, as the form's default button.
                event.preventDefault();
                return submit((event.currentTarget as HTMLButtonElement).form);
              }}
            >
              {(state) =>
                state.pending ? "Sending…" : sendEmail ? "Send invite" : "Make an invite"
              }
            </Button>
          </>
        )
      }
    >
      {made ? (
        <InviteResult made={made} />
      ) : (
        <form
          id="invite-form"
          className="invite-form"
          noValidate
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            void submit(event.currentTarget);
          }}
        >
          <Field className="field" invalid={error === "Enter a valid email address."}>
            <FieldLabel className="label">Email</FieldLabel>
            <Input
              id="invite-email"
              className="input"
              type="email"
              required
              aria-describedby={error ? "invite-email-error" : undefined}
              value={email}
              onValueChange={(value) => {
                setEmail(value);
                setError("");
              }}
            />
          </Field>
          {error ? (
            <p id="invite-email-error" className="invite-error" role="alert">
              <Icon name="alert" />
              <span>{error}</span>
            </p>
          ) : null}
          <div className="field">
            <span className="label" id="invite-role">
              Role
            </span>
            <SegmentedControl
              className="seg"
              aria-labelledby="invite-role"
              style={{ alignSelf: "flex-start" }}
              value={role}
              onValueChange={(value) => {
                if (value === "member" || value === "admin") setRole(value);
              }}
            >
              <SegmentedControlItem value="member">
                <span className="seg-label">Member</span>
              </SegmentedControlItem>
              <SegmentedControlItem value="admin">
                <span className="seg-label">Admin</span>
              </SegmentedControlItem>
            </SegmentedControl>
          </div>
          <label className="check-row">
            <Checkbox
              checked={sendEmail}
              onCheckedChange={(checked) => setSendEmail(checked === true)}
            />
            <span>Email them the invite</span>
          </label>
          <span className="hint">
            {sendEmail
              ? "They get a link to join, with the token in case the link can't open the app. It works once, for 7 days."
              : "You get the link to send yourself. It works once, for 7 days."}
          </span>
        </form>
      )}
    </Dialog>
  );
}
