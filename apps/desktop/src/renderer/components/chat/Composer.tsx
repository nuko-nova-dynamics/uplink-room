import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { Checkbox, CheckboxIndicator } from "@ui-sdk/react/checkbox";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@ui-sdk/react/menu";
import { api, type Id } from "../../lib/api";
import {
  encodeMentions,
  putBack,
  shiftPicks,
  type MentionMember,
  type MentionPick,
} from "../../lib/chat";
import {
  fileDrop,
  PendingFileChips,
  PendingFileErrors,
  useFileUploads,
  type Pending,
} from "./FileUploads";
import { latchEnter } from "../../lib/enterKey";
import { TypingLine, useTypingPing } from "./Typing";
import { useAct, useSession } from "../../lib/session";
import { Icon } from "../Icon";
import { Tip } from "../Tip";
import { TaskPicker, type TaskOrRun } from "../TaskPicker";
import { MentionInput } from "./MentionInput";
import { EmojiPicker, pickerPlace } from "./Reactions";

export type ComposerHandle = { addFiles: (files: File[]) => void; focus: () => void };

/** Kept here too: other modules import drag and drop from the composer. */
export { fileDrop };

/** What one send took from the composer, to put back if the room refuses it. */
type Draft = {
  body: string;
  picks: MentionPick[];
  refs: TaskOrRun[];
  files: Pending[];
  format: "markdown" | "html";
  /** Also send to #channel, as it was when this draft was sent: the box resets for the next one at once. */
  alsoSend: boolean;
};

/**
 * Writing a message (spec #63). One box that grows with the text: Enter sends and Shift+Enter
 * makes a new line (⌘↵ also sends), ↑ in the empty box edits your last message, `@` lists
 * teammates, agents, @everyone and the live runs in `members`, and + attaches files, mentions a task or run, or posts an HTML
 * page. Files dropped, pasted or picked upload at once; a file the room would refuse (too large,
 * SVG) is named with the reason before anything is uploaded.
 *
 * A send clears the box at once, so you can keep typing; sends go out one after another, in the
 * order you made them. One the room refuses comes back into the box, ahead of anything typed since.
 */
