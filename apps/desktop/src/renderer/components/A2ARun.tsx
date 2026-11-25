import "./agentWork.css";
/**
 * A run sent to an agent over A2A (ADR 0012): what the agent reported, and
 * reply, stop and stop-following. The run state is the agent's own report;
 * nothing here sets it.
 */
import { useState } from "react";
import { Button } from "@ui-sdk/react/button";
import { Textarea } from "@ui-sdk/react/textarea";
import { api, type RunView } from "../lib/api";
import { ago } from "../lib/format";
import { useAct } from "../lib/session";
import { Tip } from "./Tip";

type A2A = NonNullable<RunView["a2a"]>;

const STATE_LABELS: Record<string, string> = {
  TASK_STATE_SUBMITTED: "Submitted",
  TASK_STATE_WORKING: "Working",
  TASK_STATE_INPUT_REQUIRED: "Needs an answer",
  TASK_STATE_AUTH_REQUIRED: "Needs a sign-in at its gateway",
  TASK_STATE_COMPLETED: "Completed",
  TASK_STATE_FAILED: "Failed",
  TASK_STATE_CANCELED: "Canceled",
  TASK_STATE_REJECTED: "Rejected",
};

export function a2aStateLabel(state: string | undefined): string {
  if (!state) return "Nothing reported yet";
  return STATE_LABELS[state] ?? state;
}

function deliveryNote(a2a: A2A): string | null {
  switch (a2a.delivery) {
    case "pending":
    case "sending":
      return "Sending to the agent…";
    case "unconfirmed":
      return "Delivery not confirmed. It wasn't sent again.";
    case "failed":
      return "The agent didn't take it.";
    default:
      return null;
  }
}

function cancelNote(a2a: A2A): string | null {
  switch (a2a.cancel?.status) {
    case "pending":
    case "sent":
      return `${a2a.cancel.by.name} asked ${a2a.agent.name} to stop. Waiting for it to confirm.`;
    case "unsupported":
      return `${a2a.agent.name}'s gateway can't cancel from the room. Stop following the run, or stop it at the gateway.`;
    case "not_cancelable":
      return "It had already finished when the stop arrived.";
    case "failed":
      return `The stop request failed: ${a2a.cancel.error ?? "no reason given"}`;
    default:
      return null;
  }
}

/**
 * `inAgent`: shown in the agent's own settings, inside its panel. The agent isn't named again, and
 * the notes are lines of text rather than boxes inside the panel's box.
 */
