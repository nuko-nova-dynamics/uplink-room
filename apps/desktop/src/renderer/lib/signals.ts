/**
 * Which cues and banners the Room's live data calls for (DESIGN.md, Sound and
 * Notifications). The shell keeps a snapshot of what needs you, whether the
 * Inbox is at zero and who drives each terminal; comparing the last two
 * snapshots says what changed. Pure, so it is tested without the app
 * (signals.test.ts).
 */
import type { Cue } from "./sound";
import { runLabel } from "./format";
import type { NotifyChoice, NotifyRequest } from "../../main/notifySpec";

/** The parts of an Inbox row and a terminal this needs (`api.inbox.get` and `api.terminals.list`). */
type Run = {
  runId: string;
  taskId?: string | undefined;
  terminalId?: string | undefined;
  harness: string;
  state: string;
  stateChangedAt: number;
  driver?: { memberId: string; kind: string; name: string } | undefined;
  prompt?:
    | {
        kind: "approval" | "question";
        text: string;
        action?: string | undefined;
        hardToUndo?: boolean | undefined;
        promptId?: string | undefined;
      }
    | undefined;
};
type Row = { title: string; taskId?: string | undefined; runs: Run[] };
type Terminal = {
  terminalId: string;
  title: string;
  machine?: { name: string } | undefined;
  driver?: { memberId: string } | undefined;
};

/** One run waiting on you, with what its banner says and what its buttons do. */
export type Waiting = {
  key: string;
  who: string;
  task: string;
  text: string;
  canAllow: boolean;
  runId: string;
  promptId: string | undefined;
  taskId: string | undefined;
  terminalId: string | undefined;
};

export type Snapshot = {
  waiting: Map<string, Waiting>;
  zero: boolean;
  /** Who drives each live terminal, and what it is called. */
  terminals: Map<
    string,
    { driver: string | undefined; title: string; machine: string | undefined }
  >;
};

