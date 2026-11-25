import { useEffect, useRef, useState } from "react";
import { Button } from "@ui-sdk/react/button";
import { Input } from "@ui-sdk/react/input";
import { SegmentedControl, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import { api, type Id } from "../../lib/api";
import { useAct, useSession } from "../../lib/session";
import { MemberPicker } from "./MemberPicker";
import { AnchoredPopover } from "./NewDirectMessage";

/**
 * Making a channel from the sidebar's Channels +: a team channel everyone can see, or a private one
 * (ADR 0016) with the people picked here. It is a popover, not a dialog, like the new direct
 * message: naming a channel and picking people is quick, and nothing is lost by clicking away. It
 * is a UI SDK Popover in the top layer, placed at the + button, so the sidebar's list can't clip it.
 */
export function NewChannel({
  anchor,
  onClose,
  onCreated,
}: {
  /** Where the + button is, to place the popover under it. */
  anchor: DOMRect;
  onClose: () => void;
  onCreated: (channelId: Id<"channels">) => void;
}) {
  const session = useSession();
  const createTeam = useAct(api.channels.create);
  const createPrivate = useAct(api.channels.createPrivate);
  const [name, setName] = useState("");
  const [isPrivate, setPrivate] = useState(false);
  const [picked, setPicked] = useState<Id<"members">[]>([]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  // The popover opens to name the channel first.
  useEffect(() => nameInput.current?.focus(), []);

  const others = session.members.filter((m) => m.memberId !== session.me.memberId);
  const toggle = (id: Id<"members">) =>
    setPicked((all) => (all.includes(id) ? all.filter((x) => x !== id) : [...all, id]));
  const clean = name.trim().replace(/^#/, "").trim();
  const submit = async () => {
    if (!clean || busy) return;
    setBusy(true);
    const channelId = isPrivate
      ? await createPrivate({ name: clean, memberIds: picked })
      : await createTeam({ name: clean });
    setBusy(false);
    if (channelId) onCreated(channelId);
  };

  return (
    <AnchoredPopover
      anchor={anchor}
      onClose={onClose}
      className="pop new-dm new-channel"
      aria-label="New channel"
      render={
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        />
      }
    >
      <Input
        className="input"
        ref={nameInput}
        value={name}
        placeholder="Name, such as release-plans"
        aria-label="Channel name"
        maxLength={80}
        onValueChange={setName}
      />
      <SegmentedControl
        className="seg"
        aria-label="Who can see it"
        value={isPrivate ? "private" : "everyone"}
        onValueChange={(value) => setPrivate(value === "private")}
      >
        <SegmentedControlItem value="everyone">Everyone</SegmentedControlItem>
        <SegmentedControlItem value="private">Private</SegmentedControlItem>
      </SegmentedControl>
      <p className="hint">
        {isPrivate
          ? "Only the people you add can see it, admins included. It can't be made public later."
          : `Everyone in ${session.team.name} can see it and join its calls.`}
      </p>
      {isPrivate ? (
        <MemberPicker
          candidates={others}
          members={session.members}
          picked={picked}
          onToggle={toggle}
          filter={filter}
          onFilter={setFilter}
        />
      ) : null}
      <div className="new-dm-foot">
        <span className="muted grow">
          {isPrivate
            ? picked.length === 0
              ? "Just you so far."
              : `${picked.length} added, and you.`
            : null}
        </span>
        <Button
          className="btn primary"
          type="submit"
          disabled={!clean || busy}
          onClick={(event) => {
            // Enter in the name submits through this button too; the press owns the busy state.
            event.preventDefault();
            return submit();
          }}
        >
          Create
        </Button>
      </div>
    </AnchoredPopover>
  );
}
