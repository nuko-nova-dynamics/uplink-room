import { useEffect, useRef, useState } from "react";
import { Input } from "@ui-sdk/react/input";
import { Popover, PopoverContent } from "@ui-sdk/react/popover";
import { Toggle } from "@ui-sdk/react/toggle";
import { reactedBy } from "../../lib/chat";
import { Icon } from "../Icon";
import { Tip } from "../Tip";
import { EMOJI, emojiName, searchEmoji } from "./emoji";
import "./conversation.css";

export type Reaction = { emoji: string; count: number; mine: boolean; names: string[] };

/**
 * A message's reactions (spec #63): one chip per emoji with its count, pressed when you reacted
 * (UI SDK Toggle). Clicking toggles yours; hovering names who reacted, read-only chips too (they
 * stay focusable for that hint).
 */
export function ReactionChips({
  reactions,
  onToggle,
  onAdd,
  readOnly = false,
}: {
  reactions: Reaction[];
  onToggle: (emoji: string, mine: boolean) => void;
  /** Shown, not changed (the Pinned panel). */
  readOnly?: boolean;
  /** Opens the picker for another emoji. */
  onAdd?: () => void;
}) {
  if (reactions.length === 0) return null;
  return (
    <div className="reactions" role="group" aria-label="Reactions">
      {reactions.map((r) => {
        const who = reactedBy(r.names, r.count, r.emoji);
        return (
          <Tip key={r.emoji} label={who}>
            <Toggle
              className="reaction"
              pressed={r.mine}
              disabled={readOnly}
              focusableWhenDisabled={readOnly}
              aria-label={`${r.emoji} ${r.count}. ${who}. ${r.mine ? "Remove yours" : "Add yours"}`}
              onPressedChange={() => onToggle(r.emoji, r.mine)}
            >
              <span className="reaction-emoji">{r.emoji}</span>
              <span className="reaction-count">{r.count}</span>
            </Toggle>
          </Tip>
        );
      })}
      {onAdd && !readOnly ? (
        <Tip label="Add a reaction">
          <button
            type="button"
            className="reaction add"
            aria-label="Add a reaction"
            onClick={onAdd}
          >
            <Icon name="smile" size={14} />
          </button>
        </Tip>
      ) : null}
    </div>
  );
}

type Box = { left: number; right: number; top: number; bottom: number };

/** The picker's full size. */
export const PICKER_SIZE = { width: 304, height: 380 };

/** Where a picker opens in the window (pickerPlace): fixed coordinates and the most height it may take. */
export type PickerPlace = {
  left: number;
  width: number;
  maxHeight: number;
  up: boolean;
  top?: number;
  bottom?: number;
};

/**
 * How an emoji picker opens (#99 review); it's a popover in the top layer, so no list or pane clips
 * it. Under the button it opens from, or above when below is short and above has more room; as
 * tall as that side of the window allows, its emoji list scrolling inside; its right edge at the
 * button's, kept within `column` (the Replies panel can be 300 px wide) and the window, narrower
 * when they are. `top` or `bottom` is the CSS offset in the window; the picker itself is placed
 * against its anchor by UI SDK, on the side `up` names, with this width and height cap.
 */
export function pickerPlace(
  button: Box,
  /** The list it opens over: its sides, and its top when a header sits above it (the picker stays under it). */
  column: { left: number; right: number; top?: number },
  view: { width: number; height: number },
  size = PICKER_SIZE,
  margin = 8,
  gap = 4,
): PickerPlace {
  const width = Math.max(
    0,
    Math.min(size.width, column.right - column.left - 2 * margin, view.width - 2 * margin),
  );
  const rightEdge = Math.min(button.right, column.right - margin, view.width - margin);
  const left = Math.max(rightEdge - width, column.left + margin, margin);
  const below = view.height - button.bottom - gap - margin;
  const above = button.top - gap - Math.max(margin, (column.top ?? 0) + margin);
  const up = below < size.height && above > below;
  const maxHeight = Math.max(0, Math.min(size.height, up ? above : below));
  return up
    ? { left, width, maxHeight, up, bottom: view.height - button.top + gap }
    : { left, width, maxHeight, up, top: button.bottom + gap };
}

/** The emoji you picked lately, newest first, kept on this computer only. */
const RECENT_KEY = "uplink.recentEmoji";
function recentEmoji(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(list)
      ? list.filter((e): e is string => typeof e === "string").slice(0, 16)
      : [];
  } catch {
    return [];
  }
}
let quickCache: string[] | null = null;
export function rememberEmoji(emoji: string) {
  quickCache = null;
  try {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([emoji, ...recentEmoji().filter((e) => e !== emoji)].slice(0, 16)),
    );
  } catch {
    // Storage may be off (a private window): the picker just has no recent row.
  }
}

/**
 * The three reactions a message's action bar offers in one click. The first two never move, so the
 * same click always gives the same reaction; the third is your latest other one (😂 until you have one).
 */
export function quickReactions(): string[] {
  quickCache ??= ["👍", "❤️", recentEmoji().find((e) => e !== "👍" && e !== "❤️") ?? "😂"];
  return quickCache;
}

/** One emoji, as the room accepts it: a single grapheme with an emoji in it. */
export function oneEmoji(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const graphemes = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed),
  ];
  if (graphemes.length !== 1) return null;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(trimmed) ? trimmed : null;
}

/**
 * The emoji picker (spec #63, no library): search by name ("tada" finds 🎉), what you used lately,
 * then every emoji it knows by group. Any other emoji typed or pasted into the search box (the
 * system emoji picker works there) is offered as is. Enter picks the first match; Escape, a press
 * outside it or focus leaving it closes it. It's a UI SDK Popover, open while it's rendered: its
 * caller unmounts it in onClose.
 */
