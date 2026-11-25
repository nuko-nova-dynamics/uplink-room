import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Input } from "@ui-sdk/react/input";
import { Popover, PopoverContent } from "@ui-sdk/react/popover";
import { Toggle } from "@ui-sdk/react/toggle";
import { api, type Id } from "../../lib/api";
import { directMessageSize, runDetail, teamRunWarning, type LiveRun } from "../../lib/chat";
import { useAct, useRoomQuery, useSession } from "../../lib/session";
import { HarnessMark } from "../Faces";
import { ConversationFace as MemberFace } from "./ConversationFace";
import { Icon } from "../Icon";

/**
 * A direct message has at most 10 members and runs, you included, and each run's person (and an
 * agent driving it) joins with it (ADR 0015, ADR 0026; channels.openDirect).
 */
const MAX_SIZE = 10;

/**
 * Under the + button, or above it when there's more room there, never past the window's edge: the
 * list scrolls inside whatever height is left.
 */
export function placeNear(anchor: Pick<DOMRect, "top" | "bottom" | "right">, windowHeight: number) {
  const below = windowHeight - anchor.bottom - 14;
  const above = anchor.top - 14;
  const left = Math.max(8, anchor.right - 300);
  return below >= 280 || below >= above
    ? { top: anchor.bottom + 6, left, maxHeight: below }
    : { bottom: windowHeight - anchor.top + 6, left, maxHeight: above };
}

/**
 * A popover the shell opens by rendering it and closes by unmounting it, placed at a button's
 * rectangle (the sidebar's +), on UI SDK's Popover: it sits in the top layer, so no scrolling list
 * clips it, flips above the button when below is short, and is as tall as the window leaves it
 * (`--available-height`). Escape, a press outside it or focus leaving it calls `onClose`; Escape
 * also puts focus back on the button that opened it. A window resize closes it too, as the button
 * may have moved.
 */
