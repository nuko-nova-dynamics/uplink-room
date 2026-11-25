import { useState } from "react";
import { useMutation } from "convex/react";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { api, type Id } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { useToast } from "../lib/session";
import { track } from "../lib/analytics";

/**
 * Create a team, or join one with an invite token: the team picker's forms, and the same two on
 * the home of someone in no team. `teams.mine` is live, so a new team shows up on its own. Each
 * form is its field (UI SDK Field rendered as the form), so the label, box and hint keep the form's
 * layout. The form's own submit does the work, so a busy flag disables its button meanwhile.
 */
export function TeamForms({ onJoined }: { onJoined: (teamId: Id<"teams">) => void }) {
  const toast = useToast();
  const createTeam = useMutation(api.teams.create);
  const accept = useMutation(api.invites.accept);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <>
      <Field
        render={
          <form
            className="field team-form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!name.trim()) return;
              setBusy(true);
              try {
                const teamId = await createTeam({ name });
                track("team_created");
                onJoined(teamId);
              } catch (error) {
                toast.show(errorMessage(error));
              } finally {
                setBusy(false);
              }
            }}
          />
        }
      >
        <FieldLabel className="label">Create a team</FieldLabel>
        <div className="row-flex">
          <Input
            id="team-name"
            className="input"
            placeholder="Team name"
            value={name}
            onValueChange={setName}
          />
          <Button className="btn primary" type="submit" disabled={busy || !name.trim()}>
            Create
          </Button>
        </div>
        <FieldDescription className="hint" render={<span />}>
          You become its first admin, and it starts with #general.
        </FieldDescription>
      </Field>

      <Field
        render={
          <form
            className="field team-form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!token.trim()) return;
              setBusy(true);
              try {
                const teamId = await accept({ token: token.trim() });
                track("team_joined");
                onJoined(teamId);
              } catch (error) {
                toast.show(errorMessage(error));
              } finally {
                setBusy(false);
              }
            }}
          />
        }
      >
        <FieldLabel className="label">Join with an invite token</FieldLabel>
        <div className="row-flex">
          <Input
            id="invite-token"
            className="input"
            placeholder="Paste the token an admin sent you"
            value={token}
            onValueChange={setToken}
          />
          <Button className="btn" type="submit" disabled={busy || !token.trim()}>
            Join
          </Button>
        </div>
      </Field>
    </>
  );
}
