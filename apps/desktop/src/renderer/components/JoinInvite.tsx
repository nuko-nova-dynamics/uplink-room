import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { useClerk } from "@clerk/electron/react";
import { Button } from "@ui-sdk/react/button";
import { useMutation, useQuery } from "convex/react";
import { api, type Id } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { track } from "../lib/analytics";
import { useToast } from "../lib/session";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";

/**
 * "Join <team>?" for a join link the app was opened with (lib/deepLinks.ts), once the person is
 * signed in. It names the team and who invited them before anything happens, and says plainly
 * when the invite expired, was used, was revoked, or isn't one. An invite works only for the
 * account with its verified address, so a different account gets Switch account instead of Join:
 * it signs out, and the invite waits through the next sign-in.
 */
export function JoinInvite({
  token,
  onJoined,
  onClose,
}: {
  token: string;
  onJoined: (teamId: Id<"teams">) => void;
  onClose: () => void;
}) {
  const preview = useQuery(api.invites.preview, { token });
  const accept = useMutation(api.invites.accept);
  const clerk = useClerk();
  return (
    <JoinInviteView
      preview={preview}
      onJoined={onJoined}
      onClose={onClose}
      onSwitchAccount={() => clerk.signOut()}
      onAccept={() => accept({ token })}
    />
  );
}

/** The same invite dialog with supplied results and actions for the sample gym. */
export function JoinInviteView({
  preview,
  onJoined,
  onClose,
  onSwitchAccount,
  onAccept,
}: {
  preview: FunctionReturnType<typeof api.invites.preview> | undefined;
  onJoined: (teamId: Id<"teams">) => void;
  onClose: () => void;
  onSwitchAccount: () => Promise<unknown>;
  onAccept: () => Promise<Id<"teams">>;
}) {
  const toast = useToast();
  const [failure, setFailure] = useState<string | null>(null);
  /** The switch or join went through: its button stays done until the dialog goes away. */
  const [left, setLeft] = useState(false);

  if (preview === undefined) {
    return (
      <Dialog title="Join a team" onClose={onClose}>
        <p className="muted">Checking the invite</p>
      </Dialog>
    );
  }

  const close = (
    <button className="btn" type="button" onClick={onClose}>
      Close
    </button>
  );
  if (preview.state === "invalid") {
    return (
      <Dialog title="This invite isn't valid" onClose={onClose} footer={close}>
        <p>
          The link may have been cut short, or replaced by a newer one. Ask whoever invited you to
          send it again.
        </p>
      </Dialog>
    );
  }

  const from = preview.inviterName ?? "whoever invited you";
  const role = preview.role === "admin" ? "an admin" : "a member";
  if (preview.alreadyMember) {
    return (
      <Dialog
        title={`You're already in ${preview.teamName}`}
        onClose={onClose}
        footer={
          <>
            {close}
            <button className="btn primary" type="button" onClick={() => onJoined(preview.teamId)}>
              Open team
            </button>
          </>
        }
      >
        <p>This invite stays unused, so it still works for the person it was meant for.</p>
      </Dialog>
    );
  }
  if (preview.state !== "valid") {
    const titles = {
      expired: "This invite expired",
      used: "This invite was already used",
      revoked: "This invite was revoked",
    } as const;
    return (
      <Dialog title={titles[preview.state]} onClose={onClose} footer={close}>
        <p>
          {preview.state === "used"
            ? `An invite works once. Ask ${from} for a new one to join ${preview.teamName}.`
            : `Ask ${from} for a new invite to join ${preview.teamName}.`}
        </p>
      </Dialog>
    );
  }

  if (preview.account !== "match") {
    return (
      <Dialog
        title={
          preview.account === "other"
            ? "This invite is for another account"
            : "Your email isn't verified"
        }
        onClose={onClose}
        footer={
          <>
            <button className="btn" type="button" onClick={onClose}>
              Not now
            </button>
            {/* Pending while it signs out, and done until signing out leaves this dialog. */}
            <Button
              className="btn primary"
              disabled={left}
              onClick={async () => {
                setFailure(null);
                try {
                  await onSwitchAccount();
                  setLeft(true);
                } catch (error) {
                  setFailure(errorMessage(error));
                }
              }}
            >
              {(state) => (state.pending || left ? "Switching…" : "Switch account")}
            </Button>
          </>
        }
      >
        <p>
          This invite to {preview.teamName} is for <Address value={preview.inviteFor} />
          {preview.account === "other" ? (
            <>
              . You're signed in as <Address value={preview.signedInAs ?? "another address"} />.
            </>
          ) : (
            ", and your sign-in doesn't show a verified email address."
          )}
        </p>
        <p className="muted">
          Switch account signs you out. Sign in with <Address value={preview.inviteFor} /> and the
          invite will be waiting.
        </p>
        {failure ? <InviteFailure message={failure} next="Try switching accounts again." /> : null}
      </Dialog>
    );
  }

  return (
    <Dialog
      title={`Join ${preview.teamName}?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Not now
          </button>
          {/* Pending while it joins (a second press waits for the first), and done once joined. */}
          <Button
            className="btn primary"
            disabled={left}
            onClick={async () => {
              setFailure(null);
              try {
                const teamId = await onAccept();
                setLeft(true);
                track("team_joined");
                toast.show(`You joined ${preview.teamName}`, true);
                onJoined(teamId);
              } catch (error) {
                setFailure(errorMessage(error));
              }
            }}
          >
            {(state) =>
              state.pending || left ? "Joining…" : failure ? "Try again" : "Join team"
            }
          </Button>
        </>
      }
    >
      <p>
        {from} invited {preview.email} to join {preview.teamName} as {role}.
      </p>
      <p className="muted">
        Joining shows you its channels, calls, projects and agents, and shows you to its members.
      </p>
      {failure ? (
        <InviteFailure
          message={failure}
          next={`Try again. If joining still fails, ask ${from} for a new invite.`}
        />
      ) : null}
    </Dialog>
  );
}

function InviteFailure({ message, next }: { message: string; next: string }) {
  return (
    <div className="invite-error" role="alert">
      <Icon name="alert" size={14} />
      <div>
        <p>{message}</p>
        <p className="muted">{next}</p>
      </div>
    </div>
  );
}

/** A masked address such as "a…@company.com", allowed to wrap inside the dialog. */
function Address({ value }: { value: string }) {
  return <span>{value}</span>;
}