export function AnchoredPopover({
  anchor,
  onClose,
  className,
  children,
  render,
  "aria-label": label,
}: {
  anchor: Pick<DOMRect, "top" | "bottom" | "left" | "right" | "width" | "height" | "x" | "y">;
  onClose: () => void;
  className: string;
  children: ReactNode;
  render?: ReactElement;
  "aria-label": string;
}) {
  // The shell passes a new onClose whenever it renders (every channels update); the handlers call
  // the latest one.
  const close = useRef(onClose);
  close.current = onClose;
  const opener = useRef(document.activeElement as HTMLElement | null);
  const { top, bottom, left, right, width, height, x, y } = anchor;
  const at = useMemo(
    () => ({
      getBoundingClientRect: () =>
        ({ top, bottom, left, right, width, height, x, y, toJSON: () => ({}) }) as DOMRect,
    }),
    [top, bottom, left, right, width, height, x, y],
  );
  useEffect(() => {
    const resize = () => close.current();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return (
    <Popover
      open
      onOpenChange={(open, details) => {
        if (open) return;
        // It stays open until the shell unmounts it.
        details.cancel();
        // A press on the button that opened it is that button's: its click closes it. Closing here
        // too would let that click open it again at once.
        const target = details.event?.target;
        if (
          details.reason === "outside-press" &&
          target instanceof Node &&
          opener.current?.contains(target)
        )
          return;
        const back = details.reason === "escape-key" ? opener.current : null;
        close.current();
        queueMicrotask(() => {
          if (back?.isConnected && back.matches("button, input, select, textarea, a[href]"))
            back.focus();
        });
      }}
    >
      <PopoverContent
        className={className}
        aria-label={label}
        anchor={at}
        side="bottom"
        align="end"
        sideOffset={6}
        collisionPadding={8}
        initialFocus="none"
        finalFocus="none"
        {...(render ? { render } : {})}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Starting a direct message (spec #63) with one or more teammates or agents, or live runs such as
 * Claude Code (Ana) (ADR 0026), from a popover by the sidebar's +. Picking the same people and runs
 * as an existing one opens that one; a run's person joins it too, so they see what's said to it. It is a popover, not a
 * dialog: choosing people is quick and nothing is lost by clicking away. It is an AnchoredPopover
 * at the + button, so the sidebar's list can't clip it.
 */
export function NewDirectMessage({
  anchor,
  onClose,
  onOpened,
}: {
  /** Where the + button is, to place the popover under it. */
  anchor: DOMRect;
  onClose: () => void;
  onOpened: (channelId: Id<"channels">) => void;
}) {
  const session = useSession();
  const open = useAct(api.channels.openDirect);
  const [picked, setPicked] = useState<Id<"members">[]>([]);
  const [picks, setPickedRuns] = useState<Id<"runs">[]>([]);
  const live = (useRoomQuery(api.runs.live, {}) ?? []) as LiveRun[];
  // A picked run that stopped while the picker is open drops out of the pick: the room would refuse it.
  const pickedRuns = picks.filter((id) => live.some((r) => r.runId === id && !r.private));
  const [filter, setFilter] = useState("");
  const filterInput = useRef<HTMLInputElement>(null);
  // Focus goes to the filter once, when the popover opens: a shell update doesn't pull it back.
  useEffect(() => {
    filterInput.current?.focus();
  }, []);
  const others = session.members.filter(
    (m) =>
      m.memberId !== session.me.memberId &&
      m.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const needle = filter.trim().toLowerCase();
  // A run from a conversation you aren't in can be messaged only by its members.
  const runs = live.filter((r) => !r.private && r.label.toLowerCase().includes(needle));
  const sizeWith = (members: readonly string[], runIds: readonly string[]) =>
    directMessageSize(
      session.me.memberId,
      members,
      live.filter((r) => runIds.includes(r.runId)),
    );
  const full = sizeWith(picked, pickedRuns) >= MAX_SIZE;
  // A pick that would take it past 10 isn't taken.
  const toggle = (id: Id<"members">) =>
    setPicked((all) =>
      all.includes(id)
        ? all.filter((x) => x !== id)
        : sizeWith([...all, id], pickedRuns) > MAX_SIZE
          ? all
          : [...all, id],
    );
  const toggleRun = (id: Id<"runs">) =>
    setPickedRuns((all) => {
      const current = all.filter((x) => pickedRuns.includes(x));
      return current.includes(id)
        ? current.filter((x) => x !== id)
        : sizeWith(picked, [...current, id]) > MAX_SIZE
          ? current
          : [...current, id];
    });
  // A picked team run hears the direct message, and the whole team sees what it hears: say so before it opens.
  const seenByTeam = live.filter(
    (r) => pickedRuns.includes(r.runId as Id<"runs">) && r.visibleToTeam,
  );
  return (
    <AnchoredPopover
      anchor={anchor}
      onClose={onClose}
      className="pop new-dm"
      aria-label="New direct message"
    >
      <Input
        ref={filterInput}
        className="input"
        value={filter}
        placeholder="Find a teammate, agent or run"
        aria-label="Find a teammate, agent or run"
        onValueChange={setFilter}
      />
      <ul className="pick-list" aria-label="Members">
        {others.map((m) => {
          const on = picked.includes(m.memberId);
          return (
            <li key={m.memberId}>
              <Toggle pressed={on} onPressedChange={() => toggle(m.memberId)}>
                <MemberFace member={m} members={session.members} size={24} />
                <span className="grow truncate">{m.name}</span>
                {m.kind === "agent" ? <span className="tag">Agent</span> : null}
                {on ? <Icon name="check" /> : null}
              </Toggle>
            </li>
          );
        })}
      </ul>
      {runs.length > 0 ? (
        <>
          <div className="pop-title" aria-hidden="true">
            Live runs
          </div>
          <ul className="pick-list" aria-label="Live runs">
            {runs.map((r) => {
              const on = pickedRuns.includes(r.runId as Id<"runs">);
              const detail = runDetail(r);
              return (
                <li key={r.runId}>
                  <Toggle pressed={on} onPressedChange={() => toggleRun(r.runId as Id<"runs">)}>
                    <HarnessMark harness="run" size={24} title={r.label} />
                    <span className="grow pick-two">
                      <span className="truncate">{r.label}</span>
                      {detail ? <span className="muted truncate">{detail}</span> : null}
                    </span>
                    {on ? <Icon name="check" /> : null}
                  </Toggle>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {seenByTeam.map((r) => (
        <p key={r.runId} className="output-warn new-dm-warn">
          <Icon name="eye" size={14} />
          <span>{teamRunWarning(r.label)}</span>
        </p>
      ))}
      <div className="new-dm-foot">
        <span className="muted grow">
          {full
            ? "At most 10, you included."
            : seenByTeam.length
              ? null
              : "Only the people in it can see it."}
        </span>
        <button
          className="btn primary"
          type="button"
          disabled={picked.length + pickedRuns.length === 0}
          onClick={async () => {
            const opened = await open({
              memberIds: picked,
              ...(pickedRuns.length ? { runIds: pickedRuns } : {}),
            });
            if (opened) onOpened(opened.channelId);
          }}
        >
          Open
        </button>
      </div>
    </AnchoredPopover>
  );
}