export function Composer({
  channelId,
  replyTo,
  compact = false,
  members,
  everyone,
  placeholder,
  onEditLast,
  onEscape,
  alsoSendTo,
  onSent,
  notes,
  waiting = false,
  fileNote,
  ref,
}: {
  channelId: Id<"channels">;
  replyTo?: Id<"messages">;
  compact?: boolean;
  members: MentionMember[];
  everyone: boolean;
  placeholder?: string;
  /** ↑ in the empty box. */
  onEditLast?: () => void;
  /** Escape in the empty box (the channel: mark it read). */
  onEscape?: () => void;
  /** A reply's composer: where "Also send to" puts the reply too, such as "#general". */
  alsoSendTo?: string;
  /** After the room took a message from this composer. */
  onSent?: () => void;
  /**
   * Standing lines above the box, such as a direct message's warning that the whole team sees a
   * run's output (ADR 0039): said once, where the writing happens, never asked on each send.
   */
  notes?: readonly string[];
  /**
   * The place's details haven't loaded, so whether it has `notes` isn't known yet: sending waits,
   * and you can still write. A reply opened from a link can load before its channel does.
   */
  waiting?: boolean;
  /**
   * Said under the attached files once there are some: how they reach a run that takes none with a
   * message (ADR 0043), such as Claude Code in a terminal, which gets saved copies.
   */
  fileNote?: string | undefined;
  ref?: Ref<ComposerHandle>;
}) {
  const session = useSession();
  const post = useAct(api.messages.post);
  const typingPing = useTypingPing(channelId, replyTo);
  const [body, setBody] = useState("");
  const [alsoSend, setAlsoSend] = useState(false);
  const [picks, setPicks] = useState<MentionPick[]>([]);
  const [format, setFormat] = useState<"markdown" | "html">("markdown");
  const [refs, setRefs] = useState<TaskOrRun[]>([]);
  const [menu, setMenu] = useState<"closed" | "plus" | "tasks" | "emoji">("closed");
  const { pending, setPending, addFiles, removeFile, dropThumbs, ready, uploading } =
    useFileUploads();
  const fileInput = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const plusButton = useRef<HTMLButtonElement>(null);
  const emojiButton = useRef<HTMLButtonElement>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [emojiPlace, setEmojiPlace] = useState<ReturnType<typeof pickerPlace> | null>(null);

  useImperativeHandle(ref, () => ({ addFiles, focus: () => box.current?.focus() }));

  const canSend = !waiting && !uploading && (body.trim().length > 0 || ready.length > 0);

  const latest = useRef({ body, picks });
  latest.current = { body, picks };

  /** Puts a refused send back, ahead of whatever was typed since. */
  const restore = (draft: Draft) => {
    const back = putBack(draft, latest.current);
    setBody(back.body);
    setPicks(back.picks);
    setRefs((all) => [...draft.refs, ...all.filter((r) => !draft.refs.some((d) => d.id === r.id))]);
    setPending((all) => [...draft.files, ...all]);
    if (draft.format === "html") setFormat("html");
    if (draft.alsoSend) setAlsoSend(true);
  };

  const send = () => {
    if (!canSend) return;
    const draft: Draft = {
      body,
      picks,
      refs,
      files: ready,
      format,
      alsoSend: Boolean(replyTo && alsoSend),
    };
    setBody("");
    setAlsoSend(false);
    setPicks([]);
    setRefs([]);
    // What it sends goes; so does any refused file's note.
    setPending((all) => all.filter((p) => !ready.includes(p) && p.status !== "failed"));
    setFormat("markdown");
    setMenu("closed");
    const {
      body: text,
      memberIds,
      runIds,
      mentionEveryone,
    } = draft.format === "markdown"
      ? encodeMentions(draft.body, members, draft.picks)
      : { body: draft.body, memberIds: [], runIds: [], mentionEveryone: false };
    queue.current = queue.current.then(async () => {
      const result = await post({
        channelId,
        body: text,
        format: draft.format,
        ...(replyTo ? { replyTo } : {}),
        ...(draft.alsoSend ? { alsoInChannel: true } : {}),
        mentionedTasks: draft.refs.filter((m) => m.kind === "task").map((m) => m.id as Id<"tasks">),
        mentionedRuns: draft.refs.filter((m) => m.kind === "run").map((m) => m.id as Id<"runs">),
        ...(memberIds.length ? { mentionedMembers: memberIds as Id<"members">[] } : {}),
        // Live runs it is for (ADR 0029 D1): their tokens are in the body too.
        ...(runIds.length ? { addressedRuns: runIds as Id<"runs">[] } : {}),
        ...(mentionEveryone && everyone ? { mentionEveryone: true } : {}),
        ...(draft.files.length ? { attachments: draft.files.map((p) => p.uploaded!) } : {}),
        // The warning shows above the box, so this send was written under it (ADR 0039, amended 2026-11-05).
        ...(notes?.length ? { acknowledgeWarning: true } : {}),
      });
      if (result === undefined) restore(draft);
      else {
        dropThumbs(draft.files);
        onSent?.();
      }
    });
  };

  /** Puts an emoji where the caret is, keeping mentions picked after it. */
  const insertEmoji = (emoji: string, byKey = false) => {
    // Picked with Enter: held, it must not go on to send the draft (lib/enterKey).
    if (byKey) latchEnter();
    const el = box.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const next = `${body.slice(0, start)}${emoji}${body.slice(end)}`;
    setPicks(shiftPicks(picks, body, next, { start, end, caret: start + emoji.length }));
    setBody(next);
    setMenu("closed");
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  };

  const words = placeholder ?? (replyTo ? "Reply" : "Message");
  return (
    <div className={`composer ${compact ? "compact" : ""}`} {...fileDrop(addFiles)}>
      <TypingLine channelId={channelId} replyTo={replyTo} />
      {notes?.map((note) => (
        <p key={note} className="output-warn composer-note">
          <Icon name="eye" size={14} />
          <span>{note}</span>
        </p>
      ))}
      <div className={`composer-box ${format === "html" ? "html" : ""}`}>
        {refs.length > 0 || pending.some((p) => p.status !== "failed") ? (
          <ul className="pending-files" aria-label="Attached to this message">
            {refs.map((m) => (
              <li key={m.id} className="pending-file ready">
                <Icon name={m.kind === "task" ? "board" : "terminal"} size={14} />
                <span className="truncate">{m.label}</span>
                <button
                  className="icon-btn"
                  type="button"
                  aria-label={`Remove ${m.label}`}
                  onClick={() => setRefs((all) => all.filter((x) => x.id !== m.id))}
                >
                  <Icon name="close" size={14} />
                </button>
              </li>
            ))}
            <PendingFileChips pending={pending} onRemove={removeFile} />
          </ul>
        ) : null}
        {fileNote && pending.some((p) => p.status !== "failed") ? (
          <p className="hint composer-file-note">{fileNote}</p>
        ) : null}
        <PendingFileErrors pending={pending} onRemove={removeFile} />
        <div className="composer-line">
          <div className="composer-tool">
            <Menu
              open={menu === "plus"}
              onOpenChange={(open, details) => {
                if (open) {
                  setMenu("plus");
                  return;
                }
                setMenu((m) => (m === "plus" ? "closed" : m));
                // Its items put focus where they lead (the task list, the box); Escape comes back here.
                if (details.reason === "escape-key") plusButton.current?.focus();
              }}
            >
              <Tip label="Attach, mention a task, post HTML">
                <MenuTrigger
                  ref={plusButton}
                  className="icon-btn"
                  aria-label="More: attach files, mention a task or run, post an HTML page"
                >
                  <Icon name="plus" size={16} />
                </MenuTrigger>
              </Tip>
              <MenuContent
                className="pop composer-menu"
                side="top"
                align="start"
                sideOffset={6}
                collisionPadding={8}
                finalFocus="none"
              >
                <MenuItem
                  render={(props) => <button {...props} type="button" />}
                  onSelect={() => {
                    setMenu("closed");
                    fileInput.current?.click();
                  }}
                >
                  <Icon name="paperclip" size={16} /> Attach files
                </MenuItem>
                <MenuItem
                  render={(props) => <button {...props} type="button" />}
                  onSelect={() => setMenu("tasks")}
                >
                  <Icon name="board" /> Mention a task or run
                </MenuItem>
                <MenuItem
                  render={(props) => <button {...props} type="button" />}
                  onSelect={() => {
                    setMenu("closed");
                    setFormat((f) => (f === "html" ? "markdown" : "html"));
                    box.current?.focus();
                  }}
                >
                  <Icon name="doc" /> {format === "html" ? "Back to Markdown" : "Post an HTML page"}
                </MenuItem>
              </MenuContent>
            </Menu>
            {menu === "tasks" ? (
              <TaskPicker
                focus
                className="composer-menu tasks"
                title="Mention a task or run"
                empty="No tasks yet."
                onClose={() => setMenu("closed")}
                onPick={(item) => {
                  setRefs((all) => (all.some((m) => m.id === item.id) ? all : [...all, item]));
                  setMenu("closed");
                  box.current?.focus();
                }}
              />
            ) : null}
          </div>
          {format === "html" ? (
            <span className="composer-mode">
              HTML page
              <Tip label="Back to Markdown">
                <button
                  className="icon-btn"
                  type="button"
                  aria-label="Back to Markdown"
                  onClick={() => setFormat("markdown")}
                >
                  <Icon name="close" size={14} />
                </button>
              </Tip>
            </span>
          ) : null}
          <MentionInput
            inputRef={box}
            value={body}
            onChange={(next) => {
              setBody(next);
              if (format === "markdown") typingPing(next);
            }}
            picks={picks}
            onPicks={setPicks}
            members={members}
            me={session.me.memberId}
            everyone={everyone && format === "markdown"}
            autoGrow
            enterSends={format === "markdown"}
            onArrowUpEmpty={onEditLast}
            onCancel={() => body === "" && onEscape?.()}
            label={replyTo ? "Reply" : "Message"}
            placeholder={format === "html" ? "Paste an HTML page. ⌘↵ posts it." : words}
            onSubmit={send}
            onPaste={(event) => {
              const files = [...event.clipboardData.files];
              if (files.length === 0) return;
              event.preventDefault();
              addFiles(files);
            }}
          />
          <div className="composer-tool">
            <Tip label="Emoji">
              <button
                ref={emojiButton}
                className="icon-btn"
                type="button"
                aria-label="Add an emoji"
                aria-expanded={menu === "emoji"}
                onClick={(event) => {
                  // Above the composer (below has no room), inside its column (the Replies panel can be
                  // 300 px wide), and as tall as the window above it allows.
                  const button = event.currentTarget.getBoundingClientRect();
                  const column = event.currentTarget
                    .closest(".channel-col")
                    ?.getBoundingClientRect();
                  if (column)
                    setEmojiPlace(
                      pickerPlace(button, column, {
                        width: window.innerWidth,
                        height: window.innerHeight,
                      }),
                    );
                  setMenu((m) => (m === "emoji" ? "closed" : "emoji"));
                }}
              >
                <Icon name="smile" size={16} />
              </button>
            </Tip>
            {menu === "emoji" ? (
              <EmojiPicker
                className="above"
                place={emojiPlace}
                anchor={emojiButton.current}
                onClose={() => setMenu("closed")}
                onPick={insertEmoji}
              />
            ) : null}
          </div>
          <Tip
            label={
              uploading
                ? "Waiting for the upload"
                : waiting
                  ? "Loading the conversation"
                  : replyTo
                    ? "Reply"
                    : "Send"
            }
          >
            <button
              className="icon-btn composer-send"
              type="button"
              disabled={!canSend}
              aria-label={replyTo ? "Reply" : "Send"}
              onClick={send}
            >
              <Icon name="arrow-up" size={16} />
            </button>
          </Tip>
        </div>
        {replyTo && alsoSendTo ? (
          <label className="also-send">
            <Checkbox
              checked={alsoSend}
              onCheckedChange={(checked) => setAlsoSend(checked === true)}
            >
              <CheckboxIndicator>
                <Icon name="check" size={12} />
              </CheckboxIndicator>
            </Checkbox>
            <span className="truncate">Also send to {alsoSendTo}</span>
          </label>
        ) : null}
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          aria-label="Attach files"
          onChange={(event) => {
            addFiles([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
