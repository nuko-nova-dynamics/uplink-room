import { PickOne, PickOneItem } from "./PickOne";
import { teamRunWarning } from "../lib/chat";
import { agoText } from "../lib/format";
import { MemberFace } from "./Faces";
import { Icon } from "./Icon";

type Who = { memberId: string; name: string; kind: "person" | "agent" };

/** A live run as runs.live gives it: enough to say how it hears and who may message it. */
export type LiveRunFacts = {
  runId: string;
  label: string;
  driver: Who;
  accountable?: Who | undefined;
  hears: "anyone" | "driver";
  /** Whether a message from you reaches it (its driver may have narrowed who can message it). */
  hearsYou: boolean;
  /** As its machine reports it; unknown until a bridge that delivers run messages says. */
  hearing: "mid_task" | "between_turns" | "none" | "unknown";
  machine?: { name: string } | undefined;
  /** A team run: the whole team can see what it hears (ADR 0039). */
  visibleToTeam?: boolean | undefined;
};

/** runs.inbox: the texts only for the run's driver and person (ADR 0029 D6), a count for everyone. */
export type RunInbox = {
  waiting: number;
  messages?:
    | {
        messageId: string;
        place?: string | undefined;
        text?: string | undefined;
        from: { member: Who; run?: { runId: string; label: string } | undefined };
        accountable: Who;
        fromDriver: boolean;
        status: "waiting" | "delivered" | "failed";
        how?: "mid_task" | "next_turn" | undefined;
        /** Why a failed message didn't reach the run. */
        error?: "run_ended" | "driver_changed" | "not_heard" | "deleted" | "unsure" | "visible_outside" | undefined;
        at: number;
      }[]
    | undefined;
};

const HEARING: Record<LiveRunFacts["hearing"], { icon: "live" | "clock" | "terminal"; text: (machine: string) => string }> = {
  mid_task: { icon: "live", text: () => "Hears you mid-task: a message reaches it after its next step." },
  between_turns: { icon: "clock", text: () => "Hears you between turns: a message reaches it when its turn ends." },
  none: { icon: "terminal", text: () => "Can't take messages here. Its agent reads the room with the uplink command." },
  unknown: { icon: "clock", text: (machine) => `Messages wait here until Uplink Room on ${machine} can deliver them.` },
};

type InboxMessage = NonNullable<RunInbox["messages"]>[number];

/** The place a message was said, as the reason it failed names it: "#launch" for a thread there too. */
function placeName(place: string | undefined): string {
  if (!place) return "where this was posted";
  if (place === "a direct message") return "that direct message";
  return place.replace(/^a thread in /, "");
}

const FAILED: Record<NonNullable<InboxMessage["error"]>, (m: InboxMessage) => string> = {
  run_ended: () => "Didn't reach it: its terminal ended first.",
  driver_changed: () => "Didn't reach it: its driver changed to someone who can't see where this was posted.",
  not_heard: () => "Didn't reach it: its driver now lets only them and their agents message it.",
  deleted: () => "Didn't reach it: the message was deleted first.",
  unsure: () => "May not have reached it: its session took it twice without saying it arrived.",
  // What a run hears shows in its terminal or thread, which people outside a private place can see (ADR 0039).
  visible_outside: (m) => `Didn't reach it: this run is visible to people outside ${placeName(m.place)}, so it can't hear messages from there.`,
};

function statusText(m: InboxMessage): string {
  if (m.status === "waiting") return "Waiting";
  if (m.status === "failed") return m.error ? FAILED[m.error](m) : "Couldn't reach it";
  return m.how === "mid_task" ? "Reached it mid-task" : "Reached it at its next turn";
}

/**
 * A live run's messages (ADR 0026), in its panel: how it hears them, who may message it (its driver
 * chooses, runs.setHears), and what it was sent. Only its driver and the person who answers for it
 * read the texts; anyone else sees how many wait.
 */
export function RunMessages({
  run,
  me,
  inbox,
  onSetHears,
  onMessage,
}: {
  run: LiveRunFacts;
  me: string;
  inbox: RunInbox | undefined;
  onSetHears: (hears: "anyone" | "driver") => void;
  /** Opens a direct message with the run. */
  onMessage: () => void;
}) {
  const person = run.accountable ?? run.driver;
  const drives = run.driver.memberId === me;
  const hearing = HEARING[run.hearing];
  const messages = inbox?.messages;
  return (
    <section className="field run-messages" aria-label="Messages to this run">
      <div className="section-label">
        <span>Messages</span>
      </div>
      <p className="run-hearing">
        <Icon name={hearing.icon} size={14} />
        <span>{hearing.text(run.machine?.name ?? "its machine")}</span>
      </p>
      <div className="run-hears">
        <span className="run-hears-label">Who can message this run</span>
        {drives ? (
          <>
            <PickOne<"anyone" | "driver">
              className="seg"
              aria-label="Who can message this run"
              value={run.hears}
              onPick={onSetHears}
            >
              <PickOneItem value="anyone">Anyone</PickOneItem>
              <PickOneItem value="driver">Only me</PickOneItem>
            </PickOne>
            <span className="hint">
              {run.hears === "anyone"
                ? "Anyone who can see it, people and agents."
                : "You and your agents. Others' messages still post, but don't reach it."}
            </span>
          </>
        ) : (
          <span className="hint">
            {run.hears === "anyone" ? "Anyone in the team can message it." : `Only ${person.name} and their agents can message it.`}
          </span>
        )}
      </div>
      {messages === undefined ? (
        inbox ? (
          <p className="hint">
            {inbox.waiting > 0 ? `${inbox.waiting} message${inbox.waiting === 1 ? "" : "s"} waiting. ` : ""}Only {person.name} reads what it's sent.
          </p>
        ) : null
      ) : messages.length === 0 ? (
        <p className="hint">Nothing sent to it yet.</p>
      ) : (
        <ul className="run-inbox" aria-label="Sent to this run">
          {messages.map((m) => {
            const from = m.from.run?.label ?? m.from.member.name;
            // A run or an agent answers through a person: say who.
            const answers = m.from.run || m.from.member.kind === "agent" ? m.accountable.name : null;
            return (
              <li key={m.messageId}>
                <MemberFace member={m.from.member} size={20} />
                <div className="run-inbox-body">
                  <div className="run-inbox-head">
                    <b className="truncate">{from}</b>
                    {answers ? <span className="muted truncate">{answers} answers for it</span> : null}
                    <span className="muted run-inbox-when">
                      {m.place ? `${m.place}, ` : ""}
                      {agoText(m.at)}
                    </span>
                  </div>
                  {m.text !== undefined ? <p className="run-inbox-text">{m.text}</p> : <p className="hint">A message you can't see here.</p>}
                  <span className="hint">{statusText(m)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {run.hearsYou ? (
        <div className="run-message-action">
          {/* It hears the direct message this opens, and the whole team sees what it hears (ADR 0039). */}
          {run.visibleToTeam ? (
            <p className="output-warn">
              <Icon name="eye" size={14} />
              <span>{teamRunWarning(run.label)}</span>
            </p>
          ) : null}
          <div className="run-card-actions">
            <button className="btn" type="button" onClick={onMessage}>
              <Icon name="comment" /> Message this run
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
