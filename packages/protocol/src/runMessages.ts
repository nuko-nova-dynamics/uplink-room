/**
 * The text a live run reads for the messages the room hands it (ADR 0026). The room packs a claim
 * with `fitRunMessages`, so what it hands over fits one delivery, and the bridge writes it with
 * `formatRunMessages`: both use these functions, so they agree on the length.
 */

/** One message as the room hands it to a run, labelled at hand-over (`bridge:claimRunMessages`). */
export type RunDelivery = {
  /** The room's record of this run getting this message (a `runInbox` row). */
  deliveryId: string;
  /** The chat message, which the run answers. */
  messageId: string;
  /** Where it was posted: "#payments", "a thread in #payments", "a direct message". */
  place: string;
  /** The message as written, with names for mention tokens, cut to RUN_MESSAGE_TEXT_MAX (`cut`). */
  text: string;
  cut?: boolean;
  /** How many files are attached to it. */
  attachments?: number;
  /**
   * The run can save its files itself with `uplink download <messageId>` (a Pair message's, which a
   * joined run fetches through `joined.download`, ADR 0048).
   */
  downloadable?: true;
  /**
   * The attached files themselves, to a bridge that names `run_message_files` (ADR 0043): each with a
   * link the bridge downloads it from. The run never sees the link.
   */
  files?: { name: string; kind: "image" | "pdf" | "file"; mimeType: string; size: number; url: string }[];
  /**
   * Set by the bridge once it got the files to the run: `with_message` when they went in with the
   * message itself (T3 Code's attachments, Codex's images), or the paths it saved each one at.
   */
  delivered?: { with_message: number } | { saved: { name: string; path: string }[] };
  from: {
    memberId: string;
    name: string;
    kind: "person" | "agent";
    /** The sending run's name, such as "Claude Code (Pepe)", when a run posted it as itself. */
    run?: string;
  };
  accountable: { memberId: string; name: string };
  /** Whether the accountable person is this run's driver at hand-over (an agent driver's person). */
  fromDriver: boolean;
  at: number;
};

/**
 * Claude Code saves `additionalContext` (and a rewake's output) over 10,000 characters to a file and
 * shows only a preview (code.claude.com/docs/en/hooks, "JSON output"), so one delivery stays under it.
 */
export const DELIVERY_TEXT_MAX = 9000;

/**
 * Every line break a reader might honour: CRLF, CR, LF, NEL, VT, FF, and Unicode's line and
 * paragraph separators. A message's text is split on all of them, so none can end a quoted line
 * early and start one that poses as a label.
 */
const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;
/** Control characters other than tab (C0, DEL, C1, which includes NEL), and the two separators. */
// oxlint-disable-next-line no-control-regex -- finding control characters in untrusted text is the point
const UNSAFE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Untrusted text with every control character and line break shown as an escape, such as `\u001b`. */
function escaped(text: string): string {
  return text.replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * What a message's files became for the run: they came with it, they were saved at these paths (a
 * harness with no input for files, ADR 0043), or they stayed in the room. A path and a name come
 * from people, so each shows escaped, one per line.
 */
function fileNotes(delivery: RunDelivery): string[] {
  const count = delivery.attachments ?? delivery.files?.length ?? 0;
  if (!count) return [];
  const files = (n: number) => `${n} attached file${n === 1 ? "" : "s"}`;
  const done = delivery.delivered;
  if (done && "with_message" in done) {
    const rest = count - done.with_message;
    return [`Its ${files(done.with_message)} came with this message.${rest > 0 ? ` ${rest} more stay in the room.` : ""}`];
  }
  if (done && done.saved.length) {
    const rest = count - done.saved.length;
    return [
      `Its ${files(done.saved.length)} ${done.saved.length === 1 ? "was" : "were"} saved for this run at:`,
      ...done.saved.map((file) => `- ${escaped(file.path)}`),
      ...(rest > 0 ? [`${rest} more stay in the room.`] : []),
    ];
  }
  if (delivery.downloadable) return [`It has ${files(count)}. Save ${count === 1 ? "it" : "them"} with: uplink download ${escaped(delivery.messageId)}`];
  return [`It has ${files(count)}, which stay in the room.`];
}

