import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Button } from "@ui-sdk/react/button";
import { Input } from "@ui-sdk/react/input";
import {
  createMenuController,
  Menu,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { Progress, ProgressIndicator } from "@ui-sdk/react/progress";
import { Textarea } from "@ui-sdk/react/textarea";
import {
  api,
  type InboxProposal,
  type InboxRow,
  type Id,
  type MachineRow,
  type RunView,
} from "../lib/api";
import { INBOX_HARNESS, taskTitle, threadMachine } from "../lib/inboxSend";
import { LinkConversation, SendTarget, type SendTo } from "../components/LinkConversation";
import { harnessName, runKind } from "../../main/analyticsSpec";
import { formatTime, runLabel } from "../lib/format";
import { useAct, useRoomQuery, useSession, useToast } from "../lib/session";
import { LinkMascot } from "../characters/LinkMascot";
import { Face, HarnessMark, StateIcon } from "../components/Faces";
import { Icon } from "../components/Icon";
import { useNow } from "../components/useNow";
import { pendingActions, UNDO_MS, type PendingAction } from "../lib/pendingActions";
import { NewTaskDialog } from "../components/NewWork";
import { playCue } from "../lib/sound";
import { STATE_META } from "../lib/states";
import {
  answerState,
  currentStep,
  dropTrailingPrompts,
  failedNote,
  failText,
  lastSeen,
  offlineMachines,
  previewTerminal,
  rowRun,
  showRun,
  stepLine,
} from "../lib/work";
import { useTerminalTail } from "../components/RunOutput";
import { Cmd } from "../components/Cmd";
import { QuestionForm } from "../components/QuestionForm";
import type { Nav } from "../Shell";
import { track } from "../lib/analytics";
import { useStoredFlag } from "../lib/storedFlag";
import { ProposalRow } from "../components/CallTimeline";
import { Tip } from "../components/Tip";
import "./work.css";
import "./shell.css";

type SectionKey = "needsYou" | "working" | "offline" | "done";
/** How long Undo stays on a Settled or Snoozed toast before it's sent. */
const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "needsYou", label: "Needs you" },
  { key: "working", label: "Working" },
  // Runs on machines whose bridge is offline: nobody can answer or reach them until it's back.
  { key: "offline", label: "Machine offline" },
  { key: "done", label: "Done" },
];

type Entry = {
  row: InboxRow;
  section: SectionKey;
  id: string;
  projectId: Id<"projects"> | undefined;
};

function rowId(row: InboxRow): string {
  return row.taskId ?? row.runId ?? row.title;
}

/**
 * The run that decides what the row shows and what Allow and Deny act on: a waiting run with an
 * approval first, else any waiting run, else the first working one. In Mine (`me` set), waiting
 * runs you drive come before anyone else's, since they're what put the row in your Needs you. The
 * reason, the action and the buttons all come from this one run, so Allow can only approve the
 * command the row shows.
 */
function leadRun(row: InboxRow, me?: string): RunView | undefined {
  const waiting = (runs: RunView[]) =>
    runs.find((r) => r.state === "waiting" && r.prompt?.kind === "approval") ??
    runs.find((r) => r.state === "waiting");
  return (
    (me ? waiting(row.runs.filter((r) => r.driver?.memberId === me)) : undefined) ??
    waiting(row.runs) ??
    row.runs.find((r) => r.state === "working") ??
    row.runs[0]
  );
}

/** The lead run when it is waiting on an approval; Allow and Deny act on it and nothing else. */
function approvalRun(row: InboxRow, me?: string): RunView | undefined {
  const lead = leadRun(row, me);
  return lead?.state === "waiting" && lead.prompt?.kind === "approval" ? lead : undefined;
}

/** An open UI SDK menu, select, combobox or popover, in the top layer. */
const OPEN_POPUP = [
  "menu-content",
  "select-content",
  "combobox-content",
  "popover-content",
]
  .map((slot) => `[data-slot="${slot}"][data-open]`)
  .join(", ");