/** "Codex wants to run X" reads "Wants to run X" under a "Codex needs you" title. */
function reasonFor(run: Run, who: string): string {
  const prompt = run.prompt;
  if (!prompt) return "Waiting for you";
  let text = prompt.text.trim();
  if (prompt.action && !text.includes(prompt.action)) text = `${text} ${prompt.action}`;
  if (text.toLowerCase().startsWith(`${who.toLowerCase()} `)) {
    const rest = text.slice(who.length + 1);
    text = rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  return text;
}

export function snapshot(
  inbox: { needsYou: Row[]; done: Row[] },
  terminals: Terminal[],
  me: string,
): Snapshot {
  const waiting = new Map<string, Waiting>();
  for (const row of inbox.needsYou) {
    for (const run of row.runs) {
      if (run.state !== "waiting" || run.driver?.memberId !== me) continue;
      // A new approval on the same run is a new thing that needs you.
      const key = `${run.runId}:${run.prompt?.promptId ?? run.stateChangedAt}`;
      const who = runLabel(run);
      waiting.set(key, {
        key,
        who,
        task: row.title,
        text: reasonFor(run, who),
        canAllow: run.prompt?.kind === "approval" && !run.prompt.hardToUndo,
        runId: run.runId,
        promptId: run.prompt?.promptId,
        taskId: row.taskId ?? run.taskId,
        terminalId: run.terminalId,
      });
    }
  }
  return {
    waiting,
    zero: inbox.needsYou.length === 0 && inbox.done.length === 0,
    terminals: new Map(
      terminals.map((t) => [
        t.terminalId,
        { driver: t.driver?.memberId, title: t.title, machine: t.machine?.name },
      ]),
    ),
  };
}

export type Banner =
  | ({ kind: "needs"; id: string } & Waiting)
  | {
      kind: "wheel";
      id: string;
      terminalId: string;
      terminal: string;
      machine: string | undefined;
    };

export type Changes = { cues: Cue[]; banners: Banner[]; dismiss: string[] };

/**
 * The banner keys still current: each run waiting on you and each terminal you drive. A session
 * sends these when it starts, and main takes away any banner it kept that isn't among them.
 */
export function liveKeys(now: Snapshot, me: string): string[] {
  const driving = [...now.terminals].filter(([, t]) => t.driver === me).map(([id]) => wheelId(id));
  return [...now.waiting.keys(), ...driving];
}

export type BannerAction =
  | { kind: "ignore" }
  | { kind: "answer"; runId: string; promptId: string }
  | { kind: "openTerminal"; terminalId: string }
  | { kind: "openRun"; taskId: string | undefined; terminalId: string | undefined }
  | { kind: "openMessage"; channelId: string; messageId: string };

/**
 * What a click or a button on a banner does. A banner that belongs to another session (`from`, a
 * team left a moment ago, or a person signed out) does nothing in this one (`here`): its ids
 * belong to the other team. Allow answers only while the approval the banner showed is still the
 * one waiting on you (`now`, the latest snapshot); if it was answered elsewhere, moved on to a
 * newer approval, or nothing has loaded yet, the banner opens its run and answers nothing.
 * Everything else opens.
 */
export function bannerAction(
  choice: NotifyChoice,
  request: NotifyRequest,
  now: Snapshot | null,
  from: string,
  here: string,
): BannerAction {
  if (from !== here) return { kind: "ignore" };
  if (request.kind === "wheel") return { kind: "openTerminal", terminalId: request.terminalId };
  if (request.kind === "message") return { kind: "openMessage", channelId: request.channelId, messageId: request.messageId };
  const waiting = now?.waiting.get(request.id);
  const stillShown =
    waiting !== undefined &&
    waiting.runId === request.runId &&
    waiting.promptId === request.promptId &&
    waiting.canAllow;
  if (choice === "allow" && request.canAllow && stillShown) {
    return { kind: "answer", runId: request.runId, promptId: request.promptId ?? "" };
  }
  return { kind: "openRun", taskId: request.taskId, terminalId: request.terminalId };
}

/**
 * What the main process is asked to show. A needs-you banner carries its run, prompt and target,
 * and main hands them back with a click or a button, so Allow answers exactly the approval the
 * banner showed. `id` is the key the renderer dismisses it by, not the system notification's id.
 */
export function bannerRequest(banner: Banner): NotifyRequest {
  if (banner.kind === "wheel") {
    return {
      kind: "wheel",
      id: banner.id,
      terminal: banner.terminal,
      machine: banner.machine,
      terminalId: banner.terminalId,
    };
  }
  return {
    kind: "needs",
    id: banner.id,
    who: banner.who,
    task: banner.task,
    text: banner.text,
    canAllow: banner.canAllow,
    runId: banner.runId,
    promptId: banner.promptId,
    taskId: banner.taskId,
    terminalId: banner.terminalId,
  };
}

export const wheelId = (terminalId: string) => `wheel:${terminalId}`;

/**
 * What changed between two snapshots. The first snapshot after the app opens
 * (`before` null) changes nothing: work that was already waiting doesn't cue.
 */
export function changes(before: Snapshot | null, after: Snapshot, me: string): Changes {
  const result: Changes = { cues: [], banners: [], dismiss: [] };
  if (!before) return result;

  const fresh = [...after.waiting.values()].filter((w) => !before.waiting.has(w.key));
  if (fresh.length > 0) result.cues.push("needs");
  for (const w of fresh) result.banners.push({ kind: "needs", id: w.key, ...w });
  for (const key of before.waiting.keys()) if (!after.waiting.has(key)) result.dismiss.push(key);

  // The wheel is yours: a terminal that someone else drove is now yours. A terminal you just
  // started is yours from its first snapshot, so it doesn't count. When its run is already waiting
  // on you, that banner (with Allow when it can be undone) says it, so the wheel gets no second one.
  const waitingOn = new Set(fresh.map((w) => w.terminalId));
  for (const [terminalId, now] of after.terminals) {
    const was = before.terminals.get(terminalId);
    if (now.driver === me && was && was.driver !== me) {
      result.cues.push("wheel");
      if (waitingOn.has(terminalId)) continue;
      result.banners.push({
        kind: "wheel",
        id: wheelId(terminalId),
        terminalId,
        terminal: now.title,
        machine: now.machine,
      });
    }
  }
  for (const [terminalId, was] of before.terminals) {
    const now = after.terminals.get(terminalId);
    if (was.driver === me && now?.driver !== me) result.dismiss.push(wheelId(terminalId));
  }

  if (!before.zero && after.zero) result.cues.push("zero");
  // One cue per kind, however many runs changed at once.
  result.cues = [...new Set(result.cues)];
  return result;
}
