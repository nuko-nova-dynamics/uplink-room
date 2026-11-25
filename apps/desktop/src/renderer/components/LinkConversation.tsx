import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Id, type MessageRow } from "../lib/api";
import { runLabel } from "../lib/format";
import { failText } from "../lib/work";
import { deliveryLine } from "./chat/Deliveries";
import { useAct, useRoomQuery, useSoftRoomQuery } from "../lib/session";
import { Attachments } from "./chat/Attachments";
import { STATE_META } from "../lib/states";
import type { Nav } from "../Shell";
import { LinkMascot } from "../characters/LinkMascot";
import { Face, HarnessMark, StateIcon } from "./Faces";
import { MessageBody } from "./MessageBody";
import { Icon } from "./Icon";
import {
  Menu,
  MenuContent,
  MenuGroupLabel,
  MenuItem,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { Tip } from "./Tip";
import "./linkConversation.css";

export type LinkInfo = {
  memberId: Id<"members">;
  agentId: Id<"agents">;
  name: string;
  channelId: Id<"channels">;
  reach: "a2a" | "webhook" | "checks_in" | null;
};

/** How many of the conversation's latest messages the Inbox shows above what needs you. */
const SHOWN = 6;
/** How many "Show earlier messages" reaches back to. */
const SHOWN_ALL = 40;

/**
 * Your conversation with your Link (ADR 0049), at the top of the Inbox as one timeline: your
 * messages on the right, the agent's on the left. A message of the agent's that names runs shows
 * each as a centered line saying what started and a card that follows the run. "Make it a task" on
 * the agent's reply starts the work from your message before it, when the agent only answered.
 */
export function LinkConversation({
  link,
  me,
  nav,
  onMakeTask,
}: {
  link: LinkInfo;
  me: Id<"members">;
  nav: Nav;
  onMakeTask: (message: string) => void;
}) {
  const [earlier, setEarlier] = useState(false);
  const list = useRoomQuery(api.messages.list, {
    channelId: link.channelId,
    limit: earlier ? SHOWN_ALL : SHOWN,
  });
  // Without a cursor the room returns the latest messages as a list, oldest first.
  const messages = Array.isArray(list) ? list : [];
  const latest = unanswered(messages, me);
  const last = messages.at(-1)?.messageId;
  const box = useRef<HTMLOListElement>(null);
  const markRead = useAct(api.channels.markRead);
  const channels = useRoomQuery(api.channels.list, {});
  const here = channels?.find((c) => c.channelId === link.channelId);
  // A room line (a pin notice, say) has no place in the read order: the newest is a real message.
  const counted = messages.filter((m) => m.seq !== undefined && !m.system);
  const newest = counted.at(-1)?.messageId;
  // Every unread message is listed here. The room counts every message past your read point,
  // older ones not loaded and replies in threads (which this list leaves out) too, so a count
  // above what's listed means something unread isn't on screen.
  const unreadListed = here
    ? messages.filter(
        (m) => m.seq !== undefined && m.seq > here.readSeq && m.deletedAt === undefined,
      ).length
    : 0;
  const allUnreadShown = here !== undefined && here.unread <= unreadListed;
  // The conversation is marked read on what you do in it, never on a guess that you saw it: a
  // click or a key in it here (not in a file's viewer), and your own reply, which the room counts
  // as read up to it when it posts it (messages.post). Only when every unread message
  // is shown, so nothing older that isn't on screen is marked with it.
  const readNow = (event: { target: EventTarget }) => {
    // A file's viewer opens over the Inbox from inside this list, as a dialog on a backdrop
    // (.overlay): what's done in it, closing it too, isn't reading the conversation behind it.
    if (event.target instanceof Element && event.target.closest('[role="dialog"], .overlay'))
      return;
    if (newest && allUnreadShown)
      void markRead({ channelId: link.channelId, upTo: newest as Id<"messages"> });
  };
  // Your own new message comes into view, as a chat shows what you just sent. A reply doesn't pull
  // the Inbox away from what you're reading.
  const lastMine = messages.at(-1)?.author?.memberId === me;
  useEffect(() => {
    if (last && lastMine) box.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [last, lastMine]);
  return (
    <ol
      ref={box}
      className="link-conversation"
      aria-label={`Your conversation with ${link.name}`}
      onPointerDown={readNow}
      onKeyDown={readNow}
    >
      {!earlier && messages.length >= SHOWN ? (
        <li className="link-earlier">
          <button type="button" className="link-make-task" onClick={() => setEarlier(true)}>
            Show earlier messages
          </button>
        </li>
      ) : null}
      {messages.map((m, at) => {
        if (m.deletedAt !== undefined) return null;
        // A line the room wrote for the Link's run says what happened to a message (it wasn't
        // sent, the agent answered without text): one quiet line, as a delivery line. A pin
        // notice has nothing to say here.
        if (m.system) {
          return m.system.kind === "run" ? (
            <li key={m.messageId} className="link-msg room">
              <StatusLine
                icon={m.system.tone === "warn" ? "alert" : undefined}
                text={m.system.text}
              />
            </li>
          ) : null;
        }
        const mine = m.author?.memberId === me;
        const asked = mine ? undefined : lastOwnBefore(messages, at, me);
        const work = workRuns(m);
        return (
          <li key={m.messageId} className={`link-msg ${mine ? "mine" : "theirs"}`}>
            {m.body.trim() ? (
              <div className="link-msg-line">
                {mine ? null : m.author ? (
                  <Face who={m.author} size={28} />
                ) : (
                  <LinkMascot size={28} label={link.name} />
                )}
                <div className="bubble link-msg-bubble">
                  <MessageBody
                    format={m.format}
                    body={m.body}
                    title={`${m.author?.name ?? link.name}'s message`}
                  />
                </div>
              </div>
            ) : null}
            {m.attachments.length > 0 ? (
              <div className="link-msg-files">
                <LinkFiles message={m} from={m.author?.name ?? link.name} />
              </div>
            ) : null}
            {m === latest ? (
              <SendStatus message={m} link={link} />
            ) : mine ? (
              <FailedSend message={m} link={link} />
            ) : null}
            {work.map((runId) => (
              <RunCard key={runId} runId={runId} nav={nav} />
            ))}
            {!mine && asked && work.length === 0 ? (
              <button type="button" className="link-make-task" onClick={() => onMakeTask(asked)}>
                Make it a task
              </button>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * A message's files. Files in a direct message are kept behind short-lived links (ADR 0016), so
 * each is shown or downloaded through one the room gives for it (messages.attachmentLink).
 */
function LinkFiles({ message, from }: { message: MessageRow; from: string }) {
  const askLink = useAct(api.messages.attachmentLink);
  const link = useCallback(
    async (index: number, download: boolean) =>
      await askLink({ messageId: message.messageId, attachmentIndex: index, download }),
    [askLink, message.messageId],
  );
  return (
    <Attachments
      attachments={message.attachments}
      link={link}
      from={{ name: from, at: message.postedAt }}
    />
  );
}

type TimelineMessage = {
  author?: { memberId: string } | null | undefined;
  body: string;
  deletedAt?: number | undefined;
  system?: unknown;
  mentionedRuns: readonly string[];
  a2aRuns?: readonly string[] | undefined;
  a2a?: { runId: string } | undefined;
  attachments?: readonly unknown[] | undefined;
};

/**
 * The runs a message names as work started: not the A2A run your message went to (a2aRuns), nor the
 * run an A2A agent's answer came from (a2a.runId), which is the conversation itself, not new work.
 */
function workRuns(m: TimelineMessage): Id<"runs">[] {
  return m.mentionedRuns.filter(
    (runId) => !(m.a2aRuns ?? []).includes(runId) && runId !== m.a2a?.runId,
  ) as Id<"runs">[];
}

/** The text of your latest message before the one at `at`, if the agent's reply answers one. */
function lastOwnBefore(messages: TimelineMessage[], at: number, me: string): string | undefined {
  for (let i = at - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.system) continue;
    if (m.author?.memberId !== me) return undefined;
    if (m.deletedAt === undefined && m.body.trim()) return m.body.trim();
  }
  return undefined;
}

/**
 * Your latest message, while nothing has answered it: a reply or a run card from someone else
 * after it is an answer; a line the room wrote for a run isn't, since the Inbox doesn't show it.
 */
function unanswered<M extends TimelineMessage>(messages: M[], me: string): M | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.deletedAt !== undefined || m.system) continue;
    if (m.author?.memberId === me) return m;
    if (m.body.trim() || (m.attachments?.length ?? 0) > 0 || workRuns(m).length > 0)
      return undefined;
  }
  return undefined;
}

type Delivery = MessageRow["deliveries"][number];

/**
 * Under your latest message while the Link hasn't answered: one quiet line on where the message
 * stands, only when it isn't simply on its way. A routine webhook's failed send and an agent that
 * checks in use the channel's delivery words (Deliveries); a message over A2A says what its run
 * shows; with no way to reach the Link, it says the message didn't get there.
 */
function SendStatus({
  message,
  link,
}: {
  message: { deliveries: Delivery[]; a2aRuns?: readonly Id<"runs">[] | undefined };
  link: LinkInfo;
}) {
  const delivery =
    message.deliveries.find((d) => d.to.memberId === link.memberId) ?? message.deliveries[0];
  if (delivery) {
    if (delivery.status !== "failed" && delivery.status !== "waiting") return null;
    return (
      <StatusLine
        icon={delivery.status === "failed" ? "alert" : "clock"}
        text={deliveryLine(delivery).text}
      />
    );
  }
  const runId = message.a2aRuns?.[0];
  if (runId) return <A2AStatus runId={runId} name={link.name} />;
  if (link.reach === null) {
    return (
      <StatusLine icon="alert" text={`The room can't reach ${link.name}, so it didn't get this.`} />
    );
  }
  return null;
}

/**
 * An earlier message of yours whose send to the Link failed: said under it even after later
 * messages, since a later reply doesn't mean this one arrived.
 */
function FailedSend({ message, link }: { message: { deliveries: Delivery[] }; link: LinkInfo }) {
  const delivery = message.deliveries.find(
    (d) => d.to.memberId === link.memberId && d.status === "failed",
  );
  return delivery ? <StatusLine icon="alert" text={deliveryLine(delivery).text} /> : null;
}

/** A message sent over A2A: its run says whether the agent took it, and why not. */
function A2AStatus({ runId, name }: { runId: Id<"runs">; name: string }) {
  const run = useRoomQuery(api.runs.get, { runId });
  const peers = useRoomQuery(api.a2a.list, {});
  const a2a = run?.a2a;
  if (!run || !a2a) return null;
  const last = a2a.messages.at(-1);
  const peer = peers?.find((p) => p.agentId === a2a.agent.agentId);
  const reason = failText(run.failReason);
  // The words are the ones the A2A chat uses for the same states (lib/a2aChat.ts).
  const text =
    last?.status === "failed"
      ? last.error
        ? `${name} didn't take this message: ${last.error}`
        : `${name} didn't take this message.`
      : last?.status === "unconfirmed"
        ? `This may not have reached ${name}. It wasn't sent again.`
        : run.state === "failed"
          ? reason
            ? `${name} couldn't finish: ${reason}`
            : `${name} reported that the task failed.`
          : run.state === "unknown" && reason
            ? reason
            : (last?.status === "pending" || last?.status === "sending") &&
                peer?.status === "failed"
              ? `Couldn't reach ${name}. ${peer.error ?? "The card couldn't be read."}`
              : undefined;
  return text ? <StatusLine icon="alert" text={text} /> : null;
}

/** One quiet line under your message, as a delivery line in a channel: never amber. */
function StatusLine({ icon, text }: { icon?: "alert" | "clock" | undefined; text: string }) {
  return (
    <p className="link-status">
      {icon ? <Icon name={icon} size={14} /> : null}
      <span>{text}</span>
    </p>
  );
}

/**
 * A run the Link started, as one centered line ("Started a thread: Fix Safari checkout crash")
 * and a card under it that follows the run: harness, machine, state, and Open.
 */
function RunCard({ runId, nav }: { runId: Id<"runs">; nav: Nav }) {
  // A run you can't see (closed since, or from a place you aren't in) is left out, not an error.
  const run = useSoftRoomQuery(api.runs.get, { runId });
  if (!run) return null;
  const title = run.title ?? `${runLabel(run)} run`;
  const started =
    run.harness === "agent" || run.harness === "a2a"
      ? "Gave it to an agent"
      : run.threadRef
        ? "Started a thread"
        : "Started a run";
  const open = () =>
    run.threadRef
      ? nav.openThread(run.runId)
      : nav.openRun({
          runId: run.runId,
          taskId: run.taskId,
          terminalId: run.terminalId,
          spaceId: run.spaceId,
        });
  return (
    <div className="link-run">
      <p className="link-event">
        {started}: <b>{title}</b>
      </p>
      <div className="link-run-card">
        <div className="link-run-who">
          {run.driver?.kind === "agent" ? (
            <Face who={run.driver} size={16} />
          ) : (
            <HarnessMark harness={run.harness} size={16} />
          )}
          <span className="truncate">
            {runLabel(run)}
            {run.machine ? ` on ${run.machine.name}` : ""}
          </span>
        </div>
        <div className="link-run-title">{title}</div>
        <div className="link-run-foot">
          <span className="link-run-state">
            <StateIcon state={run.state} />
            {STATE_META[run.state]?.label ?? run.state}
          </span>
          <button type="button" className="btn" onClick={open}>
            {run.threadRef ? "Open thread" : "Open"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Where the Inbox's box sends: your Link, a new thread with no question asked, or an agent as a task. */
export type SendTo =
  | { kind: "link" }
  | { kind: "thread" }
  | { kind: "agent"; agentId: Id<"agents">; name: string };

type RosterAgent = {
  memberId: Id<"members">;
  agentId: Id<"agents">;
  name: string;
  who: { name: string; kind: "agent"; character?: Parameters<typeof Face>[0]["who"]["character"] };
};

/**
 * The composer's "Send to" chip (ADR 0049), as T3 Code's model picker: Link by default, or a new
 * thread that skips Link's decision, or an agent from the roster given the message as a task. Its
 * second part picks which agent is your Link.
 */
export function SendTarget({
  to,
  link,
  agents,
  taskAgents = agents,
  onTo,
  onLink,
}: {
  to: SendTo;
  link: LinkInfo | null;
  /** Roster agents the room can reach: who can be your Link. */
  agents: RosterAgent[];
  /** Roster agents that can be given a task (ADR 0044), reachable or not: they check for it. */
  taskAgents?: RosterAgent[];
  onTo: (to: SendTo) => void;
  onLink: (memberId: Id<"members"> | null) => void;
}) {
  const label =
    to.kind === "link" && link ? link.name : to.kind === "agent" ? to.name : "New thread";
  // The Link is one of the roster's agents: it shows with its own face, not Link's mascot.
  const linkWho = taskAgents.find((a) => a.memberId === link?.memberId)?.who;
  const faceOf = (next: SendTo, size: number) =>
    next.kind === "thread" ? (
      <HarnessMark harness="claude-code" size={size} />
    ) : next.kind === "agent" ? (
      <Face
        who={
          taskAgents.find((a) => a.agentId === next.agentId)?.who ?? {
            name: next.name,
            kind: "agent",
          }
        }
        size={size}
      />
    ) : linkWho ? (
      <Face who={linkWho} size={size} />
    ) : (
      <LinkMascot size={size} label="" />
    );
  // Each Send to choice as one value of a radio group: "link", "thread", or "agent:<agentId>".
  const toValue = to.kind === "agent" ? `agent:${to.agentId}` : to.kind;
  const pick = (value: string) => {
    if (value === "link" || value === "thread") return onTo({ kind: value });
    const agent = taskAgents.find((a) => `agent:${a.agentId}` === value);
    if (agent) onTo({ kind: "agent", agentId: agent.agentId, name: agent.name });
  };
  return (
    <div className="send-target">
      <Menu>
        <Tip label="Where this message goes">
          <MenuTrigger className="send-target-chip">
            {faceOf(to, 18)}
            <span>{label}</span>
            <Icon name="chevron-down" size={14} />
          </MenuTrigger>
        </Tip>
        <MenuContent
          className="pop send-target-menu"
          aria-label="Send to"
          side="top"
          align="end"
          sideOffset={8}
        >
          <MenuRadioGroup value={toValue} onValueChange={pick}>
            <MenuGroupLabel className="pop-title">Send to</MenuGroupLabel>
            {link ? (
              <MenuRadioItem
                value="link"
                label={link.name}
                disabled={link.reach === null}
                closeOnSelect
              >
                {faceOf({ kind: "link" }, 20)}
                <span className="pick-text">
                  {link.name}
                  <span className="pick-line">
                    {link.reach === null
                      ? "Your Link: the room can't reach it now"
                      : "Your Link: answers, or starts the work"}
                  </span>
                </span>
                <MenuItemIndicator>
                  <Icon name="check" size={14} />
                </MenuItemIndicator>
              </MenuRadioItem>
            ) : null}
            <MenuRadioItem value="thread" label="New thread" closeOnSelect>
              <HarnessMark harness="claude-code" size={20} />
              <span className="pick-text">
                New thread
                <span className="pick-line">Claude Code in T3 Code, no question asked</span>
              </span>
              <MenuItemIndicator>
                <Icon name="check" size={14} />
              </MenuItemIndicator>
            </MenuRadioItem>
            {taskAgents
              .filter((a) => a.memberId !== link?.memberId)
              .map((a) => (
                <MenuRadioItem
                  key={a.agentId}
                  value={`agent:${a.agentId}`}
                  label={a.name}
                  closeOnSelect
                >
                  <Face who={a.who} size={20} />
                  <span className="pick-text">
                    {a.name}
                    <span className="pick-line">Gets it as a task</span>
                  </span>
                  <MenuItemIndicator>
                    <Icon name="check" size={14} />
                  </MenuItemIndicator>
                </MenuRadioItem>
              ))}
          </MenuRadioGroup>
          <MenuRadioGroup
            value={link?.memberId ?? null}
            onValueChange={(memberId) => onLink(memberId as Id<"members">)}
          >
            <MenuGroupLabel className="pop-title">Your Link</MenuGroupLabel>
            {agents.map((a) => (
              <MenuRadioItem key={a.memberId} value={a.memberId} label={a.name} closeOnSelect>
                <Face who={a.who} size={20} />
                <span className="pick-text">{a.name}</span>
                <MenuItemIndicator>
                  <Icon name="check" size={14} />
                </MenuItemIndicator>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          {agents.length === 0 ? (
            <p className="muted pop-note">
              Connect an agent over A2A or a routine webhook to make it your Link.
            </p>
          ) : null}
          {link ? (
            <MenuItem onSelect={() => onLink(null)}>
              <span className="pick-text">No Link: messages start a thread</span>
            </MenuItem>
          ) : null}
        </MenuContent>
      </Menu>
    </div>
  );
}
