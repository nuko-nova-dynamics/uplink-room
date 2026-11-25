import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { enterLatched, latchEnter } from "../../lib/enterKey";
import { HarnessMark } from "../Faces";
import { ConversationFace as MemberFace } from "./ConversationFace";
import { Icon } from "../Icon";
import {
  addPick,
  insertMention,
  insideCodeFence,
  mentionAt,
  mentionOptions,
  shiftPicks,
  type MentionMember,
  type MentionOption,
  type MentionPick,
  type TextChange,
} from "../../lib/chat";

/**
 * A message box with `@` autocomplete (spec #63): typing `@` and a few letters lists matching
 * teammates and agents (and @everyone where it's allowed), then the live runs that match, each with
 * its task (ADR 0026); arrows move, Enter or Tab picks,
 * Escape closes. What it writes is `@Name`; each one picked from the list is kept as a pick
 * (`picks`), so the message mentions the member who was picked even when two share a name.
 *
 * The box stays a native textarea (UI SDK's Textarea leaves out the onSelect this tracks the caret
 * with), and the list is its own combobox rather than UI SDK's Trigger Menu. Matching, order
 * (members, @everyone, then live runs), insertion and picks all live in lib/chat, so Trigger Menu
 * would only take the keys and the popup, while changing what Escape does (it keeps a dismissed
 * match closed as you type on) and dropping the box's combobox role.
 */
