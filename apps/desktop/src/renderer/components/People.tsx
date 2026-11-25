import { useState } from "react";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { Listbox, ListboxGroup, ListboxGroupLabel, ListboxItem } from "@ui-sdk/react/listbox";
import {
  createPopoverController,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTitle,
} from "@ui-sdk/react/popover";
import { api, type ChannelRow, type Id, type MemberRow } from "../lib/api";
import { useCall, useLiveCalls, type LiveCall } from "../lib/call";
import { presenceLabel, usePresence, type Presence } from "../lib/presence";
import { useAct, useRoomQuery, useSession, useSoftRoomQuery } from "../lib/session";
import { STATE_META, type AnyState } from "../lib/states";
import { CHECKS_IN } from "../lib/chat";
import { useNow } from "./useNow";
import { Face, MemberFace } from "./Faces";
import { Icon } from "./Icon";
import { Tip } from "./Tip";
import type { Nav } from "../Shell";
import "./people.css";

/** The longest custom status the room keeps (members.setStatus). */
export const MAX_STATUS = 80;

/** One person or agent as People shows them: who, whether they're here, and what they're doing. */
export type Person = {
  member: MemberRow;
  me: boolean;
  presence: Presence;
  /** "Active", "Away" or "Last seen 5 min ago". */
  presenceText: string;
  /** The call they're in, as a channel name ("#general", or a direct message's name). */
  inCall: { channelId: Id<"channels">; where: string } | undefined;
  /** For an agent: the state of its most urgent run, and what it's on. */
  agent: { state: AnyState | "idle"; line: string | undefined; checksIn: boolean } | undefined;
};

/** Where People puts someone: here now, an agent, or away from the app. */
export type PeopleGroup = "online" | "agents" | "offline";

export function groupOf(person: Person): PeopleGroup {
  if (person.member.kind === "agent") return "agents";
  // Someone talking in a call is here, whatever their last app heartbeat says.
  return person.me || person.inCall || person.presence !== "offline" ? "online" : "offline";
}

/**
 * What People says someone is doing, on the line under their name: the call they're in, then their
 * custom status, then for an agent its run state and what it's on. Otherwise Away or when they were
 * last seen; nothing for someone active (the dot says it) or offline with no time (the group says it).
 */
export function doingOf(person: Person): string {
  const parts: string[] = [];
  if (person.inCall) parts.push(`In a call in ${person.inCall.where}`);
  if (person.member.status) parts.push(person.member.status);
  if (parts.length) return parts.join(" · ");
  if (person.agent) {
    if (person.agent.state === "idle") return person.agent.checksIn ? CHECKS_IN : "Idle";
    const label = STATE_META[person.agent.state].label;
    return person.agent.line ? `${label}: ${person.agent.line}` : label;
  }
  if (person.me) return "Set a status";
  if (person.presence === "active" || person.presenceText === "Offline") return "";
  return person.presenceText;
}

/** Most present first: in a call, then active, then away, each by name; you lead your group. */
export function byPresence(a: Person, b: Person): number {
  const rank = (p: Person) =>
    p.me ? 0 : p.inCall ? 1 : p.presence === "active" ? 2 : p.presence === "away" ? 3 : 4;
  return rank(a) - rank(b) || a.member.name.localeCompare(b.member.name);
}

const GROUPS: { id: PeopleGroup; label: string }[] = [
  { id: "online", label: "Online" },
  { id: "agents", label: "Agents" },
  { id: "offline", label: "Offline" },
];

/** Everyone the channel's messages reach: the whole team in a team channel, its members otherwise. */
function audience(channel: ChannelRow | undefined, members: MemberRow[]): MemberRow[] {
  if (!channel || (channel.kind !== "private" && channel.kind !== "direct")) return members;
  const ids = new Set((channel.members ?? []).map((m) => m.memberId));
  return members.filter((m) => ids.has(m.memberId));
}

