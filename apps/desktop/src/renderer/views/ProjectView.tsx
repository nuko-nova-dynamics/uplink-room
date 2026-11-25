import { useState } from "react";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Tabs, TabsList, TabsTab } from "@ui-sdk/react/tabs";
import { api, type Id, type TaskCard } from "../lib/api";
import { clock, runLabel } from "../lib/format";
import { useNow } from "../components/useNow";
import { useAct, useRoomQuery, useSession } from "../lib/session";
import { STATE_META, type AnyState } from "../lib/states";
import { boardColumn, offlineMachines, showRun, waitingNames } from "../lib/work";
import { Face, HarnessMark, MemberFace, StateIcon } from "../components/Faces";
import { Icon } from "../components/Icon";
import { Dialog } from "../components/Dialog";
import { Empty } from "../components/Empty";
import { FilesView } from "../components/files/FilesView";
import { NewTaskDialog } from "../components/NewWork";
import { RepoPicker } from "../components/RepoPicker";
import { Tip } from "../components/Tip";
import type { Nav } from "../Shell";
import { StartRunDialog } from "./TaskPanel";
import "./work.css";
import "../components/agentWork.css";
import "./project.css";

/** States a run doesn't leave: its machine being offline no longer changes what it shows. */
const FINISHED = new Set<string>(["done", "failed", "stopped"]);

/**
 * A project's tasks as one list, in sections that come from run states, most urgent first (as the
 * Inbox and T3 Code's thread list read): what waits on someone, what's working, what hasn't started,
 * what's done. An empty section isn't shown.
 */
const COLUMNS: { key: TaskCard["column"]; label: string; dot: AnyState; rule: string }[] = [
  {
    key: "needs_someone",
    label: "Needs someone",
    dot: "waiting",
    rule: "Tasks move here when a run waits on someone or fails.",
  },
  {
    key: "working",
    label: "Working",
    dot: "working",
    rule: "Tasks move here while a run is working.",
  },
  {
    key: "not_started",
    label: "Not started",
    dot: "not_started",
    rule: "New tasks wait here until their first run.",
  },
  {
    key: "done",
    label: "Done",
    dot: "done",
    rule: "Tasks move here once every run is done or stopped, or once they're settled.",
  },
];

/**
 * A project's board, or with no `projectId` the board of tasks that belong to no project, so a task
 * made with "No project" can still be found before it has runs (the Inbox lists only tasks with runs).
 */