export function Inbox({
  nav,
  groupByProject,
  setGroupByProject,
  projectFilter,
  setProjectFilter,
  frozen,
}: {
  nav: Nav;
  groupByProject: boolean;
  setGroupByProject: (value: boolean) => void;
  projectFilter: Id<"projects"> | "all";
  setProjectFilter: (value: Id<"projects"> | "all") => void;
  frozen: boolean;
}) {
  const session = useSession();
  const [view, setView] = useState<"mine" | "team">("mine");
  /** Rows lead with waiting runs you drive, in Mine and Team alike. */
  const me = session.me.memberId;
  const data = useRoomQuery(api.inbox.get, { view });
  const projects = useRoomQuery(api.projects.list, {});
  const machines = useRoomQuery(api.machines.list, {});
  const offline = useMemo(() => offlineMachines(machines), [machines]);
  const seen = useMemo(() => lastSeen(machines), [machines]);
  // `useAct` shows the Room API's message if the approval changed meanwhile (a stale `promptId`).
  const answer = useAct(api.inbox.answer);
  const settle = useAct(api.inbox.settle);
  const snooze = useAct(api.inbox.snooze);
  const toast = useToast();
  // Settling and snoozing wait a few seconds before they're sent, so Undo on the toast can take
  // them back (the room has no unsettle). The queue outlives this view (lib/pendingActions.ts):
  // leaving the Inbox keeps the wait and the toast's Undo, and a closed window sends on next start.
  const held = useSyncExternalStore(pendingActions.subscribe, pendingActions.ids);
  function hold(
    row: InboxRow,
    kind: PendingAction["kind"],
    until: number | undefined,
    text: string | null,
  ): string | undefined {
    const action: PendingAction = {
      id: rowId(row),
      teamId: session.teamId,
      kind,
      args: {
        ...(row.taskId ? { taskId: row.taskId } : { runId: row.runId! }),
        ...(until !== undefined ? { until } : {}),
      },
      deadline: Date.now() + UNDO_MS,
      changedAt: row.changedAt,
    };
    const queued = pendingActions.queue(action, (a) =>
      a.kind === "settle" ? settle(a.args as never) : snooze(a.args as never),
    );
    if (!queued) return undefined;
    if (text === null) return action.id;
    toast.show(text, true, {
      label: "Undo",
      ms: UNDO_MS,
      onClick: () => pendingActions.cancel(action.id),
    });
    return action.id;
  }
  // A row whose runs change while its Settle or Snooze waits isn't the row you acted on: the action
  // is cancelled, and the row comes back showing the change.
  useEffect(() => {
    if (!data) return;
    const rows = [...data.needsYou, ...data.working, ...data.done];
    for (const action of pendingActions.stale(
      rows.map((r) => ({ id: rowId(r), changedAt: r.changedAt })),
    )) {
      if (!pendingActions.cancel(action.id)) continue;
      const title = rows.find((r) => rowId(r) === action.id)?.title ?? "A row";
      toast.show(
        `“${title}” changed, so it wasn't ${action.kind === "settle" ? "settled" : "snoozed"}`,
      );
    }
  }, [data, toast]);
  const passWheel = useAct(api.terminals.passWheel, { success: "Handed off" });
  const now = useNow(1000);
  const [focus, setFocus] = useState(0);
  const [menu, setMenu] = useState<"snooze" | "wheel" | null>(null);
  const [creating, setCreating] = useState(false);
  // What's typed in the Inbox's message box: sent to your Link, or as a new thread, or to an agent.
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const createTask = useAct(api.tasks.create);
  const startRun = useAct(api.runs.start);
  const post = useAct(api.messages.post);
  const setLink = useAct(api.members.setLink);
  // Your Link (ADR 0049): the agent your Inbox talks to. Absent, the box starts a thread.
  const link = useRoomQuery(api.members.link, {});
  const roster = useRoomQuery(api.teams.roster, {});
  // Any roster agent that takes your work can be given a task (ADR 0044); an A2A agent may take
  // work only from its person. Only one the room can also reach can be your Link.
  const rosterAgents = (roster ?? []).flatMap((entry) =>
    entry.kind === "agent" && entry.agentId && entry.takesYourWork
      ? [
          {
            memberId: entry.memberId as Id<"members">,
            agentId: entry.agentId,
            name: entry.name,
            who: { name: entry.name, kind: "agent" as const, character: entry.character },
          },
        ]
      : [],
  );
  const reachable = rosterAgents.filter((a) =>
    (roster ?? []).some((e) => e.kind === "agent" && e.memberId === a.memberId && e.reach),
  );
  // While any Link change is being saved, nothing sends: Enter would go to an older choice. A
  // count, not a flag, so an earlier save finishing doesn't reopen the box while a later one waits.
  const [linkSaves, setLinkSaves] = useState(0);
  const linking = linkSaves > 0;
  // Picked in the chip for the next sends; until then, your Link when you have one. A Link the room
  // can't reach any more would never get the message, so the box starts a thread until it can.
  const [picked, setPicked] = useState<SendTo | null>(null);
  const linkReached = !!link && link.reach !== null;
  // A pick that no longer works (the Link unreachable, or an agent that stopped taking your work
  // since) gives way to the default instead of failing on Enter.
  const pickStands =
    !!picked &&
    !(picked.kind === "link" && !linkReached) &&
    !(picked.kind === "agent" && !rosterAgents.some((a) => a.agentId === picked.agentId));
  const to: SendTo =
    picked && pickStands ? picked : linkReached ? { kind: "link" } : { kind: "thread" };
  const sendLabel =
    to.kind === "link" ? "Send" : to.kind === "agent" ? `Give to ${to.name}` : "Start a thread";

  /** A new task in the project the Inbox shows, titled from the message. */
  const newTask = async (message: string) => {
    const title = taskTitle(message);
    const projectId = projectFilter === "all" ? undefined : projectFilter;
    const taskId = await createTask({
      title,
      ...(projectId ? { projectId } : {}),
      ...(message !== title ? { description: message } : {}),
    });
    return taskId ? { taskId: taskId as Id<"tasks">, projectId } : undefined;
  };

  /**
   * Starts work on a message as T3 Code starts a thread on Enter: no dialog. The message becomes a
   * task, and a Claude Code thread starts on it with the message as its prompt, then opens. With no
   * machine able to take a thread, the task is kept and opened to start it from there. False when
   * the room refused the task.
   */
  const startThread = async (message: string): Promise<boolean> => {
    const made = await newTask(message);
    if (!made) return false;
    const mineOn = (m: MachineRow) =>
      m.belongsTo.kind === "person" && m.belongsTo.member.memberId === me;
    const machine = threadMachine(machines ?? [], mineOn);
    if (!machine) {
      toast.show("Saved as a task. No machine has T3 Code connected to start a thread on it.");
      nav.openTask(made.taskId);
      return true;
    }
    const repo = projects?.find((p) => p.projectId === made.projectId)?.repos[0];
    const started = (await startRun({
      taskId: made.taskId,
      harness: INBOX_HARNESS,
      machineId: machine.machineId,
      via: "thread",
      prompt: message,
      ...(repo ? { repo } : {}),
    })) as { runId: Id<"runs"> } | undefined;
    if (!started) {
      // The task is kept: open it to start its run another way.
      nav.openTask(made.taskId);
      return true;
    }
    track("run_started", {
      harness: harnessName(INBOX_HARNESS),
      kind: runKind(INBOX_HARNESS, "thread", Boolean(machine.cloud)),
      access: "none",
      has_profile: false,
    });
    nav.openThread(started.runId);
    return true;
  };

  /** Gives the message to an agent as a task (ADR 0044), and opens the task. */
  const giveToAgent = async (message: string, agentId: Id<"agents">): Promise<boolean> => {
    const made = await newTask(message);
    if (!made) return false;
    await startRun({ taskId: made.taskId, via: "agent", agentId, prompt: message });
    nav.openTask(made.taskId);
    return true;
  };

  /** Sends the box where the chip says. A send the room refuses puts the words back. */
  const send = async () => {
    const message = draft.trim();
    if (!message || sending || linking) return;
    setSending(true);
    setDraft("");
    const ok =
      to.kind === "link" && link
        ? (await post({ channelId: link.channelId, body: message, format: "markdown" })) !==
          undefined
        : to.kind === "agent"
          ? await giveToAgent(message, to.agentId)
          : await startThread(message);
    // A refused send comes back ahead of anything typed since, so a late failure loses nothing.
    if (!ok) setDraft((typed) => (typed.trim() ? `${message}\n${typed}` : message));
    setSending(false);
  };
  const listRef = useRef<HTMLDivElement>(null);
  // While someone moves with the keys, the pointer's hover doesn't mark a second row.
  const [keyboard, setKeyboard] = useState(false);
  // Work that's going on its own folds into one line until someone wants to watch it: what needs you
  // and what's finished are what the Inbox is for.
  const [workingOpen, setWorkingOpen] = useStoredFlag("uplink.inbox.workingOpen", false);
  // Finished work folds the same way: one line to settle it all, open to look at each.
  const [doneOpen, setDoneOpen] = useStoredFlag("uplink.inbox.doneOpen", false);

  // A row whose running runs are all on offline machines moves to Machine offline, out of Needs
  // you (nobody can answer it) and Working (nobody knows it's working).
  const away = useCallback(
    (row: InboxRow) => {
      const going = row.runs.filter(
        (r) => r.state === "waiting" || r.state === "working" || r.state === "unknown",
      );
      return going.length > 0 && going.every((r) => r.machine && offline.has(r.machine.machineId));
    },
    [offline],
  );
  const entries = useMemo<Entry[]>(() => {
    if (!data) return [];
    const all: Entry[] = [];
    const placed: Record<SectionKey, Entry[]> = {
      needsYou: [],
      working: [],
      offline: [],
      done: [],
    };
    for (const key of ["needsYou", "working", "done"] as const) {
      for (const row of data[key]) {
        const projectId = row.projectId;
        if (projectFilter !== "all" && projectId !== projectFilter) continue;
        if (held.has(rowId(row))) continue;
        const section: SectionKey = key !== "done" && away(row) ? "offline" : key;
        placed[section].push({ row, section, id: `${section}:${rowId(row)}`, projectId });
      }
    }
    // In Team, what waits on you comes first; waits on others follow (a stable sort keeps their order).
    if (view === "team") {
      const me = session.me.memberId;
      const onMe = (e: Entry) => (e.row.waitingOn.some((w) => w.memberId === me) ? 0 : 1);
      placed.needsYou.sort((a, b) => onMe(a) - onMe(b));
    }
    for (const { key } of SECTIONS) {
      // A folded section's rows aren't on screen, so the keys skip them too. Machine offline never
      // folds: its rows can hold a question nobody can answer until the machine is back.
      if (!workingOpen && key === "working") continue;
      if (!doneOpen && key === "done") continue;
      all.push(...placed[key]);
    }
    return all;
  }, [data, projectFilter, held, away, view, session.me.memberId, workingOpen, doneOpen]);
  const finished = useMemo(() => {
    if (!data) return [] as InboxRow[];
    return data.done.filter(
      (row) =>
        (projectFilter === "all" || row.projectId === projectFilter) && !held.has(rowId(row)),
    );
  }, [data, projectFilter, held]);

  // Counted from the data, not from `entries`, which leaves folded sections out.
  const going = useMemo(() => {
    if (!data) return [] as InboxRow[];
    return data.working.filter(
      (row) =>
        (projectFilter === "all" || row.projectId === projectFilter) &&
        !held.has(rowId(row)) &&
        !away(row),
    );
  }, [data, projectFilter, held, away]);

  const clamped = Math.min(focus, Math.max(0, entries.length - 1));
  const current = entries[clamped];

  // Keyboard: arrows or j/k move; A, S, H, W and Enter act on the focused row.
  useEffect(() => {
    if (frozen) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // A popup (UI SDK) owns its keys: a letter there is typeahead, Enter picks. Send to is open
      // over the Inbox, and its typeahead "A" must not allow the focused row's approval.
      if (event.defaultPrevented || document.querySelector(OPEN_POPUP)) return;
      if (
        target &&
        (target.closest("input, textarea, select, [contenteditable]") ||
          (!menu && target.closest("button:not(.inbox-open), a[href], [role=button]")) ||
          target.closest(".overlay, .xterm"))
      )
        return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      // An open row menu (UI SDK Menu) takes the keys itself: arrows, J and K, Enter and Escape.
      if (menu) return;
      setKeyboard(true);
      if (key === "arrowdown" || key === "j" || key === "arrowup" || key === "k") {
        event.preventDefault();
        const next =
          key === "arrowdown" || key === "j"
            ? Math.min(entries.length - 1, clamped + 1)
            : Math.max(0, clamped - 1);
        setFocus(next);
        // By entry, not by position: grouping by project renders rows in another order than entries.
        const target = entries[next];
        if (target)
          listRef.current
            ?.querySelector<HTMLButtonElement>(`.inbox-open[data-entry="${CSS.escape(target.id)}"]`)
            ?.focus();
      } else if (current) {
        const approval = approvalRun(current.row, me);
        if (
          key === "a" &&
          current.section === "needsYou" &&
          approval &&
          canAnswer(current.row, approval) &&
          !(approval.machine && offline.has(approval.machine.machineId)) &&
          answerState(approval, Date.now()) !== "sending"
        ) {
          event.preventDefault();
          void answerApproval(approval, "allow", "inbox_keyboard");
        } else if (key === "s" && current.section === "done") {
          event.preventDefault();
          void settleRow(current.row);
        } else if (key === "z" && current.section !== "needsYou") {
          event.preventDefault();
          setMenu(menu === "snooze" ? null : "snooze");
        } else if (key === "h" && wheelRun(current.row)) {
          event.preventDefault();
          setMenu(menu === "wheel" ? null : "wheel");
        } else if (key === "enter") {
          event.preventDefault();
          openRow(current.row);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frozen, entries, clamped, current, menu, me]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-focus="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [clamped, entries.length]);

  function canAnswer(row: InboxRow, run: RunView): boolean {
    return (
      session.isAdmin ||
      run.driver?.memberId === session.me.memberId ||
      row.owner?.memberId === session.me.memberId
    );
  }
  /** Names the approval on screen, so an answer can't land on a newer one the person hasn't seen. */
  async function answerApproval(
    run: RunView,
    value: "allow" | "deny",
    from: "inbox" | "inbox_keyboard" = "inbox",
  ) {
    const done = await answer({
      runId: run.runId,
      answer: value,
      promptId: run.prompt?.promptId ?? "",
    });
    if (done !== undefined) track("approval_answered", { answer: value, from });
    return done;
  }
  /** A live terminal run you drive, on a machine that's online, whose wheel you can pass. */
  function wheelRun(row: InboxRow): RunView | undefined {
    return row.runs.find(
      (r) =>
        r.terminalId &&
        r.driver?.memberId === session.me.memberId &&
        !(r.machine && offline.has(r.machine.machineId)) &&
        (r.state === "working" || r.state === "waiting" || r.state === "unknown"),
    );
  }
  function settleRow(row: InboxRow) {
    playCue("settle");
    hold(row, "settle", undefined, `Settled “${row.title}”`);
  }
  /** Every finished row at once, under one toast whose Undo takes them all back. */
  function settleAll(rows: InboxRow[]) {
    playCue("settle");
    const ids = rows
      .map((row) => hold(row, "settle", undefined, null))
      .filter((id) => id !== undefined);
    if (ids.length === 0) return;
    toast.show(`Settled ${ids.length} finished tasks`, true, {
      label: "Undo",
      ms: UNDO_MS,
      onClick: () => {
        for (const id of ids) pendingActions.cancel(id);
      },
    });
  }
  function snoozeRow(row: InboxRow, until: number) {
    setMenu(null);
    hold(row, "snooze", until, `Snoozed “${row.title}” until ${formatTime(until)}`);
  }
  function openRow(row: InboxRow) {
    if (row.taskId) nav.openTask(row.taskId);
    else {
      const run = row.runs[0];
      // A private run opens its run panel: its terminal and Space are not_found for you.
      if (run)
        nav.openRun({
          runId: run.runId,
          terminalId: previewTerminal(run),
          spaceId: run.private ? undefined : run.spaceId,
        });
    }
  }

  // Tasks proposed from calls wait for a yes or a no like any other decision. A backend from before
  // they came to the Inbox doesn't send them.
  const proposals = (data?.proposals ?? []).filter(
    (p) => projectFilter === "all" || p.channelProjectId === projectFilter,
  );
  const counts = {
    needsYou: entries.filter((e) => e.section === "needsYou").length + proposals.length,
    working: going.length,
    done: finished.length,
  };
  const zero = data !== undefined && counts.needsYou === 0 && counts.done === 0;

  const grouped = (section: SectionKey) => {
    const inSection = entries.filter((e) => e.section === section);
    if (!groupByProject) return [{ name: null as string | null, items: inSection }];
    const names = new Map<string, string>((projects ?? []).map((p) => [p.projectId, p.name]));
    const groups = new Map<string, Entry[]>();
    for (const entry of inSection) {
      const key = entry.row.unfiled ? "unfiled" : (entry.projectId ?? "none");
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    return (
      [...groups.entries()]
        // Projects by name, then tasks with no project, then runs with no task (as on Unfiled).
        .sort(([a], [b]) => {
          const rank = (k: string) => (k === "unfiled" ? 2 : k === "none" ? 1 : 0);
          return rank(a) - rank(b) || (names.get(a) ?? "").localeCompare(names.get(b) ?? "");
        })
        .map(([key, items]) => ({
          name:
            key === "unfiled"
              ? "Unfiled"
              : key === "none"
                ? "No project"
                : (names.get(key) ?? "Project"),
          items,
        }))
    );
  };

  return (
    <>
      <header className="main-head inbox-head">
        {/* The sidebar says where you are; the title is for screen readers. */}
        <h1 className="sr-only">Inbox</h1>
        <span className="grow" />
        {/* The Inbox is Link's conversation with you: its name in a centered pill, as Grok Bot names a Bot. */}
        <span className="head-id inbox-summary">
          <LinkMascot size={20} state={counts.needsYou > 0 ? "waiting" : "idle"} />
          <b>Inbox</b>
        </span>
        <span className="grow" />
        {/* Whose work and which project, as one quiet menu: the header stays the Inbox's name. */}
        <InboxFilter
          view={view}
          projectFilter={projectFilter}
          projects={projects ?? []}
          onView={(next) => {
            setView(next);
            track("inbox_view_changed", { view: next });
          }}
          onProject={setProjectFilter}
        />
      </header>
      {creating ? (
        <NewTaskDialog
          chooseProject
          initialTitle={draft}
          projectId={projectFilter === "all" ? undefined : projectFilter}
          onClose={() => setCreating(false)}
          onCreated={(taskId) => {
            setCreating(false);
            setDraft("");
            // A task with no runs isn't in the Inbox yet, so open it to start one.
            nav.openTask(taskId);
          }}
        />
      ) : null}

      <div className="main-body inbox-scroll" ref={listRef}>
        <div
          className={`inbox ${zero ? "is-zero" : ""}`}
          data-keyboard={keyboard || undefined}
          onMouseMove={() => keyboard && setKeyboard(false)}
        >
          {data === undefined ? null : (
            <>
              {link ? (
                <LinkConversation
                  link={link}
                  me={me}
                  nav={nav}
                  onMakeTask={(message) => {
                    // One task per press, as the box sends one message at a time.
                    if (sending) return;
                    setSending(true);
                    void startThread(message).finally(() => setSending(false));
                  }}
                />
              ) : null}
              <LinkSays
                needs={counts.needsYou}
                done={counts.done}
                working={going.length}
                view={view}
                zero={zero}
                fresh={zero && counts.working === 0 && (projects ?? []).length === 0}
              />

              {zero && counts.working === 0 && (projects ?? []).length === 0 ? (
                <GetStarted
                  hasAgent={session.members.some((m) => m.kind === "agent")}
                  hasMachine={(machines ?? []).length > 0}
                  hasTeammate={session.members.filter((m) => m.kind === "person").length > 1}
                  onSettings={(section) => nav.go({ name: "settings", section })}
                  onNewTask={() => setCreating(true)}
                />
              ) : null}
              <FromCalls
                proposals={proposals}
                onOpenTask={(taskId) => nav.openTask(taskId)}
                onOpenChannel={(channelId) => nav.go({ name: "channel", channelId })}
              />
              {SECTIONS.map(({ key, label }) => {
                // Folded, the work going on its own is one line: who's on it, and how many.
                if (key === "working" && !workingOpen) {
                  if (going.length === 0) return null;
                  return (
                    <WorkingFold
                      key="working"
                      rows={going}
                      me={me}
                      onOpen={() => setWorkingOpen(true)}
                    />
                  );
                }
                if (key === "done" && !doneOpen) {
                  if (finished.length === 0) return null;
                  return (
                    <WorkingFold
                      key="done"
                      done
                      rows={finished}
                      me={me}
                      onOpen={() => setDoneOpen(true)}
                      onSettleAll={() => settleAll(finished)}
                    />
                  );
                }
                const groups = grouped(key);
                const total = groups.reduce((n, g) => n + g.items.length, 0);
                const counted = total;
                if (total === 0) return null;
                // In Team, these runs wait on whoever drives them, not only on you.
                const heading = key === "needsYou" && view === "team" ? "Needs someone" : label;
                return (
                  <section key={key} aria-label={heading}>
                    {/* In Mine, Link's line above says what needs you; Team names whose turn it is. */}
                    <div
                      className={`section-head ${key === "needsYou" ? "needs" : ""}`}
                      hidden={key === "needsYou" && view === "mine"}
                    >
                      <span>{heading}</span>
                      {counted > 0 ? (
                        <span className={`badge ${key === "needsYou" ? "amber" : ""}`}>
                          {counted}
                        </span>
                      ) : null}
                      <span className="grow" />
                      {key === "working" || key === "done" ? (
                        <button
                          className="btn small ghost"
                          type="button"
                          onClick={() =>
                            key === "done" ? setDoneOpen(false) : setWorkingOpen(false)
                          }
                        >
                          Fold
                        </button>
                      ) : null}
                      {key === "done" && total > 1 ? (
                        <button
                          className="btn small"
                          type="button"
                          onClick={() =>
                            settleAll(groups.flatMap((g) => g.items.map((e) => e.row)))
                          }
                        >
                          Settle all
                        </button>
                      ) : null}
                    </div>
                    {groups.map((group) => (
                      <div key={group.name ?? "all"}>
                        {group.name ? <div className="group-head">{group.name}</div> : null}
                        {group.items.map((entry) => {
                          const index = entries.indexOf(entry);
                          const focused = index === clamped;
                          return (
                            <Row
                              key={entry.id}
                              entry={entry}
                              me={me}
                              focused={focused && !frozen}
                              now={now}
                              offline={offline}
                              seen={seen}
                              mine={view === "mine"}
                              menu={focused ? menu : null}
                              canAnswer={canAnswer}
                              wheelRun={wheelRun}
                              onFocus={() => setFocus(index)}
                              onOpen={() => openRow(entry.row)}
                              onAnswer={(run, value) => answerApproval(run, value)}
                              onSettle={() => settleRow(entry.row)}
                              onSnooze={(until) => snoozeRow(entry.row, until)}
                              onPass={(run, to) => {
                                setMenu(null);
                                return passWheel({ terminalId: run.terminalId!, to });
                              }}
                              onMenu={(next) => setMenu(next)}
                            />
                          );
                        })}
                      </div>
                    ))}
                  </section>
                );
              })}
            </>
          )}
        </div>
      </div>
      {/* Message your Link as you'd message a Bot in Grok Bot; Enter sends, with no dialog (ADR 0049). */}
      <form
        className="composer inbox-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {link && link.reach === null ? (
          <p className="output-warn composer-note">
            <Icon name="alert" size={14} />
            <span>
              The room can't reach {link.name}, your Link, so messages start a thread until it can.
            </span>
          </p>
        ) : null}
        <div className="composer-box">
          <div className="composer-line">
            <span className="composer-tool">
              <Tip label="New task">
                <button
                  className="icon-btn"
                  type="button"
                  aria-label="New task"
                  onClick={() => setCreating(true)}
                >
                  <Icon name="plus" size={16} />
                </button>
              </Tip>
            </span>
            <Textarea
              className="inbox-ask"
              rows={1}
              value={draft}
              placeholder={
                to.kind === "link" && link ? `Message ${link.name}` : "Tell an agent what to do"
              }
              aria-label={
                to.kind === "link" && link ? `Message ${link.name}` : "What should an agent do?"
              }
              onValueChange={setDraft}
              // Enter sends the form and Shift+Enter makes a new line, so a pasted multi-line prompt
              // keeps its lines. Nothing sends while an input method is composing.
              submitShortcut="enter"
            />
            <SendTarget
              to={to}
              link={link ?? null}
              agents={reachable}
              taskAgents={rosterAgents}
              onTo={setPicked}
              onLink={(memberId) => {
                setPicked(null);
                setLinkSaves((n) => n + 1);
                void setLink({ agentMemberId: memberId }).finally(() => setLinkSaves((n) => n - 1));
              }}
            />
            <Tip label={sendLabel}>
              {/* Native: Enter in the box submits the form without pressing it, and `sending`
                  guards both, and Make it a task too. */}
              <button
                className="icon-btn composer-send"
                type="submit"
                disabled={!draft.trim() || sending || linking}
                aria-label={sendLabel}
              >
                <Icon name="arrow-up" size={16} />
              </button>
            </Tip>
          </div>
        </div>
      </form>
    </>
  );
}

/**
 * Link's line at the top of the Inbox, in a bubble as a Bot speaks in Grok Bot: what needs you, or
 * that nothing does (Inbox zero). Link waits while something needs you and is happy at zero.
 */
/**
 * Tasks proposed from calls (DESIGN.md, Inbox), answered in place: one group per call, each task with
 * Accept, Edit and Dismiss. An answered one leaves the Inbox.
 */
function FromCalls({
  proposals,
  onOpenTask,
  onOpenChannel,
}: {
  proposals: InboxProposal[];
  onOpenTask: (taskId: Id<"tasks">) => void;
  onOpenChannel: (channelId: Id<"channels">) => void;
}) {
  if (proposals.length === 0) return null;
  const calls: {
    callId: string;
    channelId: Id<"channels">;
    where: string;
    items: InboxProposal[];
  }[] = [];
  for (const p of proposals) {
    const call = calls.find((c) => c.callId === p.callId);
    if (call) call.items.push(p);
    else calls.push({ callId: p.callId, channelId: p.channelId, where: p.where, items: [p] });
  }
  return (
    <section className="from-calls" aria-label="Proposed from calls">
      {calls.map((call) => (
        <div key={call.callId} className="from-call">
          <div className="group-head from-call-head">
            <Icon name="volume" size={14} />
            <span className="grow truncate">
              {call.items.length === 1 ? "A task" : `${call.items.length} tasks`} from the call in{" "}
              {call.where}
            </span>
            <button
              className="btn small ghost"
              type="button"
              onClick={() => onOpenChannel(call.channelId)}
            >
              Open
            </button>
          </div>
          <div className="proposal-list">
            {call.items.map((p) => (
              <ProposalRow
                key={p.proposalId}
                proposal={p}
                channelProjectId={p.channelProjectId}
                onOpenTask={onOpenTask}
              />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function LinkSays({
  needs,
  done,
  working,
  view,
  zero,
  fresh,
}: {
  needs: number;
  done: number;
  working: number;
  view: "mine" | "team";
  zero: boolean;
  /** A new team, its first steps under this line: nothing has been caught up on yet. */
  fresh: boolean;
}) {
  const who = view === "mine" ? "you" : "anyone";
  const said = fresh
    ? "Let's get you set up."
    : zero
      ? view === "mine"
        ? "You're all caught up."
        : "Everyone's caught up."
      : needs === 0
        ? `Nothing needs ${who}. ${done === 1 ? "One task is" : `${done} tasks are`} done and ready to settle.`
        : needs === 1
          ? `One thing needs ${who}.`
          : `${needs} things need ${who}.`;
  return (
    <div className="link-says">
      <LinkMascot
        size={zero ? 44 : 28}
        state={zero ? "done" : needs > 0 ? "waiting" : "idle"}
        label="Link"
      />
      <div className="bubble link-bubble">
        {said}
        {zero && working === 0 && !fresh ? (
          <span className="muted"> Nothing is working.</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A new team's first steps, under the Inbox zero line: each a row that opens where it's done, ticked
 * once it is. Shown until the team has a project.
 */
function GetStarted({
  hasAgent,
  hasMachine,
  hasTeammate,
  onSettings,
  onNewTask,
}: {
  hasAgent: boolean;
  hasMachine: boolean;
  hasTeammate: boolean;
  onSettings: (section: "agents" | "machines" | "members") => void;
  onNewTask: () => void;
}) {
  // Any task the team made, closed ones too: a run that finished leaves nothing in the Inbox.
  const tasks = useRoomQuery(api.tasks.board, { includeClosed: true });
  const steps: { done: boolean; title: string; line: string; open: () => void }[] = [
    {
      done: hasMachine,
      title: "Link a machine",
      line: "Runs, terminals and threads start on a linked computer.",
      open: () => onSettings("machines"),
    },
    {
      done: hasAgent,
      title: "Add an agent",
      line: "It joins the roster and can be asked in chat.",
      open: () => onSettings("agents"),
    },
    {
      done: hasTeammate,
      title: "Invite a teammate",
      line: "They see the same Inbox and machines.",
      open: () => onSettings("members"),
    },
    {
      done: (tasks ?? []).length > 0,
      title: "Make a task",
      line: "Start a run on it, and it shows here while it works.",
      open: onNewTask,
    },
  ];
  const done = steps.filter((st) => st.done).length;
  const next = steps.find((st) => !st.done);
  return (
    <section className="get-started" aria-label="Get started">
      <div className="section-head">
        <span>Get started</span>
        <span className="muted">
          {done} of {steps.length} done
        </span>
      </div>
      <Progress
        className="get-started-bar"
        min={0}
        max={steps.length}
        value={done}
        aria-label="Steps done"
        getValueLabel={(value) => `${value ?? 0} of ${steps.length}`}
      >
        {/* The bar is its own track; the indicator sets its width from the value. */}
        <ProgressIndicator render={<span />} />
      </Progress>
      <ol className="get-started-steps">
        {steps.map((st) => (
          <li key={st.title}>
            <button
              type="button"
              className={`get-started-row ${st.done ? "done" : ""} ${st === next ? "next" : ""}`}
              onClick={st.open}
            >
              <span className="get-started-icon">
                <Icon name={st.done ? "check" : "circle"} />
              </span>
              <span className="get-started-text">
                <b>
                  {st.title}
                  {st === next ? <span className="get-started-next">Next</span> : null}
                </b>
                <span className="muted">{st.line}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Row({
  entry,
  me,
  focused,
  now,
  menu,
  offline,
  seen,
  mine,
  canAnswer,
  wheelRun,
  onFocus,
  onOpen,
  onAnswer,
  onSettle,
  onSnooze,
  onPass,
  onMenu,
}: {
  entry: Entry;
  me: string | undefined;
  focused: boolean;
  now: number;
  offline: Set<string>;
  seen: Map<string, number>;
  mine: boolean;
  menu: "snooze" | "wheel" | null;
  canAnswer: (row: InboxRow, run: RunView) => boolean;
  wheelRun: (row: InboxRow) => RunView | undefined;
  onFocus: () => void;
  onOpen: () => void;
  onAnswer: (run: RunView, answer: "allow" | "deny") => unknown;
  onSettle: () => unknown;
  onSnooze: (until: number) => unknown;
  onPass: (run: RunView, to: Id<"members">) => unknown;
  onMenu: (menu: "snooze" | "wheel" | null) => void;
}) {
  const { row, section } = entry;
  const session = useSession();
  const lead = leadRun(row, me);
  const approval = approvalRun(row, me);
  // A waiting run belongs to its driver's Inbox. Anyone else sees "Waiting on <driver>" and no buttons.
  // Answered after it arrived: the machine hasn't moved on yet, so there's nothing left to answer.
  // On its way: no buttons. Not delivered after a while: the buttons come back with a note.
  const delivery = approval ? answerState(approval, now) : "none";
  const answeredPending = delivery === "sending";
  const answerable =
    section === "needsYou" && approval && canAnswer(row, approval) && !answeredPending;
  // An answer can't reach a machine whose bridge is offline; it would land whenever it comes back.
  const approvalOffline = Boolean(approval?.machine && offline.has(approval.machine.machineId));
  const wheel = wheelRun(row);
  const members = session.members.filter((m) => m.memberId !== session.me.memberId);
  const rowRef = useRef<HTMLDivElement>(null);
  // Z and H open these menus by the row (UI SDK Menu, opened by its controller): each opens with
  // its first item active, so arrows and Enter work at once.
  const [snoozeMenu] = useState(() => createMenuController());
  const [wheelMenu] = useState(() => createMenuController());
  const menuNow = useRef(menu);
  menuNow.current = menu;
  const canPass = Boolean(wheel);
  useEffect(() => {
    const anchor = rowRef.current ?? undefined;
    if (menu === "snooze") void snoozeMenu.open({ anchor, focus: "first" });
    else snoozeMenu.close();
    if (menu === "wheel" && canPass) void wheelMenu.open({ anchor, focus: "first" });
    else wheelMenu.close();
  }, [menu, canPass, snoozeMenu, wheelMenu]);
  // A menu that closes itself (an item, Escape, a press outside) closes the row's menu state too.
  const closed = (which: "snooze" | "wheel") => (open: boolean) => {
    if (!open && menuNow.current === which) onMenu(null);
  };

  // The face: an agent driving the lead run shows as its character. In Mine every task is yours,
  // so the rest show the run's harness; in Team they show the task's owner.
  const faceWho = agentOf(lead) ?? (mine ? undefined : (row.owner ?? lead?.driver));
  // An answer can't reach a run whose machine is offline; it would land, unannounced, whenever the
  // machine comes back. Its card says so instead of offering an answer.
  const leadOnline = !(lead?.machine && offline.has(lead.machine.machineId));
  // An agent's question with no set choices is answered on the card itself.
  const replyRun =
    section === "needsYou" &&
    leadOnline &&
    lead?.state === "waiting" &&
    lead.prompt?.kind === "question" &&
    !lead.prompt.questions?.length &&
    lead.canReply
      ? lead
      : undefined;
  // A question with set choices (a T3 Code thread's): its options as a card, one tap to answer.
  const questionRun =
    section === "needsYou" &&
    leadOnline &&
    lead?.state === "waiting" &&
    lead.prompt?.questions?.length &&
    lead.prompt.promptId &&
    canAnswer(row, lead)
      ? lead
      : undefined;
  const state = row.state;

  // A Working row shows its run's current step, and a failed Done row the line it failed on: the
  // last line its terminal printed (DESIGN.md, Inbox).
  const workingRun = rowRun(section, row.runs);
  const failedRun =
    section === "done" && row.state === "failed"
      ? row.runs.find((r) => r.state === "failed")
      : undefined;
  // A private run's terminal is not_found for you (admins too): it never previews.
  const { tail, terminal: tailTerminal } = useTerminalTail(
    previewTerminal(workingRun ?? failedRun),
    3,
  );
  // A failed run's shell is left at a prompt; the line before it is what went wrong. A running
  // run's step is its last whole line, or the answer it got when it asked and nothing came since.
  const step = failedRun
    ? dropTrailingPrompts(tail ?? []).at(-1)
    : workingRun
      ? stepLine(tail)
      : currentStep(tail);
  const answeredStep = workingRun && !step ? workingRun.lastAnswer : undefined;
  const moreWaiting =
    section === "needsYou" ? row.runs.filter((r) => r.state === "waiting").length - 1 : 0;

  const reason = (() => {
    // Sent from a conversation you aren't in: its texts and output stay hidden (ADR 0015).
    if (row.private) return "Private run";
    if (answeredPending && approval?.lastAnswer) {
      return (
        <>
          {approval.lastAnswer.by.memberId === session.me.memberId
            ? "You"
            : approval.lastAnswer.by.name}{" "}
          {approval.lastAnswer.answer === "allow" ? "allowed" : "denied"}{" "}
          {approval.lastAnswer.action ? <Cmd text={approval.lastAnswer.action} /> : "it"}
          <span className="muted">
            ; waiting for {approval.machine?.name ?? "the machine"} to go on
          </span>
        </>
      );
    }
    if (
      (section === "needsYou" || section === "offline") &&
      lead?.state === "waiting" &&
      lead.prompt
    ) {
      // In Team, a run waiting on someone else says whose answer it waits for.
      const whose =
        lead.driver && lead.driver.memberId !== session.me.memberId ? (
          <span className="muted">Waiting on {lead.driver.name}: </span>
        ) : null;
      const more =
        moreWaiting > 0 ? <span className="muted">; {moreWaiting} more waiting</span> : null;
      // An answer that didn't land: the buttons are back, and the row says why.
      const retry =
        delivery === "failed" ? (
          <span className="state-failed">Couldn't deliver your answer, try again. </span>
        ) : null;
      const gone =
        lead.machine && offline.has(lead.machine.machineId) ? (
          <span className="muted">
            ; {lead.machine.name} is offline, so an answer can't reach it
          </span>
        ) : null;
      // The card's top line names who's asking, so the request doesn't start with the name again.
      const asked = lead.prompt.text.replace(lead.prompt.action ?? "", "").trim();
      const name = agentOf(lead)?.name ?? runLabel(lead);
      const plain =
        section === "needsYou" && asked.startsWith(`${name} `)
          ? asked.slice(name.length + 1).replace(/^./, (c) => c.toUpperCase())
          : asked;
      // An approval asks as Grok Bot's do: "Allow Codex to run pnpm add -D tiled-map?"
      const asks = section === "needsYou" && (!plain || /^wants to run$/i.test(plain));
      return lead.prompt.action ? (
        <>
          {retry}
          {whose}
          {asks
            ? `Allow ${name} to run`
            : plain ||
              (section === "needsYou" ? "Wants to run" : `${runLabel(lead)} wants to run`)}{" "}
          <Cmd text={lead.prompt.action} />
          {asks ? "?" : null}
          {more}
          {gone}
        </>
      ) : (
        <>
          {retry}
          {whose}
          {lead.prompt.text}
          {more}
          {gone}
        </>
      );
    }
    if (section === "needsYou") return "Waiting for you";
    const others = row.waitingOn.filter((w) => w.memberId !== session.me.memberId);
    if (others.length > 0) return `Waiting on ${others.map((w) => w.name).join(", ")}`;
    const shown = rowRun(section, row.runs) ?? lead;
    if (!shown) return "";
    const where = `${runLabel(shown)}${shown.machine ? ` on ${shown.machine.name}` : ""}`;
    if (failedRun) {
      const why = failText(failedRun.failReason) ?? step;
      return (
        <>
          <span className="state-failed">{runLabel(failedRun)} failed</span>
          {failedRun.machine ? ` on ${failedRun.machine.name}` : ""}
          {tailTerminal?.exitCode !== undefined ? ` (exit ${tailTerminal.exitCode})` : ""}
          {why ? <span className="step">: {why}</span> : null}
        </>
      );
    }
    const failed =
      section === "working" || section === "offline" ? failedNote(row.runs) : undefined;
    return (
      <>
        {where}
        {failed ? <span className="state-failed">; {failed}</span> : null}
        {step && workingRun ? <span className="step">: {step}</span> : null}
        {!step && answeredStep ? (
          <span className="step">
            {"; "}
            {answeredStep.by.memberId === session.me.memberId ? "You" : answeredStep.by.name}{" "}
            {answeredStep.answer === "allow" ? "allowed" : "denied"}{" "}
            {answeredStep.action ? <Cmd text={answeredStep.action} /> : "its request"}
          </span>
        ) : null}
      </>
    );
  })();

  // A row in Working shows its working run, even beside a failed attempt (named above); any other
  // row shows the run its state comes from. Same words and times as the run card (`showRun`).
  const shownRun = workingRun ?? row.runs.find((r) => r.state === state) ?? lead;
  const shown = shownRun
    ? showRun(
        shownRun,
        now,
        Boolean(shownRun.machine && offline.has(shownRun.machine.machineId)),
        shownRun.machine ? seen.get(shownRun.machine.machineId) : undefined,
      )
    : undefined;
  const right = shown ? (
    <>
      <StateIcon state={shown.icon} glyph={shown.glyph} />
      <span>
        {shown.label}{" "}
        {shown.time ? (
          <span className={shown.ticking ? "mono" : undefined}>{shown.time}</span>
        ) : null}
      </span>
    </>
  ) : (
    <>
      <StateIcon state={state} />
      <span>{STATE_META[state].label}</span>
    </>
  );

  // The text button is the row's Tab stop. Arrows and J/K move it, Enter opens it,
  // and A, S, Z and H act on it. The group tracks selection after a completed click.
  return (
    <div
      className={`inbox-row ${focused && !menu ? "focus" : ""} ${section === "needsYou" ? "needs" : ""}`}
      role="group"
      aria-label={row.title}
      title={section === "needsYou" ? row.title : undefined}
      data-focus={focused}
      ref={rowRef}
      // Focus on click, not mousedown: focusing grows the row (its key hints appear) and moves the
      // Allow button, so a mouseup after a mousedown focus change would miss the button.
      onClickCapture={onFocus}
      style={{ position: "relative" }}
    >
      {faceWho ? (
        <Face who={faceWho} state={state === "not_started" ? "idle" : state} />
      ) : (
        <HarnessMark
          harness={lead?.harness ?? "shell"}
          state={state === "not_started" ? "idle" : state}
        />
      )}
      <button
        className="inbox-open"
        type="button"
        data-entry={entry.id}
        onClick={onOpen}
        onFocus={onFocus}
      >
        <span className="title">
          {/* Every decision card starts the same way: who's asking. */}
          {section === "needsYou" && lead ? (
            <span className="who">{agentOf(lead)?.name ?? runLabel(lead)}</span>
          ) : null}
          {/* On a decision card the task is its tooltip: the question is what to read. */}
          <span className="t" hidden={section === "needsYou"}>
            {row.title}
          </span>
          {row.unfiled ? <span className="tag">Unfiled</span> : null}
        </span>
        <span className="reason">{reason}</span>
      </button>
      {replyRun ? (
        // A new question (another run's, or the next prompt) starts with an empty draft.
        <QuickReply key={`${replyRun.runId}:${replyRun.prompt?.promptId ?? ""}`} run={replyRun} />
      ) : null}
      {questionRun ? (
        <div className="inbox-question">
          <QuestionForm
            // A new question (another run's, or the next prompt) starts with no answers picked.
            key={`${questionRun.runId}:${questionRun.prompt!.promptId}`}
            runId={questionRun.runId}
            promptId={questionRun.prompt!.promptId!}
            questions={questionRun.prompt!.questions!}
          />
        </div>
      ) : null}
      <div className="right">
        {section === "done" ? (
          <Tip label="Settle (S)">
            <button className="btn settle-btn" type="button" onClick={() => void onSettle()}>
              Settle
            </button>
          </Tip>
        ) : null}
        {answerable && approval && !approvalOffline ? (
          <span className="actions">
            <Tip label={approvalOffline ? OFFLINE_ANSWER : ""}>
              <button
                className="btn primary"
                type="button"
                disabled={approvalOffline}
                onClick={() => onAnswer(approval, "allow")}
              >
                Allow
              </button>
            </Tip>
            <Tip label={approvalOffline ? OFFLINE_ANSWER : ""}>
              <button
                className="btn"
                type="button"
                disabled={approvalOffline}
                onClick={() => onAnswer(approval, "deny")}
              >
                Deny
              </button>
            </Tip>
          </span>
        ) : null}
        <span className="row-state">{right}</span>
      </div>
      {focused ? (
        <div className="row-keys" aria-label="Keyboard keys for this row">
          {answerable && !approvalOffline ? (
            <span>
              <span className="kbd">A</span> Allow
            </span>
          ) : null}
          {section === "done" ? (
            // On the focused row the hint is the button: one Settle, not two.
            <button type="button" className="key-hint" onClick={() => void onSettle()}>
              <span className="kbd">S</span> Settle
            </button>
          ) : null}
          {section !== "needsYou" ? (
            <span>
              <span className="kbd">Z</span> Snooze
            </span>
          ) : null}
          {wheel ? (
            <span>
              <span className="kbd">H</span> Hand off
            </span>
          ) : null}
          <span>
            <span className="kbd">↵</span> Open
          </span>
        </div>
      ) : null}
      <Menu controller={snoozeMenu} onOpenChange={closed("snooze")}>
        <MenuContent
          className="pop inbox-menu"
          aria-label="Snooze until"
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          onKeyDownCapture={rowMenuKeys}
        >
          <MenuGroup>
            <MenuGroupLabel className="pop-title">Snooze until</MenuGroupLabel>
            <MenuItem
              render={asButton}
              label="In 1 hour"
              onSelect={() => void onSnooze(Date.now() + 60 * 60 * 1000)}
            >
              In 1 hour <span className="muted">{formatTime(Date.now() + 60 * 60 * 1000)}</span>
            </MenuItem>
            <MenuItem
              render={asButton}
              label="Tomorrow morning"
              onSelect={() => void onSnooze(tomorrowMorning())}
            >
              Tomorrow morning <span className="muted">{formatTime(tomorrowMorning())}</span>
            </MenuItem>
            <MenuItem
              render={asButton}
              label="Next week"
              onSelect={() => void onSnooze(nextWeek())}
            >
              Next week <span className="muted">{formatTime(nextWeek())}</span>
            </MenuItem>
          </MenuGroup>
        </MenuContent>
      </Menu>
      <Menu controller={wheelMenu} onOpenChange={closed("wheel")}>
        <MenuContent
          className="pop inbox-menu"
          aria-label="Hand off to"
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          onKeyDownCapture={rowMenuKeys}
        >
          <MenuGroup>
            <MenuGroupLabel className="pop-title">Hand off to</MenuGroupLabel>
            {wheel
              ? members.map((member) => (
                  <MenuItem
                    key={member.memberId}
                    render={asButton}
                    label={member.name}
                    // Not returned: the menu closes now, and the toast says how the handoff went.
                    onSelect={() => void onPass(wheel, member.memberId)}
                  >
                    <Face who={member} size={18} /> {member.name}
                  </MenuItem>
                ))
              : null}
          </MenuGroup>
          <MenuSeparator />
          <MenuItem render={asButton}>Cancel</MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}

/** Who drives a row's lead run as a face: an agent it was given to, else its driver if an agent. */
function agentOf(run: RunView | undefined) {
  const given = run?.given?.agent;
  if (given)
    return {
      kind: "agent" as const,
      memberId: given.memberId,
      name: given.name,
      character: given.character,
    };
  return run?.driver?.kind === "agent" ? run.driver : undefined;
}

/** Finished work's state on its face: done, or failed or stopped when any of its runs was. */
function finishedState(row: InboxRow) {
  return row.state === "failed" || row.state === "stopped" ? row.state : "done";
}

/**
 * Working, folded: one line with the faces of what's working and how many, which opens the section.
 * Its work goes on whether or not anyone watches.
 */
function WorkingFold({
  rows,
  me,
  onOpen,
  done,
  onSettleAll,
}: {
  rows: InboxRow[];
  me: string;
  onOpen: () => void;
  /** Finished work: its titles, and Settle all beside the line. */
  done?: boolean;
  onSettleAll?: () => void;
}) {
  const leads = rows.map((row) => leadRun(row, me));
  // Finished isn't always done: a failed or stopped run says so on the folded line too. The row's
  // state is its most urgent run's (inbox.ts), so a later failed run counts, not only the first.
  const failed = done ? rows.filter((row) => finishedState(row) === "failed").length : 0;
  const stopped = done ? rows.filter((row) => finishedState(row) === "stopped").length : 0;
  const unwell = failed + stopped;
  const names = [
    ...new Set(leads.map((run) => (run ? (agentOf(run)?.name ?? runLabel(run)) : "A run"))),
  ];
  const said = done
    ? rows.map((row) => row.title).join(", ")
    : names.length <= 2
      ? names.join(" and ")
      : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
  return (
    <div className="working-fold-row">
      <button className="working-fold" type="button" onClick={onOpen} aria-expanded={false}>
        <span className="working-faces">
          {leads.slice(0, 4).map((run, i) => {
            const agent = agentOf(run);
            return agent ? (
              <Face
                key={i}
                who={agent}
                state={done ? finishedState(rows[i]!) : "working"}
                size={22}
              />
            ) : (
              <HarnessMark
                key={i}
                harness={run?.harness ?? "shell"}
                state={done ? finishedState(rows[i]!) : "working"}
                size={22}
              />
            );
          })}
        </span>
        <span className="grow">
          <b>
            {rows.length} {done ? (unwell > 0 ? "finished" : "done") : "working"}
          </b>
          {unwell > 0 ? (
            <span className="state-failed">
              {", "}
              {[failed > 0 ? `${failed} failed` : "", stopped > 0 ? `${stopped} stopped` : ""]
                .filter(Boolean)
                .join(", ")}
            </span>
          ) : null}{" "}
          <span className="muted">{said}</span>
        </span>
      </button>
      {done && onSettleAll ? (
        <button className="btn small" type="button" onClick={onSettleAll}>
          Settle all
        </button>
      ) : null}
      <Tip label={done ? "Show what's done" : "Show what's working"}>
        <button
          className="icon-btn working-fold-open"
          type="button"
          aria-label={done ? "Show what's done" : "Show what's working"}
          onClick={onOpen}
        >
          <Icon name="chevron-down" />
        </button>
      </Tip>
    </div>
  );
}

/**
 * An answer to an agent's question, typed right on its Inbox card (runs.reply), so a question is
 * answered where it's read. Questions a coding harness asks on its machine open their thread instead.
 */
function QuickReply({ run }: { run: RunView }) {
  const reply = useAct(api.runs.reply, { success: "Sent" });
  const [text, setText] = useState("");
  const sendButton = useRef<HTMLButtonElement>(null);
  const send = async () => {
    const said = text.trim();
    if (!said) return;
    const done = await reply({ runId: run.runId, text: said });
    if (done !== undefined) setText("");
  };
  return (
    <form
      className="quick-reply"
      onSubmit={(event) => {
        // Enter in the field presses Send, so the answer is pending on the button either way.
        event.preventDefault();
        sendButton.current?.click();
      }}
    >
      <Input
        className="input"
        value={text}
        placeholder={`Answer ${agentOf(run)?.name ?? runLabel(run)}`}
        aria-label={`Answer ${agentOf(run)?.name ?? runLabel(run)}`}
        onValueChange={setText}
      />
      <Button ref={sendButton} className="btn primary" disabled={!text.trim()} onClick={send}>
        Send
      </Button>
    </form>
  );
}

/** Renders a menu item as a native button, so the app's `.pop button` rows style it. */
const asButton = (props: Record<string, unknown>) => <button type="button" {...props} />;

/** Why Allow and Deny can't be pressed: an answer can't reach a machine whose bridge is offline. */
const OFFLINE_ANSWER = "Its machine is offline, so the answer can't reach it.";

/**
 * J and K move through an open row menu as the arrows do, as they move through the rows. They run
 * in the capture phase, before the menu's typeahead would read them as letters.
 */
function rowMenuKeys(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key !== "j" && key !== "k") return;
  event.preventDefault();
  event.stopPropagation();
  event.target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: key === "j" ? "ArrowDown" : "ArrowUp",
      bubbles: true,
      cancelable: true,
    }),
  );
}

/** Next Monday at 9:00, or the Monday after when it's Monday already. */
function nextWeek(): number {
  const date = new Date();
  date.setDate(date.getDate() + ((8 - date.getDay()) % 7 || 7));
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

function tomorrowMorning(): number {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

/** The Inbox's one filter: Mine or Team, and one project or all, in a menu under a quiet pill. */
function InboxFilter({
  view,
  projectFilter,
  projects,
  onView,
  onProject,
}: {
  view: "mine" | "team";
  projectFilter: Id<"projects"> | "all";
  projects: { projectId: Id<"projects">; name: string }[];
  onView: (view: "mine" | "team") => void;
  onProject: (projectId: Id<"projects"> | "all") => void;
}) {
  const project = projects.find((p) => p.projectId === projectFilter);
  const label = `${view === "mine" ? "Mine" : "Team"}${project ? `, ${project.name}` : ""}`;
  return (
    <div className="inbox-filter">
      <Menu>
        <MenuTrigger className="btn" aria-label={`Showing ${label}`}>
          <span className="truncate">{label}</span>
          <Icon name="chevron-down" />
        </MenuTrigger>
        <MenuContent
          className="pop inbox-filter-pop"
          aria-label="Show"
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={8}
        >
          {/* A choice closes the menu, as picking a filter is done in one press. */}
          <MenuRadioGroup value={view} onValueChange={(next) => onView(next as "mine" | "team")}>
            {(["mine", "team"] as const).map((key) => (
              <MenuRadioItem key={key} value={key} closeOnSelect render={asButton}>
                <span className="grow">{key === "mine" ? "Mine" : "Team"}</span>
                {view === key ? <Icon name="check" /> : null}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          {projects.length > 0 ? (
            <>
              <MenuSeparator />
              <MenuRadioGroup
                value={projectFilter}
                onValueChange={(next) => onProject(next as Id<"projects"> | "all")}
              >
                {[{ projectId: "all" as const, name: "All projects" }, ...projects].map((p) => (
                  <MenuRadioItem
                    key={p.projectId}
                    value={p.projectId}
                    label={p.name}
                    closeOnSelect
                    render={asButton}
                  >
                    <span className="grow truncate">{p.name}</span>
                    {projectFilter === p.projectId ? <Icon name="check" /> : null}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </>
          ) : null}
        </MenuContent>
      </Menu>
    </div>
  );
}
