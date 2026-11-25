import { useState } from "react";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { SegmentedControl, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import { Select, SelectTrigger, SelectValue } from "@ui-sdk/react/select";
import { api, type Id, type UnfiledRow } from "../lib/api";
import { ChoiceList, NO_PROJECT } from "../components/NewWork";
import { runLabel } from "../lib/format";
import { useAct, useRoomQuery, useSession } from "../lib/session";
import { offlineMachines, showRun } from "../lib/work";
import { Face, HarnessMark, StateIcon } from "../components/Faces";
import { Icon } from "../components/Icon";
import { Dialog } from "../components/Dialog";
import { useNow } from "../components/useNow";
import type { Nav } from "../Shell";
import { Empty } from "../components/Empty";
import "./work.css";
import "../components/agentWork.css";
import "./shell.css";
import "./unfiled.css";
import "../components/files/controls.css";

export function Unfiled({ nav }: { nav: Nav }) {
  const runs = useRoomQuery(api.runs.unfiled, {});
  const me = useSession().me.memberId;
  const machines = useRoomQuery(api.machines.list, {});
  const offline = offlineMachines(machines);
  const file = useAct(api.runs.file, { success: "Filed" });
  const [filing, setFiling] = useState<UnfiledRow | null>(null);
  const now = useNow(1000);

  return (
    <>
      <header className="main-head work-head work-ui">
        <h1>Unfiled</h1>
        <span className="muted head-note">
          Runs that aren't in a task yet, such as a thread started in T3 Code.
        </span>
      </header>
      <div className="main-body inbox-scroll unfiled-body">
        <div className="inbox unfiled-list work-ui">
          {runs === undefined ? null : runs.length === 0 ? (
            <Empty>Every run belongs to a task. Threads started outside a task show up here.</Empty>
          ) : (
            runs.map((run) => {
              const title = run.title ?? `${runLabel(run)} run`;
              const suggestion = run.suggestedProjects[0];
              return (
                <div key={run.runId} className="inbox-row unfiled-row">
                  {run.driver?.kind === "agent" ? (
                    <Face who={run.driver} state={run.state} />
                  ) : (
                    <HarnessMark
                      harness={run.harness}
                      state={run.state === "unknown" ? "working" : run.state}
                    />
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div className="title">
                      <span className="t">{title}</span>
                    </div>
                    <div className="reason">
                      {runLabel(run)}
                      {run.machine ? (
                        <>
                          {" "}
                          on <span className="mono machine-name">{run.machine.name}</span>
                        </>
                      ) : null}
                      {run.repo ? (
                        <>
                          {" "}
                          in <span className="muted">{run.repo}</span>
                        </>
                      ) : null}
                    </div>
                    <div className="reason">
                      {run.driver
                        ? `Controlled by ${run.driver.memberId === me ? "you" : run.driver.name}`
                        : "Nobody is in control"}
                      {suggestion ? `. ${suggestion.name} lists this repo.` : ""}
                    </div>
                  </div>
                  <div className="right">
                    {(() => {
                      const shown = showRun(
                        run,
                        now,
                        Boolean(run.machine && offline.has(run.machine.machineId)),
                      );
                      return (
                        <>
                          <StateIcon state={shown.icon} glyph={shown.glyph} />
                          <span>
                            {shown.label}{" "}
                            {shown.time ? (
                              <span className={shown.ticking ? "mono" : undefined}>
                                {shown.time}
                              </span>
                            ) : null}
                          </span>
                        </>
                      );
                    })()}
                  </div>
                  <div className="unfiled-actions">
                    {suggestion ? (
                      <button
                        className="btn file-suggest"
                        type="button"
                        onClick={() =>
                          file({
                            runId: run.runId,
                            newTask: { title, projectId: suggestion.projectId as Id<"projects"> },
                          })
                        }
                      >
                        <span className="unfiled-action-label">File in {suggestion.name}</span>
                      </button>
                    ) : null}
                    <button className="btn" type="button" onClick={() => setFiling(run)}>
                      <span className="unfiled-action-label">File under a task…</span>
                    </button>
                    {/* A private run's terminal is not_found for you (ADR 0015): no link to it. */}
                    {run.terminalId && !run.private ? (
                      <button
                        className="btn ghost"
                        type="button"
                        onClick={() => nav.openTerminal(run.terminalId!)}
                      >
                        <Icon name="terminal" />{" "}
                        <span className="unfiled-action-label">Open terminal</span>
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
      {filing ? <FileDialog run={filing} onClose={() => setFiling(null)} /> : null}
    </>
  );
}

/** Files a run under an existing task or a new one. `onFiled` runs once it's filed. */
export function FileDialog({
  run,
  onClose,
  onFiled,
}: {
  run: Pick<UnfiledRow, "runId" | "title" | "harness" | "a2a" | "suggestedProjects" | "machine">;
  onClose: () => void;
  onFiled?: () => void;
}) {
  const tasks = useRoomQuery(api.tasks.board, {});
  const projects = useRoomQuery(api.projects.list, {});
  const file = useAct(api.runs.file, { success: "Filed" });
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [taskId, setTaskId] = useState<string>("");
  const [title, setTitle] = useState(run.title ?? `${runLabel(run)} run`);
  const [projectId, setProjectId] = useState<string>(run.suggestedProjects[0]?.projectId ?? "");
  const taskChoices = (tasks ?? []).map((task) => ({
    value: task.taskId as string,
    label: task.title,
  }));
  const projectChoices = [
    { value: NO_PROJECT, label: "No project" },
    ...(projects ?? []).map((project) => ({
      value: project.projectId as string,
      label: project.name,
    })),
  ];

  const submit = async () => {
    const done =
      mode === "existing"
        ? await file({ runId: run.runId, taskId: taskId as Id<"tasks"> })
        : await file({
            runId: run.runId,
            newTask: { title, ...(projectId ? { projectId: projectId as Id<"projects"> } : {}) },
          });
    if (done !== undefined) {
      onClose();
      onFiled?.();
    }
  };

  return (
    <Dialog
      title="File this run under a task"
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          {/* Pending while the room files it, so a second press can't file it twice. */}
          <Button
            className="btn primary"
            disabled={mode === "existing" ? !taskId : !title.trim()}
            onClick={submit}
          >
            File run
          </Button>
        </>
      }
    >
      <p className="run-again-note file-run-note">
        {run.title ?? `${runLabel(run)} run`} with {runLabel(run)}
        {run.machine ? (
          <>
            {" "}
            on <span className="mono machine-name">{run.machine.name}</span>
          </>
        ) : null}
      </p>
      <SegmentedControl
        className="seg surface-seg"
        aria-label="Which task"
        style={{ alignSelf: "flex-start" }}
        value={mode}
        onValueChange={(next) => setMode(next === "new" ? "new" : "existing")}
      >
        <SegmentedControlItem value="existing">
          <span className="surface-label">Existing task</span>
        </SegmentedControlItem>
        <SegmentedControlItem value="new">
          <span className="surface-label">New task</span>
        </SegmentedControlItem>
      </SegmentedControl>
      {mode === "existing" ? (
        <Field className="field">
          <FieldLabel className="label">Task</FieldLabel>
          <Select
            items={taskChoices}
            value={taskId || null}
            onValueChange={(next) => setTaskId(next ? String(next) : "")}
            placeholder="Choose a task"
          >
            <SelectTrigger id="file-task" className="select">
              <SelectValue />
            </SelectTrigger>
            <ChoiceList choices={taskChoices} />
          </Select>
        </Field>
      ) : (
        <>
          <Field className="field">
            <FieldLabel className="label">Task title</FieldLabel>
            <Input id="file-title" className="input" value={title} onValueChange={setTitle} />
          </Field>
          <Field className="field">
            <FieldLabel className="label">Project</FieldLabel>
            <Select
              items={projectChoices}
              value={projectId || NO_PROJECT}
              onValueChange={(next) =>
                setProjectId(next && next !== NO_PROJECT ? String(next) : "")
              }
            >
              <SelectTrigger id="file-project" className="select">
                <SelectValue />
              </SelectTrigger>
              <ChoiceList choices={projectChoices} />
            </Select>
            <FieldDescription className="hint">You will own the new task.</FieldDescription>
          </Field>
        </>
      )}
    </Dialog>
  );
}
