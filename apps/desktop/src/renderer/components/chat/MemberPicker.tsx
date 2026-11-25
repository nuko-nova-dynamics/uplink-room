import { useEffect, useRef } from "react";
import { Input } from "@ui-sdk/react/input";
import { Toggle } from "@ui-sdk/react/toggle";
import type { Id, MemberRow } from "../../lib/api";
import { ConversationFace as MemberFace } from "./ConversationFace";
import { Icon } from "../Icon";

/**
 * A filter box and a list of teammates and agents to pick from, as the new direct message popover
 * has. `candidates` are the members who can be picked; the filter narrows them by name.
 */
export function MemberPicker({
  candidates,
  members,
  picked,
  onToggle,
  filter,
  onFilter,
  autoFocus = false,
}: {
  candidates: { memberId: Id<"members">; name: string; kind: "person" | "agent" }[];
  /** The team's members, for agents' characters. */
  members: MemberRow[];
  picked: readonly Id<"members">[];
  onToggle: (memberId: Id<"members">) => void;
  filter: string;
  onFilter: (text: string) => void;
  autoFocus?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  const needle = filter.trim().toLowerCase();
  const shown = candidates.filter((m) => m.name.toLowerCase().includes(needle));
  return (
    <>
      <Input
        ref={input}
        className="input"
        value={filter}
        placeholder="Find a teammate or agent"
        aria-label="Find a teammate or agent"
        onValueChange={onFilter}
      />
      {shown.length === 0 ? (
        <p className="hint pick-empty">
          {candidates.length === 0
            ? "Everyone in the team is already in it."
            : `Nobody named “${filter.trim()}”.`}
        </p>
      ) : (
        <ul className="pick-list" aria-label="Members">
          {shown.map((m) => {
            const on = picked.includes(m.memberId);
            return (
              <li key={m.memberId}>
                <Toggle pressed={on} onPressedChange={() => onToggle(m.memberId)}>
                  <MemberFace member={m} members={members} size={24} />
                  <span className="grow truncate">{m.name}</span>
                  {m.kind === "agent" ? <span className="tag">Agent</span> : null}
                  {on ? <Icon name="check" /> : null}
                </Toggle>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
