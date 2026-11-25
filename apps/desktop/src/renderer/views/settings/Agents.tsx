import "../../components/agentWork.css";
import { useEffect, useState } from "react";
import { api, type Id, type MemberRow } from "../../lib/api";
import { ago, harnessLabel, clock } from "../../lib/format";
import { useNow } from "../../components/useNow";
import { useAct, useRoomQuery, useSession } from "../../lib/session";
import {
  BODY_OPTIONS,
  CharacterView,
  COLOR_OPTIONS,
  TOOL_OPTIONS,
} from "../../characters/CharacterView";
import { HarnessMark, MemberFace, StateIcon } from "../../components/Faces";
import { Button } from "@ui-sdk/react/button";
import { Checkbox } from "@ui-sdk/react/checkbox";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { Radio, RadioGroup } from "@ui-sdk/react/radio";
import { Icon } from "../../components/Icon";
import { Tip } from "../../components/Tip";
import { Dialog } from "../../components/Dialog";
import { CopyButton } from "../../components/Copy";
import { HostedAssistants, ConnectorSection } from "./Connectors";
import { WebhookSection } from "./Webhook";
import { CHECKS_IN } from "../../lib/chat";
import { DEFAULT_SCOPES, SCOPES, ScopePicker } from "./scopes";
import {
  A2AEndpoint,
  AgentRuns,
  credentialArg,
  CredentialFields,
  NO_CREDENTIAL,
  type CredentialDraft,
} from "./A2AEndpoint";

const CONNECTIONS = [
  { id: "a2a", label: "A2A" },
  { id: "mcp", label: "MCP" },
  { id: "http", label: "HTTP" },
  { id: "cli", label: "Command line" },
] as const;

/** The Tool choice for no tool: the character then carries no accessory. */
const NO_TOOL = "none";

