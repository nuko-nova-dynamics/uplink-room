import { JoinInviteView } from "../components/JoinInvite";
import type { FunctionReturnType } from "convex/server";
import type { api } from "../lib/api";

/** No account operations run from this sample dialog. */
export function InventoryInvite({ scene }: { scene: string }) {
  const preview =
    scene === "loading"
      ? undefined
      : scene === "invalid"
        ? { state: "invalid" as const }
        : {
            state: ["expired", "used", "revoked"].includes(scene) ? scene : "valid",
            teamId: "inventory-team",
            teamName:
              scene === "overflow"
                ? "Harbor observation stations and the extended coastal survey team"
                : "Harbor Labs",
            inviterName: "Rosa Vega",
            role: "member",
            expiresAt: null,
            alreadyMember: scene === "member",
            inviteFor: "a…@example.com",
            account: scene === "other" ? "other" : "match",
            signedInAs: "r…@example.com",
            email: "ana@example.com",
          };
  return (
    <JoinInviteView
      preview={preview as FunctionReturnType<typeof api.invites.preview>}
      onJoined={() => {}}
      onClose={() => {}}
      onSwitchAccount={async () => {}}
      onAccept={async () => {
        if (scene === "error") throw new Error("The sample invite could not be accepted.");
        return "inventory-team" as never;
      }}
    />
  );
}