export function usePeople(channel: ChannelRow | undefined): Person[] {
  const session = useSession();
  const presenceOf = usePresence();
  const now = useNow(30_000);
  const live = useLiveCalls();
  const channels = useRoomQuery(api.channels.list, {});
  const roster = useSoftRoomQuery(api.teams.roster, {});
  const callOf = new Map<string, LiveCall>();
  for (const c of live ?? []) for (const p of c.participants) callOf.set(p.memberId, c);
  return audience(channel, session.members).map((member) => {
    const p = presenceOf(member.memberId);
    const me = member.memberId === session.me.memberId;
    const call = callOf.get(member.memberId);
    const room = call ? channels?.find((c) => c.channelId === call.channelId) : undefined;
    const entry = roster?.find((r) => r.kind === "agent" && r.memberId === member.memberId);
    // You're here: your own window is open, whatever the last beat the room has says.
    const presence: Presence = me ? "active" : p.presence;
    return {
      member,
      me,
      presence,
      presenceText: presenceLabel(presence, p.lastSeenAt, now),
      inCall: call
        ? {
            channelId: call.channelId,
            where: room ? (room.kind === "direct" ? room.name : `#${room.name}`) : "a channel",
          }
        : undefined,
      agent:
        member.kind === "agent"
          ? {
              state: entry?.state ?? "idle",
              line: entry?.line ?? undefined,
              checksIn: member.reach === "checks_in",
            }
          : undefined,
    };
  });
}

/**
 * People, beside a channel, as Discord's member list: everyone its messages reach, grouped into
 * Online, Agents and Offline, each with what they're doing (a call, their custom status, an agent's
 * run). Built from UI SDK behaviors: the list is a listbox (arrow keys, typing to jump), and choosing
 * someone opens their card, one popover the whole list shares through a controller.
 */
export function PeoplePanel({
  channel,
  nav,
  onClose,
}: {
  channel: ChannelRow | undefined;
  nav: Nav;
  onClose: () => void;
}) {
  const people = usePeople(channel);
  const [card] = useState(() => createPopoverController<Id<"members">>());
  const groups = GROUPS.map((g) => ({
    ...g,
    people: people.filter((p) => groupOf(p) === g.id).sort(byPresence),
  })).filter((g) => g.people.length > 0);
  const online = people.filter((p) => groupOf(p) === "online").length;
  return (
    <aside className="channel-col side-panel people-panel" aria-label="People">
      <header className="main-head">
        <h1>
          <Icon className="head-glyph" name="people" />
          People
          <span className="head-count" title={`${online} online`}>
            {people.length}
          </span>
        </h1>
        <span className="grow" />
        <Tip label="Close people">
          <button className="btn icon" type="button" aria-label="Close people" onClick={onClose}>
            <Icon name="close" />
          </button>
        </Tip>
      </header>
      <div className="people-scroll">
        <Listbox
          className="people-list"
          aria-label="People"
          activation="manual"
          value={null}
          onValueChange={(value, details) => {
            if (typeof value !== "string") return;
            const target = details.event?.target;
            const row =
              target instanceof Element
                ? target.closest<HTMLElement>('[data-slot="listbox-item"]')
                : document.querySelector<HTMLElement>(`.people-list [data-member="${value}"]`);
            void card.open({ payload: value as Id<"members">, ...(row ? { anchor: row } : {}) });
          }}
        >
          {groups.map((group) => (
            <ListboxGroup key={group.id} className="people-group">
              <ListboxGroupLabel className="people-group-label">
                {group.label} <span className="people-group-count">{group.people.length}</span>
              </ListboxGroupLabel>
              {group.people.map((person) => (
                <PersonRow key={person.member.memberId} person={person} />
              ))}
            </ListboxGroup>
          ))}
        </Listbox>
      </div>
      <Popover controller={card}>
        <PopoverContent<Id<"members">>
          className="pop person-card"
          side="left"
          align="start"
          sideOffset={8}
          collisionPadding={8}
        >
          {(state) => {
            const person = people.find((p) => p.member.memberId === state.payload);
            return person ? (
              <PersonCard person={person} nav={nav} onDone={() => card.close()} />
            ) : null;
          }}
        </PopoverContent>
      </Popover>
    </aside>
  );
}

function PersonRow({ person }: { person: Person }) {
  const { member } = person;
  const doing = doingOf(person);
  return (
    <Tip label={doing ? `${member.name}: ${doing}` : member.name} side="left">
      <ListboxItem
        value={member.memberId}
        label={member.name}
        data-member={member.memberId}
        className={`person-row in-${groupOf(person)}`}
        aria-label={`${member.name}${person.me ? " (you)" : ""}${doing ? `, ${doing}` : ""}`}
      >
        <PersonFace person={person} size={32} />
        <span className="person-text">
          <span className="person-name truncate">
            {member.name}
            {person.me ? <span className="person-you"> (you)</span> : null}
          </span>
          {doing ? (
            <small
              className={`person-doing truncate ${person.me && doing === "Set a status" ? "is-hint" : ""}`}
            >
              {person.inCall ? <Icon name="volume" size={12} /> : null}
              {person.agent && !person.inCall && !member.status && person.agent.state !== "idle" ? (
                <span className={`state-${person.agent.state}`}>{doing}</span>
              ) : (
                doing
              )}
            </small>
          ) : null}
        </span>
      </ListboxItem>
    </Tip>
  );
}

