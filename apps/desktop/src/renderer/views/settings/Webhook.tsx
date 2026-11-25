/**
 * An agent's routine webhook (slice 14 of #139): how the room reaches Grok Bot. The person copies a
 * routine's POST to URL and key from Grok Bot; each message that reaches the agent is POSTed there,
 * and the message shows whether it was sent. The key is never shown again, only its last four
 * characters.
 */
import { useEffect, useRef, useState } from "react";
import { api, type Id, type MemberRow } from "../../lib/api";
import { ago } from "../../lib/format";
import { useAct, useRoomQuery } from "../../lib/session";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { Icon } from "../../components/Icon";

export function WebhookSection({ agent, canManage }: { agent: MemberRow; canManage: boolean }) {
  const agentId = agent.agentId as Id<"agents">;
  const webhook = useRoomQuery(api.webhooks.get, { agentId });
  const save = useAct(api.webhooks.set, { success: "Webhook saved" });
  const remove = useAct(api.webhooks.remove, { success: "Webhook removed" });
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const editTrigger = useRef<HTMLButtonElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const wasEditing = useRef(false);

  useEffect(() => {
    if (editing) urlInput.current?.focus();
    else if (wasEditing.current) editTrigger.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  if (webhook === undefined) return null;

  const submit = async () => {
    const done = await save({ agentId, url, key });
    if (done !== undefined) {
      setEditing(false);
      setKey("");
    }
  };

  return (
    <div
      className="panel-section webhook-section"
      role="group"
      aria-label="Routine webhook"
      onKeyDown={(event) => {
        if (editing && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setEditing(false);
        }
      }}
    >
      <div className="row-flex">
        <span className="label grow">Routine webhook</span>
        {canManage && !webhook && !editing ? (
          <button ref={editTrigger} className="btn" type="button" onClick={() => setEditing(true)}>
            <Icon name="plus" /> Add
          </button>
        ) : null}
      </div>
      {webhook ? (
        <>
          <span className="muted truncate" title={webhook.url}>
            {webhook.url}
          </span>
          <span className="hint">
            Key {webhook.hint}, set by {webhook.setBy.name} {ago(webhook.setAt)} ago. Each message
            for {agent.name} starts one of its runs there, and the message shows whether it was
            sent.
          </span>
        </>
      ) : editing ? null : (
        <span className="muted">
          For Grok Bot: give it a routine with a webhook trigger, then copy the routine's POST to
          URL and key here. Messages for {agent.name} then start a run of that routine, and it
          answers through its connector.
        </span>
      )}
      {editing ? (
        <div className="connector-form">
          <Field className="field">
            <FieldLabel className="label">POST to</FieldLabel>
            <Input
              ref={urlInput}
              className="input"
              placeholder="https://"
              value={url}
              onValueChange={setUrl}
            />
          </Field>
          <Field className="field">
            <FieldLabel className="label">Key</FieldLabel>
            <Input
              className="input"
              type="password"
              autoComplete="off"
              value={key}
              onValueChange={setKey}
            />
            <FieldDescription className="hint">
              Sent as a bearer token. It is kept sealed and never shown again.
            </FieldDescription>
          </Field>
        </div>
      ) : null}
      {canManage && (editing || webhook) ? (
        <div className="row-flex" style={{ flexWrap: "wrap" }}>
          {editing ? (
            <>
              <Button
                className="btn primary"
                disabled={!url.trim() || !key.trim()}
                onClick={submit}
              >
                Save webhook
              </Button>
              <button className="btn" type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                ref={editTrigger}
                className="btn"
                type="button"
                onClick={() => {
                  setUrl(webhook?.url ?? "");
                  setEditing(true);
                }}
              >
                Replace
              </button>
              <button className="btn" type="button" onClick={() => void remove({ agentId })}>
                Remove
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