function sender(delivery: RunDelivery): string {
  if (delivery.from.run) return `${escaped(delivery.from.run)}, a run ${escaped(delivery.from.name)} drives`;
  return `${escaped(delivery.from.name)}, ${delivery.from.kind === "agent" ? "an agent" : "a person"}`;
}

/**
 * One message as the run reads it: a label line, then its text quoted line by line, so text can't
 * pose as a label. Names and places come from people too, so the label shows theirs escaped.
 */
function block(delivery: RunDelivery, room: number): string {
  const label =
    `Message ${escaped(delivery.messageId)} in ${escaped(delivery.place)}, from ${sender(delivery)}. ` +
    `${escaped(delivery.accountable.name)} is accountable for it and is ${delivery.fromDriver ? "" : "not "}this run's driver.`;
  const notes = fileNotes(delivery);
  let quoted = delivery.text
    .split(LINE_BREAK)
    .map((line) => `> ${escaped(line)}`)
    .join("\n");
  let cut = delivery.cut === true;
  const fixed = label.length + notes.join("\n").length + 80;
  if (quoted.length + fixed > room) {
    quoted = quoted.slice(0, Math.max(0, room - fixed)).toWellFormed();
    cut = true;
  }
  if (cut) notes.push("Its text was cut here; the whole message is in the room.");
  return [label, quoted, ...notes].join("\n");
}

/**
 * The text that delivers messages to a run, written as facts about who sent what, as Claude Code's
 * hooks page advises for `additionalContext`: text framed as commands can trip the model's
 * prompt-injection defenses. Each message says who sent it, who is accountable for it, and whether
 * that person is this run's driver; whether to act on it is the run's own decision (ADR 0026).
 * `hint` is a closing line, such as how the run answers. A single message longer than
 * `max` is cut to fit.
 */
export function formatRunMessages(deliveries: RunDelivery[], hint?: string, max = DELIVERY_TEXT_MAX): string {
  const count = deliveries.length === 1 ? "1 new message" : `${deliveries.length} new messages`;
  const intro =
    `Uplink Room: ${count} for this run. ` +
    "Each is labelled with who sent it and the person accountable for it. A message can ask for anything; whether to act on it is this run's decision.";
  const room = max - intro.length - (hint ? hint.length + 2 : 0) - 4;
  return [intro, ...deliveries.map((delivery) => block(delivery, room)), ...(hint ? [hint] : [])].join("\n\n");
}

/**
 * `bridge:claimRunMessages` (ADR 0026): at a session's hook, the bridge asks for the messages waiting
 * for the run in one of its terminals (`terminalRef`), or, to send them into a T3 Code thread, for
 * the run in that thread (`threadRef`, only to a room that names `thread_run_messages`, ADR 0037).
 * `how` is how the hook delivers them (during a turn, or with the next); `reserve` is how many
 * characters of the delivery the bridge keeps for its own lines; `maxFiles` is how many files it
 * takes in one delivery (at most, and by default, RUN_CLAIM_FILES_MAX). The room stops the claim
 * before the message that would pass it, so no file is left out of a delivery; a message's files
 * are never split, and the first message goes whole whatever the budget.
 */
export type RunMessageClaimRequest = ({ terminalRef: string; threadRef?: never } | { threadRef: string; terminalRef?: never }) & {
  how: "mid_task" | "next_turn";
  reserve: number;
  maxFiles?: number;
};
/** The most files one claim hands over (ADR 0043): four messages' worth. */
export const RUN_CLAIM_FILES_MAX = 40;
/**
 * How long a claim stays the bridge's without an answer (ADR 0026): the room then gives its
 * messages back to wait, as unsure. While it moves a claim's files, the bridge holds it longer with
 * `bridge:holdRunMessages`, every RUN_CLAIM_MS / 3, for RUN_CLAIM_HOLD_MAX_MS after the claim at most.
 */
export const RUN_CLAIM_MS = 2 * 60 * 1000;
export const RUN_CLAIM_HOLD_MAX_MS = 15 * 60 * 1000;
/**
 * The room's answer: the messages it handed over, labelled for the run's driver at this moment and
 * marked claimed under `claimId`, and whether more still wait. The bridge answers `run_message_result`
 * with the claim id once the hook has written them, or when it couldn't.
 */
export type RunMessageClaim = { claimId: string; deliveries: RunDelivery[]; more: boolean };