function PersonFace({ person, size }: { person: Person; size: number }) {
  const { member } = person;
  if (member.kind === "agent") {
    return (
      <Face
        who={{ name: member.name, kind: "agent", character: member.character }}
        state={person.agent?.state ?? "idle"}
        size={size}
      />
    );
  }
  return (
    <MemberFace
      member={member}
      size={size}
      presence={{ presence: person.presence, label: person.presenceText }}
    />
  );
}

/** Someone's card: who they are, what they're doing, and Message or Join; your own sets your status. */
function PersonCard({ person, nav, onDone }: { person: Person; nav: Nav; onDone: () => void }) {
  const call = useCall();
  const openDirect = useAct(api.channels.openDirect);
  const { member } = person;
  const role =
    member.kind === "agent"
      ? `Agent${member.addedBy ? `, added by ${member.addedBy.name}` : ""}`
      : member.role === "admin"
        ? "Admin"
        : "Member";
  const inThatCall =
    person.inCall && call.status !== "idle" && call.channelId === person.inCall.channelId;
  return (
    <>
      <div className="person-card-head">
        <PersonFace person={person} size={48} />
        <div className="person-card-who">
          <PopoverTitle className="person-card-name truncate">{member.name}</PopoverTitle>
          <span className="muted">{role}</span>
        </div>
      </div>
      <dl className="person-card-facts">
        {member.kind === "person" ? (
          <>
            <dt>Here</dt>
            <dd>{person.presenceText}</dd>
          </>
        ) : (
          <>
            <dt>Doing</dt>
            <dd>
              {doingOf({ ...person, inCall: undefined, member: { ...member, status: undefined } })}
            </dd>
          </>
        )}
        {person.inCall ? (
          <>
            <dt>Call</dt>
            <dd>{person.inCall.where}</dd>
          </>
        ) : null}
        {member.status && !person.me ? (
          <>
            <dt>Status</dt>
            <dd>{member.status}</dd>
          </>
        ) : null}
      </dl>
      {person.me ? (
        <StatusForm status={member.status} onDone={onDone} />
      ) : (
        <div className="person-card-actions">
          {person.inCall && !inThatCall ? (
            <button
              className="btn"
              type="button"
              onClick={() => {
                const target = person.inCall!.channelId;
                onDone();
                nav.go({ name: "channel", channelId: target });
                void call.join(target);
              }}
            >
              <Icon name="volume" /> Join their call
            </button>
          ) : null}
          {
            <button
              className="btn primary"
              type="button"
              onClick={async () => {
                const opened = await openDirect({ memberIds: [member.memberId] });
                if (!opened) return;
                onDone();
                nav.go({ name: "channel", channelId: opened.channelId });
              }}
            >
              Message
            </button>
          }
          <PopoverClose className="btn ghost">Close</PopoverClose>
        </div>
      )}
    </>
  );
}

/** Your custom status (members.setStatus): one line your team sees beside your name. */
function StatusForm({ status, onDone }: { status: string | undefined; onDone: () => void }) {
  const setStatus = useAct(api.members.setStatus);
  const [text, setText] = useState(status ?? "");
  const [saving, setSaving] = useState(false);
  const save = async (next: string | null) => {
    setSaving(true);
    const ok = await setStatus({ text: next });
    setSaving(false);
    if (ok) onDone();
  };
  return (
    <form
      className="status-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save(text.trim() || null);
      }}
    >
      <Field>
        <FieldLabel className="status-label">Your status</FieldLabel>
        <Input
          className="input"
          value={text}
          maxLength={MAX_STATUS}
          placeholder="What are you working on?"
          onValueChange={setText}
        />
        <FieldDescription className="muted status-hint">
          Your team sees it beside your name.
        </FieldDescription>
      </Field>
      <div className="person-card-actions">
        {status ? (
          <Button
            className="btn ghost"
            disabled={saving}
            focusableWhenDisabled
            onClick={() => save(null)}
          >
            Clear
          </Button>
        ) : null}
        <PopoverClose className="btn ghost">Cancel</PopoverClose>
        {/* The form's submit saves, so its saving flag disables this meanwhile. */}
        <Button
          className="btn primary"
          type="submit"
          disabled={saving || text.trim() === (status ?? "")}
        >
          Save
        </Button>
      </div>
    </form>
  );
}
