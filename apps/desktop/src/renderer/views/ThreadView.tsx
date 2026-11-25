/**
 * A T3 Code thread's conversation in the room (ADR 0022), framed like a terminal: who drives it,
 * its access, the wheel, then the conversation itself, newest at the bottom. The thread runs in T3
 * Code on its machine; the bridge there sends its items while someone has this view open.
 */
import { QuestionForm } from "../components/QuestionForm";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePaginatedQuery } from "convex/react";
import { Button } from "@ui-sdk/react/button";
import { Popover, PopoverContent, PopoverTrigger } from "@ui-sdk/react/popover";
import { Textarea } from "@ui-sdk/react/textarea";
import type { FunctionReturnType } from "convex/server";
import { api, type Id } from "../lib/api";
import { ACCESS_META, accessRank, formatTime, harnessLabel } from "../lib/format";
import { mayDriveBelowDrive, personDriving } from "../lib/machinePick";
import { useAct, useRoomQuery, useSession } from "../lib/session";
import { answerState, DELIVERY_MS, failText, offlineMachines, showRun } from "../lib/work";
import {
  checkpointLine,
  diffLines,
  requestOutcome,
  threadBlocks,
  workLine,
  type ThreadBlock,
  type ThreadItem,
} from "../lib/thread";
import {
  AccessControl,
  DriverPill,
  RailClose,
  RailToggle,
  Watching,
  useRail,
} from "../components/WorkHead";
import { HarnessMark, MemberFace, StateIcon } from "../components/Faces";
import { Icon } from "../components/Icon";
import { Cmd } from "../components/Cmd";
import { Markdown } from "../components/MessageBody";
import { T3PairingNote } from "../components/T3PairingNote";
import {
  fileDrop,
  PendingFileChips,
  PendingFileErrors,
  useFileUploads,
} from "../components/chat/FileUploads";
import { MODE_META, ModeChip, ModeOptions } from "../components/RunMode";
import { Tip } from "../components/Tip";
import { useNow } from "../components/useNow";
import type { Nav } from "../Shell";
import { NO_CAPTURE } from "../lib/analytics";
import "./work.css";
import "./thread.css";

const WATCH_EVERY_MS = 15_000;
/** threads.loadOlder asks the bridge again once a request has been loading this long. */
const HISTORY_RETRY_MS = 30_000;

