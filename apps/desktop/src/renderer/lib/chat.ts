/**
 * Chat logic the composer and the channel share (spec #63). Pure, so it is tested without the app
 * (chat.test.ts).
 *
 * In the composer a mention reads `@Ana Lopez`; in a stored message it is `<@memberId>`, so a
 * renamed member's old mentions still point at them. `encodeMentions` and `decodeMentions` turn
 * one into the other.
 */

/**
 * Who can be mentioned: a person or agent, or a live run (ADR 0026), which is written `<@run:runId>`
 * and named such as Claude Code (Julio). For a run, `memberId` is its run id and `detail` its task.
 */
export type MentionMember = {
  memberId: string;
  name: string;
  kind: "person" | "agent" | "run";
  /** A run's line in the @ list: its task, or that it takes messages only from its person. */
  detail?: string | undefined;
  /** A run's task, shown beside its messages. */
  task?: string | undefined;
};

export type MentionOption =
  | { kind: "member"; memberId: string; name: string; agent: boolean; detail?: string | undefined }
  | { kind: "run"; runId: string; name: string; detail?: string | undefined }
  | { kind: "everyone" };

/** A token in a stored body: `<@memberId>`, or `<@run:runId>` for a run. */
const TOKEN = /<@(run:)?([0-9a-z]{8,64})>/g;

/** The `@` word the caret is in, if any: where it starts and what has been typed after the `@`. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const lead = at === 0 ? "" : before[at - 1]!;
  if (lead && !/[\s([{"']/.test(lead)) return null;
  const query = before.slice(at + 1);
  if (query.length > 32 || /[\n@]/.test(query) || /\s\s/.test(query)) return null;
  return { start: at, query };
}

/** Who matches what was typed after `@`: names starting with it first, then names with a word starting with it. */
export function mentionOptions(
  query: string,
  members: MentionMember[],
  opts: { everyone: boolean; me?: string; limit?: number; runLimit?: number },
): MentionOption[] {
  const q = query.trim().toLowerCase();
  // A whole name followed by a space is a mention already written.
  if (/\s$/.test(query) && members.some((m) => m.name.toLowerCase() === q)) return [];
  const scored: { option: MentionOption; group: number; rank: number; name: string }[] = [];
  for (const m of members) {
    if (m.memberId === opts.me) continue;
    const name = m.name.toLowerCase();
    // A run's name is its harness and driver: "(Julio)" matches "ju" as a word too.
    const rank = name.startsWith(q) ? 0 : name.split(/[\s()]+/).some((w) => w.startsWith(q)) ? 1 : -1;
    if (rank < 0) continue;
    const option: MentionOption =
      m.kind === "run"
        ? { kind: "run", runId: m.memberId, name: m.name, detail: m.detail }
        : { kind: "member", memberId: m.memberId, name: m.name, agent: m.kind === "agent", ...(m.detail ? { detail: m.detail } : {}) };
    // Members first, then live runs: the list shows them as two groups.
    scored.push({ option, group: m.kind === "run" ? 1 : 0, rank, name });
  }
  scored.sort((a, b) => a.group - b.group || a.rank - b.rank || a.name.localeCompare(b.name));
  const out = scored.filter((s) => s.group === 0).map((s) => s.option);
  if (opts.everyone && "everyone".startsWith(q)) out.push({ kind: "everyone" });
  // Runs have rows of their own, so a team with many matching names still shows its live runs.
  const runs = scored.filter((s) => s.group === 1).map((s) => s.option);
  return [...out.slice(0, opts.limit ?? 8), ...runs.slice(0, opts.runLimit ?? 5)];
}

