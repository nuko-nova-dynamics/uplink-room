import { useEffect, useRef, useState } from "react";
import { Button } from "@ui-sdk/react/button";
import { Separator } from "@ui-sdk/react/separator";
import { decodeWithPicks, encodeMentions, type MentionMember } from "../../lib/chat";
import { MentionInput } from "./MentionInput";

/**
 * Editing a message in place (spec #63): the box opens with the message's text, mentions shown as
 * @Name and kept as the members they name; Enter (or ⌘↵) saves, Shift+Enter makes a new line, and
 * Escape cancels. An HTML page keeps Enter for new lines and saves with ⌘↵. Saving the same text, or
 * nothing at all, changes nothing; to take a message back, delete it. An HTML message is edited as
 * written: as in the composer, its mentions aren't decoded or encoded, so an @ in it stays text.
 */
export function InlineEditor({
  body,
  format = "markdown",
  members,
  addressedRuns,
  me,
  everyone,
  onSave,
  onCancel,
}: {
  /** The stored body, with `<@memberId>` mentions. */
  body: string;
  /** The message's format; only Markdown carries mentions. */
  format?: "markdown" | "html";
  members: MentionMember[];
  /** The runs the message already addresses: a mention of one that ends while editing keeps it. */
  addressedRuns?: readonly string[] | undefined;
  me?: string;
  everyone: boolean;
  /** Gets the body to store (mentions as `<@memberId>`). Resolves true once saved; the editor closes then. */
  onSave: (body: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const html = format === "html";
  const [opened] = useState(() => {
    if (html) return { text: body, picks: [] };
    const names = new Map(members.map((m) => [m.memberId, m.name]));
    return decodeWithPicks(body, (id) => names.get(id));
  });
  const initial = opened.text;
  const [text, setText] = useState(initial);
  const [picks, setPicks] = useState(opened.picks);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const changed = text.trim() !== initial.trim();
  const save = async () => {
    if (!changed) return onCancel();
    if (!text.trim()) return;
    setBusy(true);
    const done = await onSave(
      html ? text : encodeMentions(text, members, picks, { kept: addressedRuns }).body,
    );
    setBusy(false);
    if (done) onCancel();
  };
  return (
    <div className="inline-editor">
      <MentionInput
        inputRef={box}
        value={text}
        onChange={setText}
        picks={picks}
        onPicks={setPicks}
        members={members}
        me={me}
        everyone={everyone && !html}
        label="Edit message"
        minHeight={56}
        autoGrow={!html}
        enterSends={!html}
        onSubmit={() => void save()}
        onCancel={onCancel}
      />
      <div className="composer-row">
        <span className="muted edit-keys">
          {html ? "⌘↵ saves, Escape cancels" : "Enter saves, Escape cancels"}
        </span>
        <span className="grow" />
        <button className="btn ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
        <Button
          className="btn primary"
          type="button"
          disabled={busy || !text.trim()}
          onClick={() => save()}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

/**
 * The line above the first message you hadn't read when you opened the channel. When that message
 * also starts a day, the one line carries the day too, rather than two rules a few pixels apart.
 */
export function NewDivider({ day }: { day?: string | undefined } = {}) {
  return (
    <Separator className="new-divider" aria-label={day ? `${day}, new messages` : "New messages"}>
      {day ? <span className="new-day">{day}</span> : null}
      <span>New</span>
    </Separator>
  );
}