export function Agents() {
  const session = useSession();
  const [adding, setAdding] = useState<false | true | AgentTemplate>(false);
  const [selected, setSelected] = useState<string | null>(null);
  const agents = session.members.filter((m) => m.kind === "agent");
  const agent = agents.find((a) => a.memberId === selected) ?? agents[0];

  return (
    <div className="agents-view work-ui">
      <div className="pane-title">
        <h2>Agents</h2>
        <button className="btn primary" type="button" onClick={() => setAdding(true)}>
          <Icon name="plus" />
          <span className="control-label"> Add an agent</span>
        </button>
      </div>
      <p className="muted" style={{ maxWidth: 640 }}>
        Agents are team members that aren't people. Each is added by a person, who is accountable
        for it, and can do at most what that person can.
      </p>
      <RunningTools />
      <HostedAssistants />
      {agents.length === 0 ? (
        <div className="panel">
          {/* Start from a role: each opens Add an agent with its name and character set. */}
          <div className="agent-templates">
            <p className="muted">
              No team agents yet. Start from a role, or add your own with Add an agent.
            </p>
            {TEMPLATES.map((t) => (
              <div key={t.name} className="agent-template">
                <CharacterView
                  character={{ body: t.body, color: t.color, accessory: t.tool } as never}
                  state="idle"
                  size={36}
                  label={t.name}
                />
                <span className="agent-template-text">
                  <b>{t.name}</b>
                  <span className="muted">{t.line}</span>
                </span>
                <button className="btn" type="button" onClick={() => setAdding(t)}>
                  <Icon name="plus" />
                  <span className="control-label"> Add</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="machine-grid">
          <div className="machine-list">
            {agents.map((a) => (
              <button
                key={a.memberId}
                type="button"
                className={`option ${agent?.memberId === a.memberId ? "selected" : ""}`}
                style={{ gridTemplateColumns: "auto minmax(0,1fr) auto" }}
                onClick={() => setSelected(a.memberId)}
              >
                <MemberFace member={a} members={session.members} size={30} />
                <span className="truncate">{a.name}</span>
                {a.role === "admin" ? <span className="chip amber">Admin</span> : <span />}
                <span className="sub" style={{ gridColumn: "2 / 4" }}>
                  {a.addedBy ? `Added by ${a.addedBy.name}` : "Agent"}
                </span>
              </button>
            ))}
          </div>
          {agent ? <AgentPanel key={agent.memberId} agent={agent} /> : <div />}
        </div>
      )}
      {adding ? (
        <AddAgent
          template={adding === true ? undefined : adding}
          onClose={() => setAdding(false)}
          onAdded={(id) => setSelected(id)}
        />
      ) : null}
    </div>
  );
}

function AgentPanel({ agent }: { agent: MemberRow }) {
  const session = useSession();
  const agentId = agent.agentId;
  const keys = useRoomQuery(api.agents.keys, agentId ? { agentId } : "skip");
  const setRole = useAct(api.members.setRole);
  const revoke = useAct(api.agents.revokeKey, { success: "Key revoked. It stops working now." });
  const setScopes = useAct(api.agents.setKeyScopes, { success: "Scopes saved" });
  const [making, setMaking] = useState(false);
  const mine = agent.addedBy?.memberId === session.me.memberId;

  return (
    <div className="panel agent-panel work-ui">
      <div className="panel-section">
        <div className="row-flex" style={{ flexWrap: "wrap" }}>
          <MemberFace member={agent} members={session.members} size={44} state="idle" />
          <div className="grow agent-identity">
            <b>{agent.name}</b>
            <div className="muted">
              {agent.addedBy ? `Added by ${agent.addedBy.name}, who is accountable for it. ` : ""}It
              can do at most what {agent.addedBy?.name ?? "that person"} can.
            </div>
            {agent.reach === "checks_in" ? (
              <div className="muted">
                {CHECKS_IN}: it reads and posts through its connector when it runs, so messages to
                it wait until it next checks.
              </div>
            ) : null}
          </div>
          <label className="row-flex" style={{ cursor: session.isAdmin ? "pointer" : "default" }}>
            <Checkbox
              checked={agent.role === "admin"}
              disabled={!session.isAdmin}
              onCheckedChange={(checked) =>
                void setRole({
                  memberId: agent.memberId,
                  role: checked === true ? "admin" : "member",
                })
              }
            />
            <span>Admin</span>
          </label>
        </div>
        {agent.role === "admin" ? (
          <div className="note warn">
            An admin agent's key is as powerful as an admin's, including opening a team machine's
            terminals. Scopes narrow it; revoking a key stops it at once.
          </div>
        ) : null}
      </div>

      {agentId ? <ConnectorSection agentId={agentId} /> : null}
      {/* An agent is reached one way: an A2A endpoint or a routine webhook, never both. */}
      {agentId && agent.reach !== "webhook" ? (
        <A2AEndpoint agent={agent} canManage={mine || session.isAdmin} />
      ) : null}
      {agentId && agent.reach !== "a2a" ? (
        <WebhookSection agent={agent} canManage={mine || session.isAdmin} />
      ) : null}
      {agentId ? <AgentRuns agent={agent} /> : null}

      <div className="panel-section">
        <div className="row-flex">
          <span className="label grow">Agent keys</span>
          <button
            className="btn"
            type="button"
            disabled={!mine || !agentId}
            onClick={() => setMaking(true)}
          >
            <Icon name="plus" />
            <span className="control-label"> New key</span>
          </button>
        </div>
        {!mine ? (
          <span className="hint">
            Only {agent.addedBy?.name ?? "the person who added it"} can make keys for this agent.
          </span>
        ) : null}
        {keys && keys.length === 0 ? (
          <span className="muted">No keys. Make one for each place the agent runs.</span>
        ) : null}
        {(keys ?? []).map((key) => (
          <div key={key.keyId} className="key-row">
            <div className="row-flex">
              <b className="grow">{key.name}</b>
              <code>{key.prefix}…</code>
              {key.revokedAt ? (
                <span className="chip">Revoked {ago(key.revokedAt)} ago</span>
              ) : (
                <span className="muted">made {ago(key.createdAt)} ago</span>
              )}
            </div>
            <div className="run-chips">
              {key.scopes.map((s) => (
                <span key={s} className="tag">
                  {SCOPES.find((x) => x.id === s)?.label ?? s}
                </span>
              ))}
            </div>
            {!key.revokedAt && mine ? (
              <KeyActions
                keyId={key.keyId}
                scopes={key.scopes}
                onSave={(scopes) => setScopes({ keyId: key.keyId, scopes })}
                onRevoke={() => revoke({ keyId: key.keyId })}
              />
            ) : null}
          </div>
        ))}
      </div>
      {making && agentId ? (
        <NewKey agentId={agentId} agentName={agent.name} onClose={() => setMaking(false)} />
      ) : null}
    </div>
  );
}

function KeyActions({
  scopes,
  onSave,
  onRevoke,
}: {
  keyId: string;
  scopes: string[];
  onSave: (scopes: string[]) => unknown;
  onRevoke: () => unknown;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(scopes);
  const [confirming, setConfirming] = useState(false);
  return editing ? (
    <>
      <ScopePicker value={draft} onChange={setDraft} />
      <div className="row-flex">
        <Button
          className="btn primary"
          onClick={async () => {
            await onSave(draft);
            setEditing(false);
          }}
        >
          <span className="control-label">Save scopes</span>
        </Button>
        <button
          className="btn"
          type="button"
          onClick={() => {
            setDraft(scopes);
            setEditing(false);
          }}
        >
          <span className="control-label">Cancel</span>
        </button>
      </div>
    </>
  ) : confirming ? (
    <div className="key-confirm work-ui">
      <p>Revoke this key? It stops working immediately.</p>
      <div className="row-flex">
        <button className="btn" type="button" onClick={() => void onRevoke()}>
          <span className="control-label">Revoke key</span>
        </button>
        <button className="btn" type="button" onClick={() => setConfirming(false)}>
          <span className="control-label">Cancel</span>
        </button>
      </div>
    </div>
  ) : (
    <div className="row-flex key-actions work-ui">
      <button className="btn" type="button" onClick={() => setEditing(true)}>
        <span className="control-label">Change scopes</span>
      </button>
      <button className="btn" type="button" onClick={() => setConfirming(true)}>
        <span className="control-label">Revoke</span>
      </button>
    </div>
  );
}

function NewKey({
  agentId,
  agentName,
  onClose,
}: {
  agentId: Id<"agents">;
  agentName: string;
  onClose: () => void;
}) {
  const create = useAct(api.agents.createKey);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState(DEFAULT_SCOPES);
  const [secret, setSecret] = useState<string | null>(null);
  return (
    <Dialog
      wide
      title={`New key for ${agentName}`}
      onClose={onClose}
      footer={
        secret ? (
          <button className="btn primary" type="button" onClick={onClose}>
            <span className="control-label">I saved it</span>
          </button>
        ) : (
          <>
            <button className="btn" type="button" onClick={onClose}>
              <span className="control-label">Cancel</span>
            </button>
            <Button
              className="btn primary"
              disabled={!name.trim() || scopes.length === 0}
              onClick={async () => {
                const made = (await create({ agentId, name, scopes })) as
                  | { secret: string }
                  | undefined;
                if (made) setSecret(made.secret);
              }}
            >
              <span className="control-label">Make key</span>
            </Button>
          </>
        )
      }
    >
      {secret ? (
        <>
          <div className="note warn">
            This is the only time the secret is shown. Copy it now and store it where the agent
            runs. Lose it, and you make a new key.
          </div>
          <div className="secret-box">{secret}</div>
          <div>
            <CopyButton text={secret} label="Copy the secret" />
          </div>
        </>
      ) : (
        <>
          <Field className="field">
            <FieldLabel className="label">Where will it run?</FieldLabel>
            <Input
              id="key-name"
              className="input"
              placeholder="CI job"
              value={name}
              onValueChange={setName}
            />
          </Field>
          <div className="field">
            <span className="label">What this key may do</span>
            <ScopePicker value={scopes} onChange={setScopes} />
            <span className="hint">
              Starts with the smallest set. Starting runs, answering approvals, inviting people and
              changing machine settings are each granted on purpose.
            </span>
          </div>
        </>
      )}
    </Dialog>
  );
}

type AgentTemplate = { name: string; body: string; color: string; tool: string; line: string };

/** Roles a team starts from: a name and a character from the cast (DESIGN.md, Characters). */
const TEMPLATES: AgentTemplate[] = [
  {
    name: "Notetaker",
    body: "notetaker",
    color: "sage",
    tool: "notetaker",
    line: "Joins calls, writes the notes, and proposes tasks from them.",
  },
  {
    name: "Deploy bot",
    body: "deploy",
    color: "blue",
    tool: "deploy",
    line: "Ships a release when someone asks, and says what went out.",
  },
  {
    name: "Release-notes writer",
    body: "scribe",
    color: "lilac",
    tool: "scribe",
    line: "Drafts release notes from the work that merged.",
  },
];

function AddAgent({
  template,
  onClose,
  onAdded,
}: {
  template?: AgentTemplate | undefined;
  onClose: () => void;
  onAdded: (memberId: string) => void;
}) {
  const session = useSession();
  const add = useAct(api.agents.add, { success: "Agent added to the team" });
  const connect = useAct(api.a2a.connect, { success: "Connected. Reading its card." });
  const [address, setAddress] = useState("");
  const [credential, setCredential] = useState<CredentialDraft>(NO_CREDENTIAL);
  const [name, setName] = useState(template?.name ?? "");
  const [connection, setConnection] = useState<(typeof CONNECTIONS)[number]["id"]>("mcp");
  const [body, setBody] = useState<string>(template?.body ?? "watch");
  const [color, setColor] = useState<string>(template?.color ?? "teal");
  const [tool, setTool] = useState<string | null>(template?.tool ?? "watch");
  const [previewState, setPreviewState] = useState<"idle" | "working" | "waiting" | "done">("idle");

  // The preview cycles its states so the tool shows.
  useEffect(() => {
    const states = ["idle", "working", "waiting", "done"] as const;
    let i = 0;
    const id = setInterval(() => {
      i = (i + 1) % states.length;
      setPreviewState(states[i]!);
    }, 2200);
    return () => clearInterval(id);
  }, []);

  const character = { body, color, ...(tool ? { accessory: tool } : {}) };

  const submit = async () => {
    const agentId = (await add({ name, connection, character })) as Id<"agents"> | undefined;
    if (agentId && connection === "a2a" && address.trim()) {
      const cred = credentialArg(credential);
      // If this fails, the agent is still added; connect it from its panel.
      await connect({ agentId, cardUrl: address, ...(cred ? { credential: cred } : {}) });
    }
    if (!agentId) return;
    onAdded(name.trim());
    onClose();
  };

  return (
    <Dialog
      wide
      title="Add an agent"
      onClose={onClose}
      footer={
        <>
          <span className="muted grow">
            Added by {session.me.name}. It can do at most what you can, and you're accountable for
            it.
          </span>
          <button className="btn" type="button" onClick={onClose}>
            <span className="control-label">Cancel</span>
          </button>
          <Button className="btn primary" disabled={!name.trim()} onClick={submit}>
            <span className="control-label">Add to team</span>
          </Button>
        </>
      }
    >
      <div className="builder" style={{ margin: "0 -18px" }}>
        <div className="builder-preview">
          <CharacterView
            character={character}
            state={previewState}
            size={150}
            label={name || "New agent"}
            lively
          />
          <b style={{ fontSize: "var(--font-13)" }}>{name || "New agent"}</b>
          <span className="muted">{previewState}</span>
        </div>
        <div className="builder-form">
          <Field className="field">
            <FieldLabel className="label">Name</FieldLabel>
            <Input
              id="agent-name"
              className="input"
              maxLength={24}
              placeholder="Lookout"
              value={name}
              onValueChange={setName}
            />
          </Field>
          <div className="field">
            <span className="label" id="agent-connection-label">
              Connects over
            </span>
            <RadioGroup
              className="pick-row"
              aria-labelledby="agent-connection-label"
              value={connection}
              onValueChange={(value) => {
                const next = CONNECTIONS.find((c) => c.id === value);
                if (next) setConnection(next.id);
              }}
            >
              {CONNECTIONS.map((c) => (
                <Radio key={c.id} value={c.id} className="pick text">
                  {c.label}
                </Radio>
              ))}
            </RadioGroup>
          </div>
          {connection === "a2a" ? (
            <>
              <Field className="field">
                <FieldLabel className="label">Its A2A address (optional now)</FieldLabel>
                <Input
                  id="agent-a2a-url"
                  className="input"
                  placeholder="https://hermes.example.com"
                  value={address}
                  onValueChange={setAddress}
                />
                <FieldDescription className="hint">
                  The room sends it work there over A2A 1.0. Whatever it does in the room still goes
                  through the Room API with an agent key.
                </FieldDescription>
              </Field>
              {address.trim() ? (
                <CredentialFields value={credential} onChange={setCredential} />
              ) : null}
            </>
          ) : null}
          <div className="field">
            <span className="label" id="agent-body-label">
              Body
            </span>
            <RadioGroup
              className="pick-row"
              aria-labelledby="agent-body-label"
              value={body}
              onValueChange={(value) => {
                if (value) setBody(value);
              }}
            >
              {BODY_OPTIONS.map((b) => (
                <Tip key={b.id} label={b.label}>
                  <Radio value={b.id} className="pick" aria-label={b.label}>
                    <CharacterView character={{ body: b.id, color }} size={36} label={b.label} />
                  </Radio>
                </Tip>
              ))}
            </RadioGroup>
          </div>
          <div className="field">
            <span className="label" id="agent-color-label">
              Color
            </span>
            <RadioGroup
              className="pick-row"
              aria-labelledby="agent-color-label"
              value={color}
              onValueChange={(value) => {
                if (value) setColor(value);
              }}
            >
              {COLOR_OPTIONS.map((c) => (
                <Radio key={c.id} value={c.id} className="pick" aria-label={`Color ${c.id}`}>
                  <span
                    className="swatch"
                    style={{ background: `linear-gradient(135deg, ${c.c1} 50%, ${c.c2} 50%)` }}
                  />
                </Radio>
              ))}
            </RadioGroup>
          </div>
          <div className="field">
            <span className="label" id="agent-tool-label">
              Tool
            </span>
            <RadioGroup
              className="pick-row"
              aria-labelledby="agent-tool-label"
              value={tool ?? NO_TOOL}
              onValueChange={(value) => {
                if (value) setTool(value === NO_TOOL ? null : value);
              }}
            >
              {TOOL_OPTIONS.map((t) => (
                <Radio key={t.id} value={t.id} className="pick text">
                  {t.label}
                </Radio>
              ))}
              <Radio value={NO_TOOL} className="pick text">
                None
              </Radio>
            </RadioGroup>
          </div>
          <div className="field">
            <span className="label">What it may do</span>
            <div className="hint">
              It starts with the smallest set: post messages and read projects. You grant more on
              its keys, one at a time.
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * The coding tools working now (Claude Code, Codex): not members, so not agents to add or remove,
 * but in the Roster while they run, so this page lists them too and says why they're different.
 */
function RunningTools() {
  const roster = useRoomQuery(api.teams.roster, {});
  const tools = (roster ?? []).filter((r) => r.kind === "harness");
  const runs = useRoomQuery(api.runs.live, {});
  const now = useNow(1000);
  if (tools.length === 0) return null;
  return (
    <div className="panel running-tools work-ui">
      <h3>Coding tools working now</h3>
      <p className="muted">Coding tools show in the Roster while they run on a linked machine.</p>
      {tools.map((t) => (
        <div key={t.name} className="running-tool">
          <HarnessMark harness={t.name} state={t.state} size={28} />
          <b>{harnessLabel(t.name)}</b>
          <StateIcon state={t.state} withLabel />
          {t.state === "working" ? (
            <span className="mono muted">
              {clock(
                (runs ?? [])
                  .filter((run) => run.harness === t.name && run.state === "working")
                  .reduce((earliest, run) => Math.min(earliest, run.startedAt), now),
                now,
              )}
            </span>
          ) : null}
          {t.line ? <span className="muted truncate">{t.line}</span> : null}
        </div>
      ))}
    </div>
  );
}
