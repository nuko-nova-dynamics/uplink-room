import "./agentWork.css";
/**
 * One agent conversation in the task panel (ADR 0024, ADR 0041): its runs as one chat, laid out as a
 * direct conversation is (bubbles, yours on the right), with one composer at the bottom. Runs stay the
 * unit of tracking: each answer links its run, and the head's stop buttons act on the open run, the
 * conversation's latest.
 */
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button } from "@ui-sdk/react/button";
import { Textarea } from "@ui-sdk/react/textarea";
import { api, type RunView } from "../lib/api";
import { chatItems, type ChatItem } from "../lib/a2aChat";
import { formatTime } from "../lib/format";
import { useAct, useSession } from "../lib/session";
import { showRun } from "../lib/work";
import { colorPair } from "../characters/CharacterView";
import { AgentResults } from "./chat/MessageItem";
import { typingText } from "./chat/Typing";
import { StateIcon } from "./Faces";
import { ConversationFace as MemberFace } from "./chat/ConversationFace";
import { Icon } from "./Icon";
import { MessageBody, type MentionNames } from "./MessageBody";
import { Tip } from "./Tip";
import { useNow } from "./useNow";
import type { Nav } from "../Shell";

export function A2AChat({
  runs,
  nav,
  kept,
  canKeep,
  onKeep,
}: {
  /** The conversation's runs, oldest first (groupRuns). */
  runs: RunView[];
  nav: Pick<Nav, "openRun" | "go">;
  /** The task kept one of these runs. */
  kept: boolean;
  /** Whether keeping is offered: the task's owner, while the task is open. */
  canKeep: boolean;
  onKeep: (run: RunView) => unknown;
}) {
  const session = useSession();
  const me = session.me.memberId;
  const open = runs.at(-1)!;
  const a2a = open.a2a!;
  const name = a2a.agent.name;
  const live = runs.some((r) => r.state === "working");
  const now = useNow(live ? 1000 : 60_000);
  const items = useMemo(() => chatItems(runs), [runs]);
  const agentMember = a2a.agent.memberId
    ? { memberId: a2a.agent.memberId, name, kind: "agent" as const }
    : undefined;
  const character = session.members.find((m) => m.memberId === a2a.agent.memberId)?.character;
  const tone = character ? colorPair(character.color) : undefined;
  const toneStyle = tone
    ? ({ "--agent-tone": tone.c1, "--agent-shade": tone.c2 } as CSSProperties)
    : undefined;
  const mentions = useMemo<MentionNames>(() => {
    const names = new Map(session.members.map((m) => [m.memberId as string, m.name]));
    return { nameOf: (id) => names.get(id), me };
  }, [session.members, me]);
  const shown = showRun(open, now);
  const stop = useAct(api.runs.stop, { success: "Asked the agent to stop" });
  // A run given to an agent (ADR 0044) stops here at once: nothing at the agent can be canceled.
  const stopGiven = useAct(api.runs.stop, { success: "Run stopped" });
  const detach = useAct(api.runs.detach, { success: "No longer followed" });
  const stopping = a2a.cancel?.status === "pending" || a2a.cancel?.status === "sent";
  const cantCancel = a2a.canCancel === "unsupported" || a2a.cancel?.status === "unsupported";
  const finished = open.state === "done" || open.state === "stopped";

  // The chat's Run details: the terminal icon its hover bar uses, here on every answer and line.
  const details = (run: RunView) => (
    <Tip label="Run details">
      <button
        className="icon-btn a2a-chat-run"
        type="button"
        onClick={() => nav.openRun({ runId: run.runId })}
        aria-label="Run details"
      >
        <Icon name="terminal" size={14} />
      </button>
    </Tip>
  );
  // Follow new messages inside the transcript. The status row and composer reserve their own
  // space, so scrolling never paints a partial message behind either one.
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const transcript = list.current;
    const drawer = transcript?.closest<HTMLElement>(".drawer-body");
    const conversation = transcript?.closest<HTMLElement>(".a2a-chat");
    if (!transcript || !drawer || !conversation) return;
    transcript.scrollTop = transcript.scrollHeight;
    const message = conversation.getBoundingClientRect();
    const viewport = drawer.getBoundingClientRect();
    if (message.bottom > viewport.bottom) {
      drawer.scrollTop += message.bottom - viewport.bottom;
    } else if (message.top < viewport.top) {
      drawer.scrollTop += message.top - viewport.top;
    }
  }, [items.length]);

  const item = (it: ChatItem, prev: ChatItem | undefined) => {
    if (it.kind === "line") {
      return (
        <div key={it.key} className={`system-line run-line ${it.tone === "warn" ? "warn" : ""}`}>
          {it.tone === "working" ? (
            <StateIcon state="working" size={14} />
          ) : (
            <Icon name={it.tone === "warn" ? "alert" : "terminal"} size={14} />
          )}
          <span className="truncate" title={it.text}>
            {it.text}
          </span>
          {details(it.run)}
        </div>
      );
    }
    if (it.kind === "sent") {
      const mine = it.by.memberId === me;
      // A run of one author's messages: only the first shows the face, name and time.
      const continued = prev?.kind === "sent" && prev.by.memberId === it.by.memberId;
      return (
        <div key={it.key} className={`tl-item ${continued ? "cont" : ""}`}>
          <div className={`msg ${continued ? "cont" : ""} ${mine ? "mine right" : ""}`}>
            {mine ? null : continued ? (
              <span className="msg-face-gap" />
            ) : (
              <MemberFace member={it.by} members={session.members} size={28} />
            )}
            <div className="msg-body" style={{ minWidth: 0 }}>
              {continued ? null : (
                <div className="msg-head">
                  {mine ? null : <b>{it.by.name}</b>}
                  <time
                    className="muted"
                    dateTime={new Date(it.at).toISOString()}
                    title={new Date(it.at).toLocaleString()}
                  >
                    {formatTime(it.at)}
                  </time>
                </div>
              )}
              <div className="bubble-line">
                <div className="bubble">
                  <MessageBody
                    format="markdown"
                    body={it.text}
                    title={`Message from ${it.by.name}`}
                    mentions={mentions}
                  />
                </div>
              </div>
              {it.sending ? <div className="muted a2a-chat-sending">Sending to {name}…</div> : null}
            </div>
          </div>
        </div>
      );
    }
    const continued = prev?.kind === "answer";
    return (
      <div key={it.key} className={`tl-item ${continued ? "cont" : ""}`}>
        <div className={`msg agent-msg ${continued ? "cont" : ""}`} style={toneStyle}>
          {continued ? (
            <span className="msg-face-gap" />
          ) : agentMember ? (
            <MemberFace member={agentMember} members={session.members} size={28} />
          ) : (
            <span className="msg-face-gap" />
          )}
          <div className="msg-body" style={{ minWidth: 0 }}>
            {continued ? null : (
              <div className="msg-head">
                <b className={tone ? "agent-name" : undefined} style={toneStyle}>
                  {name}
                </b>
                <span className="tag">Agent</span>
                <time
                  className="muted"
                  dateTime={new Date(it.at).toISOString()}
                  title={new Date(it.at).toLocaleString()}
                >
                  {formatTime(it.at)}
                </time>
                {details(it.run)}
              </div>
            )}
            {it.text ? (
              <div className="bubble-line">
                <div className="bubble">
                  <MessageBody
                    format="markdown"
                    body={it.text}
                    title={`Message from ${name}`}
                    mentions={mentions}
                  />
                </div>
              </div>
            ) : null}
            {it.artifacts.length ? <AgentResults artifacts={it.artifacts} /> : null}
            {it.asking && it.run === open ? (
              <div className="agent-run waiting">
                <StateIcon state="waiting" size={14} />
                <b>
                  {open.canReply
                    ? `${name} is waiting on your answer`
                    : `${name} is waiting on an answer`}
                </b>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  return (
    <section
      className={`a2a-chat work-ui ${kept ? "kept" : ""}`}
      aria-label={`Conversation with ${name}`}
    >
      <div className="a2a-chat-head">
        {agentMember ? (
          <MemberFace member={agentMember} members={session.members} state={open.state} size={24} />
        ) : null}
        <div className="a2a-chat-identity">
          <b className="a2a-chat-name">{name}</b>
          <span className="tag">Agent</span>
          {kept ? <span className="chip kept-chip">Kept</span> : null}
          <StateIcon state={shown.icon} glyph={shown.glyph} label={shown.label} />
          <span className={`state-${shown.icon}`}>{shown.label}</span>
          {shown.time ? (
            <span className={shown.ticking ? "mono muted" : "muted"}>{shown.time}</span>
          ) : null}
        </div>
        <span className="grow" />
        {canKeep && finished ? (
          <Tip label="Keeps this conversation's latest run as the task's result and closes the task.">
            <button className="btn" type="button" onClick={() => onKeep(open)}>
              <Icon name="check" />
              <span className="control-label"> Keep this one</span>
            </button>
          </Tip>
        ) : null}
        {open.given && open.canReply ? (
          <Tip
            label={`Marks the run stopped here. ${name} isn't asked to stop, and its later reports are refused.`}
          >
            <button
              className="btn small danger"
              type="button"
              onClick={() => void stopGiven({ runId: open.runId })}
            >
              Stop
            </button>
          </Tip>
        ) : null}
        {a2a.following && !cantCancel && !stopping ? (
          <button className="btn" type="button" onClick={() => void stop({ runId: open.runId })}>
            <span className="control-label">Ask it to stop</span>
          </button>
        ) : null}
        {a2a.following ? (
          <Tip label="The room stops following the run. The agent may keep working on it.">
            <button
              className="btn"
              type="button"
              onClick={() => void detach({ runId: open.runId })}
            >
              <span className="control-label">Stop following</span>
            </button>
          </Tip>
        ) : null}
      </div>
      {stopping ? (
        <p className="hint a2a-chat-note">
          {a2a.cancel!.by.name} asked {name} to stop. Waiting for it to confirm.
        </p>
      ) : null}
      {a2a.cancel?.status === "unsupported" ? (
        <p className="hint a2a-chat-note">
          {name}'s gateway can't cancel from the room. Stop following the run, or stop it at the
          gateway.
        </p>
      ) : null}
      <div ref={list} className="messages a2a-chat-messages">
        <div className="messages-inner">{items.map((it, i) => item(it, items[i - 1]))}</div>
      </div>
      <A2AComposer
        run={open}
        onOpenPlace={(place) =>
          nav.go({
            name: "channel",
            channelId: place.channelId,
            ...(place.messageId ? { messageId: place.messageId } : {}),
          })
        }
      />
    </section>
  );
}

const ENDED = new Set(["done", "failed", "stopped"]);

/**
 * The conversation's one message box: `runs.reply` on its open run, which goes to the agent's open
 * task, or once that finished, starts the next run in the same context (ADR 0024). While the agent
 * works it shows as writing under the box, as in chat.
 */
export function A2AComposer({
  run,
  onOpenPlace,
}: {
  run: RunView;
  onOpenPlace?: (place: NonNullable<NonNullable<RunView["a2a"]>["place"]>) => void;
}) {
  const reply = useAct(api.runs.reply, { success: "Sent" });
  const [text, setText] = useState("");
  // Enter sends as well as the button, so one send at a time is kept here, not only on the button.
  const sending = useRef(false);
  const a2a = run.a2a!;
  const name = a2a.agent.name;
  // A room from before conversations has no `replies`: it took replies only on an open task.
  const replies =
    a2a.replies ?? (a2a.following && a2a.taskId && a2a.delivery === "sent" ? "task" : "none");
  const inFlight = a2a.messages.some((m) => m.status === "pending" || m.status === "sending");
  const open = replies === "conversation" || (replies === "task" && !inFlight);
  const allowed = run.canReply !== false;
  const writing = run.state === "working" ? typingText([{ name, kind: "agent" }]) : "";

  const send = async () => {
    const body = text.trim();
    if (!body || sending.current || !open || !allowed) return;
    sending.current = true;
    try {
      const sent = await reply({ runId: run.runId, text: body });
      if (sent !== undefined) setText("");
    } finally {
      sending.current = false;
    }
  };

  const placeholder =
    run.state === "waiting"
      ? `Answer ${name}`
      : replies === "task"
        ? `Tell ${name} more`
        : `Continue with ${name}`;
  return (
    <div className="composer a2a-chat-composer work-ui">
      {allowed ? (
        <div className="composer-box">
          <div className="composer-line">
            <Textarea
              className="textarea grow-box"
              rows={1}
              aria-label={`Message ${name}`}
              placeholder={open ? placeholder : `Sending to ${name}…`}
              value={text}
              disabled={!open}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <Button
              className="icon-btn composer-send"
              aria-label="Send"
              disabled={!open || !text.trim()}
              onClick={send}
              // The tooltip goes inside: around the Button it would swallow the Promise that keeps it pending.
              render={(props) => (
                <Tip label="Send">
                  <button type="button" {...props} />
                </Tip>
              )}
            >
              <Icon name="arrow-up" size={16} />
            </Button>
          </div>
        </div>
      ) : run.given && ENDED.has(run.state) ? (
        <p className="hint">This run ended. Give the task to {name} again to go on.</p>
      ) : (
        <p className="hint">
          Only the run's driver, whoever started it, the task's owner or an admin can write to{" "}
          {name} here.
        </p>
      )}
      <div className="a2a-chat-under">
        <span className="muted truncate" aria-live="polite">
          {writing ? `${writing}…` : a2a.place ? `It's posted in the chat this came from too.` : ""}
        </span>
        {a2a.place && onOpenPlace ? (
          <button className="link-btn" type="button" onClick={() => onOpenPlace(a2a.place!)}>
            <span className="control-label">Open in chat</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
