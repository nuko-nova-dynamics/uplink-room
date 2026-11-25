/**
 * What a system notification says and which buttons it has (DESIGN.md,
 * Notifications). Pure, so it is tested without Electron (notifySpec.test.ts).
 *
 * Three events get a banner: something needs you, the wheel is yours, and a
 * message addressed to you (a direct message, a mention, @everyone, a reply,
 * or any message in a channel you set to all; spec #63). A banner offers Allow
 * only when the approval can be undone; anything hard to undo (a deploy), every
 * question, and every message, offers Open only.
 */

export type NotifyRequest =
  | {
      kind: "needs";
      /**
       * The renderer's key for this waiting run (`<runId>:<promptId>`), which it dismisses the
       * banner by. It is too long to be the system notification's own id (notifyRegistry.ts).
       */
      id: string;
      /** Who is asking: the harness or agent running the run. */
      who: string;
      task: string;
      /** The reason line, as the Inbox row shows it. */
      text: string;
      /** The renderer worked out that this is an approval you can answer and that it can be undone. */
      canAllow: boolean;
      /** The approval the banner shows: Allow answers exactly this run and prompt. */
      runId: string;
      promptId?: string | undefined;
      /** What Open shows. */
      taskId?: string | undefined;
      terminalId?: string | undefined;
    }
  | {
      kind: "wheel";
      id: string;
      terminal: string;
      machine?: string | undefined;
      terminalId: string;
    }
  | {
      kind: "message";
      /** `message:<messageId>`. */
      id: string;
      /** Who wrote it. */
      who: string;
      /** `#channel`, or the other members' names for a direct message. */
      where: string;
      direct: boolean;
      /** Why it reached you. */
      reason: MessageReason;
      /** A trimmed plain-text preview. */
      text: string;
      /** What Open shows: the message in its channel. */
      channelId: string;
      messageId: string;
    };

export type MessageReason = "direct" | "mention" | "reply" | "everyone" | "all";
const REASONS: readonly MessageReason[] = ["direct", "mention", "reply", "everyone", "all"];

export type NotifyChoice = "allow" | "open";

export type NotifySpec = {
  title: string;
  subtitle?: string;
  body: string;
  /** Button order matters: on macOS only the first is shown without hovering. */
  buttons: { text: string; choice: NotifyChoice }[];
};

const MAX = 120;
function clip(text: string, max = MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Only macOS shows a subtitle, so elsewhere the task goes on the body's first line. */
export function notifySpec(request: NotifyRequest, platform: NodeJS.Platform): NotifySpec {
  if (request.kind === "message") {
    const who = clip(request.who, 40);
    const where = request.direct ? "Direct message" : clip(request.where, 50);
    const title =
      request.reason === "mention"
        ? `${who} mentioned you`
        : request.reason === "reply"
          ? `${who} replied to you`
          : request.reason === "everyone"
            ? `${who} to @everyone`
            : who;
    const text = clip(request.text) || "Sent an attachment";
    const buttons: NotifySpec["buttons"] = [{ text: "Open", choice: "open" }];
    return platform === "darwin"
      ? { title, subtitle: where, body: text, buttons }
      : { title, body: `${where}\n${text}`, buttons };
  }
  if (request.kind === "wheel") {
    const where = request.machine ? ` on ${clip(request.machine, 40)}` : "";
    return {
      title: "You have control",
      body: `You're in control of ${clip(request.terminal, 60)}${where} now.`,
      buttons: [{ text: "Open", choice: "open" }],
    };
  }
  const title = `${clip(request.who, 40)} needs you`;
  const task = clip(request.task, 70);
  const text = clip(request.text);
  const buttons: NotifySpec["buttons"] = request.canAllow
    ? [
        { text: "Allow", choice: "allow" },
        { text: "Open", choice: "open" },
      ]
    : [{ text: "Open", choice: "open" }];
  return platform === "darwin"
    ? { title, subtitle: task, body: text, buttons }
    : { title, body: `${task}\n${text}`, buttons };
}

/**
 * Whether main shows a banner now. Needs you and the wheel interrupt only while you're in another
 * app; inside the app the Inbox and the sound cue say it. A message banner shows while the window
 * has focus too: it can be for a channel or direct message other than the one you're reading, and
 * the renderer already leaves out the one you're looking at (lib/messageSignals.ts).
 */
export function showsWhileFocused(request: NotifyRequest): boolean {
  return request.kind === "message";
}

export function shouldShow(request: NotifyRequest, focused: boolean): boolean {
  return !focused || showsWhileFocused(request);
}

/** The most of a display field (who, task, reason, terminal, machine) a request keeps. */
const MAX_FIELD = 500;

/**
 * Checks a request from the renderer before anything is shown. Ids must be well formed, or the
 * request is refused. Display text is clipped instead: a reason line can carry a whole command
 * (Claude Code forwards scripts in full), and its approval still needs its banner.
 */
export function parseNotifyRequest(value: unknown): NotifyRequest | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const ref = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 200;
  const optional = (x: unknown): x is string | undefined => x === undefined || ref(x);
  const display = (x: unknown): string | null =>
    typeof x === "string" ? x.slice(0, MAX_FIELD) : null;
  const id = v["id"];
  if (!ref(id)) return null;
  if (v["kind"] === "needs") {
    const { canAllow, runId, promptId, taskId, terminalId } = v;
    const who = display(v["who"]);
    const task = display(v["task"]);
    const text = display(v["text"]);
    if (who === null || task === null || text === null || typeof canAllow !== "boolean") return null;
    if (!ref(runId) || !optional(promptId) || !optional(taskId) || !optional(terminalId))
      return null;
    return { kind: "needs", id, who, task, text, canAllow, runId, promptId, taskId, terminalId };
  }
  if (v["kind"] === "message") {
    const who = display(v["who"]);
    const where = display(v["where"]);
    const text = display(v["text"]);
    const { direct, reason, channelId, messageId } = v;
    if (who === null || where === null || text === null || typeof direct !== "boolean") return null;
    if (!REASONS.includes(reason as MessageReason) || !ref(channelId) || !ref(messageId)) return null;
    return { kind: "message", id, who, where, direct, reason: reason as MessageReason, text, channelId, messageId };
  }
  if (v["kind"] === "wheel") {
    const terminal = display(v["terminal"]);
    const machine = v["machine"] === undefined ? undefined : display(v["machine"]);
    const terminalId = v["terminalId"];
    if (terminal === null || machine === null || !ref(terminalId)) return null;
    return { kind: "wheel", id, terminal, machine, terminalId };
  }
  return null;
}

/** A renderer session's id (Signals makes one per mount). */
export function parseSession(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 100 ? value : null;
}

/** The banner keys a session says are live: keys like a request's `id`, and not unboundedly many. */
export function parseLiveKeys(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 5000) return null;
  return value.every((key) => typeof key === "string" && key.length > 0 && key.length <= 200)
    ? (value as string[])
    : null;
}
