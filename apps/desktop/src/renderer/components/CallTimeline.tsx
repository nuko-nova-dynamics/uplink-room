import "./calls.css";
/**
 * A call in its channel's timeline (DESIGN.md "Calls"): its start and end as
 * centered one-line events, the proposed tasks under its call notes, and its
 * transcript in a side panel.
 */
import { useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { Input } from "@ui-sdk/react/input";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { api, type Id } from "../lib/api";
import { useAct, useRoomQuery, useSession } from "../lib/session";
import { Face, MemberFace } from "./Faces";
import { Icon } from "./Icon";
import { Tip } from "./Tip";

export type ChannelCall = FunctionReturnType<typeof api.calls.list>[number];
type Proposal = ChannelCall["proposals"][number];

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "under a minute" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * A call's start, duration and participants as a sentence at its start or end time.
 */
export function CallEvent({
  call,
  kind,
  more = [],
}: {
  call: ChannelCall;
  kind: "started" | "ended" | "whole";
  /** Later short calls folded into this line (ChannelView): "Rosa Vega started 3 calls". */
  more?: ChannelCall[] | undefined;
}) {
  const at = kind === "ended" ? call.endedAt! : call.startedAt;
  if (kind === "whole" && more.length > 0) {
    const all = [call, ...more];
    const starters = [
      ...new Map(all.map((c) => [c.startedBy.memberId, c.startedBy.name])).values(),
    ];
    const each = all.map((c) => minutes(c.endedAt! - c.startedAt));
    return (
      <div className="timeline-event" role="note">
        <Icon name="volume" size={14} />
        <span>
          <b>{starters.join(", ")}</b> started {all.length} calls
          <span className="event-who">
            {" "}
            lasting {each.every((m) => m === each[0]) ? `${each[0]} each` : each.join(", ")}
          </span>
        </span>
        <span
          className="muted"
          title={all.map((c) => new Date(c.startedAt).toLocaleString()).join("\n")}
        >
          {new Date(call.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </span>
      </div>
    );
  }
  return (
    <div className="timeline-event" role="note">
      <Icon name="volume" size={14} />
      {kind === "started" ? (
        <span>
          <b>{call.startedBy.name}</b> started a call
        </span>
      ) : kind === "whole" ? (
        <span>
          <b>{call.startedBy.name}</b> started a call lasting{" "}
          {minutes(call.endedAt! - call.startedAt)}
          {/* Who else was in it: the caller is already named. */}
          {call.everyone.some((m) => m.memberId !== call.startedBy.memberId) ? (
            <span className="event-who">
              {" "}
              with{" "}
              {call.everyone
                .filter((m) => m.memberId !== call.startedBy.memberId)
                .map((m) => m.name)
                .join(", ")}
            </span>
          ) : null}
        </span>
      ) : (
        <span>
          Call ended after {minutes(call.endedAt! - call.startedAt)}
          <span className="event-who"> with {call.everyone.map((m) => m.name).join(", ")}</span>
        </span>
      )}
      {/* In the channel's list, under a day separator that already names the day. */}
      <span className="muted" title={new Date(at).toLocaleString()}>
        {new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
      </span>
    </div>
  );
}

/** The proposed tasks from a call, each with Accept and Dismiss. Nothing becomes a task by itself. */
export function ProposedTasks({
  call,
  channelProjectId,
  onOpenTask,
  onOpenTranscript,
}: {
  call: ChannelCall;
  channelProjectId: Id<"projects"> | undefined;
  onOpenTask: (taskId: Id<"tasks">) => void;
  onOpenTranscript: () => void;
}) {
  const pending = call.proposals.filter((p) => p.status === "pending").length;
  return (
    <div className="proposals" aria-label="Proposed tasks">
      {call.proposals.length > 0 ? (
        <div className="proposals-head">
          <b>Proposed tasks</b>
          <span className="muted">
            {pending > 0 ? `${pending} to accept or dismiss` : "All answered"}
            {channelProjectId ? "" : ". This channel has no project, so accepting asks where."}
          </span>
        </div>
      ) : null}
      {call.proposals.length > 0 ? (
        <div className="proposal-list">
          {call.proposals.map((p) => (
            <ProposalRow
              key={p.proposalId}
              proposal={p}
              channelProjectId={channelProjectId}
              onOpenTask={onOpenTask}
            />
          ))}
        </div>
      ) : null}
      {call.hasTranscript ? (
        <div className="msg-foot">
          <button
            className="btn ghost proposal-transcript"
            type="button"
            onClick={onOpenTranscript}
          >
            <Icon name="transcript" /> Transcript
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** One proposed task: Accept (asking which project when its channel has none), Edit and Dismiss, or how it was answered. */
export function ProposalRow({
  proposal,
  channelProjectId,
  onOpenTask,
}: {
  proposal: Proposal;
  channelProjectId: Id<"projects"> | undefined;
  onOpenTask: (taskId: Id<"tasks">) => void;
}) {
  const session = useSession();
  const projects = useRoomQuery(api.projects.list, {});
  const accept = useAct(api.calls.acceptProposal, { success: "Task created" });
  const dismiss = useAct(api.calls.dismissProposal);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(proposal.title);
  const [ownerId, setOwnerId] = useState<string>(proposal.owner?.memberId ?? session.me.memberId);
  const people = session.members.filter((m) => m.kind === "person");

  const doAccept = (projectId?: Id<"projects"> | null) =>
    void accept({
      proposalId: proposal.proposalId,
      ...(projectId !== undefined ? { projectId } : {}),
      ...(editing ? { title, ownerId: ownerId as Id<"members"> } : {}),
    });

  if (proposal.status !== "pending") {
    return (
      <div className={`proposal answered ${proposal.status}`}>
        <Icon name={proposal.status === "accepted" ? "check" : "x"} size={14} />
        <span className="grow truncate">{proposal.title}</span>
        <span className="muted">
          {proposal.status === "accepted" ? "Accepted" : "Dismissed"}
          {proposal.answeredBy ? ` by ${proposal.answeredBy.name}` : ""}
        </span>
        {proposal.taskId ? (
          <button className="btn" type="button" onClick={() => onOpenTask(proposal.taskId!)}>
            <Icon name="board" size={14} /> Open task
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="proposal">
      <div className="proposal-main">
        {editing ? (
          <div className="proposal-edit">
            <Input
              className="input"
              aria-label="Task title"
              value={title}
              onValueChange={setTitle}
            />
            <Select
              value={ownerId}
              items={people.map((m) => ({ value: m.memberId, label: m.name }))}
              onValueChange={(next) => {
                if (typeof next === "string") setOwnerId(next);
              }}
            >
              <SelectTrigger className="select proposal-owner-select" aria-label="Owner">
                <SelectValue className="truncate" />
              </SelectTrigger>
              <SelectContent className="pop" sideOffset={4} collisionPadding={8}>
                {people.map((m) => (
                  <SelectItem key={m.memberId} value={m.memberId} label={m.name}>
                    <span className="grow truncate">{m.name}</span>
                    <SelectItemIndicator>
                      <Icon name="check" size={14} />
                    </SelectItemIndicator>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <>
            <b className="proposal-title">{proposal.title}</b>
            {proposal.description ? <p className="proposal-desc">{proposal.description}</p> : null}
          </>
        )}
      </div>
      <div className="proposal-side">
        {!editing && proposal.owner ? (
          <span className="proposal-owner" title={`Suggested owner: ${proposal.owner.name}`}>
            <MemberFace member={proposal.owner} members={session.members} size={18} />
            <span className="truncate">{proposal.owner.name}</span>
          </span>
        ) : null}
        <div className="proposal-actions">
          <button className="btn ghost" type="button" onClick={() => setEditing((on) => !on)}>
            {editing ? "Cancel" : "Edit"}
          </button>
          <button
            className="btn ghost"
            type="button"
            onClick={() => void dismiss({ proposalId: proposal.proposalId })}
          >
            Dismiss
          </button>
          {channelProjectId ? (
            <button
              className="btn primary"
              type="button"
              disabled={editing && !title.trim()}
              onClick={() => doAccept()}
            >
              Accept
            </button>
          ) : (
            // The channel has no project, so accepting asks which one.
            <Menu>
              <MenuTrigger className="btn primary" disabled={editing && !title.trim()}>
                Accept
              </MenuTrigger>
              <MenuContent className="pop" align="end" sideOffset={4} collisionPadding={8}>
                <MenuGroup>
                  <MenuGroupLabel className="pop-title">Which project?</MenuGroupLabel>
                  {(projects ?? []).map((p) => (
                    <MenuItem
                      key={p.projectId}
                      label={p.name}
                      onSelect={() => doAccept(p.projectId)}
                    >
                      <Icon name="folder" /> <span className="grow truncate">{p.name}</span>
                    </MenuItem>
                  ))}
                </MenuGroup>
                <MenuSeparator />
                <MenuItem onSelect={() => doAccept(null)}>
                  <Icon name="board" /> No project
                </MenuItem>
              </MenuContent>
            </Menu>
          )}
        </div>
      </div>
    </div>
  );
}

/** A call's transcript, in the side column. */
export function TranscriptPanel({ callId, onClose }: { callId: Id<"calls">; onClose: () => void }) {
  const transcript = useRoomQuery(api.calls.transcript, { callId });
  const session = useSession();
  return (
    <aside className="channel-col side-col" aria-label="Transcript">
      <header className="main-head">
        <h1>Transcript</h1>
        <span className="grow" />
        <Tip label="Close transcript">
          <button
            className="btn icon"
            type="button"
            aria-label="Close transcript"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </Tip>
      </header>
      <div className="messages transcript">
        {transcript?.deleted ? (
          <div className="empty">This transcript was deleted 30 days after the call.</div>
        ) : null}
        {transcript && !transcript.deleted && transcript.lines.length === 0 ? (
          <div className="empty">Nothing was transcribed in this call.</div>
        ) : null}
        {(transcript?.lines ?? []).map((line, i) => (
          <div key={i} className="transcript-line">
            {line.speaker.kind === "agent" ? (
              <Face who={{ name: line.speaker.name, kind: "agent" }} size={20} />
            ) : (
              <MemberFace member={line.speaker} members={session.members} size={20} />
            )}
            <div>
              <div className="msg-head">
                <b>{line.speaker.name}</b>
                <span className="muted">
                  {new Date(line.at).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
              </div>
              <p>{line.text}</p>
            </div>
          </div>
        ))}
        {transcript?.keptUntil && !transcript.deleted ? (
          <p className="hint">
            Kept until{" "}
            {new Date(transcript.keptUntil).toLocaleDateString([], {
              month: "long",
              day: "numeric",
            })}
            .
          </p>
        ) : null}
      </div>
    </aside>
  );
}
