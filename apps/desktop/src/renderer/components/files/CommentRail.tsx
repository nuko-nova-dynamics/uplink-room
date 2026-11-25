import { useEffect, useRef, useState } from "react";
import { Button } from "@ui-sdk/react/button";
import { Textarea } from "@ui-sdk/react/textarea";
import { Toggle, ToggleGroup } from "@ui-sdk/react/toggle";
import type { CommentThread, MemberRow } from "../../lib/api";
import { ago } from "../../lib/format";
import { ConversationFace as MemberFace } from "../chat/ConversationFace";
import { Icon } from "../Icon";
import { Markdown } from "../MessageBody";
import { Tip } from "../Tip";
import { pinLabel, type Pin } from "./pins";
import "./comments.css";

type Author = CommentThread["author"];

function Who({ author, members }: { author: Author; members: MemberRow[] }) {
  return (
    <span className="comment-who">
      <MemberFace member={author} members={members} size={18} />
      <b>{author.name}</b>
      {author.kind === "agent" ? (
        <span className="tag" title="Agents can do at most what the person who added them can.">
          Agent{author.addedBy ? `, added by ${author.addedBy.name}` : ""}
        </span>
      ) : null}
    </span>
  );
}

function Composer({
  placeholder,
  submit,
  onSubmit,
  onCancel,
  autoFocus = false,
}: {
  placeholder: string;
  submit: string;
  onSubmit: (body: string) => Promise<boolean>;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, [autoFocus]);
  useEffect(() => {
    const field = area.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [body]);
  const send = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    if (await onSubmit(body)) setBody("");
    setBusy(false);
  };
  return (
    <div className="comment-composer">
      <Textarea
        ref={area}
        className="textarea"
        rows={2}
        placeholder={placeholder}
        aria-label={placeholder}
        value={body}
        onValueChange={setBody}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send();
          if (event.key === "Escape") onCancel?.();
        }}
      />
      <div className="row-flex">
        <span className="muted hint-keys" title="Comments are Markdown">
          {navigator.platform.includes("Mac") ? "⌘ Enter" : "Ctrl+Enter"} sends
        </span>
        <span className="grow" />
        {onCancel ? (
          <button className="btn ghost" type="button" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        {/* Busy until the comment is sent; ⌘ Enter goes through the same guard. */}
        <Button className="btn primary" disabled={!body.trim() || busy} onClick={send}>
          {submit}
        </Button>
      </div>
    </div>
  );
}

