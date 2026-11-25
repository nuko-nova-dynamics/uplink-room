import { useEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@ui-sdk/react/popover";
import { api, type Id } from "../../lib/api";
import { useAct, useRoomQuery, useSession } from "../../lib/session";
import { ConversationFace as MemberFace } from "./ConversationFace";
import { Icon } from "../Icon";
import { Tip } from "../Tip";
import { MemberPicker } from "./MemberPicker";

type Member = { memberId: Id<"members">; name: string; kind: "person" | "agent" };

/**
 * A private channel's members (ADR 0016), from the button in its header: who is in it, adding
 * people or agents, removing them (its creator, or an admin in it), and leaving. Leaving is hard
 * to undo (only someone still in it can add you back), so it asks once more, in place: a popover
 * (UI SDK's Popover) with a confirm step, not a dialog. Escape returns focus to the button; a click
 * elsewhere moves on to what was clicked.
 */
export function ChannelMembers({
  channelId,
  name,
  members,
  createdBy,
  onLeft,
}: {
  channelId: Id<"channels">;
  name: string;
  /** Its members as channels.list has them, for the button's faces and count. */
  members: Member[];
  /** Its creator, as channels.list has it. */
  createdBy: Id<"members"> | undefined;
  /** After you leave: the channel is gone for you. */
  onLeft: () => void;
}) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"list" | "add" | "leave">("list");
  const [picked, setPicked] = useState<Id<"members">[]>([]);
  const [filter, setFilter] = useState("");
  const addButton = useRef<HTMLButtonElement>(null);
  const leaveButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    setMode("list");
    setPicked([]);
    setFilter("");
  };
  // Each step of the popover puts focus where the next key belongs: the filter when adding (the
  // picker focuses it), Cancel when asked to confirm leaving, and the control you came from back.
  const previous = useRef(mode);
  useEffect(() => {
    const from = previous.current;
    previous.current = mode;
    if (!open || from === mode) return;
    if (mode === "leave") cancelButton.current?.focus();
    else if (mode === "list" && from === "add") addButton.current?.focus();
    else if (mode === "list" && from === "leave") leaveButton.current?.focus();
  }, [mode, open]);
  const detail = useRoomQuery(api.channels.members, open ? { channelId } : "skip");
  const add = useAct(api.channels.addMembers);
  const remove = useAct(api.channels.removeMember);
  const leave = useAct(api.channels.leave);

  const me = session.me.memberId;
  // Until channels.members answers (a few hundred ms), the same facts from what the app already has,
  // so the creator never sees a list without its remove buttons.
  const creatorId = detail?.creatorId ?? createdBy;
  const canRemove = detail?.canRemove ?? (me === createdBy || session.me.role === "admin");
  const inIt = new Set<string>((detail?.members ?? members).map((m) => m.memberId));
  const candidates = session.members.filter((m) => !inIt.has(m.memberId));
  const others = members.filter((m) => m.memberId !== me);

  return (
    <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <Tip label="Members">
        <PopoverTrigger className="members-btn" aria-label={`Members, ${members.length}`}>
          <span className="dm-faces">
            {(others.length ? others : members).slice(0, 3).map((m) => (
              // 24 px, as in a direct message's header: a smaller face's initials fall under 11 px.
              <MemberFace key={m.memberId} member={m} members={session.members} size={24} />
            ))}
          </span>
          <span className="members-count">{members.length}</span>
        </PopoverTrigger>
      </Tip>
      <PopoverContent
        className="pop members-pop"
        aria-label={`Members of ${name}`}
        side="bottom"
        align="end"
        sideOffset={4}
        collisionPadding={8}
        initialFocus="none"
      >
        {mode === "add" ? (
          <>
            <div className="pop-title">Add to {name}</div>
            <MemberPicker
              candidates={candidates}
              members={session.members}
              picked={picked}
              onToggle={(id) =>
                setPicked((all) => (all.includes(id) ? all.filter((x) => x !== id) : [...all, id]))
              }
              filter={filter}
              onFilter={setFilter}
              autoFocus
            />
            <div className="new-dm-foot">
              <span className="hint grow">They'll see its history too.</span>
              <button className="btn ghost" type="button" onClick={() => setMode("list")}>
                Back
              </button>
              <button
                className="btn primary"
                type="button"
                disabled={picked.length === 0}
                onClick={async () => {
                  if (await add({ channelId, memberIds: picked })) {
                    setPicked([]);
                    setFilter("");
                    setMode("list");
                  }
                }}
              >
                Add
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="pop-title">Members</div>
            <ul className="pick-list members-list" aria-label="Members">
              {(detail?.members ?? members).map((m) => {
                const creator = creatorId === m.memberId;
                const removable = canRemove && m.memberId !== me;
                return (
                  <li key={m.memberId} className="member-row">
                    <MemberFace member={m} members={session.members} size={24} />
                    <span className="grow truncate">{m.name}</span>
                    {m.kind === "agent" ? <span className="tag">Agent</span> : null}
                    {creator ? (
                      <span className="muted">Created it</span>
                    ) : m.memberId === me ? (
                      <span className="muted">You</span>
                    ) : null}
                    {removable ? (
                      <Tip label={`Remove ${m.name}`}>
                        <button
                          className="icon-btn"
                          type="button"
                          aria-label={`Remove ${m.name}`}
                          onClick={() => void remove({ channelId, memberId: m.memberId })}
                        >
                          <Icon name="close" />
                        </button>
                      </Tip>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <div className="sep" />
            {mode === "leave" ? (
              <div className="leave-confirm">
                <p>Leave {name}? Someone in it has to add you back.</p>
                <div className="row-flex">
                  <button
                    className="btn"
                    type="button"
                    onClick={async () => {
                      if (await leave({ channelId })) {
                        close();
                        onLeft();
                      }
                    }}
                  >
                    Leave
                  </button>
                  <button
                    ref={cancelButton}
                    className="btn ghost"
                    type="button"
                    onClick={() => setMode("list")}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button ref={addButton} type="button" onClick={() => setMode("add")}>
                  <Icon name="plus" />
                  <span className="grow">Add people</span>
                </button>
                <button ref={leaveButton} type="button" onClick={() => setMode("leave")}>
                  <Icon name="exit" />
                  <span className="grow">Leave {name}</span>
                </button>
              </>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