export function MentionInput({
  value,
  onChange,
  picks = [],
  onPicks,
  members,
  everyone,
  me,
  placeholder,
  label,
  minHeight = 64,
  onSubmit,
  onCancel,
  onPaste,
  inputRef,
  enterSends = false,
  onArrowUpEmpty,
  autoGrow = false,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The mentions picked from the list, where they sit in `value`. */
  picks?: MentionPick[];
  onPicks?: (picks: MentionPick[]) => void;
  members: MentionMember[];
  /** Whether @everyone is offered (people only: agents can't use it). */
  everyone: boolean;
  me?: string;
  placeholder?: string;
  label: string;
  minHeight?: number;
  /** ⌘↵ or Ctrl+↵, and Enter alone when `enterSends`. */
  onSubmit?: () => void;
  /** Enter alone submits (Shift+Enter, or Enter inside a ``` block, makes a new line). */
  enterSends?: boolean;
  /** ↑ in an empty box (the composer: edit your last message). */
  onArrowUpEmpty?: () => void;
  /** One line that grows with the text (up to a cap, then it scrolls), instead of a fixed box. */
  autoGrow?: boolean;
  /** Escape when the list isn't open. */
  onCancel?: () => void;
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const own = useRef<HTMLTextAreaElement>(null);
  const box = inputRef ?? own;
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false);
  // Where the selection was just before each change, so picks move with the text actually edited (#70).
  const selection = useRef<Omit<TextChange, "caret"> | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const remember = () => {
      selection.current = { start: el.selectionStart, end: el.selectionEnd };
    };
    el.addEventListener("beforeinput", remember);
    return () => el.removeEventListener("beforeinput", remember);
  }, [box]);

  // Grow with the text: measure from one line each time, so it shrinks again after a send.
  useLayoutEffect(() => {
    const el = box.current;
    if (!autoGrow || !el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
  }, [autoGrow, value, box]);

  const typing = closed ? null : mentionAt(value, caret);
  const options: MentionOption[] = typing
    ? mentionOptions(typing.query, members, { everyone, me })
    : [];
  const open = options.length > 0;
  const current = Math.min(active, Math.max(0, options.length - 1));
  // The list scrolls past 260px: keep the selected row (with its group's title) in view as arrows move it.
  useLayoutEffect(() => {
    if (!open) return;
    document
      .getElementById(`${listId}-${current}`)
      ?.parentElement?.scrollIntoView({ block: "nearest" });
  }, [open, current, listId]);

  const pick = (option: MentionOption, byKey = false) => {
    if (!typing) return;
    // Picked with Enter: held down, it must not send the half-written message (lib/enterKey).
    if (byKey) latchEnter();
    const next = insertMention(value, typing.start, caret, option);
    onPicks?.(addPick(picks, value, next.text, typing.start, option));
    onChange(next.text);
    setCaret(next.caret);
    setActive(0);
    // Closed until the next keystroke, so the name just written doesn't list itself again.
    setClosed(true);
    requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((current + step + options.length) % options.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(options[current]!, true);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setClosed(true);
        return;
      }
    }
    // An IME still composing (Japanese, Chinese, Korean input) owns Enter.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    // A held Enter, or the press that just picked a suggestion or an emoji, never sends.
    if (event.key === "Enter" && (event.repeat || enterLatched())) {
      if (!event.shiftKey) event.preventDefault();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit?.();
    } else if (
      event.key === "Enter" &&
      enterSends &&
      !event.shiftKey &&
      !event.altKey &&
      !insideCodeFence(value, event.currentTarget.selectionStart ?? value.length)
    ) {
      // Discord's keys: Enter sends, Shift+Enter (or Enter inside a ``` block) makes a new line.
      event.preventDefault();
      onSubmit?.();
    } else if (event.key === "Escape") {
      onCancel?.();
    } else if (event.key === "ArrowUp" && onArrowUpEmpty && value === "") {
      event.preventDefault();
      onArrowUpEmpty();
    }
  };

  return (
    <div className="mention-input">
      <textarea
        ref={box}
        className={autoGrow ? "textarea grow-box" : "textarea"}
        rows={autoGrow ? 1 : undefined}
        style={autoGrow ? undefined : { minHeight }}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${listId}-${current}` : undefined}
        onChange={(event) => {
          const before = selection.current;
          selection.current = null;
          const at = event.target.selectionStart ?? event.target.value.length;
          onPicks?.(
            shiftPicks(
              picks,
              value,
              event.target.value,
              before ? { ...before, caret: at } : undefined,
            ),
          );
          onChange(event.target.value);
          setCaret(at);
          setClosed(false);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      {open ? (
        <div
          className="pop mention-list"
          role="listbox"
          id={listId}
          aria-label="Mention someone"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            setClosed(true);
            box.current?.focus({ preventScroll: true });
          }}
        >
          {options.map((option, i) => {
            // A group's title before its first row: people and agents, then live runs.
            const group = option.kind === "run" ? "Live runs" : "Members";
            const prev = options[i - 1];
            const title = !prev || (prev.kind === "run" ? "Live runs" : "Members") !== group;
            return (
              <div
                key={
                  option.kind === "everyone"
                    ? "everyone"
                    : option.kind === "run"
                      ? `run:${option.runId}`
                      : option.memberId
                }
                role="presentation"
              >
                {title ? (
                  <div className="pop-title" aria-hidden="true">
                    {group}
                  </div>
                ) : null}
                <button
                  id={`${listId}-${i}`}
                  type="button"
                  tabIndex={-1}
                  role="option"
                  aria-selected={i === current}
                  onMouseDown={(event) => {
                    // Keeps the caret in the box.
                    event.preventDefault();
                    pick(option);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  {option.kind === "everyone" ? (
                    <>
                      <span className="mention-at" aria-hidden="true">
                        <Icon name="at" size={14} />
                      </span>
                      <b>everyone</b>
                      <span className="muted">Everyone in this channel</span>
                    </>
                  ) : option.kind === "run" ? (
                    <>
                      <span className="mention-face" aria-hidden="true">
                        <HarnessMark harness="run" />
                      </span>
                      <b className="mention-name">{option.name}</b>
                      {option.detail ? (
                        <span className="muted truncate">{option.detail}</span>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <span className="mention-face" aria-hidden="true">
                        <MemberFace
                          member={{
                            memberId: option.memberId,
                            name: option.name,
                            kind: option.agent ? "agent" : "person",
                          }}
                          size={24}
                        />
                      </span>
                      <b className="mention-name">{option.name}</b>
                      {option.agent ? <span className="tag">Agent</span> : null}
                      {option.detail ? (
                        <span className="muted truncate">{option.detail}</span>
                      ) : null}
                    </>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
