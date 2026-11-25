import "../components/agentWork.css";
import { useEffect, useRef, useId, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { Button } from "@ui-sdk/react/button";
import { Dialog as UiDialog, DialogClose, DialogContent } from "@ui-sdk/react/dialog";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { Radio, RadioGroup } from "@ui-sdk/react/radio";
import { SegmentedControl, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Textarea } from "@ui-sdk/react/textarea";
import { api, type Access, type Id, type MachineRow, type RunView } from "../lib/api";
import {
  accessRank,
  ACCESS_LEVELS,
  ACCESS_META,
  agoText,
  formatTime,
  harnessLabel,
  terminalModes,
  profileRefusal,
  runLabel,
  STARTABLE_HARNESSES,
  takesFirstPrompt,
  threadRefusal,
} from "../lib/format";
import { useAct, useActOnce, useRoomQuery, useSession } from "../lib/session";
import { STATE_META } from "../lib/states";
import {
  answerState,
  dropTrailingPrompts,
  failText,
  offlineMachines,
  previewTerminal,
  showRun,
  stateSummary,
  waitingNames,
} from "../lib/work";
import { Face, HarnessMark, MemberFace, StateIcon } from "../components/Faces";
import { Icon } from "../components/Icon";
import { Cmd } from "../components/Cmd";
import { Dialog } from "../components/Dialog";
import { Tip } from "../components/Tip";
import { useNow } from "../components/useNow";
import { A2AChat } from "../components/A2AChat";
import { groupRuns } from "../lib/a2aChat";
import { JoinedNote } from "../components/JoinedNote";
import { RunOutput, useTerminalTail } from "../components/RunOutput";
import { accessLine } from "../components/WorkHead";
import {
  MODE_META,
  modeBlock,
  RUNTIME_MODES,
  runtimeModeRank,
  TERMINAL_DEFAULT_LABEL,
  type RuntimeMode,
} from "../components/RunMode";
import "./work.css";
import type { Nav } from "../Shell";
import {
  defaultMachine,
  machineBlock,
  rexBlock,
  slotsFree,
  takesOnlyItsPersonsRuns,
  wakesOnRun,
} from "../lib/machinePick";
import { harnessName, runKind } from "../../main/analyticsSpec";
import { track } from "../lib/analytics";

/** The option for "nothing chosen" (No project, No repo, Machine setup): an item needs a value. */
const NONE = "none";

/** The options of a native-looking picker: a `.select` trigger that shows the chosen label, and its list. */
function Picker({
  value,
  options,
  onChange,
  id,
  label,
  disabled = false,
}: {
  value: string;
  options: { value: string; label: string; disabled?: boolean }[];
  onChange: (value: string) => void;
  id?: string;
  /** Names the trigger when no FieldLabel does. */
  label?: string;
  disabled?: boolean;
}) {
  return (
    <Select
      items={options}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
    >
      <SelectTrigger
        className="select"
        {...(id ? { id } : {})}
        {...(label ? { "aria-label": label } : {})}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="pop" sideOffset={4} collisionPadding={8}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={Boolean(option.disabled)}>
            {option.label}
            <SelectItemIndicator>
              <Icon name="check" size={12} />
            </SelectItemIndicator>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The task and run drawers (a side panel over the view), on UI SDK's Dialog rendered inline: it
 * stays in `.main`, where `.drawer` places it with its title row level with the window's top row,
 * over the Shell's `.drawer-scrim`, whose click closes it. The rest of the window is inert, Tab stays
 * inside, and Escape closes it; a dialog, select or popover opened from inside it is nested, so its
 * Escape closes only that. Focus starts on the panel itself, so no control shows a ring before a key
 * is pressed. It's open while it's rendered; the caller unmounts it in onClose.
 */
export function WorkDrawer({
  className,
  label,
  onClose,
  children,
}: {
  className: string;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  // A child with autoFocus runs before effects, so remember the opener before the commit.
  const opener = useRef(document.activeElement as HTMLElement | null);
  const close = useRef(onClose);
  close.current = onClose;
  // An inline dialog hears Escape where it renders and on the document: one key closes it once.
  const lastEvent = useRef<Event | undefined>(undefined);
  useEffect(() => {
    const previous = opener.current;
    return () => {
      // The caller closes the drawer by unmounting it, so focus goes back here, not through a close.
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <UiDialog
      open
      // The Shell's scrim takes the click that closes the drawer; the rest of the window stays inert.
      closeOnOutsidePress={false}
      persistentElements={[".drawer-scrim"]}
      onOpenChange={(open, details) => {
        if (open) return;
        details.cancel();
        if (details.event && details.event === lastEvent.current) return;
        lastEvent.current = details.event;
        close.current();
      }}
    >
      <DialogContent
        inline
        render={<aside />}
        className={className}
        aria-label={label}
        initialFocus="content"
        finalFocus="none"
      >
        {children}
      </DialogContent>
    </UiDialog>
  );
}

export function TaskPanel({
  taskId,
  nav,
  onClose,
}: {
  taskId: Id<"tasks">;
  nav: Nav;
  onClose: () => void;
}) {
  const session = useSession();
  const task = useRoomQuery(api.tasks.get, { taskId });
  const projects = useRoomQuery(api.projects.list, {});
  const machines = useRoomQuery(api.machines.list, {});
  const offline = offlineMachines(machines);
  const keepRun = useAct(api.tasks.keepRun, { success: "Kept. The task is closed." });
  const stopRun = useAct(api.runs.stop, { success: "Run stopped" });
  const update = useAct(api.tasks.update, { success: "Task saved" });
  const [settleTask] = useActOnce(api.inbox.settle, { success: "Settled" });
  const answer = useAct(api.inbox.answer);
  // Open with no `from` for a new run, or with the settings of a run to run again.
  const [starting, setStarting] = useState<{ from?: StartFrom } | null>(null);
  const [editing, setEditing] = useState(false);
  const now = useNow(1000);

  const me = session.me.memberId;
  const isOwner = task?.owner.memberId === me;
  const closed = task?.closedAt !== undefined;
  const people = session.members.filter((m) => m.kind === "person");
  const waitingOn = [
    ...new Set((task?.waitingOn ?? []).map((w) => (w.memberId === me ? "you" : w.name))),
  ];
  const keptRun = task?.runs.find((r) => r.runId === task.keptRunId);
  // Every run finished: settling is the next step, so it's the primary action.
  const allFinished = Boolean(
    task &&
    !closed &&
    task.runs.length > 0 &&
    task.runs.every((r) => r.state === "done" || r.state === "failed" || r.state === "stopped"),
  );

  // Settled since its runs last changed: put away until one changes state again (GLOSSARY.md, "Settle").
  const settled = Boolean(task?.settled);

  const anyLive = Boolean(
    task?.runs.some((r) => r.state === "working" || r.state === "waiting" || r.state === "unknown"),
  );
  // An agent conversation's runs are one chat; every other run is a card (ADR 0041).
  const groups = groupRuns(task?.runs ?? []);

  return (
    <WorkDrawer className="drawer work-ui task-panel" label="Task" onClose={onClose}>
      <div className="drawer-head">
        <h1 className="drawer-title" title={task?.title}>
          {task?.title ?? "Task"}
        </h1>
        {allFinished && !settled ? (
          <Button
            className="btn primary"
            pendingAnnouncement="Settling"
            onClick={() => settleTask({ taskId })}
            // The tooltip goes inside: around the Button it would swallow the Promise that keeps it pending.
            render={(props) => (
              <Tip label="Settle (S in the Inbox)">
                <button type="button" {...props} />
              </Tip>
            )}
          >
            <span className="control-label">Settle</span>
          </Button>
        ) : null}
        <button className="btn" type="button" disabled={!task} onClick={() => setEditing(true)}>
          <span className="control-label">Edit</span>
        </button>
        <Tip label={closed ? "This task is closed: a run was kept." : ""}>
          <button
            // The primary action only while nothing runs: with a run live, the run's own controls lead.
            className={allFinished || anyLive ? "btn" : "btn primary"}
            type="button"
            disabled={!task || closed}
            onClick={() => setStarting({})}
          >
            <Icon name="plus" />
            <span className="control-label"> Start a run</span>
          </button>
        </Tip>
        <Tip label="Close task">
          <DialogClose className="btn icon" aria-label="Close task">
            <Icon name="close" />
          </DialogClose>
        </Tip>
      </div>
      {task ? (
        <div className="drawer-body">
          <div className="task-facts">
            <div className="task-state">
              {closed ? (
                <>
                  <StateIcon state="done" />
                  <span className="state-done">
                    Closed{keptRun ? `: kept the ${runLabel(keptRun)} run` : ""}
                  </span>
                </>
              ) : (
                <>
                  {(() => {
                    // One run: its own state. Several: each counted, so this line can't lead with a
                    // state another screen leads with differently.
                    const machineOff = (r: RunView) =>
                      Boolean(r.machine && offline.has(r.machine.machineId));
                    const going = task.runs.filter(
                      (r) =>
                        r.state === "waiting" || r.state === "working" || r.state === "unknown",
                    );
                    const allOffline = going.length > 0 && going.every(machineOff);
                    const reachable = task.runs.some(
                      (r) => r.state === "waiting" && !machineOff(r),
                    );
                    if (task.runs.length > 1) {
                      return (
                        <>
                          <StateIcon
                            state={allOffline ? "unknown" : task.state}
                            glyph={allOffline ? "offline" : undefined}
                          />
                          <span className="task-summary">{stateSummary(task.runs, offline)}</span>
                          {reachable && waitingOn.length > 0 ? (
                            <span className="state-waiting">
                              Waiting on {waitingNames(waitingOn)}
                            </span>
                          ) : null}
                        </>
                      );
                    }
                    const lead = task.runs[0];
                    const shown = lead ? showRun(lead, now, machineOff(lead)) : undefined;
                    const icon = shown?.icon ?? task.state;
                    return (
                      <>
                        <StateIcon state={icon} glyph={shown?.glyph} />
                        <span className={`state-${icon}`}>
                          {shown?.label ?? STATE_META[task.state].label}
                          {lead?.state === "waiting" && !shown?.offline && waitingOn.length > 0
                            ? ` on ${waitingNames(waitingOn)}`
                            : ""}
                        </span>
                      </>
                    );
                  })()}
                  {settled ? (
                    <span className="task-settled">
                      <Icon name="check" size={14} /> Settled
                    </span>
                  ) : null}
                </>
              )}
            </div>
            <label className="task-fact">
              <span>Owner</span>
              <span className="task-fact-value">
                <MemberFace member={task.owner} members={session.members} size={20} />
                <Picker
                  label="Owner"
                  value={task.owner.memberId}
                  options={people.map((person) => ({
                    value: person.memberId,
                    label: person.memberId === me ? `${person.name} (you)` : person.name,
                  }))}
                  onChange={(ownerId) => void update({ taskId, ownerId: ownerId as Id<"members"> })}
                />
              </span>
            </label>
            <label className="task-fact">
              <span>Project</span>
              <span className="task-fact-value">
                <Icon name="folder" />
                <Picker
                  label="Project"
                  value={task.projectId ?? NONE}
                  options={[
                    { value: NONE, label: "No project" },
                    ...(projects ?? []).map((project) => ({
                      value: project.projectId,
                      label: project.name,
                    })),
                  ]}
                  onChange={(projectId) =>
                    void update({
                      taskId,
                      projectId: (projectId === NONE ? null : projectId) as Id<"projects"> | null,
                    })
                  }
                />
              </span>
            </label>
          </div>
          {task.description ? <p className="task-description">{task.description}</p> : null}
          <TaskPlan task={task} />

          <section className="field" aria-label="Runs">
            <div className="section-label">
              <span>Runs</span>
              {groups.length > 1 ? (
                <span className="hint">Side by side, to compare what each one did.</span>
              ) : null}
            </div>
            {task.runs.length === 0 ? (
              <div className="runs-empty">
                <p>
                  No runs yet. Start one, or start several with different agents and keep the one
                  that does it best.
                </p>
              </div>
            ) : (
              <div className="runs-grid">
                {groups.map((group) =>
                  group.kind === "chat" ? (
                    <A2AChat
                      key={group.key}
                      runs={group.runs}
                      nav={nav}
                      kept={group.runs.some((r) => r.runId === task.keptRunId)}
                      canKeep={isOwner && !closed}
                      onKeep={(run) => keepRun({ taskId, runId: run.runId })}
                    />
                  ) : (
                    <RunCard
                      key={group.run.runId}
                      run={group.run}
                      me={me}
                      now={now}
                      machineOffline={Boolean(
                        group.run.machine && offline.has(group.run.machine.machineId),
                      )}
                      kept={task.keptRunId === group.run.runId}
                      // Keeping a run closes the task, even when it's the task's only run.
                      canKeep={isOwner && !closed}
                      onRunAgain={
                        closed || group.run.a2a || group.run.spaceId || !group.run.machine
                          ? undefined
                          : () =>
                              setStarting({
                                from: {
                                  harness: group.run.harness,
                                  machineId: group.run.machine!.machineId,
                                  repo: group.run.repo,
                                  via: group.run.terminalId ? "terminal" : "thread",
                                },
                              })
                      }
                      canAnswer={
                        session.isAdmin ||
                        isOwner ||
                        group.run.driver?.memberId === session.me.memberId
                      }
                      onKeep={() => keepRun({ taskId, runId: group.run.runId })}
                      onStop={() => stopRun({ runId: group.run.runId })}
                      onOpenTerminal={() =>
                        group.run.terminalId && nav.openTerminal(group.run.terminalId)
                      }
                      onOpenSpace={() => group.run.spaceId && nav.openSpace(group.run.spaceId)}
                      onOpenThread={() => nav.openThread(group.run.runId)}
                      // Names the approval on screen; a stale one is refused and `useAct` shows why.
                      onAnswer={async (value) => {
                        const done = await answer({
                          runId: group.run.runId,
                          answer: value,
                          promptId: group.run.prompt?.promptId ?? "",
                        });
                        if (done !== undefined)
                          track("approval_answered", { answer: value, from: "task" });
                      }}
                      members={session.members}
                    />
                  ),
                )}
              </div>
            )}
          </section>
        </div>
      ) : null}
      {starting && task ? (
        <StartRunDialog
          taskId={taskId}
          projectId={task.projectId}
          onClose={() => setStarting(null)}
          nav={nav}
          {...(starting.from ? { from: starting.from } : {})}
        />
      ) : null}
      {editing && task ? (
        <EditTaskDialog
          title={task.title}
          description={task.description ?? ""}
          onClose={() => setEditing(false)}
          onSave={async (title, description) => {
            const saved = await update({ taskId, title, description });
            if (saved !== undefined) setEditing(false);
          }}
        />
      ) : null}
    </WorkDrawer>
  );
}

function EditTaskDialog({
  title: initialTitle,
  description: initialDescription,
  onClose,
  onSave,
}: {
  title: string;
  description: string;
  onClose: () => void;
  onSave: (title: string, description: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  return (
    <Dialog
      title="Edit task"
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            <span className="control-label">Cancel</span>
          </button>
          <Button
            className="btn primary"
            disabled={!title.trim()}
            pendingAnnouncement="Saving"
            onClick={() => onSave(title.trim(), description)}
          >
            <span className="control-label">Save task</span>
          </Button>
        </>
      }
    >
      <Field className="field">
        <FieldLabel className="label">Title</FieldLabel>
        <Input
          id="task-title"
          className="input"
          value={title}
          autoFocus
          onValueChange={(value) => setTitle(value)}
        />
      </Field>
      <Field className="field">
        <FieldLabel className="label">Description</FieldLabel>
        <Textarea
          id="task-description"
          className="textarea"
          rows={5}
          value={description}
          placeholder="What done looks like, so a run knows when to stop."
          onValueChange={(value) => setDescription(value)}
        />
      </Field>
    </Dialog>
  );
}

function RunCard({
  run,
  me,
  now,
  machineOffline,
  kept,
  canKeep,
  canAnswer,
  onKeep,
  onRunAgain,
  onStop,
  onOpenTerminal,
  onOpenSpace,
  onOpenThread,
  onAnswer,
  members,
}: {
  run: RunView;
  me: string;
  now: number;
  machineOffline: boolean;
  kept: boolean;
  canKeep: boolean;
  canAnswer: boolean;
  onKeep: () => unknown;
  /** Opens Start a run with this run's harness, machine and repo. */
  onRunAgain: (() => void) | undefined;
  onStop: () => unknown;
  onOpenTerminal: () => void;
  onOpenSpace: () => void;
  onOpenThread: () => void;
  onAnswer: (answer: "allow" | "deny") => unknown;
  members: ReturnType<typeof useSession>["members"];
}) {
  const finished = run.state === "done" || run.state === "failed" || run.state === "stopped";
  // Why it failed: the room's reason, or else the last line its terminal printed.
  // A private run's terminal is not_found for you (admins too), so nothing here reads it.
  const terminalId = previewTerminal(run);
  const { terminal: failedTerminal, tail: failedTail } = useTerminalTail(
    run.state === "failed" ? terminalId : undefined,
    3,
  );
  // The terminal's exit code, when its process exited on its own (#96).
  const exitCode = run.state === "failed" ? failedTerminal?.exitCode : undefined;
  // One reason line, the same words as the run's Inbox row: the room's reason, or else the last
  // line before the shell's prompt. The excerpt below keeps the lines around it.
  const why =
    run.state === "failed" && !run.a2a
      ? (failText(run.failReason) ?? dropTrailingPrompts(failedTail ?? []).at(-1))
      : undefined;
  const shown = showRun(run, now, machineOffline);
  // An answer given after this prompt arrived answers it: the machine hasn't moved on yet, so it
  // shows as sent, with no buttons. A prompt that arrived after an answer to the same command is
  // asked again.
  // An answer still on its way hides the buttons; one that didn't land brings them back.
  const delivery = answerState(run, now);
  const answeredPending = delivery === "sending";
  const askedAgain =
    run.state === "waiting" &&
    delivery === "none" &&
    run.prompt?.action !== undefined &&
    run.lastAnswer?.action === run.prompt.action;
  return (
    <div className={`run-card work-ui ${kept ? "kept" : ""}`}>
      <div className="run-card-head">
        {run.driver?.kind === "agent" ? (
          <MemberFace member={run.driver} members={members} state={run.state} size={24} />
        ) : (
          <HarnessMark
            harness={run.harness}
            state={run.state === "unknown" ? "working" : run.state}
          />
        )}
        <b className="run-card-name">{runLabel(run)}</b>
        {kept ? <span className="chip kept-chip">Kept</span> : null}
      </div>
      {/* The state has one row of its own on every card, so cards side by side line up. */}
      <div className="run-card-state">
        <StateIcon state={shown.icon} glyph={shown.glyph} withLabel label={shown.label} />
        {shown.time ? (
          <span className={shown.ticking ? "mono muted" : "muted"}>{shown.time}</span>
        ) : null}
      </div>
      <div className="run-card-meta">
        {!run.a2a && run.joined ? (
          <span>Joined by itself</span>
        ) : !run.a2a ? (
          <span className="run-location">
            <span>Machine</span>
            <span className={run.machine?.name ? "mono" : undefined}>
              {run.machine?.name ?? "machine gone"}
            </span>
          </span>
        ) : null}
        {run.repo ? (
          <span className="run-location">
            <span>Repository</span>
            <span>{run.repo}</span>
          </span>
        ) : null}
        {/* Your own control goes without saying; someone else's, or nobody's, is worth a line. */}
        {run.driver?.memberId === me ? null : (
          <span className="truncate">
            {run.driver ? `Controlled by ${run.driver.name}` : "Nobody is in control"}
          </span>
        )}
      </div>
      {run.state === "waiting" && run.prompt ? (
        <div className={`prompt-box band ${machineOffline ? "quiet" : ""}`}>
          <div>
            {askedAgain && run.lastAnswer ? (
              <span className="asked-again">
                <span className="tag">Asked again</span>{" "}
                {run.lastAnswer.by.memberId === me ? "You" : run.lastAnswer.by.name}{" "}
                {run.lastAnswer.answer === "allow" ? "allowed" : "denied"} this{" "}
                {agoText(run.lastAnswer.at, now)}.
              </span>
            ) : null}
            {run.prompt.action ? (
              <>
                {run.prompt.text.replace(run.prompt.action, "").trim() || "Wants to run"}{" "}
                <Cmd text={run.prompt.action} />
              </>
            ) : (
              run.prompt.text
            )}
          </div>
          {answeredPending && run.lastAnswer ? (
            <span className="hint">
              {run.lastAnswer.by.memberId === me ? "You" : run.lastAnswer.by.name}{" "}
              {run.lastAnswer.answer === "allow" ? "allowed" : "denied"} it{" "}
              {agoText(run.lastAnswer.at, now)}. Waiting for {run.machine?.name ?? "the machine"} to
              go on.
            </span>
          ) : run.prompt.kind === "approval" && machineOffline ? (
            <span className="hint">
              {run.machine?.name ?? "Its machine"} is offline, so an answer can't reach it.
            </span>
          ) : run.prompt.kind === "approval" && canAnswer ? (
            <>
              {delivery === "failed" ? (
                <span className="hint state-failed">Couldn't deliver your answer, try again.</span>
              ) : null}
              <div className="row-flex">
                <button className="btn primary" type="button" onClick={() => onAnswer("allow")}>
                  <span className="control-label">Allow</span>
                </button>
                <button className="btn" type="button" onClick={() => onAnswer("deny")}>
                  <span className="control-label">Deny</span>
                </button>
              </div>
            </>
          ) : !canAnswer || run.prompt.kind !== "approval" ? (
            <span className="hint">
              {run.driver && run.driver.memberId !== me
                ? `${run.driver.name} is in control of this run, so it waits in ${run.driver.name}'s Inbox to answer.`
                : "Answer it in its terminal."}
            </span>
          ) : null}
        </div>
      ) : null}
      {why || exitCode !== undefined ? (
        <div className="run-fail">
          {exitCode !== undefined ? <b>Exited with code {exitCode}. </b> : null}
          {why}
        </div>
      ) : null}
      {run.private ? <p className="hint">Private run</p> : null}
      {terminalId ? (
        <RunOutput
          terminalId={terminalId}
          onOpen={onOpenTerminal}
          finished={finished}
          failed={run.state === "failed"}
        />
      ) : null}
      {run.joined ? <JoinedNote finished={finished} /> : null}
      {/* The last answer folds into one line once the run has moved on (DESIGN.md, Conversations). */}
      {run.lastAnswer && run.state !== "waiting" ? (
        <div className="hint">
          {run.lastAnswer.by.memberId === me ? "You" : run.lastAnswer.by.name}{" "}
          {run.lastAnswer.answer === "allow" ? "allowed" : "denied"}
          {run.lastAnswer.action ? (
            <>
              {" "}
              <Cmd text={run.lastAnswer.action} />
            </>
          ) : null}
          {run.lastAnswer.by.kind === "agent" && run.lastAnswer.by.addedBy
            ? `, for ${run.lastAnswer.by.addedBy.name}`
            : ""}
          <span className="faint-time" title={formatTime(run.lastAnswer.at)}>
            {" "}
            {agoText(run.lastAnswer.at, now)}
          </span>
        </div>
      ) : null}
      <div className="run-card-actions">
        {terminalId ? (
          // Quiet: a running task needs nothing from you, so nothing on its card is loud.
          <button className="btn" type="button" onClick={onOpenTerminal}>
            <Icon name="terminal" />
            <span className="control-label"> Open terminal</span>
          </button>
        ) : null}
        {run.spaceId && !run.private ? (
          <button className="btn primary" type="button" onClick={onOpenSpace}>
            <Icon name="machine" />
            <span className="control-label"> Open Space</span>
          </button>
        ) : null}
        {run.threadRef && !run.private ? (
          <button className="btn primary" type="button" onClick={onOpenThread}>
            <Icon name="comment" />
            <span className="control-label"> Open thread</span>
          </button>
        ) : null}
        {/* Keeping a run closes the task, so it's offered once the run has finished its work. */}
        {canKeep && (run.state === "done" || run.state === "stopped") ? (
          <Tip label="Keeps this run as the task's result and closes the task.">
            <button className="btn" type="button" onClick={onKeep}>
              <Icon name="check" />
              <span className="control-label"> Keep this run</span>
            </button>
          </Tip>
        ) : null}
        {onRunAgain && (run.state === "failed" || run.state === "stopped") ? (
          <button className="btn" type="button" onClick={onRunAgain}>
            <span className="control-label">Run again</span>
          </button>
        ) : null}
        <span className="grow" />
        {!finished && !run.a2a ? (
          // Terminal runs and T3 Code thread runs both stop from the room (`stop_thread`).
          <Tip
            label={
              machineOffline
                ? `${run.machine?.name ?? "Its machine"} is offline: the run is marked stopped here now, and the machine gets the stop when its bridge is back.`
                : ""
            }
          >
            <button className="btn stop-run" type="button" onClick={onStop}>
              <Icon name="stop" />{" "}
              <span className="control-label">
                {machineOffline ? "Mark stopped" : run.spaceId ? "Stop sharing" : "Stop"}
              </span>
            </button>
          </Tip>
        ) : null}
      </div>
    </div>
  );
}

/** A short tag for why a machine can't take a run; its line below says it in full. */
function blockTag(block: string): string {
  const level = /is set to (View|Suggest): teammates/.exec(block)?.[1];
  if (level) return `Set to ${level}`;
  if (block.startsWith("Its bridge is offline")) return "Offline";
  if (block.startsWith("Sharing is stopped")) return "Sharing stopped";
  if (block.startsWith("No free slot")) return "No free slot";
  if (block.includes("deleted")) return "Being deleted";
  return "Unavailable";
}

/** A run's settings to start it again: Run again on a failed or stopped run fills the dialog with them. */
export type StartFrom = {
  harness: string;
  machineId: Id<"machines">;
  repo: string | undefined;
  via: "terminal" | "thread" | "rex";
};

/** Where a run goes: a T3 Code thread only for a harness T3 Code can run, else a shared terminal; or a Rex tab. */
export function whereItRuns(harness: string, via: Via): Via {
  return via === "thread" && threadRefusal(harness) ? "terminal" : via;
}

type Via = "terminal" | "thread" | "rex";

/**
 * Start a run's "Where it runs": a shared terminal, a T3 Code thread or a Rex tab. T3 Code can't run
 * every harness (a plain shell, Hermes Agent), so for those the thread choice is off and says why, and
 * the terminal shows as picked whatever was picked before. "In Rex" shows once a machine in the team
 * can open Rex tabs (ADR 0019), and says why it's off for the chosen machine.
 */
export function WhereItRuns({
  harness,
  via,
  onVia,
  rex,
}: {
  harness: string;
  via: Via;
  onVia: (via: Via) => void;
  /** Set when a machine in the team can open Rex tabs: why the chosen one can't (null: it can). */
  rex?: { block: string | null; machineName: string | undefined };
}) {
  const refusal = threadRefusal(harness);
  const where = whereItRuns(harness, via);
  const rexWhyId = useId();
  return (
    <div className="field work-ui">
      <span className="label">Where it runs</span>
      <SegmentedControl
        className="seg"
        aria-label="Where it runs"
        style={{ alignSelf: "flex-start" }}
        value={where}
        onValueChange={(next) => {
          if (next === "terminal" || next === "thread" || next === "rex") onVia(next);
        }}
      >
        <SegmentedControlItem value="terminal">
          <span className="control-label">In a shared terminal</span>
        </SegmentedControlItem>
        {/* Its tooltip says why it's off, the same words as the line under the control. */}
        <Tip label={refusal ?? ""}>
          <SegmentedControlItem value="thread" disabled={Boolean(refusal)}>
            <span className="control-label">As a T3 Code thread</span>
          </SegmentedControlItem>
        </Tip>
        {rex ? (
          <SegmentedControlItem
            value="rex"
            disabled={rex.block !== null}
            aria-describedby={rex.block ? rexWhyId : undefined}
          >
            <span className="control-label">In Rex</span>
          </SegmentedControlItem>
        ) : null}
      </SegmentedControl>
      {refusal ? <span className="hint">{refusal}</span> : null}
      {where === "rex" && rex?.machineName ? (
        <span className="hint">
          Opens a new tab in Rex on <span className="mono">{rex.machineName}</span>, in its Uplink
          Room session, so whoever is at that machine sees it too. Approvals are answered by typing
          in it.
        </span>
      ) : rex?.block ? (
        <span className="hint" id={rexWhyId}>
          In Rex is off. {rex.block}
        </span>
      ) : null}
    </div>
  );
}

export function StartRunDialog({
  taskId,
  projectId,
  onClose,
  nav,
  from,
  agentId: givenTo,
  toAgent = false,
}: {
  taskId: Id<"tasks">;
  projectId: Id<"projects"> | undefined;
  onClose: () => void;
  nav: Nav;
  from?: StartFrom;
  /** Opens on "An agent from the roster" with this agent picked (ADR 0044). */
  agentId?: Id<"agents"> | undefined;
  /** Opens on "An agent from the roster" with none picked yet. */
  toAgent?: boolean;
}) {
  const session = useSession();
  const { teamId } = session;
  const machines = useRoomQuery(api.machines.list, {});
  const projects = useRoomQuery(api.projects.list, {});
  const myProfiles = useRoomQuery(api.profiles.mine, {});
  const roster = useRoomQuery(api.teams.roster, {});
  // Only for what an A2A agent's gateway says about itself: its card's name and whether it can stop.
  const peers = useRoomQuery(api.a2a.list, {});
  const start = useAct(api.runs.start, { success: "Run started" });
  // Every agent in the roster can take a task (ADR 0044): over A2A, at its routine webhook, or when it checks in.
  const agents = (roster ?? []).flatMap((entry) =>
    entry.kind === "agent" && entry.agentId ? [{ ...entry, agentId: entry.agentId }] : [],
  );
  const [mode, setMode] = useState<"machine" | "agent">(givenTo || toAgent ? "agent" : "machine");
  const [agentId, setAgentId] = useState<string>(givenTo ?? "");
  const picked = agents.find((a) => a.agentId === agentId);

  const [harness, setHarness] = useState(from?.harness ?? "claude-code");
  const [via, setVia] = useState<"terminal" | "thread" | "rex">(from?.via ?? "terminal");
  const [machineId, setMachineId] = useState<string>(from?.machineId ?? "");
  const [repo, setRepo] = useState(from?.repo ?? "");
  const [profileId, setProfileId] = useState<string>("");
  const [access, setAccess] = useState<Access>("watch");
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("approval-required");
  const [prompt, setPrompt] = useState("");
  const [showBlocked, setShowBlocked] = useState(false);

  const projectRepos = projects?.find((p) => p.projectId === projectId)?.repos ?? [];
  const mineOn = (machine: MachineRow) =>
    machine.belongsTo.kind === "person" &&
    machine.belongsTo.member.memberId === session.me.memberId;

  // Default to the first machine that can take the run. Run again keeps the run's own machine
  // unless that machine can't take it now (offline, say).
  useEffect(() => {
    if (!machines) return;
    const picked = machines.find((m) => m.machineId === machineId);
    if (picked && machineBlock(picked, mineOn(picked)) === null) return;
    const first = defaultMachine(machines, mineOn);
    if (first) setMachineId(first.machineId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machines]);
  useEffect(() => {
    if (!repo && projectRepos[0]) setRepo(projectRepos[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRepos.join(",")]);

  const machine = machines?.find((m) => m.machineId === machineId);
  const fromMachine = from
    ? machines?.find((m) => m.machineId === from.machineId)?.name
    : undefined;
  const profilesHere = (myProfiles ?? []).filter(
    (p) => p.machine?.machineId === machineId && p.status === "ready",
  );
  // Only some harnesses keep a profile's logins apart from the machine setup; the rest use it.
  const noProfile = profileRefusal(harness);
  // T3 Code runs only the harnesses it has a provider for; the rest run in a terminal, whatever was picked.
  const where = whereItRuns(harness, via);
  const pickHarness = (next: string) => {
    setHarness(next);
    if (threadRefusal(next)) setVia((current) => (current === "thread" ? "terminal" : current));
  };
  // "In Rex" shows once any machine in the team can open Rex tabs, and says why it's off for this one.
  const offersRex = (machines ?? []).some((m) => m.rex?.available);
  const noRex = rexBlock(machine);
  useEffect(() => {
    if (via === "rex" && noRex) setVia("terminal");
  }, [via, noRex]);
  // A first prompt goes to a thread, or on the command line of a harness whose CLI takes one in Rex.
  const takesPrompt = where === "thread" || (where === "rex" && takesFirstPrompt(harness));

  // What the agent may do (ADR 0043): a thread takes every mode its provider offers; a terminal only
  // where the room starts it with flags (Claude Code and Codex); a run in Rex starts as set up.
  const modes: readonly RuntimeMode[] =
    where === "thread"
      ? RUNTIME_MODES
      : where === "terminal"
        ? (terminalModes(harness) as RuntimeMode[])
        : [];
  const modeCap = machine?.mostPermissiveMode;
  useEffect(() => {
    if (
      !modes.includes(runtimeMode) ||
      (modeCap && runtimeModeRank(runtimeMode) > runtimeModeRank(modeCap))
    )
      setRuntimeMode("approval-required");
  }, [modes.join(","), modeCap, runtimeMode]);
  // A machine's limit can be lower than the level picked; drop to what it allows.
  useEffect(() => {
    if (machine && accessRank(access) > accessRank(machine.mostOpenAccess))
      setAccess(machine.mostOpenAccess);
  }, [machine, access]);
  useEffect(() => {
    setProfileId("");
  }, [machineId]);
  useEffect(() => {
    if (noProfile) setProfileId("");
  }, [noProfile]);

  const submitAgent = async () => {
    if (!agentId) return;
    const result = await start({
      taskId,
      via: "agent",
      agentId: agentId as Id<"agents">,
      ...(prompt.trim() ? { prompt } : {}),
    });
    if (result) {
      if (picked?.reach === "a2a")
        track("run_started", { harness: "a2a", kind: "a2a", access: "none", has_profile: false });
      onClose();
    }
  };

  const submit = async () => {
    if (mode === "agent") return submitAgent();
    if (!machine) return;
    const result = (await start({
      taskId,
      harness,
      machineId: machine.machineId,
      via: where,
      ...(repo.trim() ? { repo: repo.trim() } : {}),
      ...(where === "terminal"
        ? { access, ...(profileId ? { profileId: profileId as Id<"profiles"> } : {}) }
        : {}),
      ...(where === "rex" ? { access } : {}),
      ...(takesPrompt && prompt.trim() ? { prompt } : {}),
      ...(modes.length && runtimeMode !== "approval-required" ? { runtimeMode } : {}),
    })) as { runId: Id<"runs">; terminalId: Id<"terminals"> | undefined } | undefined;
    if (result) {
      track("run_started", {
        harness: harnessName(harness),
        // A run in Rex is a shared terminal too.
        kind: runKind(harness, where === "thread" ? "thread" : "terminal", Boolean(machine.cloud)),
        access: where === "thread" ? "none" : access,
        has_profile: where === "terminal" && Boolean(profileId),
      });
      onClose();
      if (result.terminalId) nav.openTerminal(result.terminalId);
    }
  };
  void useQuery; // (queries above go through useRoomQuery; kept for the team id import)
  void teamId;

  return (
    <Dialog
      wide
      title={mode === "agent" ? "Give to an agent" : from ? "Run again" : "Start a run"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            <span className="control-label">Cancel</span>
          </button>
          <Button
            className="btn primary"
            disabled={mode === "agent" ? !agentId : !machine}
            pendingAnnouncement="Starting"
            onClick={submit}
          >
            <span className="control-label">
              {mode === "agent"
                ? picked
                  ? `Give to ${picked.name}`
                  : "Give to an agent"
                : from
                  ? "Run again"
                  : "Start run"}
            </span>
          </Button>
        </>
      }
    >
      {from ? (
        <p className="run-again-note">
          Starts the {harnessLabel(from.harness)} run{fromMachine ? ` from ${fromMachine}` : ""}{" "}
          again
          {from.repo ? (
            <>
              {" "}
              in <span>{from.repo}</span>
            </>
          ) : null}
          . Change anything below first.
        </p>
      ) : null}
      {agents.length > 0 ? (
        <div className="field">
          <span className="label">Who works on it</span>
          <SegmentedControl
            className="seg"
            aria-label="Machine or agent"
            style={{ alignSelf: "flex-start" }}
            value={mode}
            onValueChange={(next) => {
              if (next === "machine" || next === "agent") setMode(next);
            }}
          >
            <SegmentedControlItem value="machine">
              <span className="control-label">A harness on a machine</span>
            </SegmentedControlItem>
            <SegmentedControlItem value="agent">
              <span className="control-label">An agent from the roster</span>
            </SegmentedControlItem>
          </SegmentedControl>
        </div>
      ) : null}
      {mode === "agent" ? (
        <>
          <div className="field">
            <span className="label">Agent</span>
            <RadioGroup
              className="option-list"
              aria-label="Agent"
              value={agentId || null}
              onValueChange={(next) => {
                if (next) setAgentId(next);
              }}
            >
              {agents.map((agent) => {
                const peer =
                  agent.reach === "a2a"
                    ? peers?.find((p) => p.agentId === agent.agentId)
                    : undefined;
                return (
                  <Radio
                    key={agent.agentId}
                    value={agent.agentId}
                    className={`option machine-option ${agentId === agent.agentId ? "selected" : ""}`}
                  >
                    <Face
                      who={{ name: agent.name, kind: "agent", character: agent.character }}
                      state={agent.state}
                      size={24}
                    />
                    <span>{agent.name}</span>
                    {peer ? (
                      <span className="muted">{peer.card?.name ?? peer.cardUrl}</span>
                    ) : (
                      <span />
                    )}
                    <span className="sub">
                      {agent.reach === "a2a" ? (
                        <>
                          It runs on its own gateway. The room follows its task and shows what it
                          reports.
                          {peer?.cancel === "unsupported"
                            ? " Its gateway can't be asked to stop."
                            : ""}
                        </>
                      ) : agent.reach === "webhook" ? (
                        "Its routine gets the task. It reports back here."
                      ) : (
                        "It sees the task when it checks the room."
                      )}
                    </span>
                  </Radio>
                );
              })}
            </RadioGroup>
          </div>
          <Field className="field">
            <FieldLabel className="label">What to tell it</FieldLabel>
            <Textarea
              id="a2a-prompt"
              className="textarea"
              placeholder="Leave empty to send the task's title and description."
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </Field>
        </>
      ) : (
        <>
          <div className="field">
            <span className="label">Harness</span>
            <SegmentedControl
              className="seg harness-options"
              aria-label="Harness"
              value={harness}
              onValueChange={(next) => {
                if (next) pickHarness(next);
              }}
            >
              {STARTABLE_HARNESSES.map((h) => (
                <SegmentedControlItem key={h} value={h}>
                  <span className="control-label">{harnessLabel(h)}</span>
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
            {agents.length === 0 && !from ? (
              // One line, so the form (and Access) starts high enough to show at the smallest window.
              <span className="hint">Outside agents and shared desktops join from Settings.</span>
            ) : null}
          </div>

          <WhereItRuns
            harness={harness}
            via={via}
            onVia={setVia}
            {...(offersRex ? { rex: { block: noRex, machineName: machine?.name } } : {})}
          />

          <Field className="field">
            <FieldLabel className="label">Repo</FieldLabel>
            {projectRepos.length > 0 ? (
              <Picker
                id="run-repo"
                value={repo || NONE}
                options={[
                  ...projectRepos.map((r) => ({ value: r, label: r })),
                  { value: NONE, label: "No repo" },
                ]}
                onChange={(next) => setRepo(next === NONE ? "" : next)}
              />
            ) : (
              <Input
                id="run-repo"
                className="input"
                placeholder="owner/name"
                value={repo}
                onValueChange={(value) => setRepo(value)}
              />
            )}
            <FieldDescription className="hint">
              {projectId
                ? projectRepos.length
                  ? "From the project's repo list."
                  : "This project lists no repos yet. Add them on its board."
                : "This task has no project, so type the repo."}
            </FieldDescription>
          </Field>

          <div className="field">
            <span className="label">Machine</span>
            <RadioGroup
              className="option-list"
              aria-label="Machine"
              value={machineId || null}
              onValueChange={(next) => {
                if (next) setMachineId(next);
              }}
            >
              {machines === undefined ? null : machines.length === 0 ? (
                <div className="note">
                  No machines are linked yet. Pair one in Settings, then come back.
                </div>
              ) : (
                (() => {
                  // Machines that can take the run are listed; the rest fold into one line that
                  // names them, so the dialog's own choices stay in view.
                  const option = (m: MachineRow) => {
                    const mine = mineOn(m);
                    const block = machineBlock(m, mine);
                    const free = slotsFree(m);
                    return (
                      <Radio
                        key={m.machineId}
                        value={m.machineId}
                        className={`option machine-option ${machineId === m.machineId ? "selected" : ""}`}
                        disabled={block !== null}
                      >
                        <Icon name="machine" />
                        <span className="mono">{m.name}</span>
                        {block ? (
                          <span className="tag">{blockTag(block)}</span>
                        ) : (
                          <span className="muted">
                            {mine
                              ? "Yours, no slot used"
                              : `${Math.max(0, free)} of ${m.slots} slot${m.slots === 1 ? "" : "s"} free`}
                          </span>
                        )}
                        <span className="sub">
                          {takesOnlyItsPersonsRuns(m, mine) ? (
                            // The reason already says whose machine it is and its level.
                            block
                          ) : (
                            <>
                              {m.belongsTo.kind === "team"
                                ? "Team machine"
                                : mine
                                  ? "Your machine"
                                  : `${m.belongsTo.member.name}'s machine`}{" "}
                              with up to {ACCESS_META[m.mostOpenAccess].label}
                              {block ? `. ${block}` : wakesOnRun(m) ? ". Starts when you run" : ""}
                            </>
                          )}
                        </span>
                      </Radio>
                    );
                  };
                  const open = machines.filter((m) => machineBlock(m, mineOn(m)) === null);
                  const blocked = machines.filter((m) => machineBlock(m, mineOn(m)) !== null);
                  // With nothing to pick, the machines that can't take the run show at once, each with why.
                  if (open.length === 0) return <>{blocked.map(option)}</>;
                  return (
                    <>
                      {open.map(option)}
                      {blocked.length > 0 ? (
                        <button
                          type="button"
                          className="blocked-toggle"
                          aria-expanded={showBlocked}
                          onClick={() => setShowBlocked((v) => !v)}
                        >
                          <Icon name={showBlocked ? "chevron-down" : "chevron"} size={14} />
                          {blocked.length} can't take a run now:{" "}
                          <span className="mono">{blocked.map((m) => m.name).join(", ")}</span>
                        </button>
                      ) : null}
                      {showBlocked ? blocked.map(option) : null}
                    </>
                  );
                })()
              )}
            </RadioGroup>
          </div>

          {where !== "thread" ? (
            <>
              <Field className="field">
                <FieldLabel className="label">Logins and settings</FieldLabel>
                {where === "rex" ? (
                  <span className="hint">
                    A run in Rex uses the machine setup: Rex starts the tab with its own
                    environment, so a profile's logins can't be kept apart there.
                  </span>
                ) : noProfile ? (
                  <span className="hint" title={noProfile}>
                    {harnessLabel(harness)} uses the machine setup: the logins, settings and skills
                    the machine already has.
                  </span>
                ) : (
                  <Picker
                    id="run-profile"
                    value={profileId || NONE}
                    disabled={!machine}
                    options={[
                      {
                        value: NONE,
                        label:
                          "Machine setup (the logins, settings and skills the machine already has)",
                      },
                      ...profilesHere.map((profile) => ({
                        value: profile.profileId as string,
                        label: `My profile: ${profile.name}`,
                      })),
                    ]}
                    onChange={(next) => setProfileId(next === NONE ? "" : next)}
                  />
                )}
                {noProfile || where === "rex" ? null : (
                  <FieldDescription className="hint">
                    To use your own logins, make a profile on this machine in Settings, then
                    Profiles.
                  </FieldDescription>
                )}
              </Field>

              <div className="field">
                <span className="label">Teammates can</span>
                <SegmentedControl
                  className="seg"
                  aria-label="Teammates can"
                  style={{ gridTemplateColumns: "repeat(4, 1fr)" }}
                  value={access}
                  onValueChange={(next) => {
                    if (next) setAccess(next as Access);
                  }}
                >
                  {ACCESS_LEVELS.map((level) => {
                    const blocked = machine
                      ? accessRank(level) > accessRank(machine.mostOpenAccess)
                      : false;
                    return (
                      <Tip
                        key={level}
                        label={
                          blocked
                            ? `This machine allows at most ${ACCESS_META[machine!.mostOpenAccess].label}.`
                            : ""
                        }
                      >
                        <SegmentedControlItem value={level} disabled={blocked}>
                          <Icon
                            name={
                              level === "watch"
                                ? "eye"
                                : level === "suggest"
                                  ? "suggest"
                                  : level === "drive"
                                    ? "wheel"
                                    : "open"
                            }
                          />
                          <span className="segment-label">{ACCESS_META[level].label}</span>
                        </SegmentedControlItem>
                      </Tip>
                    );
                  })}
                </SegmentedControl>
                {/* Whoever starts a terminal drives it, so the line speaks to the driver. */}
                <span className="hint">
                  {accessLine(access, "terminal", { me: true })}
                  {machine && accessRank(machine.mostOpenAccess) < 3
                    ? ` Levels above ${ACCESS_META[machine.mostOpenAccess].label} are off: ${machine.name} allows at most ${ACCESS_META[machine.mostOpenAccess].label}.`
                    : ""}
                </span>
              </div>
            </>
          ) : null}
          {modes.length ? (
            <Field className="field">
              <FieldLabel className="label">What {harnessLabel(harness)} may do</FieldLabel>
              <Picker
                id="run-mode"
                value={runtimeMode}
                options={modes.map((mode) => ({
                  value: mode,
                  label:
                    mode === "approval-required" && where === "terminal"
                      ? TERMINAL_DEFAULT_LABEL
                      : MODE_META[mode].label,
                  disabled: Boolean(modeBlock(mode, { cap: modeCap, machineName: machine?.name })),
                }))}
                onChange={(next) => setRuntimeMode(next as RuntimeMode)}
              />
              <FieldDescription className="hint">
                {runtimeMode === "approval-required" && where === "terminal"
                  ? `${harnessLabel(harness)} starts with its own settings on the machine, as it always has.`
                  : MODE_META[runtimeMode].line}
                {modeCap && modes.some((mode) => runtimeModeRank(mode) > runtimeModeRank(modeCap))
                  ? ` ${machine?.name ?? "This machine"} allows up to ${MODE_META[modeCap].label}; whoever it belongs to can allow more in Settings, Machines.`
                  : ""}
                {where === "thread"
                  ? " The driver can change it later from the thread's header."
                  : ""}
              </FieldDescription>
            </Field>
          ) : null}
          {takesPrompt ? (
            <Field className="field">
              <FieldLabel className="label">First prompt (optional)</FieldLabel>
              <Textarea
                id="run-prompt"
                className="textarea"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </Field>
          ) : null}
        </>
      )}
    </Dialog>
  );
}

/** One linked pull request as a line: where it is, its state, its review decision and its checks (ADR 0051). */
function pullRequestLine(pr: {
  pullRequestId: string;
  url: string;
  repo: string;
  number: number;
  title?: string;
  state?: "open" | "draft" | "merged" | "closed";
  review: "approved" | "changes_requested" | "none";
  checks: "passing" | "failing" | "pending" | "none";
  error?: string;
}): string {
  const name = `${pr.repo}#${pr.number}${pr.title ? ` ${pr.title}` : ""}`;
  if (!pr.state) return `${name}: ${pr.error ?? "reading it from GitHub"}`;
  const review = pr.review === "approved" ? "approved" : pr.review === "changes_requested" ? "changes requested" : null;
  const checks = pr.checks === "none" ? null : `checks ${pr.checks}`;
  return [`${name}: ${pr.state}`, review, checks].filter(Boolean).join(", ");
}

/**
 * Where the task stands in a plan (ADR 0050, ADR 0051): the tasks it waits for, its place in a
 * machine's queue, and its linked pull requests. A backend from before those sends none of them.
 */
function TaskPlan({
  task,
}: {
  task: {
    needs?: { taskId: string; title: string; closed: boolean }[];
    queued?: { machine: { name: string }; lastRefusal?: string };
    pullRequests?: Parameters<typeof pullRequestLine>[0][];
  };
}) {
  const needs = task.needs ?? [];
  const pulls = task.pullRequests ?? [];
  const open = needs.filter((need) => !need.closed);
  if (!needs.length && !task.queued && !pulls.length) return null;
  return (
    <section className="field" aria-label="Plan">
      <div className="section-label">
        <span>Plan</span>
      </div>
      <ul className="task-plan">
        {needs.length ? (
          <li>
            <span className="task-plan-label">Waits for</span>
            {needs.map((need) => (need.closed ? `${need.title} (closed)` : need.title)).join(", ")}
          </li>
        ) : null}
        {task.queued ? (
          <li>
            <span className="task-plan-label">Queued</span>
            {`Starts on ${task.queued.machine.name} by itself${open.length ? " once what it waits for is closed" : ""}`}
            {task.queued.lastRefusal ? `. Can't start yet: ${task.queued.lastRefusal}` : ""}
          </li>
        ) : null}
        {pulls.map((pr) => (
          <li key={pr.pullRequestId}>
            <span className="task-plan-label">Pull request</span>
            <a href={pr.url} target="_blank" rel="noreferrer">
              {pullRequestLine(pr)}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
