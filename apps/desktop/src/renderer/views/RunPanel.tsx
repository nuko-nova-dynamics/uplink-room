import "../components/agentWork.css";
/**
 * A drawer for one run: one that has no task, terminal or Space to open (a T3 Code thread started
 * straight in T3 Code, or a run sent to an A2A agent by a channel mention, ADR 0012), or a live run
 * opened from its mention in chat (ADR 0026). It shows what the room knows about the run, lets you
 * file it under a task, answer it or stop it, and for a live run, its messages (RunMessages).
 */
import { useState } from "react";
import { Button } from "@ui-sdk/react/button";
import { DialogClose } from "@ui-sdk/react/dialog";
import { api, type Id } from "../lib/api";
import { harnessLabel, runLabel } from "../lib/format";
import { useAct, useRoomQuery, useSession } from "../lib/session";
import { answerState, failText, offlineMachines, showRun } from "../lib/work";
import { T3PairingNote } from "../components/T3PairingNote";
import { MemberFace, StateIcon } from "../components/Faces";
import { Icon } from "../components/Icon";
import { Cmd } from "../components/Cmd";
import { useNow } from "../components/useNow";
import { A2ARunActions, A2ARunDetails } from "../components/A2ARun";
import { RunMessages } from "../components/RunMessages";
import { JoinedNote } from "../components/JoinedNote";
import { Tip } from "../components/Tip";
import { WorkDrawer as Drawer } from "./TaskPanel";
import { FileDialog } from "./Unfiled";
import { track } from "../lib/analytics";
import type { Nav } from "../Shell";
import "./work.css";