export function CommentRail({
  pinBy,
  pinHint,
  placing,
  onStartPin,
  onCancelPin,
  draft,
  onComment,
  threads,
  status,
  onStatus,
  openCount,
  selected,
  onSelect,
  detached,
  members,
  canDelete,
  onReply,
  onResolve,
  onReopen,
  onDelete,
}: {
  /** How a pin is placed: by clicking the file, by selecting text, or not at all (HTML pages). */
  pinBy: "click" | "select" | "none";
  /** What placing a pin means on this file, such as "Click the PDF where the comment goes." */
  pinHint: string;
  placing: boolean;
  onStartPin: () => void;
  onCancelPin: () => void;
  draft: Pin | null;
  onComment: (pin: Pin, body: string) => Promise<boolean>;
  threads: CommentThread[] | undefined;
  status: "open" | "resolved";
  onStatus: (status: "open" | "resolved") => void;
  openCount: number;
  selected: string | null;
  onSelect: (commentId: string | null) => void;
  detached: ReadonlySet<string>;
  members: MemberRow[];
  canDelete: (thread: { author: Author }) => boolean;
  onReply: (commentId: string, body: string) => Promise<boolean>;
  onResolve: (commentId: string) => void;
  onReopen: (commentId: string) => void;
  onDelete: (commentId: string) => void;
}) {
  const [fileDraft, setFileDraft] = useState(false);
  const wholeFileButton = useRef<HTMLButtonElement>(null);
  const wasFileDraft = useRef(false);
  useEffect(() => {
    if (wasFileDraft.current && !fileDraft) wholeFileButton.current?.focus();
    wasFileDraft.current = fileDraft;
  }, [fileDraft]);
  const pin: Pin | null = draft ?? (fileDraft ? { kind: "file" } : null);
  const selectedEl = useRef<HTMLElement | null>(null);

  useEffect(() => {
    selectedEl.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  return (
    <aside className="comment-rail" aria-label="Comments">
      <div className="rail-head">
        <h2 className="rail-title">Comments</h2>
        <span className="grow" />
        <ToggleGroup
          className="seg surface-seg"
          aria-label="Which comments"
          value={[status]}
          deselectable={false}
          onValueChange={(next) => {
            if (next[0] === "open" || next[0] === "resolved") onStatus(next[0]);
          }}
        >
          <Toggle value="open">
            <span className="surface-label segment-label">
              Open{openCount ? ` ${openCount}` : ""}
            </span>
          </Toggle>
          <Toggle value="resolved">
            <span className="surface-label segment-label">Resolved</span>
          </Toggle>
        </ToggleGroup>
      </div>

      {pin ? (
        <div className="comment-card draft">
          <div className="comment-anchor">
            <Icon name="pin" /> <span className="truncate">{pinLabel(pin)}</span>
          </div>
          <Composer
            placeholder="Write a comment"
            submit="Comment"
            autoFocus
            onSubmit={async (body) => {
              const ok = await onComment(pin, body);
              if (ok) setFileDraft(false);
              return ok;
            }}
            onCancel={() => {
              setFileDraft(false);
              onCancelPin();
            }}
          />
        </div>
      ) : placing ? (
        <div className="rail-note">
          <span className="grow">{pinHint}</span>
          <button className="btn ghost" type="button" onClick={onCancelPin}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="rail-actions">
          {pinBy === "click" ? (
            <button className="btn" type="button" onClick={onStartPin}>
              <Icon name="pin" /> Pin a comment
            </button>
          ) : null}
          <button
            ref={wholeFileButton}
            className="btn ghost"
            type="button"
            onClick={() => setFileDraft(true)}
          >
            <Icon name="comment" /> On the whole file
          </button>
          {pinBy === "select" ? <p className="rail-hint">{pinHint}</p> : null}
        </div>
      )}

      <div className="rail-list">
        {threads === undefined ? null : threads.length === 0 ? (
          <div className="rail-empty">
            {status === "open" ? "No open comments." : "Nothing resolved yet."}
          </div>
        ) : (
          threads.map((thread, index) => {
            const isSelected = thread.commentId === selected;
            const isDetached = detached.has(thread.commentId);
            return (
              <article
                key={thread.commentId}
                ref={isSelected ? (el) => void (selectedEl.current = el) : undefined}
                className={`comment-card ${isSelected ? "selected" : ""}`}
                role="group"
                aria-label={`Comment ${index + 1}`}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (
                    event.target === event.currentTarget &&
                    (event.key === "Enter" || event.key === " ")
                  ) {
                    event.preventDefault();
                    onSelect(isSelected ? null : thread.commentId);
                  }
                }}
                onClick={() => onSelect(isSelected ? null : thread.commentId)}
              >
                <div className="comment-anchor">
                  <span className="pin-n" aria-label={`Comment ${index + 1}`}>
                    {index + 1}
                  </span>
                  <span className="truncate">{pinLabel(thread.pin)}</span>
                  <span className="grow" />
                  <span className="muted">{ago(thread.createdAt)}</span>
                </div>
                <Who author={thread.author} members={members} />
                {isDetached ? (
                  <div className="comment-detached">
                    Detached: this passage is no longer in the doc.
                  </div>
                ) : null}
                <div className="comment-body">
                  <Markdown source={thread.body} wrapLongWords />
                </div>
                {thread.replies.map((reply) => (
                  <div key={reply.commentId} className="comment-reply">
                    <Who author={reply.author} members={members} />
                    <div className="comment-body">
                      <Markdown source={reply.body} wrapLongWords />
                    </div>
                  </div>
                ))}
                {thread.resolvedBy ? (
                  <div className="muted comment-resolved">
                    <Icon name="check" /> Resolved by {thread.resolvedBy.name}
                  </div>
                ) : null}
                {isSelected ? (
                  <div
                    className="comment-actions"
                    role="presentation"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {status === "open" ? (
                      <Composer
                        placeholder="Reply"
                        submit="Reply"
                        onSubmit={(body) => onReply(thread.commentId, body)}
                      />
                    ) : null}
                    <div className="row-flex">
                      {status === "open" ? (
                        <button
                          className="btn"
                          type="button"
                          onClick={() => onResolve(thread.commentId)}
                        >
                          <Icon name="check" /> Resolve
                        </button>
                      ) : (
                        <button
                          className="btn"
                          type="button"
                          onClick={() => onReopen(thread.commentId)}
                        >
                          Reopen
                        </button>
                      )}
                      <span className="grow" />
                      {canDelete(thread) ? (
                        <Tip label="Delete comment">
                          <button
                            className="icon-btn"
                            type="button"
                            aria-label="Delete comment"
                            onClick={() => onDelete(thread.commentId)}
                          >
                            <Icon name="trash" />
                          </button>
                        </Tip>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })
        )}
      </div>
    </aside>
  );
}