/** Puts a picked mention in place of the `@query` being typed. Returns the new text and caret. */
export function insertMention(text: string, start: number, caret: number, option: MentionOption) {
  const label = option.kind === "everyone" ? "@everyone" : `@${option.name}`;
  const next = `${text.slice(0, start)}${label} ${text.slice(caret).replace(/^ /, "")}`;
  return { text: next, caret: start + label.length + 1 };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A mention picked from the list, where it sits in the text. It keeps the member it was picked for,
 * so two members with the same name stay apart, through typing (`shiftPicks`) and editing
 * (`decodeWithPicks`).
 */
export type MentionPick = { start: number; memberId: string; name: string; run?: true };

const labelOf = (pick: Pick<MentionPick, "name">) => `@${pick.name}`;

/**
 * Where the text box's selection was before a change (`start`, `end`) and where the caret is after
 * it: enough to know which stretch of the text the change replaced.
 */
export type TextChange = { start: number; end: number; caret: number };

/**
 * The stretch of `before` (from `from` to `to`) that a change replaced, from where the selection
 * was: typing or pasting replaces the selection, Backspace removes what is before the caret,
 * Delete what is after it. Null when that doesn't give `after` (an undo, a replacement elsewhere).
 */
function replaced(before: string, after: string, change: TextChange): { from: number; to: number } | null {
  const delta = after.length - before.length;
  let from = change.start;
  let to = change.end;
  if (from === to && delta < 0) {
    if (change.caret < from) from = change.caret;
    else to = from - delta;
  }
  const inserted = to - from + delta;
  if (from < 0 || to > before.length || inserted < 0) return null;
  return before.slice(0, from) === after.slice(0, from) && before.slice(to) === after.slice(from + inserted)
    ? { from, to }
    : null;
}

/**
 * Moves picks to where they are after the text changed from `before` to `after`. Text changed
 * inside a pick's `@Name` drops the pick; text before it moves it. Which text changed comes from
 * `change` when the text box reports it, since the text alone can't say which of two `@Ana `
 * was deleted (#70); without it, from the longest unchanged start and end.
 */
export function shiftPicks(picks: MentionPick[], before: string, after: string, change?: TextChange): MentionPick[] {
  let edit = change ? replaced(before, after, change) : null;
  if (!edit) {
    let head = 0;
    const max = Math.min(before.length, after.length);
    while (head < max && before[head] === after[head]) head++;
    let tail = 0;
    while (tail < max - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
    edit = { from: head, to: before.length - tail };
  }
  const delta = after.length - before.length;
  const out: MentionPick[] = [];
  for (const pick of picks) {
    const end = pick.start + labelOf(pick).length;
    let start: number;
    if (end <= edit.from) start = pick.start;
    else if (pick.start >= edit.to) start = pick.start + delta;
    else continue;
    if (after.slice(start, start + labelOf(pick).length) === labelOf(pick)) out.push({ ...pick, start });
  }
  return out;
}

/** Adds a pick for a mention just written at `start` (after shifting the others for the insert). */
export function addPick(picks: MentionPick[], before: string, after: string, start: number, option: MentionOption) {
  const moved = shiftPicks(picks, before, after);
  if (option.kind === "everyone") return moved;
  const pick: MentionPick =
    option.kind === "run" ? { start, memberId: option.runId, name: option.name, run: true } : { start, memberId: option.memberId, name: option.name };
  return [...moved, pick].sort((a, b) => a.start - b.start);
}

const tokenOf = (m: { memberId: string; run?: boolean }) => (m.run ? `<@run:${m.memberId}>` : `<@${m.memberId}>`);

/**
 * The body to post: each picked mention becomes `<@memberId>` for the member it was picked for, or
 * `<@run:runId>` for a run. An `@Name` typed without the list becomes a mention when exactly one
 * member or run has that name (longest names first, so "@Ana Lopez" isn't read as "@Ana"); a name
 * two share stays text. Also says which runs it addresses and whether it writes `@everyone`.
 *
 * A run picked before it ended keeps its identity: its `@Name` stays text, never another run now
 * named the same. `kept` lists the runs the message being edited already addresses; one of those
 * keeps its token, which the room keeps addressed while the token stays (messages.edit).
 */
export function encodeMentions(text: string, members: MentionMember[], picks: MentionPick[] = [], opts: { kept?: readonly string[] } = {}) {
  const known = new Map(members.map((m) => [m.memberId, m]));
  let body = text;
  // A gone pick's name, held out of the name matching below and put back after it.
  const held: string[] = [];
  // Picked ones first, from the end, so earlier positions stay right.
  for (const pick of [...picks].sort((a, b) => b.start - a.start)) {
    if (body.slice(pick.start, pick.start + labelOf(pick).length) !== labelOf(pick)) continue;
    const member = known.get(pick.memberId);
    let out: string;
    if (member && (member.kind === "run") === (pick.run === true)) out = tokenOf(pick);
    else if (!member && pick.run && opts.kept?.includes(pick.memberId)) out = tokenOf(pick);
    else {
      held.push(labelOf(pick));
      out = `\uE000${held.length - 1}\uE001`;
    }
    body = `${body.slice(0, pick.start)}${out}${body.slice(pick.start + labelOf(pick).length)}`;
  }
  const byName = new Map<string, MentionMember[]>();
  for (const m of members) byName.set(m.name.toLowerCase(), [...(byName.get(m.name.toLowerCase()) ?? []), m]);
  const unique = members.filter((m) => m.name.trim() && byName.get(m.name.toLowerCase())!.length === 1);
  for (const m of unique.sort((a, b) => b.name.length - a.name.length)) {
    const pattern = new RegExp(`(^|[^\\w@<])@${escapeRegExp(m.name)}(?![\\w])`, "gi");
    body = body.replace(pattern, (_, lead: string) => `${lead}${tokenOf({ memberId: m.memberId, run: m.kind === "run" })}`);
  }
  body = body.replace(/\uE000(\d+)\uE001/g, (_, i: string) => held[Number(i)]!);
  // In the order the body names them.
  const memberIds: string[] = [];
  const runIds: string[] = [];
  for (const match of body.matchAll(TOKEN)) {
    const id = match[2]!;
    const member = known.get(id);
    if (!member || (member.kind === "run") !== (match[1] !== undefined)) continue;
    const into = member.kind === "run" ? runIds : memberIds;
    if (!into.includes(id)) into.push(id);
  }
  const mentionEveryone = /(^|[^\w@])@everyone\b/i.test(body);
  return { body, memberIds, runIds, mentionEveryone };
}

/** A stored body as the composer shows it: `<@memberId>` and `<@run:runId>` back to `@Name`. */
export function decodeMentions(body: string, nameOf: (id: string) => string | undefined): string {
  return decodeWithPicks(body, nameOf).text;
}

/**
 * A stored body for editing: `@Name` in the text, with a pick for each, so saving keeps the same
 * members and runs. `nameOf` names member ids and run ids alike (they never collide). A token it
 * can't name (a run that ended) stays as written.
 */
export function decodeWithPicks(body: string, nameOf: (id: string) => string | undefined) {
  const picks: MentionPick[] = [];
  let text = "";
  let last = 0;
  for (const match of body.matchAll(TOKEN)) {
    const name = nameOf(match[2]!);
    if (!name) continue;
    text += body.slice(last, match.index);
    picks.push({ start: text.length, memberId: match[2]!, name, ...(match[1] ? { run: true as const } : {}) });
    text += `@${name}`;
    last = match.index! + match[0].length;
  }
  text += body.slice(last);
  return { text, picks };
}

/**
 * A refused send put back in the composer (which clears at once on send): its text ahead of what
 * was typed since it went out, with both parts' picked mentions where they now sit.
 */
export function putBack(sent: { body: string; picks: MentionPick[] }, now: { body: string; picks: MentionPick[] }) {
  if (!now.body) return { body: sent.body, picks: sent.picks };
  const shift = sent.body.length + 1;
  return { body: `${sent.body}\n${now.body}`, picks: [...sent.picks, ...now.picks.map((p) => ({ ...p, start: p.start + shift }))] };
}

type Authored = { author: { memberId: string }; asRun?: { runId: string } | undefined };

/**
 * Whether you wrote the message yourself. A run's message is stored under its driver (ADR 0029 D2),
 * but the driver didn't write it: posting it doesn't read the channel for them, so it is new to
 * them like anyone else's. Who may delete it still goes by its author.
 */
export function wroteIt(message: Authored, me: string): boolean {
  return message.author.memberId === me && !message.asRun;
}

/**
 * Where the "new" divider goes: before the first message after the point you had read when you
 * opened the channel, unless you wrote it (posting reads the channel; a run you drive posting doesn't). `messages` are oldest first.
 * When no loaded message with a seq is at or before that point and older pages remain (`exhausted`
 * false), the boundary isn't in view yet: `above` says unread messages go on above, and there is no
 * divider.
 */
export function unreadMark(
  messages: ({ messageId: string; seq?: number | undefined; system?: unknown } & Authored)[],
  readSeq: number | undefined,
  me: string,
  exhausted: boolean,
): { before: string } | { above: true } | null {
  if (readSeq === undefined) return null;
  // The read point is loaded when a message with a seq at or before it is (a pin line has none and
  // proves nothing), or when nothing older is left.
  const reached = exhausted || messages.some((m) => m.seq !== undefined && !m.system && m.seq <= readSeq);
  for (const m of messages) {
    if (m.seq === undefined || m.seq <= readSeq || m.system) continue;
    if (!reached) return { above: true };
    return wroteIt(m, me) ? null : { before: m.messageId };
  }
  return null;
}

/** The divider's place alone (kept for callers that know the boundary is loaded). */
export function dividerBefore(
  messages: ({ messageId: string; seq?: number | undefined; system?: unknown } & Authored)[],
  readSeq: number | undefined,
  me: string,
): string | null {
  const mark = unreadMark(messages, readSeq, me, true);
  return mark && "before" in mark ? mark.before : null;
}

/**
 * Whether the channel is still on its way to a message it was opened at (a search result or a
 * banner): the message is loading, or the older stretch around it is, or the view hasn't scrolled
 * to it yet. Until then the list on screen is the newest page, which the reader isn't looking at,
 * so read tracking waits. A target among the newest messages is cleared once it's in view; one
 * further back keeps the list around it (`mode` "around") and counts as reached once positioned.
 */
export function openingAtMessage(
  target: string | null,
  mode: "live" | "around",
  anchor: string | null,
  positionedAt: string | null,
): boolean {
  if (target === null) return false;
  return !(mode === "around" && anchor !== null && positionedAt === anchor);
}

/** One scrolling list of a channel's messages (its own column, or the Replies panel) and its visible box. */
export type ReadPane = {
  rows: { messageId: string; seq: number; top: number; bottom: number }[];
  viewport: { top: number; bottom: number };
};

const shownIn = (r: { top: number; bottom: number }, viewport: { top: number; bottom: number }) =>
  r.top < viewport.bottom - 4 && r.bottom > viewport.top + 4;

/** What one channel's read tracking remembers this session (readThrough fills it in). */
export type ReadMemory = {
  /**
   * Every message and reply that has been on screen, by seq. Null: it was, and has been deleted
   * since (the room said so when asked to read through it), so there's nothing left to see there
   * and it can't be read through.
   */
  seen: Map<number, string | null>;
  /** Per thread: every one of its replies up to this seq has been on screen. */
  threadThrough: Map<string, number>;
  /** How far the room has taken the read point this session, and a mark on its way there. */
  marked: number;
  pending: number | null;
};

export function newReadMemory(): ReadMemory {
  return { seen: new Map(), threadThrough: new Map(), marked: 0, pending: null };
}

/**
 * Asks the room to read the channel through `upTo` (`send`), and records it in `memory` only once
 * the room took it, so a refused mark is tried again rather than skipped. When the message is gone
 * (`gone(error)`: deleted since it was on screen), its seq is kept as seen but never read through
 * again: the next try reads through the newest message before it that's still there. Marks at or
 * before one already taken, or on its way, aren't sent again.
 */
export async function sendReadMark(
  memory: ReadMemory,
  upTo: { messageId: string; seq: number },
  send: (messageId: string) => Promise<unknown>,
  gone: (error: unknown) => boolean,
): Promise<"sent" | "skipped" | "gone" | "failed"> {
  if (upTo.seq <= memory.marked || (memory.pending !== null && upTo.seq <= memory.pending)) return "skipped";
  memory.pending = upTo.seq;
  try {
    await send(upTo.messageId);
    memory.marked = Math.max(memory.marked, upTo.seq);
    return "sent";
  } catch (error) {
    if (!gone(error)) return "failed";
    memory.seen.set(upTo.seq, null);
    return "gone";
  } finally {
    if (memory.pending === upTo.seq) memory.pending = null;
  }
}

/** A thread with replies past the read point (messages.unreadThreads). */
export type UnreadThread = { parentId: string; lastReplySeq?: number | undefined; firstNewSeq?: number | undefined };

/**
 * How far to mark a channel read. The read point moves past seq N only once every message and
 * reply up to N has been on screen: in the channel's own list or in the Replies panel, now or
 * earlier this session. `memory` records what's on screen now, and how far the open thread has
 * been seen without a gap. The read point stops before the first place something may not have
 * been seen:
 * - a message in the channel's list, or a reply in the open panel, that hasn't been on screen;
 * - messages the list hasn't loaded: before its oldest when it doesn't reach the read point
 *   (`reachesRead` false), after its newest when it doesn't reach the newest (`complete` false);
 * - another thread's unread replies: from its first new reply (`firstNewSeq`), or from the read
 *   point when that isn't known, or after how far the thread has been seen this session; a thread
 *   seen through its newest reply stops nothing;
 * - threads not listed yet (`threads` null while loading, `threadsComplete` false while more pages
 *   remain), which could have a reply right after the read point.
 * Where only a lower bound is known (the last three), the place is the first seq from it that
 * hasn't been on screen. Then the read point moves to the newest message seen before that place,
 * so once an earlier gap is filled it goes on through everything seen after it. `seen` lists the replies on screen past the new
 * read point, to mark seen on their own (channels.markSeen), so their mentions stop counting.
 */
export function readThrough(
  memory: ReadMemory,
  view: {
    readSeq: number;
    main: ReadPane & { complete: boolean; reachesRead: boolean };
    /**
     * The Replies panel, when open. `loaded`: its replies have come (messages.replies); until
     * then it shows only the parent, which says nothing about the thread's replies.
     */
    replies: (ReadPane & { parentId: string; loaded: boolean }) | null;
    threads: UnreadThread[] | null;
    threadsComplete: boolean;
  },
): { upTo: { messageId: string; seq: number } | null; seen: string[] } {
  const { readSeq, main, replies } = view;
  for (const r of main.rows) if (shownIn(r, main.viewport)) memory.seen.set(r.seq, r.messageId);
  if (replies) {
    for (const r of replies.rows) if (shownIn(r, replies.viewport)) memory.seen.set(r.seq, r.messageId);
  }
  if (replies?.loaded) {
    // The panel holds the whole thread: it has been seen up to its first reply past the read point
    // that hasn't been on screen, or through its newest.
    const ordered = replies.rows.filter((r) => r.seq > readSeq && r.messageId !== replies.parentId).sort((a, b) => a.seq - b.seq);
    const gap = ordered.find((r) => !memory.seen.has(r.seq));
    const through = gap ? gap.seq - 1 : Math.max(readSeq, ...ordered.map((r) => r.seq));
    if (through > (memory.threadThrough.get(replies.parentId) ?? 0)) memory.threadThrough.set(replies.parentId, through);
  }
  const unseen = (seq: number) => seq > readSeq && !memory.seen.has(seq);
  // Where something not on screen may be when only "from here on" is known: the first seq from
  // there that hasn't been seen (a seq that has been on screen can't be the unseen one).
  const firstUnseenFrom = (from: number) => {
    let seq = Math.max(from, readSeq + 1);
    while (memory.seen.has(seq)) seq++;
    return seq;
  };
  let stop = Number.POSITIVE_INFINITY;
  if (!main.reachesRead) stop = firstUnseenFrom(readSeq + 1);
  if (!main.complete) stop = Math.min(stop, firstUnseenFrom(Math.max(readSeq, ...main.rows.map((r) => r.seq)) + 1));
  for (const r of main.rows) if (unseen(r.seq)) stop = Math.min(stop, r.seq);
  if (replies) for (const r of replies.rows) if (unseen(r.seq)) stop = Math.min(stop, r.seq);
  if (view.threads === null || !view.threadsComplete) stop = Math.min(stop, firstUnseenFrom(readSeq + 1));
  for (const t of view.threads ?? []) {
    // An open thread whose replies have loaded: its rows above say exactly. Until then its
    // unread replies stop the read point as any other thread's do.
    if (replies?.loaded && t.parentId === replies.parentId) continue;
    if (t.lastReplySeq !== undefined && t.lastReplySeq <= readSeq) continue;
    const through = memory.threadThrough.get(t.parentId) ?? readSeq;
    if (t.lastReplySeq !== undefined && through >= t.lastReplySeq) continue;
    stop = Math.min(stop, firstUnseenFrom(Math.max(t.firstNewSeq ?? readSeq + 1, through + 1)));
  }
  let upTo: { messageId: string; seq: number } | null = null;
  // The newest message still there at or before the last seq covered.
  for (const [seq, messageId] of memory.seen) {
    if (messageId !== null && seq > readSeq && seq < stop && (!upTo || seq > upTo.seq)) upTo = { messageId, seq };
  }
  const through = upTo?.seq ?? readSeq;
  const seen = replies ? replies.rows.filter((r) => r.seq > through && shownIn(r, replies.viewport)).map((r) => r.messageId) : [];
  return { upTo, seen };
}

/**
 * The unread-thread pages loaded so far (messages.unreadThreads, each page asked for with the
 * one before's continueCursor), as one list. A page is used only while it still follows the one
 * before it: when new replies reorder the threads, the pages after a change are dropped and asked
 * for again from `next`. `complete` says every thread is listed; `next` is the cursor of the page
 * to load next (null when complete or while a page is loading); `cursors` are the ones still good.
 */
export function mergeThreadPages<T extends { message: { messageId: string } }>(
  cursors: string[],
  pages: ({ page: T[]; continueCursor: string; isDone: boolean } | undefined)[],
): { threads: T[]; complete: boolean; next: string | null; cursors: string[] } {
  const threads: T[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (!page) return { threads, complete: false, next: null, cursors: cursors.slice(0, i) };
    for (const t of page.page) {
      if (ids.has(t.message.messageId)) continue;
      ids.add(t.message.messageId);
      threads.push(t);
    }
    if (page.isDone) return { threads, complete: true, next: null, cursors: cursors.slice(0, i) };
    if (cursors[i] !== page.continueCursor) return { threads, complete: false, next: page.continueCursor, cursors: cursors.slice(0, i) };
  }
  return { threads, complete: false, next: null, cursors };
}

/** "Julio", "Julio and Ana", "Julio, Ana and 3 others": who reacted, for a chip's tooltip. */
export function reactedBy(names: string[], count: number, emoji: string): string {
  const others = count - names.length;
  const list =
    others > 0
      ? `${names.join(", ")} and ${others} other${others === 1 ? "" : "s"}`
      : names.length > 1
        ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
        : (names[0] ?? "");
  return `${list} reacted with ${emoji}`;
}

const MB = 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/** What the room will say about a file before it is uploaded, so the composer can say it at once. */
export function attachmentProblem(file: { name: string; size: number; type: string }): string | null {
  const name = file.name.toLowerCase();
  if (/\.svgz?$/.test(name) || file.type === "image/svg+xml") {
    return `${file.name}: SVG files can't be attached. Attach a PNG instead.`;
  }
  const limit = IMAGE_EXT.test(name) ? 20 * MB : 50 * MB;
  if (file.size > limit) {
    return `${file.name} is ${Math.round(file.size / MB)} MB. ${IMAGE_EXT.test(name) ? "Images" : name.endsWith(".pdf") ? "PDFs" : "Files"} can be at most ${limit / MB} MB; share a link to it instead.`;
  }
  return null;
}

/** The content type to upload a file with: the browser's, or one from its extension for images and PDFs. */
export function uploadType(file: { name: string; type: string }): string {
  const ext = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const known: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
  };
  return known[ext] ?? (file.type || "application/octet-stream");
}

export function fileSize(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(bytes >= 10 * MB ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Messages from one person this close together read as one run: one face, name and time. */
export const RUN_GAP_MS = 5 * 60_000;

type RunPart = { authorId: string; at: number; plain: boolean };

/**
 * Whether `next` joins the run `prev` started (spec #63, Discord's grouping): the same author, the
 * same day, within RUN_GAP_MS, and both plain messages (not a pin line, a deleted placeholder or a
 * pinned message, which keep their own header). Anything between them, such as a call event or
 * the "new" divider, starts a new run; the caller passes undefined for `prev` then.
 */
export function continuesRun(prev: RunPart | undefined, next: RunPart): boolean {
  if (!prev || !prev.plain || !next.plain || prev.authorId !== next.authorId) return false;
  if (next.at - prev.at > RUN_GAP_MS || next.at < prev.at) return false;
  return sameDay(prev.at, next.at);
}

/**
 * A message's place in the grouping: by its author, and a run's messages by the run and the driver
 * who posted each (ADR 0029 D2), so when the wheel passes the new driver's name and "answers for it"
 * tag show again, and a run's messages stay apart from its driver's own.
 */
export function groupPart(message: {
  author: { memberId: string };
  asRun?: { runId: string } | undefined;
  postedAt: number;
  system?: unknown;
  deletedAt?: number | undefined;
  pinned?: unknown;
}): RunPart {
  return {
    authorId: message.asRun ? `run:${message.asRun.runId}:${message.author.memberId}` : message.author.memberId,
    at: message.postedAt,
    plain: !message.system && message.deletedAt === undefined && !message.pinned,
  };
}

export const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** A day separator's words: "Today", "Yesterday", "Monday, November 2", with the year when it isn't this year's. */
export function dayLabel(at: number, now: number = Date.now()): string {
  if (sameDay(at, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(at, yesterday.getTime())) return "Yesterday";
  const date = new Date(at);
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  });
}

/**
 * Whether Enter at `caret` is inside an open ``` code block, where it makes a new line instead of
 * sending, as in Discord: an odd number of fences before the caret.
 */
export function insideCodeFence(text: string, caret: number): boolean {
  return ((text.slice(0, caret).match(/```/g) ?? []).length & 1) === 1;
}

/** A message that is only emoji (at most a few), shown larger, as Discord does. */
export function emojiOnly(body: string): boolean {
  const text = body.trim();
  if (!text || text.length > 40) return false;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text.replace(/\s+/g, ""))];
  return (
    graphemes.length > 0 &&
    graphemes.length <= 6 &&
    graphemes.every((g) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g.segment) && !/[\p{L}\p{N}]/u.test(g.segment.replace(/[⃣️]/g, "")))
  );
}

/**
 * A search result's text in pieces, with the words searched for marked as hits. The search matches
 * whole words, and the last one as the start of a word too, so a hit is where a word starts with
 * one of the query's words.
 */
export function matchSegments(text: string, query: string): { text: string; hit: boolean }[] {
  const words = query.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (words.length === 0) return [{ text, hit: false }];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join("|")})`, "giu");
  const out: { text: string; hit: boolean }[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) out.push({ text: text.slice(last, match.index), hit: false });
    out.push({ text: match[0], hit: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}

/** A message body as plain words for a search result: no markdown marks, on one line. Mentions stay as tokens. */
export function plainText(body: string): string {
  return body
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\p{L}\p{N}*_])[*_]([^*_\n]+)[*_](?![\p{L}\p{N}])/gu, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export type ExcerptPart = { text: string; hit?: true; mention?: "me" | "other" };

/**
 * A search result's text (spec #63): plain words, cut to show the first match with some of what
 * comes before it ("…" where it was cut), the matches marked, and mentions as names marked the way
 * the message list marks them. A mention is never cut in half.
 */
export function searchExcerpt(
  body: string,
  query: string,
  nameOf: (memberId: string) => string | undefined,
  me: string,
  { before = 60, length = 200 }: { before?: number; length?: number } = {},
): ExcerptPart[] {
  const plain = plainText(body);
  let text = "";
  const mentions: { start: number; end: number; me: boolean }[] = [];
  let last = 0;
  for (const match of plain.matchAll(/<@([0-9a-z]{8,64})>/g)) {
    text += plain.slice(last, match.index);
    const name = nameOf(match[1]!);
    if (name) {
      const start = text.length;
      text += `@${name}`;
      mentions.push({ start, end: text.length, me: match[1] === me });
    } else text += match[0];
    last = match.index + match[0].length;
  }
  text += plain.slice(last);
  const words = query.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  const hits: { start: number; end: number }[] = [];
  if (words.length) {
    for (const match of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join("|")})`, "giu"))) {
      hits.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  const first = hits[0];
  let from = 0;
  if (first && first.start > before) {
    from = first.start - before;
    const space = text.indexOf(" ", from);
    if (space !== -1 && space < first.start) from = space + 1;
  }
  let to = Math.min(text.length, from + length);
  if (to < text.length) {
    const space = text.lastIndexOf(" ", to);
    if (space > Math.max(from, first?.end ?? 0)) to = space;
  }
  for (const m of mentions) {
    if (m.start < from && m.end > from) from = m.start;
    if (m.start < to && m.end > to) to = m.end;
  }
  const cuts = new Set([from, to]);
  for (const r of [...hits, ...mentions]) {
    if (r.start > from && r.start < to) cuts.add(r.start);
    if (r.end > from && r.end < to) cuts.add(r.end);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const parts: ExcerptPart[] = from > 0 ? [{ text: "…" }] : [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const hit = hits.some((h) => h.start <= a && h.end >= b);
    const mention = mentions.find((m) => m.start <= a && m.end >= b);
    const part: ExcerptPart = {
      text: text.slice(a, b),
      ...(hit ? { hit: true as const } : {}),
      ...(mention ? { mention: mention.me ? ("me" as const) : ("other" as const) } : {}),
    };
    const prev = parts.at(-1);
    if (prev && !prev.hit && !prev.mention && !part.hit && !part.mention && prev.text !== "…") prev.text += part.text;
    else parts.push(part);
  }
  if (to < text.length) parts.push({ text: "…" });
  return parts;
}

/** A long file name cut in the middle, keeping its start and its extension: "a-really-lon…final.txt". */
export function shortName(name: string, max = 36): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : "";
  const keep = max - 1 - ext.length;
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  const stem = name.slice(0, name.length - ext.length);
  return `${stem.slice(0, head)}…${tail > 0 ? stem.slice(-tail) : ""}${ext}`;
}

/**
 * Where a thread opens without a target (spec #63): at the first reply past your read point that
 * you didn't write (`wroteIt`), so you read on from there; null when there's none (it opens at the newest).
 */
export function firstUnreadReply(
  replies: ({ messageId: string; seq?: number | undefined } & Authored)[],
  readSeq: number,
  me: string,
): string | null {
  return replies.find((r) => r.seq !== undefined && r.seq > readSeq && !wroteIt(r, me))?.messageId ?? null;
}

/**
 * The message ↑ in the empty composer edits: your newest one in the channel's live list, not one a
 * run you drive posted. None
 * while the channel shows an older stretch (opened at a search result), whose newest isn't yours
 * to edit by accident.
 */
export function lastEditable<M extends { messageId: string; system?: unknown; deletedAt?: number | undefined } & Authored>(
  messages: M[],
  me: string,
  mode: "live" | "around",
): M | null {
  if (mode !== "live") return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (wroteIt(m, me) && !m.system && m.deletedAt === undefined) return m;
  }
  return null;
}

/** A live run as runs.live lists it: what the composer and the new direct message picker need. */
export type LiveRun = {
  runId: string;
  label: string;
  driver: { memberId: string; name: string };
  accountable?: { memberId: string; name: string } | undefined;
  title?: string | undefined;
  task?: { taskId: string; title: string } | undefined;
  private: boolean;
  hearsYou: boolean;
  /** A team run: the whole team can see its terminal or thread, which show what it hears (ADR 0039). */
  visibleToTeam?: boolean | undefined;
};

/**
 * What the app says before a direct message with a team run opens (ADR 0039, amended
 * 2026-11-05): the run hears it, and the whole team can see what it hears. Once it is open, the
 * room's own warning for it (channels.list) takes over.
 */
export function teamRunWarning(label: string): string {
  return `${label}'s output is visible to the whole team, so what you send it won't stay private.`;
}

/** What a live run is doing, in a few words: its task's title, or the run's own. */
export function runDetail(run: Pick<LiveRun, "title" | "task" | "hearsYou" | "accountable" | "driver">): string | undefined {
  // One that takes messages only from its person says so instead: a message from you won't reach it.
  if (!run.hearsYou) return `Takes messages only from ${(run.accountable ?? run.driver).name}`;
  return run.task?.title ?? run.title;
}

/**
 * The live runs that can be mentioned in a place (ADR 0026): never a run from a conversation you
 * aren't in (the room lists it as private), and in a direct message or private channel (`place`
 * with its members) only a run whose driver is in it, or that the direct message was opened with
 * while its person (who answers for it) still is, as the room checks (`addressRefusal`): once the
 * wheel passes to someone outside, the room refuses the whole post. Elsewhere (`place` null),
 * every other live run.
 */
/** What an agent that only reads and posts through the connector shows by its name (slice 14 of #139). */
export const CHECKS_IN = "Checks in on its own schedule";

/**
 * The people and agents who can be mentioned in a place, from its member list (or the team's),
 * each agent that checks in on its own schedule with that line beside it. `team` says how the room
 * reaches each agent (teams.members `reach`).
 */
export function memberMentionables(
  listed: readonly { memberId: string; name: string; kind: "person" | "agent" }[],
  team: readonly { memberId: string; reach?: string | undefined }[],
): MentionMember[] {
  const checksIn = new Set(team.filter((m) => m.reach === "checks_in").map((m) => m.memberId));
  return listed.map((m) => ({
    memberId: m.memberId,
    name: m.name,
    kind: m.kind,
    ...(checksIn.has(m.memberId) ? { detail: CHECKS_IN } : {}),
  }));
}

export function runMentionables(
  live: readonly LiveRun[],
  place: { members: readonly { memberId: string }[]; runs?: readonly { runId: string }[] | undefined } | null,
): MentionMember[] {
  const inPlace = place ? new Set(place.members.map((m) => m.memberId)) : null;
  const openedWith = new Set(place?.runs?.map((r) => r.runId) ?? []);
  const reachable = (run: LiveRun) =>
    !inPlace || inPlace.has(run.driver.memberId) || (openedWith.has(run.runId) && !!run.accountable && inPlace.has(run.accountable.memberId));
  return live
    .filter((run) => !run.private && reachable(run))
    .map((run) => ({ memberId: run.runId, name: run.label, kind: "run" as const, detail: runDetail(run), task: run.task?.title ?? run.title }));
}

/**
 * How many members and runs a direct message would have, counted as channels.openDirect counts
 * them: you, the members picked, and for each run its person (who answers for it) and an agent
 * driving it, each once, plus the runs themselves. The room allows at most 10.
 */
export function directMessageSize(
  me: string,
  memberIds: readonly string[],
  runs: readonly (Pick<LiveRun, "runId" | "driver"> & { accountable?: { memberId: string } | undefined })[],
): number {
  const ids = new Set([me, ...memberIds]);
  for (const run of runs) {
    ids.add(run.driver.memberId);
    if (run.accountable) ids.add(run.accountable.memberId);
  }
  return ids.size + new Set(runs.map((r) => r.runId)).size;
}

/**
 * The choices a question names, when it names them plainly: "Which release note: the CSV export one,
 * or the DST fix?" gives "the CSV export one" and "the DST fix". Two or three short choices after the
 * last colon, split on "or"; anything else gives none, and the card keeps only its answer box.
 */
export function questionChoices(text: string): string[] {
  const line = text.trim();
  if (!line.endsWith("?") || line.includes("\n")) return [];
  const asked = line.slice(line.lastIndexOf(":") + 1, -1).trim();
  const parts = asked.split(/,?\s+or\s+|,\s+/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return [];
  return parts.every((p) => p.length >= 2 && p.length <= 48) ? parts : [];
}

/**
 * The newest message of each agent run in a list: only that one shows the run's live state (working,
 * the question waiting on you), so an earlier question in the same run doesn't take an answer meant for
 * the latest one.
 */
export function latestOfRuns<M extends { messageId: string; a2a?: { runId: string } | undefined }>(messages: readonly M[]): Set<M["messageId"]> {
  const last = new Map<string, M["messageId"]>();
  for (const m of messages) if (m.a2a) last.set(m.a2a.runId, m.messageId);
  return new Set(last.values());
}
