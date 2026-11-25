import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Button } from "@ui-sdk/react/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@ui-sdk/react/menu";
import { Toggle } from "@ui-sdk/react/toggle";
import { Toolbar, ToolbarButton } from "@ui-sdk/react/toolbar";
import { api, type Id, type MessageRow } from "../../lib/api";
import {
  decodeMentions,
  emojiOnly,
  questionChoices,
  wroteIt,
  type MentionMember,
} from "../../lib/chat";
import type { FunctionReturnType } from "convex/server";
import { clock, formatTime, runLabel } from "../../lib/format";
import { useAct, useRoomQuery, useSession, useToast } from "../../lib/session";
import { copyText } from "../../lib/clipboard";
import { messageLink } from "../../lib/deepLinks";
import type { Nav } from "../../Shell";
import { Dialog } from "../Dialog";
import { HarnessMark, StateIcon } from "../Faces";
import { ConversationFace as MemberFace } from "./ConversationFace";
import { colorPair } from "../../characters/CharacterView";
import { Icon } from "../Icon";
import { Tip } from "../Tip";
import { MessageBody, type MentionNames } from "../MessageBody";
import { Attachments, LinkPreviews } from "./Attachments";
import { InlineEditor } from "./InlineEditor";
import { EmojiPicker, pickerPlace, ReactionChips, type PickerPlace } from "./Reactions";
import { useNow } from "../useNow";
import { Deliveries } from "./Deliveries";

/**
 * How a list lays its messages out: rows (true), every message on the left under its author's face
 * and name with no bubble; bubbles (false), yours on the right, as Grok Bot and Muse do, which every
 * conversation uses (DESIGN.md, Conversations).
 */
export const MessageRows = createContext(false);

/** A time without its day, for a message under a day separator that already names the day. */
function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** A time without its day, and without AM/PM, for the gutter beside a run's later messages. */
function gutterTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
    .formatToParts(at)
    .filter((p) => p.type !== "dayPeriod")
    .map((p) => p.value)
    .join("")
    .trim();
}

/**
 * One message (spec #63): its author, body with mentions, reactions, attachments, link previews,
 * replies and pin, and on hover the actions you may take on it (react, reply, pin, edit, delete).
 * A later message in its author's run (`continued`) leaves out the face, name and time; the time
 * shows in the gutter on hover.
 */
