import "../../components/agentWork.css";
import { useState } from "react";
import { useQuery } from "convex/react";
import { Button } from "@ui-sdk/react/button";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../lib/api";
import { agoText } from "../../lib/format";
import { useAccountAct } from "../../lib/pairs";
import { useAgentSetup } from "../../lib/agentSetup";
import { useBridgeCli } from "../../lib/bridgeCli";
import { McpRow, SkillRow, ToolsRow } from "../../components/AgentSetup";
import { Cmd } from "../../components/Cmd";
import { Empty } from "../../components/Empty";
import { useNow } from "../../components/useNow";
import "./commandLine.css";

type SignIn = FunctionReturnType<typeof api.people.signIns>[number];

/** "Dec 3", or "Dec 3, 2027" outside this year. */
function day(at: number, now: number): string {
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** When a sign-in was made, last used and works until, in one sentence each. */
export function signInFacts(
  signIn: Pick<SignIn, "createdAt" | "lastUsedAt" | "expiresAt">,
  now: number,
): string[] {
  return [
    `Signed in ${agoText(signIn.createdAt, now)}.`,
    signIn.lastUsedAt !== undefined
      ? `Last used ${agoText(signIn.lastUsedAt, now)}.`
      : "Not used yet.",
    `Works until ${day(signIn.expiresAt, now)}.`,
  ];
}

/**
 * Settings, Command line (ADR 0030, ADR 0042). On this computer: `uplink` and `uplink-mcp`, which
 * the app carries, in a terminal (Add to PATH), the `uplink` skill in Claude Code and Codex, and
 * `uplink-mcp` in an agent. Then each computer where you ran `uplink login`, when it signed in,
 * when it was last used and until when it works, with Revoke. Revoking signs that computer's
 * command line out at once and ends the runs its sessions joined, so it asks once more, in place.
 * The sign-ins are an account setting: the same in every team, and for someone in none.
 */
export function CommandLine() {
  const signIns = useQuery(api.people.signIns, {});
  const now = useNow(60_000);
  const cli = useBridgeCli();
  const agents = useAgentSetup();
  const platform = cli.status?.platform ?? agents.setup?.platform;
  // Outside the installed app there's nothing on this computer to set up.
  const local = cli.status !== null || cli.error !== null || Boolean(agents.setup);
  return (
    <div className="command-line-view work-ui">
      <div className="pane-title">
        <h2>Command line</h2>
      </div>
      {local ? (
        <div className="panel">
          <div className="panel-section">
            <span className="label">On this {platform === "darwin" ? "Mac" : "computer"}</span>
            <span className="muted cli-intro">
              Uplink Room carries <Cmd text="uplink" />, the Room API's command-line tool, and{" "}
              <Cmd text="uplink-mcp" />, its MCP server. With them on PATH, run{" "}
              <Cmd text="uplink login" /> once; then your Claude Code, Codex or Hermes sessions can
              join the room, pair with other people's agents and answer messages.
            </span>
            <ul className="setup-perms cli-row agent-setup" aria-label="uplink on this computer">
              <ToolsRow cli={cli} />
              <SkillRow target="claude" agents={agents} />
              <SkillRow target="codex" agents={agents} />
              <McpRow agents={agents} />
            </ul>
          </div>
        </div>
      ) : null}
      <div className="panel">
        <div className="panel-section">
          <span className="label">Signed-in computers</span>
          <span className="muted cli-intro">
            Each computer where you ran <Cmd text="uplink login" />. Its <Cmd text="uplink" /> tool
            and <Cmd text="uplink-mcp" /> act as you there, in any of your teams or in none, and its
            sessions can join the room and pair.{" "}
            {local
              ? "On this computer they come with the app, above."
              : "The Uplink Room app on each computer carries them: Settings, Command line, Add to PATH."}
          </span>
        </div>
        {signIns === undefined ? (
          <div className="panel-section muted">Loading…</div>
        ) : signIns.length === 0 ? (
          <Empty>
            No computer is signed in. Run <Cmd text="uplink login" /> in a terminal to sign in its
            command line; it opens your browser.
          </Empty>
        ) : (
          <ul className="cli-signins" aria-label="Signed-in computers">
            {signIns.map((signIn) => (
              <SignInRow key={signIn.signInId} signIn={signIn} now={now} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SignInRow({ signIn, now }: { signIn: SignIn; now: number }) {
  const revoke = useAccountAct(api.people.revokeSignIn, { success: `Signed out ${signIn.name}` });
  const [confirm, setConfirm] = useState(false);
  return (
    <li className="panel-section cli-signin work-ui">
      <div className="cli-signin-head">
        <div className="grow cli-signin-text">
          <b className="mono truncate" title={signIn.name}>
            {signIn.name}
          </b>
          <span className="muted">{signInFacts(signIn, now).join(" ")}</span>
          <span className="muted">
            Token starting <span>{signIn.prefix}</span>
          </span>
        </div>
        {confirm ? null : (
          <button className="btn" type="button" onClick={() => setConfirm(true)}>
            <span className="control-label">Revoke</span>
          </button>
        )}
      </div>
      {confirm ? (
        <div className="cli-confirm" role="group" aria-label={`Revoke ${signIn.name}`}>
          <p>
            Sign out {signIn.name}'s command line? It stops working at once, and the runs its
            sessions joined with <Cmd text="uplink join" /> end.
          </p>
          <div className="row-flex">
            <Button
              className="btn danger"
              onClick={async () => {
                await revoke({ signInId: signIn.signInId });
                setConfirm(false);
              }}
            >
              <span className="control-label">Revoke</span>
            </Button>
            <button className="btn ghost" type="button" autoFocus onClick={() => setConfirm(false)}>
              <span className="control-label">Cancel</span>
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
