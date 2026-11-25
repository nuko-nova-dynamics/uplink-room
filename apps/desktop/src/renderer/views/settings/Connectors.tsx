import "../../components/agentWork.css";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api, type Id } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { ago } from "../../lib/format";
import { useSession, useToast } from "../../lib/session";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { CopyButton } from "../../components/Copy";
import { Icon } from "../../components/Icon";
import { DEFAULT_SCOPES, ScopePicker } from "./scopes";

/**
 * Hosted assistants that join through the remote connector (ADR 0028, ADR 0031): the address a
 * person adds in Grok Bot, ChatGPT, Meta AI or Claude, the connections waiting for the person's
 * approval, and those that ended. Approving one picks its team, name and scopes (decision D15 of
 * ADR 0029); it then shows up in the agent list like any agent.
 */
type Connector = FunctionReturnType<typeof api.connectors.list>[number];

/** The room's MCP address: the HTTP actions live on `.convex.site`, beside the `.convex.cloud` the app talks to. */
export function connectorAddress(convexUrl: string | undefined): string | null {
  if (!convexUrl) return null;
  try {
    const url = new URL(convexUrl);
    if (!url.hostname.endsWith(".convex.cloud")) return null;
    url.hostname = url.hostname.replace(/\.convex\.cloud$/, ".convex.site");
    return `${url.origin}/mcp`;
  } catch {
    return null;
  }
}

const CONVEX_URL = import.meta.env["VITE_CONVEX_URL"] as string | undefined;

/** Where a connection came from: its client's host, when the client ID is a URL (a client metadata document). */
function sourceOf(connector: Connector): string | null {
  try {
    return new URL(connector.clientId).host || null;
  } catch {
    return null;
  }
}

/** "from claude.ai", or nothing when the client ID says no more than the client's own name. */
function From({ connector }: { connector: Connector }) {
  const source = sourceOf(connector);
  return source ? (
    <>
      {" "}
      from <span className="connector-origin">{source}</span>
    </>
  ) : null;
}

/** Calls an account function (no team) with the toast `useAct` gives team functions. */
function useRemove() {
  const run = useMutation(api.connectors.remove);
  const toast = useToast();
  return async (connectorId: Id<"connectors">, success: string) => {
    try {
      await run({ connectorId });
      toast.show(success, true);
    } catch (error) {
      toast.show(errorMessage(error));
    }
  };
}

export function HostedAssistants() {
  const connectors = useQuery(api.connectors.list, {});
  const address = connectorAddress(CONVEX_URL);
  const waiting = (connectors ?? []).filter((c) => c.status === "pending");
  const ended = (connectors ?? []).filter((c) => c.status === "ended");

  return (
    <div className="panel connectors work-ui">
      <div className="panel-section">
        <div className="row-flex">
          <span className="label grow">Hosted assistants</span>
          {waiting.length > 0 ? (
            <span className="chip amber">{waiting.length} waiting for you</span>
          ) : null}
        </div>
        <span className="muted connector-intro">
          Grok Bot, ChatGPT, Meta AI and Claude join as agents through a connector. Add Uplink Room
          in the assistant's connector settings
          {address ? " with this address" : " once the room's connector address is configured"} and
          sign in there. It waits here until you add it to a team.
        </span>
        {address ? (
          <div className="cmd-row">
            <code className="cmd-box" aria-label="Connector address">
              {address}
            </code>
            <CopyButton text={address} />
          </div>
        ) : (
          <span className="hint">The connector address is not configured for this room.</span>
        )}
      </div>
      {waiting.map((connector) => (
        <Waiting key={connector.connectorId} connector={connector} />
      ))}
      {ended.map((connector) => (
        <Ended key={connector.connectorId} connector={connector} />
      ))}
    </div>
  );
}

