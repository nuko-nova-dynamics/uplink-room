import "../../components/agentWork.css";
/**
 * An agent's A2A endpoint (ADR 0012): where the room sends it work, the token
 * the room sends with it (shown only as its last four characters), the A2A
 * version the room speaks to it and the last connection check (ADR 0018), and
 * the runs sent to it.
 */
import { useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { api, type Id, type MemberRow } from "../../lib/api";
import { ago, agoText } from "../../lib/format";
import { useAct, useRoomQuery } from "../../lib/session";
import { StateIcon } from "../../components/Faces";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { SegmentedControl, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import { Icon } from "../../components/Icon";
import { Tip } from "../../components/Tip";
import { Dialog } from "../../components/Dialog";
import { useNow } from "../../components/useNow";
import { A2ARunActions, A2ARunDetails, a2aStateLabel } from "../../components/A2ARun";

export type CredentialDraft = { kind: "none" | "bearer" | "header"; name: string; secret: string };

export const NO_CREDENTIAL: CredentialDraft = { kind: "none", name: "", secret: "" };

const TOKEN_KINDS = [
  ["none", "None"],
  ["bearer", "Bearer token"],
  ["header", "In a header"],
] as const;

/** The credential argument for a2a.connect or a2a.setCredential, or undefined for none. */
export function credentialArg(draft: CredentialDraft) {
  if (draft.kind === "none" || !draft.secret.trim()) return undefined;
  return draft.kind === "bearer"
    ? { kind: "bearer" as const, secret: draft.secret }
    : { kind: "header" as const, name: draft.name, secret: draft.secret };
}

export function CredentialFields({
  value,
  onChange,
}: {
  value: CredentialDraft;
  onChange: (v: CredentialDraft) => void;
}) {
  return (
    <div className="field credential-fields work-ui">
      <span className="label">Token the room sends it</span>
      <SegmentedControl
        className="seg"
        aria-label="Token kind"
        style={{ alignSelf: "flex-start" }}
        value={value.kind}
        onValueChange={(kind) => {
          const next = TOKEN_KINDS.find(([k]) => k === kind)?.[0];
          if (next) onChange({ ...value, kind: next });
        }}
      >
        {TOKEN_KINDS.map(([kind, label]) => (
          <SegmentedControlItem key={kind} value={kind}>
            <span className="control-label">{label}</span>
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
      {value.kind === "header" ? (
        <Input
          className="input"
          aria-label="Header name"
          placeholder="X-API-Key"
          value={value.name}
          onValueChange={(name) => onChange({ ...value, name })}
        />
      ) : null}
      {value.kind !== "none" ? (
        <Input
          className="input"
          type="password"
          autoComplete="off"
          aria-label="Token"
          placeholder="The token its gateway gave you for the room"
          value={value.secret}
          onValueChange={(secret) => onChange({ ...value, secret })}
        />
      ) : null}
      <span className="hint">
        Not an agent key: this is what the agent's gateway expects from the room, such as a Hermes
        per-peer token. It is kept sealed and never shown again.
      </span>
    </div>
  );
}

type Peer = NonNullable<FunctionReturnType<typeof api.a2a.get>>;

/** What the last Check connection found, and who ran it when. A failure needs someone, so it is amber. */
function ConnectionResult({ connection }: { connection: NonNullable<Peer["connection"]> }) {
  if (connection.status === "checking") {
    return <span className="hint connection-result">Checking the connection…</span>;
  }
  return (
    <span
      className={`hint connection-result${connection.status === "failed" ? " amber-text" : ""}`}
    >
      {connection.summary} Checked by {connection.by.name} {agoText(connection.at)}.
    </span>
  );
}

export function A2AEndpoint({ agent, canManage }: { agent: MemberRow; canManage: boolean }) {
  const agentId = agent.agentId as Id<"agents">;
  const peer = useRoomQuery(api.a2a.get, { agentId });
  const recheck = useAct(api.a2a.recheck, { success: "Reading its card again" });
  const checkConnection = useAct(api.a2a.checkConnection);
  const disconnect = useAct(api.a2a.disconnect, { success: "Disconnected" });
  const clear = useAct(api.a2a.clearCredential, { success: "Token deleted" });
  const update = useAct(api.a2a.update, { success: "Saved" });
  const [editing, setEditing] = useState<"connect" | "address" | "token" | null>(null);

  if (peer === undefined) return null;
  return (
    <div className="panel-section a2a-endpoint work-ui">
      <div className="row-flex">
        <span className="label grow">A2A endpoint{peer ? ": Agent Card" : ""}</span>
        {canManage && !peer ? (
          <button className="btn" type="button" onClick={() => setEditing("connect")}>
            <Icon name="plus" />
            <span className="control-label"> Connect</span>
          </button>
        ) : null}
        {peer ? (
          peer.status === "ready" ? (
            <span className="chip">
              <Icon name="check" size={14} /> <span className="control-label">Ready</span>
            </span>
          ) : peer.status === "checking" ? (
            <span className="chip">Reading its card…</span>
          ) : (
            <span className="chip amber">Card not read</span>
          )
        ) : null}
      </div>
      {!peer ? (
        <span className="muted">
          Not connected. Connect its A2A gateway (Hermes, OpenClaw or any A2A 1.0 or 0.3 agent) so
          the room can send it work from tasks and mentions.
        </span>
      ) : (
        <>
          {/* The agent is named above; the card's own name shows only when it differs. */}
          {peer.card && peer.card.name !== agent.name ? <b>{peer.card.name}</b> : null}
          <span className="muted truncate">{peer.cardUrl}</span>
          {peer.error ? <div className="note warn">{peer.error}</div> : null}
          {peer.card ? (
            <>
              {peer.card.description ? (
                <span className="muted">{peer.card.description}</span>
              ) : null}
              <div className="run-chips">
                <span className="tag">
                  {peer.card.streaming ? "Streams updates" : "Polled for updates"}
                </span>
                <span className="tag">
                  {peer.cancel === "supported"
                    ? "Can be asked to stop"
                    : peer.cancel === "unsupported"
                      ? "Can't be asked to stop"
                      : "Stop not tried yet"}
                </span>
                {peer.protocol.speaks === "0.3" ? (
                  <span
                    className="tag"
                    title={
                      peer.protocol.declared === "0.3"
                        ? "Its Agent Card names A2A 0.3, so the room speaks 0.3 to it."
                        : "Its Agent Card says A2A 1.0, but it answers only A2A 0.3, so the room speaks 0.3 to it."
                    }
                  >
                    Speaks A2A 0.3
                  </span>
                ) : null}
                {peer.card.skills.map((s) => (
                  <span key={s.id} className="tag">
                    {s.name}
                  </span>
                ))}
              </div>
              {peer.card.needsCredential && !peer.credential ? (
                <div className="note warn">
                  Its card asks for{" "}
                  {peer.card.security
                    .map((s) => (s.detail ? `${s.kind} (${s.detail})` : s.kind))
                    .join(" or ") || "a credential"}
                  , and the room has no token for it.
                </div>
              ) : null}
            </>
          ) : null}
          <span className="hint">
            {peer.credential
              ? `Token: ${peer.credential.kind === "bearer" ? "bearer" : `in ${peer.credential.headerName}`} ${peer.credential.hint}, set by ${peer.credential.setBy.name} ${ago(peer.credential.setAt)} ago.`
              : "No token."}{" "}
            {peer.sendWork === "team"
              ? "Anyone in the team can send it work."
              : `Only ${agent.addedBy?.name ?? "its person"} can send it work.`}
          </span>
          {peer.connection ? <ConnectionResult connection={peer.connection} /> : null}
          {canManage ? (
            <div className="row-flex" style={{ flexWrap: "wrap" }}>
              <Tip
                label={
                  peer.endpointUrl
                    ? "Makes one harmless call with the room's token, to see whether it works and which A2A version answers"
                    : "Its Agent Card has to be read first"
                }
              >
                <Button
                  className="btn"
                  focusableWhenDisabled
                  disabled={!peer.endpointUrl || peer.connection?.status === "checking"}
                  onClick={() => void checkConnection({ agentId })}
                >
                  <span className="control-label">Check connection</span>
                </Button>
              </Tip>
              <button className="btn" type="button" onClick={() => void recheck({ agentId })}>
                <span className="control-label">Read the card again</span>
              </button>
              <button className="btn" type="button" onClick={() => setEditing("address")}>
                <span className="control-label">Change address</span>
              </button>
              <button className="btn" type="button" onClick={() => setEditing("token")}>
                <span className="control-label">
                  {peer.credential ? "Replace token" : "Add a token"}
                </span>
              </button>
              {peer.credential ? (
                <button className="btn" type="button" onClick={() => void clear({ agentId })}>
                  <span className="control-label">Delete token</span>
                </button>
              ) : null}
              <button
                className="btn"
                type="button"
                onClick={() =>
                  void update({
                    agentId,
                    sendWork: peer.sendWork === "team" ? "accountable" : "team",
                  })
                }
              >
                <span className="control-label truncate">
                  {peer.sendWork === "team"
                    ? `Only ${agent.addedBy?.name ?? "its person"} sends work`
                    : "Anyone sends work"}
                </span>
              </button>
              <button
                className="btn danger"
                type="button"
                onClick={() => void disconnect({ agentId })}
              >
                <span className="control-label">Disconnect</span>
              </button>
            </div>
          ) : null}
        </>
      )}
      {editing ? (
        <EndpointDialog
          agentId={agentId}
          agentName={agent.name}
          mode={editing}
          currentUrl={peer?.cardUrl}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function EndpointDialog({
  agentId,
  agentName,
  mode,
  currentUrl,
  onClose,
}: {
  agentId: Id<"agents">;
  agentName: string;
  mode: "connect" | "address" | "token";
  currentUrl: string | undefined;
  onClose: () => void;
}) {
  const connect = useAct(api.a2a.connect, { success: "Connected. Reading its card." });
  const update = useAct(api.a2a.update, { success: "Saved. Reading its card." });
  const setCredential = useAct(api.a2a.setCredential, { success: "Token saved" });
  const [url, setUrl] = useState(mode === "address" ? (currentUrl ?? "") : "");
  const [credential, setCredentialDraft] = useState<CredentialDraft>(NO_CREDENTIAL);

  const submit = async () => {
    const cred = credentialArg(credential);
    const ok =
      mode === "connect"
        ? await connect({ agentId, cardUrl: url, ...(cred ? { credential: cred } : {}) })
        : mode === "address"
          ? await update({ agentId, cardUrl: url })
          : cred
            ? await setCredential({ agentId, credential: cred })
            : undefined;
    if (ok !== undefined) onClose();
  };

  return (
    <Dialog
      title={mode === "token" ? `Token for ${agentName}` : `${agentName}'s A2A address`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            <span className="control-label">Cancel</span>
          </button>
          <Button
            className="btn primary"
            disabled={mode === "token" ? !credentialArg(credential) : !url.trim()}
            onClick={submit}
          >
            <span className="control-label">Save</span>
          </Button>
        </>
      }
    >
      {mode !== "token" ? (
        <Field className="field credential-fields work-ui">
          <FieldLabel className="label">Its address</FieldLabel>
          <Input
            id="a2a-url"
            className="input"
            placeholder="https://hermes.example.com"
            value={url}
            onValueChange={setUrl}
          />
          <FieldDescription className="hint">
            The room reads its Agent Card from /.well-known/agent-card.json there, and sends
            requests only to that address over https. It needs A2A 1.0 or 0.3 over JSON-RPC, and an
            address the room's server can reach.
          </FieldDescription>
        </Field>
      ) : null}
      {mode !== "address" ? (
        <CredentialFields value={credential} onChange={setCredentialDraft} />
      ) : null}
    </Dialog>
  );
}

export function AgentRuns({ agent }: { agent: MemberRow }) {
  const runs = useRoomQuery(api.a2a.runs, { agentId: agent.agentId as Id<"agents">, limit: 20 });
  const [open, setOpen] = useState<string | null>(null);
  const now = useNow(1000);
  if (!runs || runs.length === 0) return null;
  return (
    <div className="panel-section a2a-endpoint work-ui">
      <span className="label">Runs sent to {agent.name}</span>
      {runs.map((run) => (
        <div key={run.runId} className="a2a-run-row">
          <button
            type="button"
            className="row-flex"
            style={{
              background: "none",
              border: 0,
              padding: 0,
              textAlign: "left",
              color: "inherit",
              cursor: "pointer",
            }}
            aria-expanded={open === run.runId}
            onClick={() => setOpen(open === run.runId ? null : run.runId)}
          >
            <StateIcon state={run.state} withLabel />
            <b className="grow truncate">{run.title ?? "Run"}</b>
            <span className="muted">
              {a2aStateLabel(run.a2a?.externalState)}, {agoText(run.stateChangedAt, now)}
            </span>
          </button>
          {open === run.runId ? (
            <div className="a2a-run-details">
              <A2ARunDetails run={run} now={now} inAgent />
              <A2ARunActions run={run} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