export function A2ARunDetails({
  run,
  now,
  inAgent = false,
}: {
  run: RunView;
  now: number;
  inAgent?: boolean;
}) {
  const a2a = run.a2a;
  if (!a2a) return null;
  // The run's reason says what went wrong in full ("Icarus doesn't answer SendMessage…"), so the
  // short delivery note ("The agent didn't take it.") would only repeat it.
  const reason = run.failReason && (run.state === "unknown" || run.state === "failed");
  const notes = [reason ? null : deliveryNote(a2a), cancelNote(a2a)].filter(Boolean) as string[];
  const note = (text: string, warn: boolean) =>
    inAgent ? (
      <span key={text} className={warn ? "state-failed" : "muted"}>
        {text}
      </span>
    ) : (
      <div key={text} className={warn ? "note state-failed" : "note"}>
        {text}
      </div>
    );
  return (
    <div className="a2a-facts work-ui">
      <dl>
        {inAgent ? null : (
          <>
            <dt>Agent</dt>
            <dd>{a2a.agent.name}</dd>
          </>
        )}
        <dt>It reports</dt>
        <dd>
          {a2aStateLabel(a2a.externalState)}
          {a2a.observedAt ? (
            <span className="muted">; seen {ago(a2a.observedAt, now)} ago</span>
          ) : null}
        </dd>
        {a2a.following ? null : (
          <>
            <dt>Followed</dt>
            <dd>No longer</dd>
          </>
        )}
      </dl>
      {a2a.lastMessage ? (
        <div className="note" style={{ whiteSpace: "pre-wrap" }}>
          {a2a.lastMessage}
        </div>
      ) : null}
      {a2a.artifacts.map((artifact) => (
        <div key={artifact.artifactId} className="sugg">
          <b>{artifact.name ?? "Result"}</b>
          {artifact.text ? (
            <div
              className="muted"
              style={{ whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto" }}
            >
              {artifact.text}
              {artifact.truncated ? " (cut short)" : ""}
            </div>
          ) : null}
          {artifact.urls.map((url) => (
            <a key={url} href={url} target="_blank" rel="noreferrer" className="truncate">
              {url}
            </a>
          ))}
          {artifact.hasData ? (
            <span className="muted">Also has data the room doesn't keep.</span>
          ) : null}
        </div>
      ))}
      {notes.map((text) => note(text, false))}
      {reason ? note(run.failReason!, run.state === "failed") : null}
      {a2a.lastError && a2a.following ? (
        <span className="hint">Last problem: {a2a.lastError}</span>
      ) : null}
    </div>
  );
}

/**
 * Reply, stop and stop following. The reply box stays after the agent's task finished: a reply then
 * continues the conversation as a new task in the same context, a run of its own (ADR 0024), which
 * `onOpenRun` opens. On a run from chat the reply is posted there too, and `onOpenPlace` goes there.
 */
export function A2ARunActions({
  run,
  onOpenRun,
  onOpenPlace,
}: {
  run: RunView;
  onOpenRun?: ((runId: RunView["runId"]) => void) | undefined;
  onOpenPlace?: ((place: NonNullable<A2A["place"]>) => void) | undefined;
}) {
  const reply = useAct(api.runs.reply, { success: "Sent" });
  const stop = useAct(api.runs.stop, { success: "Asked the agent to stop" });
  const detach = useAct(api.runs.detach, { success: "No longer followed" });
  const [text, setText] = useState("");
  const a2a = run.a2a;
  if (!a2a) return null;
  const stopping = a2a.cancel?.status === "pending" || a2a.cancel?.status === "sent";
  const cantCancel = a2a.canCancel === "unsupported" || a2a.cancel?.status === "unsupported";
  // A room from before conversations has no `replies`: it took replies only on an open task.
  const replies =
    a2a.replies ?? (a2a.following && a2a.taskId && a2a.delivery === "sent" ? "task" : "none");
  const inFlight = a2a.messages.some((m) => m.status === "pending" || m.status === "sending");
  const canReply = replies === "conversation" || (replies === "task" && !inFlight);
  const name = a2a.agent.name;

  const send = async () => {
    if (!text.trim()) return;
    const sent = await reply({ runId: run.runId, text });
    if (sent === undefined) return;
    setText("");
    if (sent && sent.runId !== run.runId) onOpenRun?.(sent.runId);
  };

  return (
    <div className="a2a-actions work-ui">
      {!canReply && !(a2a.place && onOpenPlace) && !a2a.following ? (
        <p className="hint">No actions are available. The room is no longer following this run.</p>
      ) : null}
      {canReply ? (
        <div className="field">
          <Textarea
            className="textarea"
            style={{ minHeight: 48 }}
            aria-label={`Reply to ${name}`}
            placeholder={
              run.state === "waiting"
                ? `Answer ${name}`
                : replies === "conversation"
                  ? `Continue with ${name}`
                  : `Tell ${name} more`
            }
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
          />
          {replies === "conversation" ? (
            <span className="hint">
              {a2a.place
                ? `It's posted in the chat this run came from, and ${name} answers there with what was said before.`
                : `${name} gets it with what was said before, as a new run.`}
            </span>
          ) : null}
          <div className="row-flex">
            <Button className="btn primary" disabled={!text.trim()} onClick={send}>
              <span className="control-label">Send reply</span>
            </Button>
            {a2a.place && onOpenPlace ? (
              <button className="btn" type="button" onClick={() => onOpenPlace(a2a.place!)}>
                <span className="control-label">Open in chat</span>
              </button>
            ) : null}
          </div>
        </div>
      ) : a2a.place && onOpenPlace ? (
        <div className="row-flex">
          <button className="btn" type="button" onClick={() => onOpenPlace(a2a.place!)}>
            <span className="control-label">Open in chat</span>
          </button>
        </div>
      ) : null}
      {a2a.following ? (
        <div className="row-flex" style={{ flexWrap: "wrap" }}>
          {!cantCancel && !stopping ? (
            <button
              className="btn danger"
              type="button"
              onClick={() => void stop({ runId: run.runId })}
            >
              <span className="control-label">Ask it to stop</span>
            </button>
          ) : null}
          <Tip label="The room stops following the run. The agent may keep working on it.">
            <button
              className="btn"
              type="button"
              onClick={() => void detach({ runId: run.runId })}
            >
              <span className="control-label">Stop following</span>
            </button>
          </Tip>
        </div>
      ) : null}
    </div>
  );
}