export function ProjectView({
  projectId,
  nav,
}: {
  projectId: Id<"projects"> | undefined;
  nav: Nav;
}) {
  const session = useSession();
  const projects = useRoomQuery(api.projects.list, {});
  const project = projects?.find((p) => p.projectId === projectId);
  // Closed tasks (a run was kept) stay on the board in Done, so finished work is still findable here.
  const everyTask = useRoomQuery(
    api.tasks.board,
    projectId ? { projectId, includeClosed: true } : { includeClosed: true },
  );
  const board = projectId ? everyTask : everyTask?.filter((task) => task.projectId === undefined);
  const machines = useRoomQuery(api.machines.list, {});
  const offline = offlineMachines(machines);
  const [tab, setTab] = useState<"board" | "files">("board");
  const [creating, setCreating] = useState(false);
  const [editingRepos, setEditingRepos] = useState(false);
  // Give to an agent from a card (ADR 0044): offered once the team has an agent to give it to.
  const roster = useRoomQuery(api.teams.roster, {});
  const hasAgents = (roster ?? []).some((entry) => entry.kind === "agent" && entry.agentId);
  const [giving, setGiving] = useState<TaskCard | null>(null);
  const name = projectId ? (project?.name ?? "Project") : "No project";
  const head = (
    <>
      <h1 title={name}>{name}</h1>
      {projectId ? (
        <TabsList className="tabs" aria-label="Project">
          <TabsTab value="board">Tasks</TabsTab>
          <TabsTab value="files">Files</TabsTab>
        </TabsList>
      ) : (
        <span className="muted head-note">Tasks that belong to no project</span>
      )}
      <span className="grow" />
      {project ? (
        // The project's conversation and its repositories are a click away, as icons, so the
        // header's one labeled button is New task.
        <Tip label="Channel">
          <button
            className="btn icon"
            type="button"
            aria-label="Channel"
            onClick={() => nav.go({ name: "channel", channelId: project.channelId })}
          >
            <Icon name="hash" />
          </button>
        </Tip>
      ) : null}
      {projectId ? (
        <Tip
          label={
            project && project.repos.length > 0
              ? `Repositories (${project.repos.length})`
              : "Repositories"
          }
        >
          <button
            className="btn icon"
            type="button"
            aria-label="Repositories"
            onClick={() => setEditingRepos(true)}
          >
            <Icon name="layers" />
          </button>
        </Tip>
      ) : null}
      <button className="btn primary" type="button" onClick={() => setCreating(true)}>
        <Icon name="plus" /> <span>New task</span>
      </button>
    </>
  );

  return (
    <>
      {projectId ? (
        // The tabs' root is the header, so it stays the view's direct child; the board or the
        // files below show the chosen tab.
        <Tabs
          render={<header className="main-head work-head work-ui" />}
          value={tab}
          onValueChange={(next) => setTab(next === "files" ? "files" : "board")}
        >
          {head}
        </Tabs>
      ) : (
        <header className="main-head work-head work-ui">{head}</header>
      )}

      <div className="main-body">
        {tab === "board" || !projectId ? (
          board !== undefined && board.length === 0 ? (
            <Empty
              size={44}
              action={
                <button className="btn primary" type="button" onClick={() => setCreating(true)}>
                  <Icon name="plus" /> <span>New task</span>
                </button>
              }
            >
              {projectId
                ? `No tasks in ${name} yet.`
                : "Every task belongs to a project. A task made with No project shows up here."}
            </Empty>
          ) : board === undefined ? null : (
            <div className="board-wrap work-ui">
              <div className="board task-list">
                {COLUMNS.map((column) => {
                  const inColumn = (board ?? []).filter((t) => boardColumn(t) === column.key);
                  // A task whose live runs are all on offline machines can't be acted on: it sits at
                  // the foot of its column under a quiet divider, out of the column's count, as the
                  // Inbox files it under Machine offline.
                  const away = (t: TaskCard) => {
                    const going = t.runs.filter(
                      (r) =>
                        r.state === "waiting" || r.state === "working" || r.state === "unknown",
                    );
                    return (
                      going.length > 0 &&
                      going.every((r) => r.machine && offline.has(r.machine.machineId))
                    );
                  };
                  if (inColumn.length === 0) return null;
                  const tasks = inColumn.filter((t) => !away(t));
                  const offlineTasks = inColumn.filter(away);
                  return (
                    <section key={column.key} className="column" aria-label={column.label}>
                      <div className="column-head project-column-head" title={column.rule}>
                        <StateIcon state={column.dot} still />
                        <b>{column.label}</b>
                        {tasks.length > 0 ? (
                          <span className="badge">
                            {tasks.length}
                          </span>
                        ) : null}
                      </div>
                      {tasks.map((task) => (
                        <TaskCardView
                          key={task.taskId}
                          task={task}
                          me={session.me.memberId}
                          offline={offline}
                          onOpen={() => nav.openTask(task.taskId)}
                          onGive={
                            hasAgents && task.closedAt === undefined
                              ? () => setGiving(task)
                              : undefined
                          }
                          members={session.members}
                        />
                      ))}
                      {offlineTasks.length > 0 ? (
                        <>
                          <p className="column-divider">
                            <Icon name="offline" size={14} /> Machine offline: {offlineTasks.length}
                          </p>
                          {offlineTasks.map((task) => (
                            <TaskCardView
                              key={task.taskId}
                              task={task}
                              me={session.me.memberId}
                              offline={offline}
                              underDivider
                              onOpen={() => nav.openTask(task.taskId)}
                              onGive={
                                hasAgents && task.closedAt === undefined
                                  ? () => setGiving(task)
                                  : undefined
                              }
                              members={session.members}
                            />
                          ))}
                        </>
                      ) : null}
                    </section>
                  );
                })}
              </div>
            </div>
          )
        ) : (
          <FilesView projectId={projectId} />
        )}
      </div>

      {creating ? (
        <NewTaskDialog
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={(taskId) => {
            setCreating(false);
            nav.openTask(taskId);
          }}
        />
      ) : null}
      {giving ? (
        <StartRunDialog
          taskId={giving.taskId}
          projectId={giving.projectId}
          toAgent
          onClose={() => setGiving(null)}
          nav={nav}
        />
      ) : null}
      {editingRepos && project ? (
        <ReposDialog
          projectId={project.projectId}
          repos={project.repos}
          onClose={() => setEditingRepos(false)}
        />
      ) : null}
    </>
  );
}