export function ThreadView({ runId, nav }: { runId: Id<"runs">; nav: Nav }) {
  const session = useSession();
  const me = session.me.memberId;
  const run = useRoomQuery(api.runs.get, { runId });
  const thread = useRoomQuery(api.threads.get, { runId });
  const machines = useRoomQuery(api.machines.list, {});
  const wheelRequests = useRoomQuery(api.threads.wheelRequests, { runId });
  const watch = useAct(api.threads.watch);
  const setAccess = useAct(api.threads.setAccess);
  const takeWheel = useAct(api.threads.takeWheel, { success: "You have control" });
  const requestWheel = useAct(api.threads.requestWheel, { success: "Asked for control" });
  const passWheel = useAct(api.threads.passWheel, { success: "Handed off" });
  const answerWheel = useAct(api.threads.answerWheelRequest);
  const setMode = useAct(api.threads.setMode, { success: "Changed what the agent may do" });
  const now = useNow(1000);

  // Say we're reading it now, and every ~15 seconds while it's open: the bridge follows it meanwhile.
  useEffect(() => {
    void watch({ runId });
    const id = setInterval(() => void watch({ runId }), WATCH_EVERY_MS);
    return () => clearInterval(id);
  }, [runId, watch]);

  const machine = machines?.find((m) => m.machineId === run?.machine?.machineId);
  const offline = offlineMachines(machines);
  const machineOffline = Boolean(run?.machine && offline.has(run.machine.machineId));
  const isDriver = thread?.driver?.memberId === me;
  const isStarter = thread?.startedBy?.memberId === me;
  const open = thread?.open ?? true;
  const ownsMachine =
    machine?.belongsTo.kind === "person"
      ? machine.belongsTo.member.memberId === me
      : session.isAdmin;
  const machinePerson = personDriving(machine);
  const title = run ? (run.title ?? `${harnessLabel(run.harness)} thread`) : "Thread";
  const harness = run ? harnessLabel(run.harness) : "The agent";
  // A room from before ADR 0043 names no mode: the thread asks for approvals, as every room thread did.
  const mode = thread?.runtimeMode ?? "approval-required";
  const asked = (wheelRequests ?? []).some((r) => r.from.memberId === me);
  const canDrive = Boolean(thread && open && !machineOffline && thread.machine?.passesWheel);
  const suggestions = useRoomQuery(api.threads.suggestions, { runId });
  const asksMe = isDriver ? (wheelRequests?.length ?? 0) : 0;
  // The side panel opens by itself only while something waits in it; its button says how many.
  const handOffTo = thread
    ? session.members.filter(
        (m) =>
          m.memberId !== me &&
          (accessRank(thread.access) >= accessRank("drive") ||
            mayDriveBelowDrive(machine, thread.startedBy, m.memberId)),
      )
    : [];
  const rail = useRail((suggestions?.length ?? 0) + asksMe > 0);

  return (
    <div
      className={`terminal-layout ${rail.open ? "" : "rail-closed"} ${NO_CAPTURE}`}
      style={{ position: "relative" }}
    >
      <div className="terminal-main thread-main">
        <header className="main-head work-head">
          <Tip label="Back">
            <button
              className="btn icon"
              type="button"
              aria-label="Back"
              onClick={() => nav.go({ name: "inbox" })}
            >
              <Icon name="chevron" style={{ transform: "rotate(180deg)" }} />
            </button>
          </Tip>
          {/* The agent and its task as one centered pill, as Grok Bot's header names the Bot. */}
          <div className="head-id">
            {run ? (
              <HarnessMark
                harness={run.harness}
                state={run.state === "unknown" ? "working" : run.state}
              />
            ) : null}
            <h1 className="truncate" title={title}>
              {title}
            </h1>
          </div>
          <span className="grow" />
          {thread && !isDriver && canDrive ? (
            thread.access === "open" ||
            (thread.access !== "drive" && mayDriveBelowDrive(machine, thread.startedBy, me)) ? (
              <button className="btn amber" type="button" onClick={() => void takeWheel({ runId })}>
                <Icon name="wheel" /> Take control
              </button>
            ) : thread.access === "drive" ? (
              <button
                className="btn"
                type="button"
                disabled={asked}
                onClick={() => void requestWheel({ runId })}
              >
                <Icon name="wheel" /> {asked ? "Asked for control" : "Ask for control"}
              </button>
            ) : null
          ) : null}
          {/* A thread the room stopped because T3 Code took no mode within the machine's cap keeps
              the amber chip that says why (ADR 0043). */}
          {/* The default (Ask before acting) goes without saying: the chip shows only a mode someone
              chose, one the machine lowered, or one on its way. The access menu changes it either way. */}
          {thread &&
          (open || thread.runtimeModeOverCap) &&
          (mode !== "approval-required" ||
            thread.runtimeModeOverCap ||
            thread.runtimeModeLoweredFrom ||
            (thread.runtimeModePending && thread.runtimeModePending !== mode)) ? (
            <ModeChip
              mode={mode}
              setBy={thread.runtimeModeSetBy}
              setAt={thread.runtimeModeSetAt}
              loweredFrom={thread.runtimeModeLoweredFrom}
              pending={thread.runtimeModePending}
              overCap={thread.runtimeModeOverCap}
            />
          ) : null}
          {thread ? (
            // One header control: who's in control, as a pill that opens Hand off, what teammates may do,
            // what the agent may do, who's watching, where it runs and Open in T3 Code. The title keeps the rest of the row.
            <ThreadAccessMenu
              label={
                <DriverPill
                  driver={thread.driver}
                  me={me}
                  members={session.members}
                  ended={open ? undefined : "stopped"}
                />
              }
            >
              {isDriver && canDrive ? (
                <div className="access-menu-section">
                  <div className="pop-title">Hand off to</div>
                  {handOffTo.length === 0 ? (
                    <span className="muted">Nobody can take control at this access level.</span>
                  ) : null}
                  {handOffTo.map((m) => (
                    <button
                      key={m.memberId}
                      type="button"
                      className="access-menu-item"
                      onClick={() => void passWheel({ runId, to: m.memberId })}
                    >
                      <MemberFace member={m} members={session.members} size={18} /> {m.name}
                    </button>
                  ))}
                </div>
              ) : null}
              {open ? (
                <div className="access-menu-section">
                  <AccessControl
                    access={thread.access}
                    loweredFrom={thread.loweredFrom}
                    mostOpen={thread.machine?.mostOpenAccess}
                    machineName={thread.machine?.name}
                    canOpenUp={isStarter && !machineOffline}
                    canLower={Boolean(ownsMachine) && !machineOffline}
                    live={open}
                    onSet={(access) => void setAccess({ runId, access })}
                    starterLabel="whoever started this thread"
                    surface="thread"
                    driver={isDriver ? { me: true } : { me: false, name: thread.driver?.name }}
                  />
                </div>
              ) : null}
              {open ? (
                <div className="access-menu-section">
                  {isDriver && canDrive && thread.changesMode ? (
                    <>
                      <ModeOptions
                        label={`What ${harness} may do`}
                        value={mode}
                        cap={thread.machine?.mostPermissiveMode}
                        offered={thread.runtimeModes}
                        machineName={thread.machine?.name}
                        compact
                        onPick={(runtimeMode) => void setMode({ runId, runtimeMode })}
                      />
                      <span className="hint access-line">
                        {MODE_META[mode].line} A change applies from {harness}'s next step.
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="label">What {harness} may do</span>
                      <span className="hint access-line">
                        <b>{MODE_META[mode].label}.</b> {MODE_META[mode].line}{" "}
                        {isDriver
                          ? `The bridge on ${thread.machine?.name ?? "its machine"} is too old to change it from here. Change it in T3 Code.`
                          : "Only whoever is in control changes it."}
                      </span>
                    </>
                  )}
                </div>
              ) : null}
              <div className="access-menu-foot">
                <Watching
                  watching={thread.watching}
                  me={me}
                  driverId={thread.driver?.memberId}
                  members={session.members}
                />
                {run ? (
                  <span className="muted where">
                    {harness} in a T3 Code thread
                    {run.machine ? (
                      <>
                        {" on "}
                        <span className="mono">{run.machine.name}</span>
                      </>
                    ) : null}
                  </span>
                ) : null}
                {thread.t3Link ? (
                  <a className="btn" href={thread.t3Link} target="_blank" rel="noreferrer">
                    <Icon name="link" /> Open in T3 Code
                  </a>
                ) : null}
              </div>
            </ThreadAccessMenu>
          ) : null}
          <RailToggle
            open={rail.open}
            onToggle={rail.toggle}
            waiting={(isDriver ? (suggestions?.length ?? 0) : 0) + asksMe}
            urgent={asksMe > 0}
            label="Suggestions"
          />
        </header>

        <div className="thread-notes">
          {thread &&
          open &&
          machinePerson &&
          isStarter &&
          !isDriver &&
          machinePerson.memberId !== me ? (
            // ADR 0025: the machine's person took the wheel of this thread when they lowered the machine.
            <div className="note">
              <span className="mono">{machine!.name}</span> is set to{" "}
              {ACCESS_META[machine!.mostOpenAccess].label}, so {machinePerson.name} is in control of
              every thread there, yours included. It keeps going, and you can{" "}
              {thread.access === "watch" ? "watch it" : "suggest messages for it"}.
            </div>
          ) : null}
          {machine ? (
            <T3PairingNote
              t3={machine.t3}
              machineName={machine.name}
              now={now}
              onlyNeedsYou
              withChip
            />
          ) : null}
          {machineOffline && run?.machine ? (
            <div className="note">
              <span className="mono">{run.machine.name}</span> is offline, so this is the thread as
              it last was. It goes on when its bridge is back.
            </div>
          ) : null}
          {thread && !thread.showsConversation && !machineOffline ? (
            <div className="note">
              The bridge on <span className="mono">{thread.machine?.name ?? "its machine"}</span> is
              too old to send this thread here. Update Uplink Room there
              {thread.t3Link ? ", or open it in T3 Code" : ""}.
            </div>
          ) : null}
        </div>

        <Conversation
          runId={runId}
          harness={harness}
          older={thread?.older ?? false}
          // A request whose bridge went away mid-read stops counting as loading, so you can ask again.
          history={
            thread?.history?.status === "loading" && now - thread.history.at >= HISTORY_RETRY_MS
              ? undefined
              : thread?.history
          }
          waiting={run?.state === "waiting"}
        />

        {run && thread ? (
          <ThreadFoot
            run={run}
            thread={thread}
            harness={harness}
            isDriver={isDriver}
            canAnswer={
              thread.answersApprovals ?? Boolean(session.isAdmin || run.driver?.memberId === me)
            }
            machineOffline={machineOffline}
            now={now}
          />
        ) : null}
      </div>

      {rail.open ? (
        <aside className="terminal-side thread-side" aria-label="Thread suggestions and activity">
          <div className="thread-side-head">
            <h2>Suggestions and activity</h2>
            <RailClose onClose={rail.toggle} />
          </div>
          {isDriver && wheelRequests?.length ? (
            <div className="side-block">
              <h2>Asking for control</h2>
              {wheelRequests.map((r) => (
                <div key={r.requestId} className="sugg">
                  <div className="row-flex">
                    <MemberFace member={r.from} members={session.members} size={20} />
                    <span className="grow">{r.from.name} wants control</span>
                  </div>
                  <div className="row-flex">
                    <button
                      className="btn primary"
                      type="button"
                      onClick={() => void answerWheel({ requestId: r.requestId, grant: true })}
                    >
                      Hand it over
                    </button>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => void answerWheel({ requestId: r.requestId, grant: false })}
                    >
                      Not now
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          <ThreadSuggestions
            runId={runId}
            isDriver={isDriver}
            canSend={Boolean(thread?.takesMessages && !machineOffline)}
          />
          <SentLog runId={runId} />
        </aside>
      ) : null}
    </div>
  );
}

type RunRow = FunctionReturnType<typeof api.runs.get>;
type ThreadRow = FunctionReturnType<typeof api.threads.get>;

/**
 * The bottom band: what the thread waits on, then the message box for its driver, a suggestion box
 * for teammates on a Suggest or more open thread, and where the run stands with Stop turn.
 */
export function ThreadFoot({
  run,
  thread,
  harness,
  isDriver,
  canAnswer,
  machineOffline,
  now,
}: {
  run: RunRow;
  thread: ThreadRow;
  harness: string;
  isDriver: boolean;
  canAnswer: boolean;
  machineOffline: boolean;
  now: number;
}) {
  const send = useAct(api.threads.send);
  const suggest = useAct(api.threads.suggest, { success: "Suggested" });
  const interrupt = useAct(api.threads.interrupt, { success: "Stopping this turn" });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  // Files go with the driver's messages, through the bridge to T3 Code (ADR 0043); a suggestion is text.
  const files = useFileUploads();
  const fileInput = useRef<HTMLInputElement>(null);
  const takesFiles = isDriver && thread.takesFiles;
  // While a question waits, its card is the one box: the message box folds to a link until asked for.
  const [writeAnyway, setWriteAnyway] = useState(false);
  const asking = run.state === "waiting" && Boolean(run.prompt);
  const shown = showRun(run, now, machineOffline);
  const busy = run.state === "working";
  const canSuggest = !isDriver && thread.open && accessRank(thread.access) >= accessRank("suggest");
  const reach = thread.open && thread.takesMessages && !machineOffline;
  const attached = takesFiles ? files.ready : [];
  const ready = (text.trim().length > 0 || attached.length > 0) && !(takesFiles && files.uploading);
  const submit = async () => {
    const body = text.trim();
    if (!ready || sending) return;
    setSending(true);
    try {
      const done = isDriver
        ? await send({
            runId: run.runId,
            text: body,
            ...(attached.length ? { attachments: attached.map((p) => p.uploaded!) } : {}),
          })
        : await suggest({ runId: run.runId, text: body });
      // Only what went: anything typed or attached while it was sending stays.
      if (done !== undefined) {
        setText((current) => (current.trim() === body ? "" : current));
        files.dropThumbs(attached);
        files.setPending((all) =>
          all.filter((p) => !attached.includes(p) && p.status !== "failed"),
        );
      }
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="thread-foot">
      {run.state === "waiting" && run.prompt ? (
        <WaitingCard
          run={run}
          thread={thread}
          harness={harness}
          canAnswer={canAnswer}
          machineOffline={machineOffline}
          now={now}
        />
      ) : null}
      {run.state === "failed" && failText(run.failReason) ? (
        <div className="run-fail">{failText(run.failReason)}</div>
      ) : null}
      {(isDriver || canSuggest) && reach && asking && !writeAnyway && !text ? (
        <button
          className="link-btn thread-write-anyway"
          type="button"
          onClick={() => setWriteAnyway(true)}
        >
          {isDriver ? `Write ${harness} a message instead` : "Suggest a message instead"}
        </button>
      ) : (isDriver || canSuggest) && reach ? (
        <form
          className="composer-box thread-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          {...(takesFiles ? fileDrop(files.addFiles) : {})}
        >
          {takesFiles && files.pending.some((p) => p.status !== "failed") ? (
            <ul className="pending-files" aria-label="Attached to this message">
              <PendingFileChips pending={files.pending} onRemove={files.removeFile} />
            </ul>
          ) : null}
          {takesFiles ? (
            <PendingFileErrors pending={files.pending} onRemove={files.removeFile} />
          ) : null}
          {/* One line, as Grok Bot's composer: attach, the box, and send. While a turn runs, what you
              send waits for it, and the box and the button say so. */}
          <div className="composer-line">
            {takesFiles ? (
              <span className="composer-tool">
                <Tip label="Attach images or files. You can also paste or drop them here.">
                  <button
                    className="icon-btn"
                    type="button"
                    aria-label="Attach images or files"
                    onClick={() => fileInput.current?.click()}
                  >
                    <Icon name="plus" size={16} />
                  </button>
                </Tip>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  aria-label="Attach files"
                  onChange={(event) => {
                    files.addFiles([...(event.target.files ?? [])]);
                    event.target.value = "";
                  }}
                />
              </span>
            ) : null}
            <Textarea
              className="textarea grow-box"
              rows={1}
              value={text}
              aria-label={
                isDriver
                  ? `Message ${harness}`
                  : `Suggest a message to ${thread.driver?.name ?? "whoever is in control"}`
              }
              placeholder={
                isDriver
                  ? run.state === "waiting" && run.prompt?.kind === "question"
                    ? "Type your answer, or talk about something else"
                    : busy
                      ? `Queue a message for ${harness}`
                      : `Message ${harness}`
                  : `Suggest a message. ${thread.driver?.name ?? "Whoever is in control"} sends it or not.`
              }
              onChange={(event) => setText(event.target.value)}
              onPaste={(event) => {
                const pasted = [...event.clipboardData.files];
                if (!takesFiles || pasted.length === 0) return;
                event.preventDefault();
                files.addFiles(pasted);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            {/* The form's submit, which Enter in the box runs too, keeps its own pending flag: UI SDK's
                Button tracks only a Promise its own onClick returns. */}
            <Tip
              label={
                takesFiles && files.uploading
                  ? "Waiting for the upload"
                  : isDriver
                    ? busy
                      ? `Queue: it goes to ${harness} when this turn ends`
                      : "Send (Enter)"
                    : "Suggest: it goes to the side panel for whoever is in control"
              }
            >
              <button
                className="icon-btn composer-send"
                type="submit"
                disabled={!ready || sending}
                aria-label={isDriver ? (busy ? "Queue" : "Send") : "Suggest"}
              >
                <Icon name={isDriver ? "arrow-up" : "suggest"} size={16} />
              </button>
            </Tip>
          </div>
        </form>
      ) : thread.open && !machineOffline && !thread.takesMessages && (isDriver || canSuggest) ? (
        <div className="hint thread-foot-note">
          The bridge on <span className="mono">{thread.machine?.name ?? "its machine"}</span> is too
          old to send messages from here. Update Uplink Room there, or write in T3 Code.
        </div>
      ) : thread.open && !isDriver && !canSuggest ? (
        <div className="hint thread-foot-note">
          {thread.driver?.name ?? "Someone"} is in control of this thread. Teammates can suggest
          messages once its access is Suggest or more open.
        </div>
      ) : null}
      <div className="thread-state">
        <StateIcon state={shown.icon} glyph={shown.glyph} />
        <span className={`state-${shown.icon}`}>{shown.label}</span>
        {shown.time ? <span className="mono muted">{shown.time}</span> : null}
        {isDriver && busy && reach ? (
          <button
            className="btn"
            type="button"
            onClick={() => void interrupt({ runId: run.runId })}
          >
            <Icon name="stop" /> Stop turn
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Suggested messages: the driver sends, edits or dismisses them; others see what waits. */
function ThreadSuggestions({
  runId,
  isDriver,
  canSend,
}: {
  runId: Id<"runs">;
  isDriver: boolean;
  canSend: boolean;
}) {
  const suggestions = useRoomQuery(api.threads.suggestions, { runId });
  const send = useAct(api.threads.sendSuggestion);
  const dismiss = useAct(api.threads.dismissSuggestion);
  const [editing, setEditing] = useState<{ id: Id<"threadSuggestions">; text: string } | null>(
    null,
  );
  return (
    <div className="side-block">
      <h2>Suggested messages</h2>
      {(suggestions?.length ?? 0) === 0 ? <span className="muted">None waiting.</span> : null}
      {(suggestions ?? []).map((s) => (
        <div key={s.suggestionId} className="sugg">
          <div className="muted thread-suggestion-by">{s.from.name} suggests</div>
          {editing?.id === s.suggestionId ? (
            <Textarea
              className="textarea"
              rows={3}
              value={editing.text}
              autoFocus
              aria-label="Edit the suggested message"
              onChange={(event) => setEditing({ id: s.suggestionId, text: event.target.value })}
            />
          ) : (
            <div className="thread-sugg-text">{s.text}</div>
          )}
          {isDriver ? (
            <div className="row-flex" style={{ flexWrap: "wrap" }}>
              <Tip label="The message can't reach the machine now." disabled={canSend}>
                <button
                  className="btn primary"
                  type="button"
                  disabled={!canSend}
                  onClick={async () => {
                    const edited = editing?.id === s.suggestionId ? editing.text : undefined;
                    const sent = await send({
                      suggestionId: s.suggestionId,
                      ...(edited !== undefined ? { text: edited } : {}),
                    });
                    // On failure the edit stays open, so it can be fixed and sent again.
                    if (sent !== undefined)
                      setEditing((e) => (e?.id === s.suggestionId ? null : e));
                  }}
                >
                  Send
                </button>
              </Tip>
              {editing?.id === s.suggestionId ? null : (
                <button
                  className="btn"
                  type="button"
                  onClick={() => setEditing({ id: s.suggestionId, text: s.text })}
                >
                  Edit
                </button>
              )}
              <button
                className="btn"
                type="button"
                onClick={() => void dismiss({ suggestionId: s.suggestionId })}
              >
                Dismiss
              </button>
            </div>
          ) : (
            <span className="hint">Only whoever is in control can send it.</span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Who sent what into the thread from the room, oldest of the page first. */
function SentLog({ runId }: { runId: Id<"runs"> }) {
  const session = useSession();
  const log = usePaginatedQuery(
    api.threads.messages,
    { teamId: session.teamId, runId },
    { initialNumItems: 30 },
  );
  return (
    <div className="side-block">
      <h2>Who sent what</h2>
      {log.results.length === 0 ? (
        <span className="muted">Nothing sent from the room yet.</span>
      ) : null}
      {log.status === "CanLoadMore" || log.status === "LoadingMore" ? (
        <button
          className="btn"
          type="button"
          disabled={log.status === "LoadingMore"}
          onClick={() => log.loadMore(30)}
        >
          Show earlier
        </button>
      ) : null}
      {[...log.results].reverse().map((entry) => (
        <div key={entry.messageId} className="log-line" title={formatTime(entry.at)}>
          <span className="log-time">{formatTime(entry.at)}</span>
          <b style={{ fontWeight: 500, color: "var(--text)", flex: "none" }}>
            {entry.by.memberId === session.me.memberId ? "You" : entry.by.name}
          </b>
          <span className="truncate">{entry.text}</span>
          {entry.suggestedBy ? (
            <span className="faint" style={{ flex: "none" }}>
              from {entry.suggestedBy.name}
            </span>
          ) : null}
          {entry.status === "failed" ? (
            <span className="state-failed" style={{ flex: "none" }} title={entry.error}>
              not sent
            </span>
          ) : entry.status === "queued" ? (
            <span className="muted" style={{ flex: "none" }}>
              waits for the turn
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** The conversation, oldest at the top and following the newest while you're at the bottom. */
function Conversation({
  runId,
  harness,
  older,
  history,
  waiting,
}: {
  runId: Id<"runs">;
  harness: string;
  older: boolean;
  history: { status: "loading" | "failed"; error?: string | undefined } | undefined;
  /** The run waits on a request: the card below shows it, so the conversation doesn't again. */
  waiting: boolean;
}) {
  const session = useSession();
  const pages = usePaginatedQuery(
    api.threads.items,
    { teamId: session.teamId, runId },
    { initialNumItems: 80 },
  );
  const loadOlder = useAct(api.threads.loadOlder);
  const blocks = useMemo(
    () =>
      threadBlocks(pages.results as ThreadItem[]).filter(
        (b) => !(waiting && b.kind === "request" && b.item.outcome === undefined),
      ),
    [pages.results, waiting],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // Stays at the bottom as items arrive, unless you scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [blocks]);

  const moreHere = pages.status === "CanLoadMore" || pages.status === "LoadingMore";
  const loading = pages.status === "LoadingFirstPage";
  return (
    <div
      className="thread-scroll"
      ref={scroller}
      onScroll={(event) => {
        const el = event.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      <div className="thread-column">
        {moreHere || older ? (
          <div className="thread-earlier">
            <button
              className="btn"
              type="button"
              disabled={pages.status === "LoadingMore" || history?.status === "loading"}
              onClick={() => {
                pinned.current = false;
                if (moreHere) pages.loadMore(80);
                else void loadOlder({ runId });
              }}
            >
              {history?.status === "loading"
                ? "Loading earlier messages…"
                : "Show earlier messages"}
            </button>
            {history?.status === "failed" ? (
              <span className="hint state-failed">
                Couldn't load them from T3 Code: {history.error}
              </span>
            ) : null}
          </div>
        ) : null}
        {loading ? <div className="thread-empty muted">Loading…</div> : null}
        {!loading && !blocks.length ? (
          <div className="thread-empty muted">
            Nothing here yet. The thread shows once its bridge sends it.
          </div>
        ) : null}
        {blocks.map((block) => (
          <Block
            key={block.kind === "work" ? block.key : block.item.itemId}
            block={block}
            runId={runId}
            harness={harness}
          />
        ))}
      </div>
    </div>
  );
}

function Block({
  block,
  runId,
  harness,
}: {
  block: ThreadBlock;
  runId: Id<"runs">;
  harness: string;
}) {
  switch (block.kind) {
    case "message":
      return <Message item={block.item} harness={harness} />;
    case "work":
      return <Work items={block.items} />;
    case "plan":
      return <Plan item={block.item} />;
    case "request":
      return <RequestLine item={block.item} />;
    case "checkpoint":
      return <Checkpoint item={block.item} runId={runId} />;
    case "notice":
      return (
        <div className={`thread-event ${block.item.tone === "error" ? "state-failed" : "muted"}`}>
          {block.item.tone === "error" ? <Icon name="alert" /> : null}
          <span>{block.item.text}</span>
        </div>
      );
  }
}

/** A thread item as threads.items returns it: a message sent from the room names who sent it. */
type Person = { name: string; memberId: string; kind: "person" | "agent" };
/** The room's own copy of a file sent from the thread's box (ADR 0043): an image has a link to show it from. */
type RoomFile = { name: string; kind: "image" | "pdf" | "file"; size: number; url: string | null };
type RoomItem = ThreadItem & { sentBy?: Person; suggestedBy?: Person; roomFiles?: RoomFile[] };

function Message({ item, harness }: { item: RoomItem; harness: string }) {
  const session = useSession();
  const mine = item.role === "user";
  const sender = item.sentBy;
  // As in a Grok Bot chat, a thread is one agent's, so neither its replies nor your own words need a
  // name over them; only a teammate's message, or a suggested one, says who it's from.
  const named =
    mine && ((sender && sender.memberId !== session.me.memberId) || Boolean(item.suggestedBy));
  return (
    <div className={`thread-msg ${mine ? "to-agent" : "from-agent"}`}>
      {named ? (
        <div className="thread-msg-head">
          {sender ? (
            <>
              <MemberFace member={sender} members={session.members} size={18} />
              <b>{sender.memberId === session.me.memberId ? "You" : sender.name}</b>
              <span className="muted">
                to {harness}
                {item.suggestedBy ? `, suggested by ${item.suggestedBy.name}` : ""}
              </span>
            </>
          ) : (
            <span className="muted">
              To {harness}
              {item.suggestedBy ? `, suggested by ${item.suggestedBy.name}` : ""}
            </span>
          )}
        </div>
      ) : null}
      {item.text || !item.roomFiles?.length ? (
        <div className="bubble thread-bubble">
          {mine ? (
            <div className="thread-plain">{item.text}</div>
          ) : (
            <Markdown source={item.text ?? ""} />
          )}
          {item.cut ? <div className="hint">Long message: the rest is in T3 Code.</div> : null}
        </div>
      ) : null}
      {item.roomFiles?.length ? (
        <div className="thread-files">
          {item.roomFiles.map((f, i) =>
            f.url ? (
              <Tip key={i} label={`${f.name}, ${sizeText(f.size)}`}>
                <a className="thread-image" href={f.url} target="_blank" rel="noreferrer">
                  <img src={f.url} alt={f.name} />
                </a>
              </Tip>
            ) : (
              <span
                key={i}
                className="chip"
                title={`${f.name} went to ${harness} with this message.`}
              >
                <Icon name={f.kind === "image" ? "image" : f.kind === "pdf" ? "pdf" : "file"} />{" "}
                {f.name}
                <span className="muted"> {sizeText(f.size)}</span>
              </span>
            ),
          )}
        </div>
      ) : item.attachments?.length ? (
        <div className="thread-files">
          {item.attachments.map((a, i) => (
            <span
              key={i}
              className="chip"
              title="T3 Code's link to the file is a credential, so the room shows only its name. Open the thread in T3 Code to see it."
            >
              <Icon name={a.kind === "image" ? "image" : "file"} /> {a.name}
              {a.size !== undefined ? <span className="muted"> {sizeText(a.size)}</span> : null}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function sizeText(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A turn's work, folded into one line until opened; each step opens to its input and output. */
function Work({ items }: { items: ThreadItem[] }) {
  const [open, setOpen] = useState(false);
  // The turn's state is its last step's: a test that failed and then passed reads done.
  const last = items.at(-1);
  const failed = Boolean(last?.failed);
  const running = items.some(
    (i) => i.status === "running" || i.status === "inProgress" || i.streaming,
  );
  return (
    <div className={`thread-work ${open ? "open" : ""}`}>
      <button
        className="thread-fold"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="chevron" className="fold-mark" />
        <StateIcon state={running ? "working" : failed ? "failed" : "done"} />
        <span>{workLine(items)}</span>
      </button>
      {open ? (
        <div className="thread-steps">
          {items.map((item) => (
            <Step key={item.itemId} item={item} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Step({ item }: { item: ThreadItem }) {
  const [open, setOpen] = useState(false);
  const label =
    item.kind === "reasoning"
      ? "Thinking"
      : item.kind === "file_change"
        ? `Edited ${item.title ?? "a file"}`
        : (item.title ?? "Tool call");
  const counts =
    item.kind === "file_change" && (item.additions !== undefined || item.deletions !== undefined)
      ? ` +${item.additions ?? 0} −${item.deletions ?? 0}`
      : "";
  const body =
    item.kind === "reasoning"
      ? item.text
      : item.kind === "file_change"
        ? item.diff
        : (item.output ?? item.input);
  const state =
    item.status === "running" || item.status === "inProgress"
      ? "working"
      : item.failed
        ? "failed"
        : "done";
  return (
    <div className="thread-step">
      <button
        className="thread-fold step"
        type="button"
        aria-expanded={open}
        disabled={!body}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="chevron" className="fold-mark" />
        <StateIcon state={state} />
        <span className={item.kind === "reasoning" || item.kind === "file_change" ? "" : "mono"}>
          {item.kind === "file_change" ? (
            <>
              Edited <span>{item.title ?? "a file"}</span>
            </>
          ) : (
            label
          )}
        </span>
        {counts ? <span className="muted">{counts}</span> : null}
        {item.exitCode !== undefined && item.exitCode !== 0 ? (
          <span className="mono state-failed">exit {item.exitCode}</span>
        ) : null}
      </button>
      {open && body ? (
        item.kind === "reasoning" ? (
          <div className="thread-reasoning">{body}</div>
        ) : item.kind === "file_change" ? (
          <Diff text={body} />
        ) : (
          <div className="thread-output">
            {item.input && item.output ? (
              <div className="thread-output-cmd">$ {item.input}</div>
            ) : null}
            <pre className="mono">{body}</pre>
            {item.cut ? (
              <div className="thread-output-cut">Cut to its last 4,000 characters.</div>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}

function Plan({ item }: { item: ThreadItem }) {
  return (
    <div className="thread-plan">
      <div className="thread-plan-head">
        <Icon name="board" /> <b>Plan</b>
        {item.streaming ? <span className="muted">Writing…</span> : null}
      </div>
      {item.steps?.length ? (
        <ol className="thread-plan-steps">
          {item.steps.map((step, i) => (
            <li key={i} className={`plan-${step.status}`}>
              <StateIcon
                state={
                  step.status === "completed"
                    ? "done"
                    : step.status === "running" || step.status === "in_progress"
                      ? "working"
                      : "not_started"
                }
              />
              <span>{step.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {item.text ? <Markdown source={item.text} /> : null}
    </div>
  );
}

/** A request once it's answered: one line. A pending one is the card at the bottom. */
function RequestLine({ item }: { item: ThreadItem }) {
  const outcome = requestOutcome(item);
  const what =
    item.request === "approval" ? (
      item.input ? (
        <Cmd text={item.input} />
      ) : (
        item.text
      )
    ) : item.request === "secret" ? (
      `a secret: ${item.text}`
    ) : item.request === "link" ? (
      "linking another machine"
    ) : (
      item.text
    );
  return (
    <div className="thread-event muted">
      <Icon name={outcome === "Denied" ? "x" : outcome ? "check" : "clock"} />
      <span>
        {outcome ? `${outcome}: ` : item.request === "question" ? "Asked: " : "Asked for "}
        {what}
      </span>
    </div>
  );
}

function Checkpoint({ item, runId }: { item: ThreadItem; runId: Id<"runs"> }) {
  const [open, setOpen] = useState(false);
  const requestDiff = useAct(api.threads.requestDiff);
  const diff = useRoomQuery(
    api.threads.diff,
    open && item.turn !== undefined ? { runId, turn: item.turn } : "skip",
  );
  return (
    <div className="thread-checkpoint">
      <div className="thread-event muted">
        <Icon name="file" />
        <span>{checkpointLine(item)}</span>
        {item.turn !== undefined && item.files?.length ? (
          <button
            className="btn"
            type="button"
            aria-expanded={open}
            onClick={() => {
              if (!open) void requestDiff({ runId, turn: item.turn! });
              setOpen((v) => !v);
            }}
          >
            <span className="event-label">{open ? "Hide diff" : "Show diff"}</span>
          </button>
        ) : null}
      </div>
      {open ? (
        !diff || diff.status === "loading" ? (
          <div className="thread-diff-state muted">Getting the diff from T3 Code…</div>
        ) : diff.status === "failed" ? (
          <div className="thread-diff-state state-failed">Couldn't get the diff: {diff.error}</div>
        ) : (
          <>
            <Diff text={diff.diff ?? ""} />
            {diff.cut ? (
              <div className="hint">
                The diff is long: this is its first part. The rest is in T3 Code.
              </div>
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}

function Diff({ text }: { text: string }) {
  const lines = useMemo(() => diffLines(text), [text]);
  return (
    <pre className="thread-diff">
      {lines.map((line, i) => (
        <span key={i} className={`diff-${line.kind}`}>
          {line.text}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

/**
 * What the thread waits on now: an approval with Allow and Deny, a question with its form, for
 * whoever may answer; anything else (a secret, a link) is answered in T3 Code.
 */
function WaitingCard({
  run,
  thread,
  harness,
  canAnswer,
  machineOffline,
  now,
}: {
  run: RunRow;
  thread: ThreadRow;
  harness: string;
  canAnswer: boolean;
  machineOffline: boolean;
  now: number;
}) {
  const answer = useAct(api.inbox.answer);
  const [answering, setAnswering] = useState(false);
  const prompt = run.prompt!;
  const delivery = answerState(run, now);
  const act = async (value: "allow" | "deny") => {
    if (answering) return;
    setAnswering(true);
    try {
      await answer({ runId: run.runId, answer: value, promptId: prompt.promptId ?? "" });
    } finally {
      setAnswering(false);
    }
  };
  // As for approvals: an answer still waiting after DELIVERY_MS didn't land, and can be sent again.
  const answered =
    prompt.kind === "question" &&
    prompt.promptId !== undefined &&
    run.questionAnswer?.promptId === prompt.promptId;
  const questionSent = answered && now - run.questionAnswer!.at < DELIVERY_MS;
  const questionFailed = answered && !questionSent;
  return (
    <div className="prompt-box thread-waiting">
      <div>
        <b>{harness} is waiting. </b>
        {prompt.kind === "question" && prompt.questions?.length ? null : prompt.action ? (
          <>
            {prompt.text.replace(prompt.action, "").trim() || "Wants to run"}{" "}
            <Cmd text={prompt.action} />
          </>
        ) : (
          prompt.text
        )}
      </div>
      {prompt.kind === "question" && prompt.questions?.length ? (
        !canAnswer ? (
          <>
            <div>{prompt.text}</div>
            <span className="hint">
              Only the person in control, the task's owner or an admin can answer it.
            </span>
          </>
        ) : !thread.takesAnswers ? (
          <>
            <div>{prompt.text}</div>
            <span className="hint">
              The bridge on its machine is too old to take answers. Answer it in T3 Code.
            </span>
          </>
        ) : machineOffline ? (
          <span className="hint">
            {run.machine?.name ?? "Its machine"} is offline, so an answer can't reach it.
          </span>
        ) : questionSent ? (
          <span className="hint">
            Answer sent. Waiting for {run.machine?.name ?? "the machine"} to go on.
          </span>
        ) : (
          <>
            {questionFailed ? (
              <span className="hint state-failed">Couldn't deliver your answer, try again.</span>
            ) : null}
            <QuestionForm
              key={prompt.promptId}
              runId={run.runId}
              promptId={prompt.promptId!}
              questions={prompt.questions}
            />
          </>
        )
      ) : prompt.kind !== "approval" ? (
        <div className="row-flex">
          <span className="hint grow">
            {/T3 Code/.test(prompt.text) ? "" : "Answer it in T3 Code."}
          </span>
          {thread.t3Link ? (
            <a className="btn" href={thread.t3Link} target="_blank" rel="noreferrer">
              <Icon name="link" /> Open in T3 Code
            </a>
          ) : null}
        </div>
      ) : !canAnswer ? (
        <span className="hint">
          Only the person in control, the task's owner or an admin can answer it.
        </span>
      ) : machineOffline ? (
        <span className="hint">
          {run.machine?.name ?? "Its machine"} is offline, so an answer can't reach it.
        </span>
      ) : delivery === "sending" ? (
        <span className="hint">
          Answer sent. Waiting for {run.machine?.name ?? "the machine"} to go on.
        </span>
      ) : (
        <div className="row-flex">
          {delivery === "failed" ? (
            <span className="hint state-failed">Couldn't deliver your answer, try again.</span>
          ) : null}
          <Button className="btn primary" disabled={answering} onClick={() => act("allow")}>
            Allow
          </Button>
          <Button className="btn" disabled={answering} onClick={() => act("deny")}>
            Deny
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * A header button that opens what teammates may do in this thread, who's watching and where it runs,
 * on UI SDK's Popover: Escape, a press outside or focus leaving closes it, and focus goes back to the
 * button. It opens with focus on the panel itself, so Enter can't hand the thread off by accident.
 */
function ThreadAccessMenu({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="access-menu">
      <Popover>
        <PopoverTrigger className="access-menu-btn">
          {label} <Icon name="chevron-down" size={14} />
        </PopoverTrigger>
        <PopoverContent
          className="pop access-pop"
          aria-label="Teammates in this thread"
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          initialFocus="content"
        >
          {children}
        </PopoverContent>
      </Popover>
    </div>
  );
}