export function RunPanel({
  runId,
  onClose,
  nav,
  onOpenRun,
  onOpenPlace,
}: {
  runId: Id<"runs">;
  onClose: () => void;
  nav: Nav;
  /** Opens another run: where a reply after the agent finished went (ADR 0024). */
  onOpenRun?: (runId: Id<"runs">) => void;
  /** Opens the chat place an agent's run came from. */
  onOpenPlace?: (place: {
    channelId: Id<"channels">;
    messageId?: Id<"messages"> | undefined;
  }) => void;
}) {
  const session = useSession();
  const run = useRoomQuery(api.runs.get, { runId });
  const unfiled = useRoomQuery(api.runs.unfiled, {});
  const machines = useRoomQuery(api.machines.list, {});
  const offline = offlineMachines(machines);
  const file = useAct(api.runs.file, { success: "Filed" });
  const stop = useAct(api.runs.stop, { success: "Run stopped" });
  const answer = useAct(api.inbox.answer);
  // A live run can be messaged (ADR 0026): how it hears, who may, and what it was sent.
  const live = useRoomQuery(api.runs.live, {})?.find((r) => r.runId === runId);
  const inbox = useRoomQuery(api.runs.inbox, live ? { runId } : "skip");
  const setHears = useAct(api.runs.setHears);
  const openDirect = useAct(api.channels.openDirect);
  const [filing, setFiling] = useState(false);
  const now = useNow(1000);

  const me = session.me.memberId;
  const row = unfiled?.find((r) => r.runId === runId);
  const suggestion = row?.suggestedProjects[0];
  const finished =
    run && (run.state === "done" || run.state === "failed" || run.state === "stopped");
  const title = run ? (run.title ?? `${runLabel(run)} run`) : "Run";
  const why = run?.state === "failed" && !run.a2a ? failText(run.failReason) : undefined;
  const canAnswer = Boolean(run && (session.isAdmin || run.driver?.memberId === me));
  // Names the approval on screen; a stale one is refused and `useAct` says why. The panel opens
  // from an Inbox row, so the answer counts as one given from the Inbox.
  // One answer at a time: the buttons are off from the first click until the room has it.
  const [answering, setAnswering] = useState(false);
  const answerRun = async (value: "allow" | "deny") => {
    if (answering) return;
    setAnswering(true);
    try {
      const done = await answer({ runId, answer: value, promptId: run?.prompt?.promptId ?? "" });
      if (done !== undefined) track("approval_answered", { answer: value, from: "inbox" });
    } finally {
      setAnswering(false);
    }
  };
  // The same rule as the Inbox and the task panel: no answer to a machine that's offline, and none
  // while an earlier answer to this prompt is on its way.
  const machineOffline = Boolean(run?.machine && offline.has(run.machine.machineId));
  const delivery = run ? answerState(run, now) : "none";
  // A thread's machine whose T3 Code pairing broke: say why the run reads Unknown, and what fixes it.
  const machineRow = run?.threadRef
    ? machines?.find((m) => m.machineId === run.machine?.machineId)
    : undefined;

  return (
    <Drawer className="drawer work-ui run-panel" label="Run" onClose={onClose}>
      <div className="drawer-head">
        <h1 className="drawer-title" title={title}>
          {title}
        </h1>
        <Tip label="Close run">
          <DialogClose className="btn icon" aria-label="Close run">
            <Icon name="close" />
          </DialogClose>
        </Tip>
      </div>
      {run ? (
        <div className="drawer-body">
          <div className="task-facts">
            <div className="task-state">
              {(() => {
                const shown = showRun(
                  run,
                  now,
                  Boolean(run.machine && offline.has(run.machine.machineId)),
                );
                return (
                  <>
                    <StateIcon state={shown.icon} glyph={shown.glyph} />
                    <span className={`state-${shown.icon}`}>{shown.label}</span>
                    {shown.time ? <span className="mono muted">{shown.time}</span> : null}
                  </>
                );
              })()}
              {run.taskId ? null : <span className="tag">Unfiled</span>}
            </div>
            <div className="task-fact">
              <span>{run.a2a ? "Agent" : "Coding tool"}</span>
              <span className="task-fact-value">
                {run.a2a
                  ? run.a2a.agent.name
                  : run.threadRef
                    ? `${harnessLabel(run.harness)} in a T3 Code thread`
                    : run.joined
                      ? `${harnessLabel(run.harness)}, joined by itself`
                      : harnessLabel(run.harness)}
              </span>
            </div>
            {live ? (
              <div className="task-fact">
                <span>Name</span>
                <span className="task-fact-value" title={`Mention it as @${live.label}`}>
                  {live.label}
                </span>
              </div>
            ) : null}
            {run.machine ? (
              <div className="task-fact">
                <span>Machine</span>
                <span className="task-fact-value mono">{run.machine.name}</span>
              </div>
            ) : null}
            {run.repo ? (
              <div className="task-fact">
                <span>Repo</span>
                <span className="task-fact-value">{run.repo}</span>
              </div>
            ) : null}
            <div className="task-fact">
              <span>In control</span>
              <span className="task-fact-value">
                {run.driver ? (
                  <>
                    <MemberFace member={run.driver} members={session.members} size={20} />
                    {run.driver.memberId === me ? `${run.driver.name} (you)` : run.driver.name}
                  </>
                ) : (
                  "Nobody"
                )}
              </span>
            </div>
          </div>

          {run.state === "waiting" && run.prompt ? (
            <div className="prompt-box">
              <div>
                {run.prompt.action ? (
                  <>
                    {run.prompt.text.replace(run.prompt.action, "").trim() || "Wants to run"}{" "}
                    <Cmd text={run.prompt.action} />
                  </>
                ) : (
                  run.prompt.text
                )}
              </div>
              {run.prompt.kind !== "approval" || !canAnswer || run.a2a ? null : machineOffline ? (
                <span className="hint">
                  {run.machine?.name ?? "Its machine"} is offline, so an answer can't reach it.
                </span>
              ) : delivery === "sending" && run.lastAnswer ? (
                <span className="hint">
                  {run.lastAnswer.by.memberId === me ? "You" : run.lastAnswer.by.name}{" "}
                  {run.lastAnswer.answer === "allow" ? "allowed" : "denied"} it. Waiting for{" "}
                  {run.machine?.name ?? "the machine"} to go on.
                </span>
              ) : (
                <>
                  {delivery === "failed" ? (
                    <span className="hint state-failed">
                      Couldn't deliver your answer, try again.
                    </span>
                  ) : null}
                  <div className="row-flex">
                    <Button
                      className="btn primary"
                      disabled={answering}
                      onClick={() => answerRun("allow")}
                    >
                      <span className="control-label">Allow</span>
                    </Button>
                    <Button
                      className="btn"
                      disabled={answering}
                      onClick={() => answerRun("deny")}
                    >
                      <span className="control-label">Deny</span>
                    </Button>
                  </div>
                </>
              )}
            </div>
          ) : null}
          {why ? <div className="run-fail">{why}</div> : null}
          {run.joined ? <JoinedNote finished={Boolean(finished)} /> : null}
          {/* Opened from a run's mention in chat: where it works. */}
          {run.terminalId || (run.taskId && !run.a2a) ? (
            <div className="run-card-actions">
              {run.terminalId ? (
                <button
                  className="btn"
                  type="button"
                  onClick={() => nav.openTerminal(run.terminalId!)}
                >
                  <Icon name="terminal" />
                  <span className="control-label"> Open terminal</span>
                </button>
              ) : null}
              {run.taskId ? (
                <button className="btn" type="button" onClick={() => nav.openTask(run.taskId!)}>
                  <Icon name="board" />
                  <span className="control-label"> Open task</span>
                </button>
              ) : null}
            </div>
          ) : null}
          {live ? (
            <RunMessages
              run={live}
              me={me}
              inbox={inbox}
              onSetHears={(hears) => void setHears({ runId, hears })}
              onMessage={async () => {
                const opened = await openDirect({ memberIds: [], runIds: [runId] });
                if (opened) nav.go({ name: "channel", channelId: opened.channelId });
              }}
            />
          ) : null}
          {machineRow ? (
            <T3PairingNote
              t3={machineRow.t3}
              machineName={machineRow.name}
              now={now}
              onlyNeedsYou
              withChip
            />
          ) : null}

          {run.a2a ? (
            <div className="run-card">
              <A2ARunDetails run={run} now={now} />
              <A2ARunActions run={run} onOpenRun={onOpenRun} onOpenPlace={onOpenPlace} />
            </div>
          ) : run.threadRef && !run.private ? (
            <div className="run-card-actions">
              <button className="btn primary" type="button" onClick={() => nav.openThread(runId)}>
                <Icon name="comment" />
                <span className="control-label"> Open thread</span>
              </button>
            </div>
          ) : null}

          {run.taskId ? null : (
            <div className="run-card-actions">
              {suggestion ? (
                <button
                  className="btn primary"
                  type="button"
                  onClick={async () => {
                    const done = await file({
                      runId,
                      newTask: { title, projectId: suggestion.projectId as Id<"projects"> },
                    });
                    if (done !== undefined) onClose();
                  }}
                >
                  <span className="control-label">File in {suggestion.name}</span>
                </button>
              ) : null}
              <button
                className={suggestion ? "btn" : "btn primary"}
                type="button"
                onClick={() => setFiling(true)}
              >
                <span className="control-label">File under a task…</span>
              </button>
              {!finished && !run.a2a ? (
                <Tip
                  label={
                    run.machine && offline.has(run.machine.machineId)
                      ? `${run.machine.name} is offline: the run is marked stopped here now, and the machine gets the stop when its bridge is back.`
                      : ""
                  }
                >
                  <button
                    className="btn stop-run"
                    type="button"
                    onClick={() => void stop({ runId })}
                  >
                    <Icon name="stop" />
                    <span className="control-label">
                      {" "}
                      {run.machine && offline.has(run.machine.machineId) ? "Mark stopped" : "Stop"}
                    </span>
                  </button>
                </Tip>
              ) : null}
            </div>
          )}
          {suggestion ? (
            <span className="hint">
              {suggestion.name} lists {run.repo}, so this run probably belongs there.
            </span>
          ) : null}
        </div>
      ) : null}
      {filing && run ? (
        <FileDialog
          run={{ ...run, suggestedProjects: row?.suggestedProjects ?? [] }}
          onClose={() => setFiling(false)}
          onFiled={onClose}
        />
      ) : null}
    </Drawer>
  );
}