export function EmojiPicker({
  onPick,
  onClose,
  className = "",
  place,
  anchor,
}: {
  /** `byKey`: picked with Enter or Space, not a pointer. */
  onPick: (emoji: string, byKey: boolean) => void;
  onClose: () => void;
  className?: string;
  /**
   * How it opens (pickerPlace): its width, height cap and side. Placed so, it closes when what's
   * behind it scrolls or the window resizes, which would leave that size wrong.
   */
  place?: PickerPlace | null | undefined;
  /** What it opens beside: the button, or the bar the button is in. */
  anchor?: Element | null | undefined;
}) {
  const [query, setQuery] = useState("");
  const [recent] = useState(recentEmoji);
  const [pointed, setPointed] = useState<string | null>(null);
  // The group whose emoji are at the top of the list, marked in the tabs as the list scrolls.
  const [inView, setInView] = useState<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    search.current?.focus({ preventScroll: true });
    // Its size was measured for where it opened: a scroll behind it, or a resize, closes it.
    const onScroll = (event: Event) => {
      if (box.current && !box.current.contains(event.target as Node)) close.current();
    };
    const onResize = () => close.current();
    if (place) {
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", onResize);
    }
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      // Closed by unmounting, so focus goes back here rather than through a popover close.
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [place]);
  const pick = (emoji: string, byKey = false) => {
    rememberEmoji(emoji);
    onPick(emoji, byKey);
  };
  const typed = oneEmoji(query);
  const found = query.trim()
    ? [...(typed ? [typed] : []), ...searchEmoji(query).filter((e) => e !== typed)]
    : null;
  const grid = (list: string[], label: string, firstIsEnter = false) => (
    <div className="emoji-grid" role="group" aria-label={label}>
      {list.map((emoji, i) => (
        <button
          key={emoji}
          type="button"
          className={firstIsEnter && i === 0 ? "enter-pick" : undefined}
          aria-label={`${emojiName(emoji) ?? emoji} ${emoji}`}
          onMouseEnter={() => setPointed(emoji)}
          onFocus={() => setPointed(emoji)}
          // A button pressed with a key fires a click with no pointer (detail 0).
          onClick={(event) => pick(emoji, event.detail === 0)}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
  // The footer names the emoji you point at, or the one Enter would pick.
  const named = pointed ?? found?.[0] ?? null;
  const groups = [...(recent.length ? ["Recent"] : []), ...EMOJI.map((g) => g.name)];
  return (
    <Popover
      open
      onOpenChange={(open, details) => {
        if (open) return;
        // Open while it's rendered: the caller unmounts it.
        details.cancel();
        close.current();
      }}
    >
      <PopoverContent
        ref={box}
        className={`pop emoji-picker ${place ? "placed" : className}`}
        aria-label="Pick an emoji"
        {...(anchor ? { anchor } : {})}
        side={(place ? place.up : className.includes("above")) ? "top" : "bottom"}
        align="end"
        sideOffset={4}
        collisionPadding={8}
        initialFocus="none"
        finalFocus="none"
        style={place ? { width: place.width, maxHeight: place.maxHeight } : undefined}
      >
        <Input
          ref={search}
          className="input"
          value={query}
          placeholder="Search emoji"
          aria-label="Search emoji"
          onValueChange={setQuery}
          onKeyDown={(event) => {
            if (event.key === "Enter" && found?.[0]) {
              event.preventDefault();
              pick(found[0], true);
            }
          }}
        />
        {found ? null : (
          <div className="emoji-tabs" role="group" aria-label="Emoji groups">
            {groups.map((name) => (
              <button
                key={name}
                type="button"
                aria-current={(inView ?? groups[0]) === name ? "true" : undefined}
                onClick={() => {
                  // Scrolls the emoji list alone (scrollIntoView could move what's behind the picker).
                  const list = scroll.current;
                  const head = list?.querySelector<HTMLElement>(`[data-group="${name}"]`);
                  if (list && head) list.scrollTop = head.offsetTop - list.offsetTop;
                }}
              >
                {name}
              </button>
            ))}
          </div>
        )}
        <div
          className="emoji-scroll"
          ref={scroll}
          onMouseLeave={() => setPointed(null)}
          onScroll={(event) => {
            const list = event.currentTarget;
            let current: string | null = null;
            for (const head of list.querySelectorAll<HTMLElement>("[data-group]")) {
              if (head.offsetTop - list.offsetTop <= list.scrollTop + 4)
                current = head.dataset["group"] ?? null;
            }
            setInView(current);
          }}
        >
          {found ? (
            found.length ? (
              grid(found, "Matches", true)
            ) : (
              <div className="emoji-none muted">
                No emoji named "{query.trim()}". Paste one, or try another word.
              </div>
            )
          ) : (
            <>
              {recent.length ? (
                <>
                  <div className="emoji-head" data-group="Recent">
                    Recent
                  </div>
                  {grid(recent, "Recent")}
                </>
              ) : null}
              {EMOJI.map((group) => (
                <div key={group.name}>
                  <div className="emoji-head" data-group={group.name}>
                    {group.name}
                  </div>
                  {grid(
                    group.items.map(([e]) => e),
                    group.name,
                  )}
                </div>
              ))}
            </>
          )}
        </div>
        <div className="emoji-foot" aria-live="polite">
          {named ? (
            <>
              <span className="emoji-foot-glyph">{named}</span>
              <span className="truncate">{emojiName(named) ?? "This emoji"}</span>
              {found?.[0] === named && !pointed ? (
                <span className="muted emoji-foot-key">Enter</span>
              ) : null}
            </>
          ) : (
            <span className="muted">Point at an emoji to see its name</span>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