export function MessageItem({
  message,
  nav,
  members,
  everyone,
  highlight = false,
  inReplies = false,
  inPins = false,
  continued = false,
  dayShown = false,
  threadOpen = false,
  readSeq,
  newReplies,
  editing: editingProp,
  onEditingChange,
  onReply,
  onJump,
  onMarkUnread,
  onOpenThread,
  runLatest = false,
}: {
  message: MessageRow;
  nav: Nav;
  members: MentionMember[];
  /** Whether @everyone may be written here (people only). */
  everyone: boolean;
  highlight?: boolean;
  inReplies?: boolean;
  /** In the Pinned panel, which says who pinned it below each message. */
  inPins?: boolean;
  /** A later message in its author's run. */
  continued?: boolean;
  /** A day separator above names its day, so the time goes without the date (the date is in its tooltip). */
  dayShown?: boolean;
  /** Its thread is open in the Replies panel beside the list. */
  threadOpen?: boolean;
  /** Where you have read the channel up to: a thread with a newer reply is marked new. */
  readSeq?: number | undefined;
  /** How many of its replies you haven't read (messages.unreadThreads): a count, and whether there are more. */
  newReplies?: { count: number; more: boolean } | undefined;
  /** Whether it is being edited, when the channel decides (↑ in the composer edits your last). */
  editing?: boolean | undefined;
  onEditingChange?: ((editing: boolean) => void) | undefined;
  onReply?: () => void;
  /** Opens another message in this channel (a pin line's target). */
  onJump?: (messageId: Id<"messages">) => void;
  /** Mark the channel unread from this message on (the channel's list only). */
  onMarkUnread?: () => void;
  /** Opens a thread in Replies: where an agent's work went after its thread proposal was accepted. */
  onOpenThread?: (rootId: Id<"messages">) => void;
  /** For an agent's message: whether it is its run's newest in its list (latestOfRuns), so it shows the run's live state. Off elsewhere, such as Pins. */
  runLatest?: boolean;
}) {
  const session = useSession();
  const me = session.me.memberId;
  const projects = useRoomQuery(api.projects.list, {});
  const rows = useContext(MessageRows);
  // An agent's answer over A2A: its run's state shows on the message (working, waiting on you).
  const agentRun = useRoomQuery(
    api.runs.get,
    message.a2a && message.deletedAt === undefined ? { runId: message.a2a.runId } : "skip",
  );
  const react = useAct(api.messages.react);
  const unreact = useAct(api.messages.unreact);
  const edit = useAct(api.messages.edit);
  const remove = useAct(api.messages.delete);
  const pin = useAct(api.messages.pin);
  const unpin = useAct(api.messages.unpin);
  const hidePreview = useAct(api.messages.hidePreview);
  const askLink = useAct(api.messages.attachmentLink);
  const attachmentLink = useCallback(
    async (index: number, download: boolean) =>
      await askLink({ messageId: message.messageId, attachmentIndex: index, download }),
    [askLink, message.messageId],
  );
  const saveAttachment = useAct(api.files.saveAttachment, {
    success: "Saved to the project's files.",
  });
  const [ownEditing, setOwnEditing] = useState(false);
  const editing = editingProp ?? ownEditing;
  const setEditing = onEditingChange ?? setOwnEditing;
  const [picker, setPicker] = useState(false);
  const [more, setMore] = useState(false);
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  // The reaction picker opens below the action bar, or above it when the window has more room
  // there, in the top layer so a short pane never clips it (pickerPlace).
  const [place, setPlace] = useState<PickerPlace | null>(null);
  const actions = useRef<HTMLDivElement>(null);
  // The More menu is a UI SDK Menu in the top layer: under the bar, or above it near the bottom
  // of the list, and the list never clips its lower actions (Copy link, Delete).
  const moreButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (!confirm && wasConfirming.current) moreButton.current?.focus();
    wasConfirming.current = confirm;
  }, [confirm]);
  const openPicker = () => {
    const bar = actions.current?.getBoundingClientRect();
    const listEl = actions.current?.closest<HTMLElement>(".messages");
    const list = listEl?.getBoundingClientRect();
    // Within the list's width (without its scrollbar), so it covers this column, not the next.
    if (bar && list && listEl) {
      const column = {
        left: list.left,
        right: list.left + listEl.clientLeft + listEl.clientWidth,
        top: list.top,
      };
      setPlace(pickerPlace(bar, column, { width: window.innerWidth, height: window.innerHeight }));
    }
    setPicker((p) => !p);
  };

  // Members and live runs by id (they never collide), and the runs this message was for, each with
  // the name the room gives it now (ADR 0026): an ended run is still named in its old messages.
  const nameOf = useMemo(() => {
    const names = new Map(members.map((m) => [m.memberId, m.name]));
    for (const run of message.addressedRuns ?? []) names.set(run.runId, run.label);
    return (id: string) => names.get(id);
  }, [members, message.addressedRuns]);
  // Channels a `#name` can open: team channels and private ones you're in, not direct messages.
  const channelList = useRoomQuery(api.channels.list, {});
  const channels = useMemo(
    () =>
      new Map(
        (channelList ?? [])
          .filter((c) => c.kind !== "direct")
          .map((c) => [c.name.toLowerCase(), c.channelId as string]),
      ),
    [channelList],
  );
  const mentions = useMemo<MentionNames>(
    () => ({ nameOf, runName: nameOf, me, channels }),
    [nameOf, me, channels],
  );
  const openChannel = useCallback(
    (channelId: string) => nav.go({ name: "channel", channelId: channelId as Id<"channels"> }),
    [nav],
  );
  const openRun = useCallback(
    (runId: string) => nav.openRun({ runId: runId as Id<"runs"> }),
    [nav],
  );
  const author = message.author;
  const id = message.messageId;
  // Posted by a live run as itself (ADR 0029 D2): the author is its driver then, who answers for it.
  const asRun = message.asRun;
  const speaker = asRun ? asRun.label : author.name;
  const runTask = asRun
    ? members.find((m) => m.kind === "run" && m.memberId === asRun.runId)?.task
    : undefined;

  if (message.system?.kind === "run") {
    // What happened to an agent's run that the agent didn't say itself (ADR 0024), with the run.
    const line = message.system;
    return (
      <div
        className={`system-line run-line ${line.tone} ${highlight ? "highlight" : ""}`}
        data-message={id}
      >
        <Icon name={line.tone === "warn" ? "alert" : "terminal"} size={14} />
        <span className="truncate" title={line.text}>
          {line.text}
        </span>
        <RunLink runId={line.runId} nav={nav} label="Open run" />
        <span className="muted">{formatTime(message.postedAt)}</span>
      </div>
    );
  }

  if (message.system) {
    const pinned = message.system;
    return (
      <div className={`system-line ${highlight ? "highlight" : ""}`} data-message={id}>
        <Icon name="pushpin" size={14} />
        <span>
          <b>{author.name}</b> pinned{" "}
          {onJump ? (
            <button className="link-btn" type="button" onClick={() => onJump(pinned.messageId)}>
              a message
            </button>
          ) : (
            "a message"
          )}
        </span>
        <span className="muted">{formatTime(message.postedAt)}</span>
      </div>
    );
  }

  const newReply =
    (newReplies?.count ?? 0) > 0 ||
    (message.lastReplySeq !== undefined && readSeq !== undefined && message.lastReplySeq > readSeq);
  const repliesButton =
    !inReplies && onReply && message.replyCount > 0 ? (
      <div className="msg-foot">
        <button
          className={`btn ghost replies-btn ${newReply ? "has-new" : ""}`}
          type="button"
          onClick={onReply}
        >
          {message.repliers?.length ? (
            <span className="replier-faces" aria-hidden="true">
              {message.repliers.map((r) => (
                <MemberFace key={r.memberId} member={r} members={session.members} size={18} />
              ))}
            </span>
          ) : (
            <Icon name="reply" />
          )}{" "}
          {message.replyCount} repl{message.replyCount === 1 ? "y" : "ies"}
          {message.lastReplyAt !== undefined ? (
            <span className="muted replies-last">Last reply {formatTime(message.lastReplyAt)}</span>
          ) : null}
          {newReply ? (
            <span className="new-tag">
              {newReplies?.count ? `${newReplies.count}${newReplies.more ? "+" : ""} new` : "New"}
            </span>
          ) : null}
        </button>
      </div>
    ) : null;

  if (message.deletedAt !== undefined) {
    return (
      <div
        className={`msg deleted ${highlight ? "highlight" : ""}`}
        data-message={id}
        data-seq={message.seq}
      >
        <span className="msg-face-gap" />
        <div>
          <div className="muted deleted-line">
            <Icon name="trash" size={14} /> Message deleted
          </div>
          {repliesButton}
        </div>
      </div>
    );
  }

  // A run you drive posts under you (ADR 0029 D2), but it isn't yours: it names itself, stays on
  // the left, and can be a message for you. You may still delete it, as you answer for it.
  const mine = wroteIt(message, me);
  const authored = author.memberId === me;
  // The Pinned panel keeps every message on the left: it's a list of pins, not a conversation.
  const right = mine && !inPins && !rows;
  const authorCharacter =
    author.kind === "agent"
      ? session.members.find((m) => m.memberId === author.memberId)?.character
      : undefined;
  const agentTone = authorCharacter ? colorPair(authorCharacter.color) : undefined;
  // A run this message was sent to over A2A shows on the agent's answer instead (ADR 0024).
  const sentTo = new Set<string>(message.a2aRuns ?? []);
  const runChips = message.mentionedRuns.filter(
    (runId) => !sentTo.has(runId) && runId !== message.a2a?.runId,
  );
  // Your own @everyone isn't a message for you (the room agrees; this also covers an older room).
  const forMe = message.mentionsMe && !mine;
  const mayDelete = authored || session.isAdmin || author.addedBy?.memberId === me;
  const mayUnpin = message.pinned && (message.pinned.by.memberId === me || session.isAdmin);
  const toggle = (emoji: string, reacted: boolean) =>
    void (reacted ? unreact({ messageId: id, emoji }) : react({ messageId: id, emoji }));

  return (
    <div
      className={`msg ${continued ? "cont" : ""} ${mine ? "mine" : ""} ${right ? "right" : ""} ${rows ? "rows" : ""} ${agentTone ? "agent-msg" : ""} ${forMe ? "mentioned" : ""} ${highlight ? "highlight" : ""} ${threadOpen ? "thread-open" : ""} ${runLatest && agentRun?.state === "waiting" ? "asking" : ""}`}
      data-message={id}
      data-seq={message.seq}
      style={
        agentTone
          ? ({ "--agent-tone": agentTone.c1, "--agent-shade": agentTone.c2 } as CSSProperties)
          : undefined
      }
    >
      {/* Your own messages sit on the right with no face or name, as in Messages and Grok Bot. */}
      {right ? null : continued ? (
        <time
          className="msg-gutter-time"
          dateTime={new Date(message.postedAt).toISOString()}
          title={new Date(message.postedAt).toLocaleString()}
        >
          {gutterTime(message.postedAt)}
        </time>
      ) : asRun ? (
        <HarnessMark harness="run" size={28} title={asRun.label} />
      ) : (
        <MemberFace member={author} members={session.members} size={28} />
      )}
      <div className="msg-body" style={{ minWidth: 0 }}>
        {message.threadOf && !inReplies && onReply ? (
          <Tip label="Open the thread">
            <button className="thread-ref" type="button" onClick={onReply}>
              <Icon name="reply" size={14} />
              <span className="muted">Replied to a thread:</span>
              <b>{message.threadOf.author.name}</b>
              <span className="truncate muted">
                {message.threadOf.excerpt
                  ? decodeMentions(message.threadOf.excerpt, nameOf)
                  : "Message deleted"}
              </span>
            </button>
          </Tip>
        ) : null}
        {continued ? null : (
          <div className="msg-head">
            {asRun ? (
              <>
                <Tip label="Open the run">
                  <button
                    className="msg-run-name"
                    type="button"
                    onClick={() => openRun(asRun.runId)}
                  >
                    <b>{asRun.label}</b>
                  </button>
                </Tip>
                <span
                  className="tag"
                  title={`${author.name} drove this run when it posted, so they answer for what it says.`}
                >
                  Run, {author.name} answers for it
                </span>
                {runTask ? <span className="muted truncate msg-run-task">{runTask}</span> : null}
              </>
            ) : right ? null : (
              // An agent's name in its character's color, so its messages read as its own at a glance.
              <b
                className={agentTone ? "agent-name" : undefined}
                style={
                  agentTone
                    ? ({
                        "--agent-tone": agentTone.c1,
                        "--agent-shade": agentTone.c2,
                      } as CSSProperties)
                    : undefined
                }
              >
                {author.name}
              </b>
            )}
            {author.kind === "agent" && !asRun ? (
              <span
                className="tag"
                title={
                  author.addedBy
                    ? `Agent, added by ${author.addedBy.name}. It can do at most what ${author.addedBy.name} can.`
                    : "Agents can do at most what the person who added them can."
                }
              >
                Agent
              </span>
            ) : null}
            <time
              className="muted"
              dateTime={new Date(message.postedAt).toISOString()}
              title={new Date(message.postedAt).toLocaleString()}
            >
              {dayShown ? clockTime(message.postedAt) : formatTime(message.postedAt)}
            </time>
            {message.pinned && !inPins ? (
              <span className="muted" title={`Pinned by ${message.pinned.by.name}`}>
                <Icon name="pushpin" size={14} /> Pinned
              </span>
            ) : null}
          </div>
        )}
        {editing ? (
          <InlineEditor
            body={message.body}
            format={message.format}
            members={members}
            addressedRuns={message.addressedRuns?.map((r) => r.runId)}
            me={me}
            everyone={everyone}
            onCancel={() => setEditing(false)}
            onSave={async (body) => (await edit({ messageId: id, body })) !== undefined}
          />
        ) : message.body.trim() ? (
          <div className="bubble-line">
            <div
              className={`bubble ${message.format === "html" ? "has-frame" : ""} ${message.format === "markdown" && emojiOnly(message.body) ? "jumbo" : ""}`}
              style={message.format === "html" ? { width: "min(720px, 100%)" } : undefined}
            >
              <MessageBody
                key={message.body}
                format={message.format}
                body={message.body}
                title={`Message from ${speaker}`}
                mentions={mentions}
                editedAt={message.editedAt}
                onChannel={openChannel}
                onRun={openRun}
              />
            </div>
            {message.format === "html" && message.editedAt !== undefined ? (
              <span
                className="muted msg-edited"
                title={`Edited ${new Date(message.editedAt).toLocaleString()}`}
              >
                (edited)
              </span>
            ) : null}
          </div>
        ) : null}
        <Attachments
          from={{ name: author.name, at: message.postedAt }}
          attachments={message.attachments}
          link={attachmentLink}
          projects={projects?.map((p) => ({ projectId: p.projectId, name: p.name }))}
          onSave={(index, projectId) =>
            void saveAttachment({
              messageId: id,
              attachmentIndex: index,
              projectId: projectId as Id<"projects">,
            })
          }
        />
        <LinkPreviews
          previews={message.previews}
          onHide={authored ? () => void hidePreview({ messageId: id }) : undefined}
        />
        <ReactionChips
          reactions={message.reactions}
          onToggle={toggle}
          onAdd={openPicker}
          readOnly={inPins}
        />
        {message.a2a?.proposal ? (
          <ThreadProposal
            messageId={id}
            agent={author.name}
            proposal={message.a2a.proposal}
            onOpenThread={onOpenThread}
          />
        ) : null}
        <Deliveries deliveries={message.deliveries ?? []} />
        {message.mentionedTasks.length + runChips.length > 0 ? (
          <div className="msg-foot">
            {message.mentionedTasks.map((taskId) => (
              <TaskMention key={taskId} taskId={taskId} onOpen={() => nav.openTask(taskId)} />
            ))}
            {runChips.map((runId) => (
              <RunMention key={runId} runId={runId} nav={nav} />
            ))}
          </div>
        ) : null}
        {/* An agent's message over A2A: its run's state while live, and a quiet link to its details. */}
        {message.a2a && runLatest ? (
          <AgentRunLine
            run={agentRun ?? undefined}
            agent={author.name}
            question={decodeMentions(message.body, nameOf)}
            nav={nav}
          />
        ) : null}
        {runLatest && agentRun?.a2a?.artifacts.length ? (
          <AgentResults artifacts={agentRun.a2a.artifacts} />
        ) : null}
        {repliesButton}
      </div>

      {editing ? null : (
        <Toolbar
          ref={actions}
          className={picker || more ? "msg-actions picking" : "msg-actions"}
          aria-label={`Actions for ${speaker}'s message`}
        >
          <Tip label="More reactions">
            <ToolbarButton className="icon-btn" aria-label="React" onClick={openPicker}>
              <Icon name="smile" />
            </ToolbarButton>
          </Tip>
          {!inReplies && onReply ? (
            <Tip label="Reply">
              <ToolbarButton className="icon-btn" aria-label="Reply" onClick={onReply}>
                <Icon name="reply" />
              </ToolbarButton>
            </Tip>
          ) : null}
          {agentRun ? (
            <Tip label="Run details">
              <ToolbarButton
                className="icon-btn"
                aria-label="Run details"
                onClick={() => nav.openRun(agentRun)}
              >
                <Icon name="terminal" />
              </ToolbarButton>
            </Tip>
          ) : null}
          {message.pinned ? (
            mayUnpin ? (
              <Tip label="Unpin">
                <Toggle
                  className="icon-btn"
                  aria-label="Unpin"
                  pressed
                  onPressedChange={(pressed) => {
                    if (!pressed) void unpin({ messageId: id });
                  }}
                >
                  <Icon name="pushpin" />
                </Toggle>
              </Tip>
            ) : null
          ) : (
            <Tip label="Pin to the channel">
              <ToolbarButton
                className="icon-btn"
                aria-label="Pin"
                onClick={() => void pin({ messageId: id })}
              >
                <Icon name="pushpin" />
              </ToolbarButton>
            </Tip>
          )}
          {authored ? (
            <Tip label="Edit">
              <ToolbarButton
                className="icon-btn"
                aria-label="Edit"
                onClick={() => setEditing(true)}
              >
                <Icon name="edit" />
              </ToolbarButton>
            </Tip>
          ) : null}
          <Menu open={more} onOpenChange={(open) => setMore(open)}>
            <Tip label="More">
              <ToolbarButton
                render={<MenuTrigger ref={moreButton} />}
                className="icon-btn"
                aria-label="More actions"
              >
                <Icon name="more" />
              </ToolbarButton>
            </Tip>
            <MenuContent
              className="pop msg-more"
              side="bottom"
              align="end"
              sideOffset={4}
              collisionPadding={8}
            >
              {onMarkUnread ? (
                <MenuItem
                  render={(props) => <button {...props} type="button" />}
                  onSelect={() => onMarkUnread()}
                >
                  <Icon name="inbox" /> Mark unread from here
                </MenuItem>
              ) : null}
              {message.body.trim() && message.format === "markdown" ? (
                <MenuItem
                  render={(props) => <button {...props} type="button" />}
                  onSelect={() => void copyText(decodeMentions(message.body, nameOf))}
                >
                  <Icon name="copy" /> Copy text
                </MenuItem>
              ) : null}
              <MenuItem
                render={(props) => <button {...props} type="button" />}
                onSelect={() => {
                  copyText(messageLink(session.teamId, message.channelId, id)).then(
                    () =>
                      toast.show(
                        "Link copied. It opens this message for anyone in the channel.",
                        true,
                      ),
                    () => toast.show("Couldn't copy the link."),
                  );
                }}
              >
                <Icon name="link" /> Copy link to message
              </MenuItem>
              {mayDelete ? (
                <>
                  <MenuSeparator className="sep" />
                  <Tip label="Shift-click deletes without asking" side="right">
                    <MenuItem
                      render={(props) => <button {...props} type="button" />}
                      className="danger"
                      onSelect={(event) => {
                        if ((event as MouseEvent).shiftKey) void remove({ messageId: id });
                        else setConfirm(true);
                      }}
                    >
                      <Icon name="trash" /> Delete message
                    </MenuItem>
                  </Tip>
                </>
              ) : null}
            </MenuContent>
          </Menu>
          {picker ? (
            <EmojiPicker
              place={place}
              anchor={actions.current}
              onClose={() => setPicker(false)}
              onPick={(emoji) => {
                setPicker(false);
                const had = message.reactions.find((r) => r.emoji === emoji)?.mine ?? false;
                toggle(emoji, had);
              }}
            />
          ) : null}
        </Toolbar>
      )}

      {confirm ? (
        <Dialog
          title="Delete this message?"
          returnFocus={moreButton}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <span className="grow" />
              <button className="btn" type="button" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button
                className="btn primary"
                type="button"
                onClick={() => {
                  // The message leaving the list says it's done; a toast would only cover the composer.
                  setConfirm(false);
                  void remove({ messageId: id });
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <div className="delete-preview">
            <span className="msg-head">
              <b>{author.name}</b> <span className="muted">{formatTime(message.postedAt)}</span>
            </span>
            <div className="bubble">
              {message.format === "markdown" && message.body.trim() ? (
                <MessageBody
                  format="markdown"
                  body={message.body}
                  title={`Message from ${author.name}`}
                  mentions={mentions}
                />
              ) : (
                <span className="muted">
                  {message.format === "html"
                    ? "An HTML page"
                    : `${message.attachments.length} attachment${message.attachments.length === 1 ? "" : "s"}`}
                </span>
              )}
            </div>
          </div>
          <p className="muted">
            {message.replyCount > 0
              ? 'It has replies, so a "message deleted" line stays in its place. Its attachments are deleted.'
              : message.attachments.length > 0
                ? "It's removed for everyone, with its attachments."
                : "It's removed for everyone."}
            {mine ? "" : ` ${speaker} wrote it.`}
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}

function TaskMention({ taskId, onOpen }: { taskId: Id<"tasks">; onOpen: () => void }) {
  const task = useRoomQuery(api.tasks.get, { taskId });
  return (
    <Tip label="Open the task">
      <button className="chip" type="button" onClick={onOpen}>
        <Icon name="board" size={14} /> {task?.title ?? "Task"}
      </button>
    </Tip>
  );
}

function RunMention({ runId, nav }: { runId: Id<"runs">; nav: Nav }) {
  const run = useRoomQuery(api.runs.get, { runId });
  return (
    <Tip label="Open the run">
      <button className="chip run-mention" type="button" onClick={() => run && nav.openRun(run)}>
        <Icon name="terminal" size={14} />{" "}
        {run ? `${runLabel(run)} run${run.title ? `: ${run.title}` : ""}` : "Run"}
      </button>
    </Tip>
  );
}

/** A text link to a run, in a run's line. */
function RunLink({ runId, nav, label }: { runId: Id<"runs">; nav: Nav; label: string }) {
  const run = useRoomQuery(api.runs.get, { runId });
  return (
    <button
      className="link-btn"
      type="button"
      onClick={() => run && nav.openRun(run)}
      disabled={!run}
    >
      {label}
    </button>
  );
}

type AgentRun = NonNullable<FunctionReturnType<typeof api.runs.get>>;

/**
 * Under an agent's message over A2A, what its run is doing: working with its timer, waiting on an
 * answer, or failed with why. A finished run leaves only a quiet Details link that shows on hover.
 */
function AgentRunLine({
  run,
  agent,
  question,
  nav,
}: {
  run: AgentRun | undefined;
  agent: string;
  question: string;
  nav: Nav;
}) {
  const live = run?.state === "working";
  const now = useNow(live ? 1000 : 60_000);
  if (!run) return null;
  const details = (
    <Tip label="Open the run: its state, what was sent, and replies">
      <button className="link-btn" type="button" onClick={() => nav.openRun(run)}>
        Details
      </button>
    </Tip>
  );
  if (run.state === "working") {
    return (
      <div className="agent-run working">
        <StateIcon state="working" size={14} />
        <span>Working</span>
        <span className="mono muted">{clock(run.stateChangedAt ?? run.startedAt, now)}</span>
        {details}
      </div>
    );
  }
  if (run.state === "waiting")
    return <AgentAnswer run={run} agent={agent} question={question} details={details} />;
  if (run.state === "failed") {
    return (
      <div className="agent-run failed">
        <StateIcon state="failed" size={14} />
        <span>Failed</span>
        {run.failReason ? <span className="muted truncate">{run.failReason}</span> : null}
        {details}
      </div>
    );
  }
  // Finished: nothing under the message; the hover bar's Run details opens it.
  return null;
}

/**
 * An agent waiting on your answer in chat: a card under its question, with its choices as buttons that
 * send on a click; your own words go in the message box. The answer goes to the agent's run (runs.reply), which
 * posts it where the run came from, as typing it in the message box would.
 */
function AgentAnswer({
  run,
  agent,
  question,
  details,
}: {
  run: AgentRun;
  agent: string;
  question: string;
  details: ReactNode;
}) {
  const reply = useAct(api.runs.reply);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  // In a channel an answer reaches the agent only when it names it; in a direct message it always does.
  const rows = useContext(MessageRows);
  // Only those runs.reply takes (its driver, its starter, the task's owner, an admin) get the buttons.
  const choices = run.canReply ? questionChoices(question) : [];
  const write = rows
    ? `write your answer with @${agent} in the message box`
    : "write your answer in the message box";
  const send = async (answer: string) => {
    if (!answer.trim() || busy) return;
    setSelected(answer);
    setBusy(true);
    const result = await reply({ runId: run.runId, text: answer.trim() });
    if (result === undefined) setSelected(null);
    setBusy(false);
  };
  return (
    <div className="agent-answer" role="group" aria-label={`Answer ${agent}`}>
      <div className="agent-run waiting">
        <StateIcon state="waiting" size={14} />
        <b>
          {run.canReply ? `${agent} is waiting on your answer` : `${agent} is waiting on an answer`}
        </b>
        {details}
      </div>
      {choices.length ? (
        <div className="agent-answer-choices">
          {choices.map((c) => (
            <Toggle
              key={c}
              className="btn"
              pressed={selected === c}
              disabled={busy}
              onPressedChange={() => void send(c)}
            >
              <span className="answer-check" aria-hidden="true">
                {selected === c ? <Icon name="tick" size={14} /> : null}
              </span>
              {c.charAt(0).toUpperCase() + c.slice(1)}
            </Toggle>
          ))}
        </div>
      ) : null}
      {/* Anything else goes in the message box below: one box to write in, not two. */}
      <span className="muted agent-answer-hint">
        {choices.length ? `Or ${write}.` : `${write.charAt(0).toUpperCase()}${write.slice(1)}.`}
      </span>
    </div>
  );
}

type Artifact = NonNullable<AgentRun["a2a"]>["artifacts"][number];

/**
 * What an agent made, as cards under its message (Muse's result cards): each with its name, the first
 * lines of its text, and its links. A long one is cut short and says so.
 */
export function AgentResults({ artifacts }: { artifacts: Artifact[] }) {
  return (
    <div className="agent-results">
      {artifacts.map((a) => {
        const lines = (a.text ?? "")
          .split("\n")
          .filter((l) => l.trim())
          .slice(0, 4);
        return (
          <div key={a.artifactId} className="agent-result">
            <div className="agent-result-head">
              <Icon name={a.urls.length && !a.text ? "link" : "doc"} size={14} />
              <b className="truncate">{a.name ?? "Result"}</b>
              {a.truncated ? <span className="muted">cut short</span> : null}
            </div>
            {lines.length ? <pre className="agent-result-preview">{lines.join("\n")}</pre> : null}
            {a.urls.length ? (
              <div className="agent-result-links">
                {a.urls.map((u) => (
                  <a key={u} href={u} target="_blank" rel="noreferrer" className="truncate">
                    {u.replace(/^https?:\/\//, "")}
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

type Proposal = NonNullable<NonNullable<MessageRow["a2a"]>["proposal"]>;

/**
 * An agent's proposal to move its work to a thread of its own (ADR 0024): Yes and No for whoever
 * may answer, and the seconds until it counts as Yes. Once answered, one line says what happened.
 */
export function ThreadProposal({
  messageId,
  agent,
  proposal,
  onOpenThread,
}: {
  messageId: Id<"messages">;
  agent: string;
  proposal: Proposal;
  onOpenThread?: ((rootId: Id<"messages">) => void) | undefined;
}) {
  const answer = useAct(api.messages.answerProposal);
  const [busy, setBusy] = useState(false);
  const pending = proposal.status === "pending";
  const now = useNow(pending ? 1000 : 60_000);
  const decide = async (open: boolean) => {
    setBusy(true);
    await answer({ messageId, open });
    setBusy(false);
  };
  if (pending) {
    const left = Math.max(0, Math.ceil((proposal.expiresAt - now) / 1000));
    return (
      <div className="thread-proposal" role="group" aria-label={`${agent} asks to open a thread`}>
        {proposal.canDecide ? (
          <>
            <Button
              className="btn primary"
              type="button"
              disabled={busy}
              onClick={() => decide(true)}
            >
              Yes
            </Button>
            <Button className="btn" type="button" disabled={busy} onClick={() => decide(false)}>
              No
            </Button>
          </>
        ) : null}
        <span className="muted" aria-live="off">
          {left > 0 ? (
            <>
              Opens a thread{proposal.title ? ` for “${proposal.title}”` : ""} in{" "}
              <span className="countdown">{left} s</span>
              {proposal.canDecide ? " unless you say no." : "."}
            </>
          ) : (
            "Opening the thread…"
          )}
        </span>
      </div>
    );
  }
  if (proposal.status === "accepted") {
    return (
      <div className="thread-proposal decided muted">
        <Icon name="reply" size={14} />
        <span>
          {proposal.decidedBy
            ? `${proposal.decidedBy.name} opened a thread.`
            : "Nobody answered within 30 seconds, so the thread opened."}
        </span>
        {onOpenThread ? (
          <button
            className="link-btn"
            type="button"
            onClick={() => onOpenThread(proposal.triggerMessageId)}
          >
            Open thread
          </button>
        ) : null}
      </div>
    );
  }
  if (proposal.status === "canceled") {
    // Nobody's Yes or No: the run stopped, or a message it needed was deleted. The room says which.
    return (
      <div className="thread-proposal decided muted">
        <span>{proposal.reason ?? "No thread opened."}</span>
      </div>
    );
  }
  return (
    <div className="thread-proposal decided muted">
      <span>
        {proposal.decidedBy ? `${proposal.decidedBy.name} said no` : "Answered no"}, so {agent}{" "}
        answers here.
      </span>
    </div>
  );
}