function TaskCardView({
  task,
  me,
  offline,
  underDivider = false,
  onOpen,
  onGive,
  members,
}: {
  task: TaskCard;
  me: string;
  offline: Set<string>;
  /** The card sits under its column's "Machine offline" divider, which already says so. */
  underDivider?: boolean;
  onOpen: () => void;
  /** Opens Give to an agent for this task; unset on a closed task or with no agent in the roster. */
  onGive: (() => void) | undefined;
  members: ReturnType<typeof useSession>["members"];
}) {
  const closed = task.closedAt !== undefined;
  const failed = task.runs.filter((r) => r.state === "failed").length;
  const working = task.runs.find(
    (r) => r.state === "working" && !(r.machine && offline.has(r.machine.machineId)),
  );
  const now = useNow(working ? 1000 : 60_000);
  // Stopped runs fold into one "+N stopped" chip once there's more than one, so live and finished
  // work stays readable; a kept run always shows.
  const stopped = task.runs.filter((r) => r.state === "stopped" && r.runId !== task.keptRunId);
  const fold = stopped.length > 1;
  const chipRuns = fold ? task.runs.filter((r) => !stopped.includes(r)) : task.runs;
  const folded = fold ? stopped.length : 0;
  // An offline machine matters only to a run that is still going; a finished run shows its result.
  const away = (run: TaskCard["runs"][number]) =>
    Boolean(run.machine && offline.has(run.machine.machineId)) && !FINISHED.has(run.state);
  const shownOf = (run: TaskCard["runs"][number]) => showRun(run, 0, away(run));
  // Only a run someone can answer waits on them: one whose machine is offline waits quietly.
  const answerable = task.runs.filter(
    (r) => r.state === "waiting" && !(r.machine && offline.has(r.machine.machineId)),
  );
  const waitingOn = [
    ...new Set(
      answerable
        .map((r) => r.driver)
        .filter((d): d is NonNullable<typeof d> => Boolean(d))
        .map((d) => (d.memberId === me ? "you" : d.name)),
    ),
  ];
  const offlineWaiting =
    answerable.length === 0
      ? task.runs.find(
          (r) => r.state === "waiting" && r.machine && offline.has(r.machine.machineId),
        )?.machine?.name
      : undefined;
  return (
    <div className={`card-wrap ${onGive ? "giveable" : ""}`}>
      <button
        className={`card task-card work-ui ${closed ? "closed" : ""}`}
        type="button"
        onClick={onOpen}
      >
        <span className="t">{task.title}</span>
        {/* Your own tasks need no owner line; a teammate's names them. */}
        {task.owner.memberId === me ? null : (
          <span className="meta">
            <MemberFace member={task.owner} members={members} size={20} />
            <span className="truncate">{task.owner.name}</span>
          </span>
        )}
        {waitingOn.length > 0 ? (
          // One line of text that wraps as a sentence, so the machine name is never the part cut off.
          <span className="card-note wrap">
            {/* Amber only when you are one of them; a wait on others is theirs to answer. */}
            <span className={waitingOn.includes("you") ? "amber-text" : "muted"}>
              Waiting on {waitingNames(waitingOn)}
            </span>
          </span>
        ) : offlineWaiting ? (
          <span className="card-note wrap muted">Waiting, {offlineWaiting} offline</span>
        ) : task.settled && !closed ? (
          // Put away: its failed runs are still on its chips, but nobody needs to look at it now.
          <span className="card-note muted">
            <Icon name="check" size={14} /> Settled
          </span>
        ) : failed > 0 && task.state === "failed" ? (
          <span className="card-note state-failed">
            <StateIcon state="failed" size={14} />
            {failed === task.runs.length
              ? failed === 1
                ? "The run failed"
                : "Every run failed"
              : `${failed} of ${task.runs.length} runs failed`}
          </span>
        ) : closed ? (
          <span className="card-note muted">
            <Icon name="check" size={14} /> Closed
          </span>
        ) : working ? (
          // How long its live run has gone and where, as the Inbox row says it.
          <span className="card-note muted">
            {/* The run's chip below already spins; the line says only how long and where. */}
            <span className="task-working-line">
              <span>
                Working{" "}
                <span className="mono">
                  {clock(working.stateChangedAt ?? working.startedAt, now)}
                </span>
              </span>
            </span>
            {working.machine ? (
              <>
                {" "}
                on <span className="mono machine-name card-machine">{working.machine.name}</span>
              </>
            ) : null}
          </span>
        ) : null}
        {task.runs.length > 0 ? (
          <span className="run-chips">
            {chipRuns.map((run) => (
              <span
                key={run.runId}
                className={`run-chip ${task.keptRunId === run.runId ? "kept" : ""}`}
                title={`${runLabel(run)}${run.machine ? ` on ${run.machine.name}` : ""}: ${shownOf(run).label}${task.keptRunId === run.runId ? ", kept" : ""}`}
              >
                {run.driver?.kind === "agent" ? (
                  <MemberFace member={run.driver} members={members} state={run.state} size={18} />
                ) : (
                  <HarnessMark
                    harness={run.harness}
                    state={run.state === "unknown" ? "working" : run.state}
                  />
                )}
                {/* The run's own state shape; nobody can answer a run on an offline machine, so its
                  icon isn't amber. An agent's run carries the agent's name. */}
                <StateIcon
                  state={away(run) ? "unknown" : run.state}
                  glyph={
                    shownOf(run).glyph === "live"
                      ? "live"
                      : away(run)
                        ? STATE_META[run.state].icon
                        : undefined
                  }
                  size={14}
                  still
                  label={shownOf(run).label}
                />
                <span className="truncate">
                  {run.driver?.kind === "agent" ? run.driver.name : runLabel(run)}
                </span>
                {/* Once per card: under the divider the divider says it, and the card's note too. */}
                {away(run) && !underDivider ? (
                  <Icon
                    name="offline"
                    size={14}
                    className="chip-offline"
                    aria-label="Machine offline"
                  />
                ) : null}
              </span>
            ))}
            {folded > 0 ? (
              <span
                className="run-chip folded"
                title={`${folded} stopped run${folded === 1 ? "" : "s"}`}
              >
                <StateIcon state="stopped" size={14} />
                <span>+{folded} stopped</span>
              </span>
            ) : null}
          </span>
        ) : null}
      </button>
      {/* A sibling of the card, not inside it: a button can't hold another. */}
      {onGive ? (
        <Tip label="Give to an agent">
          <button
            className="icon-btn card-give"
            type="button"
            aria-label="Give to an agent"
            onClick={onGive}
          >
            <Icon name="send" size={14} />
          </button>
        </Tip>
      ) : null}
    </div>
  );
}

function ReposDialog({
  projectId,
  repos,
  onClose,
}: {
  projectId: Id<"projects">;
  repos: string[];
  onClose: () => void;
}) {
  const setRepos = useAct(api.projects.setRepos, { success: "Repos saved" });
  const [list, setList] = useState(repos);
  return (
    <Dialog
      title="Repos this project touches"
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            onClick={async () => {
              if ((await setRepos({ projectId, repos: list })) !== undefined) onClose();
            }}
          >
            Save repos
          </button>
        </>
      }
    >
      <Field className="field project-repos">
        <FieldLabel className="label">Repos</FieldLabel>
        <RepoPicker inputId="repos" repos={list} onChange={setList} />
        <FieldDescription className="hint">
          New runs offer these repos, and unfiled runs in them are suggested for this project.
        </FieldDescription>
      </Field>
    </Dialog>
  );
}

export { Face };