function Waiting({ connector }: { connector: Connector }) {
  const session = useSession();
  const teams = useQuery(api.teams.mine, {});
  const approve = useMutation(api.connectors.approve);
  const remove = useRemove();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(connector.label.slice(0, 24));
  const [scopes, setScopes] = useState(DEFAULT_SCOPES);
  const [teamId, setTeamId] = useState<Id<"teams">>(session.teamId);
  // Once approved, the button stays off until the row leaves the list.
  const [added, setAdded] = useState(false);
  const team = (teams ?? []).find((t) => t.teamId === teamId) ?? session.team;

  const add = async () => {
    try {
      await approve({ teamId, connectorId: connector.connectorId, name, scopes });
      setAdded(true);
      toast.show(`${name.trim()} joined ${team.name}`, true);
    } catch (error) {
      toast.show(errorMessage(error));
    }
  };

  return (
    <div className="panel-section">
      <div className="row-flex" style={{ flexWrap: "wrap" }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <b>{connector.label}</b>
          <div className="muted">
            Signed in with your account
            <From connector={connector} />, {ago(connector.createdAt)} ago. Until you add it, it
            can't read or post anything.
          </div>
        </div>
        {open ? null : (
          <>
            <button className="btn" type="button" onClick={() => setOpen(true)}>
              <span className="control-label">Review</span>
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => void remove(connector.connectorId, `Declined ${connector.label}`)}
            >
              <span className="control-label">Decline</span>
            </button>
          </>
        )}
      </div>
      {open ? (
        <>
          <div className="connector-form">
            <Field className="field">
              <FieldLabel className="label">Its name in the team</FieldLabel>
              <Input
                id={`connector-name-${connector.connectorId}`}
                className="input"
                maxLength={24}
                value={name}
                onValueChange={setName}
              />
            </Field>
            {teams && teams.length > 1 ? (
              <Field className="field">
                <FieldLabel className="label">Team</FieldLabel>
                <Select
                  value={teamId as string}
                  items={teams.map((t) => ({ value: t.teamId as string, label: t.name }))}
                  onValueChange={(value) => {
                    if (value) setTeamId(value as Id<"teams">);
                  }}
                >
                  <SelectTrigger id={`connector-team-${connector.connectorId}`} className="select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="pop">
                    {teams.map((t) => (
                      <SelectItem key={t.teamId} value={t.teamId as string}>
                        {t.name}
                        <SelectItemIndicator>
                          <Icon name="check" size={14} />
                        </SelectItemIndicator>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
          </div>
          <div className="field">
            <span className="label">What it may do</span>
            <ScopePicker value={scopes} onChange={setScopes} />
            <span className="hint">
              It starts with the smallest set. You're accountable for it, and it can do at most what
              you can.
            </span>
          </div>
          <div className="row-flex">
            <Button
              className="btn primary"
              disabled={added || !name.trim() || scopes.length === 0}
              onClick={add}
            >
              <span className="control-label">Add to {team.name}</span>
            </Button>
            <button
              className="btn"
              type="button"
              onClick={() => void remove(connector.connectorId, `Declined ${connector.label}`)}
            >
              <span className="control-label">Decline</span>
            </button>
            <button className="btn" type="button" onClick={() => setOpen(false)}>
              <span className="control-label">Cancel</span>
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Ended({ connector }: { connector: Connector }) {
  const remove = useRemove();
  return (
    <div className="panel-section">
      <div className="row-flex" style={{ flexWrap: "wrap" }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <b>{connector.agent?.name ?? connector.label}</b>
          <div className="muted">
            Its connection ended: {connector.why}. Remove it, and the next time the assistant calls
            it asks you again.
          </div>
        </div>
        <button
          className="btn"
          type="button"
          onClick={() =>
            void remove(
              connector.connectorId,
              `Removed ${connector.agent?.name ?? connector.label}`,
            )
          }
        >
          <span className="control-label">Remove</span>
        </button>
      </div>
    </div>
  );
}

/** In an agent's panel: the connection behind an agent that joined through the connector. */
export function ConnectorSection({ agentId }: { agentId: Id<"agents"> }) {
  const connectors = useQuery(api.connectors.list, {});
  const remove = useRemove();
  const connector = connectors?.find(
    (c) => c.agent?.agentId === agentId && c.status === "approved",
  );
  if (!connector) return null;
  return (
    <div className="panel-section connector-section work-ui">
      <span className="label">Connector</span>
      {connectorAddress(CONVEX_URL) ? (
        <div className="cmd-row">
          <span className="cmd-box connector-address">{connectorAddress(CONVEX_URL)}</span>
          <CopyButton text={connectorAddress(CONVEX_URL)!} />
        </div>
      ) : (
        <span className="hint">The connector address is not configured for this room.</span>
      )}
      <div className="row-flex" style={{ flexWrap: "wrap" }}>
        <span className="muted grow" style={{ minWidth: 0 }}>
          Joined
          <From connector={connector} /> through the room's connector address. Last called{" "}
          {ago(connector.lastSeenAt)} ago.
        </span>
        <button
          className="btn danger"
          type="button"
          onClick={() =>
            void remove(
              connector.connectorId,
              `Disconnected ${connector.agent?.name ?? connector.label}`,
            )
          }
        >
          <span className="control-label">Disconnect</span>
        </button>
      </div>
    </div>
  );
}
