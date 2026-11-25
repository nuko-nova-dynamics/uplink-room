import { expect, test, vi } from "vitest";
import {
  addPick,
  attachmentProblem,
  continuesRun,
  dayLabel,
  emojiOnly,
  insideCodeFence,
  matchSegments,
  plainText,
  searchExcerpt,
  shortName,
  firstUnreadReply,
  lastEditable,
  mergeThreadPages,
  newReadMemory,
  sendReadMark,
  decodeMentions,
  decodeWithPicks,
  dividerBefore,
  encodeMentions,
  openingAtMessage,
  putBack,
  readThrough,
  shiftPicks,
  unreadMark,
  insertMention,
  mentionAt,
  mentionOptions,
  memberMentionables,
  CHECKS_IN,
  reactedBy,
  runMentionables,
  groupPart,
  directMessageSize,
  wroteIt,
} from "./chat";

const members = [
  { memberId: "mjulio00001", name: "Julio", kind: "person" as const },
  { memberId: "mana0000001", name: "Ana", kind: "person" as const },
  { memberId: "manalopez01", name: "Ana Lopez", kind: "person" as const },
  { memberId: "mhermes0001", name: "Hermes", kind: "agent" as const },
];

test("the @ word at the caret, and who matches it", () => {
  expect(mentionAt("hi @an", 6)).toEqual({ start: 3, query: "an" });
  expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
  expect(mentionAt("mail me at a@b.c", 16)).toBeNull();
  expect(mentionAt("hi @an\nthere", 12)).toBeNull();
  const names = (q: string, everyone = true) =>
    mentionOptions(q, members, { everyone, me: "mjulio00001" }).map((o) => (o.kind === "everyone" ? "@everyone" : o.name));
  expect(names("an")).toEqual(["Ana", "Ana Lopez"]);
  expect(names("lo")).toEqual(["Ana Lopez"]);
  expect(names("e")).toEqual(["@everyone"]);
  expect(names("e", false)).toEqual([]);
  expect(names("")).toEqual(["Ana", "Ana Lopez", "Hermes", "@everyone"]);
  expect(insertMention("hi @an!", 3, 6, { kind: "member", memberId: "mana0000001", name: "Ana", agent: false })).toEqual({
    text: "hi @Ana !",
    caret: 8,
  });
});

test("@Name becomes a mention token, longest name first, and comes back for editing", () => {
  const sent = encodeMentions("@Ana Lopez and @ana, ping @Hermes. Not julio@example.com or @Juliana. @everyone", members);
  expect(sent.body).toBe("<@manalopez01> and <@mana0000001>, ping <@mhermes0001>. Not julio@example.com or @Juliana. @everyone");
  expect(sent.memberIds).toEqual(["manalopez01", "mana0000001", "mhermes0001"]);
  expect(sent.mentionEveryone).toBe(true);
  const names = new Map(members.map((m) => [m.memberId, m.name]));
  expect(decodeMentions(sent.body, (id) => names.get(id))).toBe(
    "@Ana Lopez and @Ana, ping @Hermes. Not julio@example.com or @Juliana. @everyone",
  );
  expect(encodeMentions("email@everyone.com", members).mentionEveryone).toBe(false);
});

test("a live run is offered by its name with its task, and picking it writes <@run:id> and addresses it (ADR 0026)", () => {
  const withRuns = [
    ...members,
    { memberId: "mclaude0001", name: "Claude", kind: "person" as const },
    { memberId: "rcc00000001", name: "Claude Code (Julio)", kind: "run" as const, detail: "Export tide tables" },
    { memberId: "rcc00000002", name: "Claude Code 2 (Julio)", kind: "run" as const, detail: "Fix the DST offset" },
  ];
  const options = mentionOptions("cl", withRuns, { everyone: true, me: "mjulio00001" });
  expect(options).toEqual([
    { kind: "member", memberId: "mclaude0001", name: "Claude", agent: false },
    { kind: "run", runId: "rcc00000001", name: "Claude Code (Julio)", detail: "Export tide tables" },
    { kind: "run", runId: "rcc00000002", name: "Claude Code 2 (Julio)", detail: "Fix the DST offset" },
  ]);
  // Picked from the list, then one typed in full without it.
  const typed = "ask @cl";
  const picked = insertMention(typed, 4, typed.length, options[1]!);
  expect(picked.text).toBe("ask @Claude Code (Julio) ");
  const picks = addPick([], typed, picked.text, 4, options[1]!);
  const sent = encodeMentions(`${picked.text}and @Claude Code 2 (Julio), cc @Claude`, withRuns, picks);
  expect(sent.body).toBe("ask <@run:rcc00000001> and <@run:rcc00000002>, cc <@mclaude0001>");
  expect(sent.runIds).toEqual(["rcc00000001", "rcc00000002"]);
  expect(sent.memberIds).toEqual(["mclaude0001"]);
  // Editing it again: each token back as the name, with a pick that keeps the run.
  const names = new Map(withRuns.map((m) => [m.memberId, m.name]));
  const opened = decodeWithPicks(sent.body, (id) => names.get(id));
  expect(opened.text).toBe("ask @Claude Code (Julio) and @Claude Code 2 (Julio), cc @Claude");
  expect(encodeMentions(opened.text, withRuns, opened.picks).body).toBe(sent.body);
  // A run that ended since keeps its token: it is still the run the message was for.
  expect(decodeMentions("hi <@run:rgone000001>", (id) => names.get(id))).toBe("hi <@run:rgone000001>");
});

test("a channel offers the live runs you can message there: not private ones, and in a direct message or private channel only those whose driver is in it", () => {
  const run = (runId: string, label: string, driver: string, more: Record<string, unknown> = {}) => ({
    runId,
    label,
    driver: { memberId: driver, name: driver },
    accountable: { memberId: driver, name: driver === "mana" ? "Ana" : "Julio" },
    title: undefined,
    task: { taskId: "t1", title: `Task of ${label}` },
    private: false,
    hearsYou: true,
    ...more,
  });
  const live = [
    run("rjulio0001", "Claude Code (Julio)", "mjulio"),
    run("rana000001", "Codex (Ana)", "mana", { hearsYou: false }),
    run("rsecret001", "Claude Code (Mia)", "mmia", { private: true, task: undefined }),
  ];
  expect(runMentionables(live, null)).toEqual([
    { memberId: "rjulio0001", name: "Claude Code (Julio)", kind: "run", detail: "Task of Claude Code (Julio)", task: "Task of Claude Code (Julio)" },
    { memberId: "rana000001", name: "Codex (Ana)", kind: "run", detail: "Takes messages only from Ana", task: "Task of Codex (Ana)" },
  ]);
  // A direct message with Julio, and one opened with Ana's run.
  expect(runMentionables(live, { members: [{ memberId: "mjulio" }, { memberId: "mrosa" }] }).map((r) => r.name)).toEqual(["Claude Code (Julio)"]);
  // Opening it with the run added Ana, its person, as a member.
  expect(runMentionables(live, { members: [{ memberId: "mrosa" }, { memberId: "mana" }], runs: [{ runId: "rana000001" }] }).map((r) => r.name)).toEqual([
    "Codex (Ana)",
  ]);
});

test("a picked run that ended stays the run it was picked for: it isn't swapped for another run now named the same", () => {
  // Julio's first Claude Code run ended while the message was being written; his other one is
  // now named "Claude Code (Julio)".
  const now = [...members, { memberId: "rcc00000002", name: "Claude Code (Julio)", kind: "run" as const }];
  const picks = [{ start: 4, memberId: "rcc00000001", name: "Claude Code (Julio)", run: true as const }];
  const sent = encodeMentions("ask @Claude Code (Julio) to stop", now, picks);
  expect(sent.body).toBe("ask @Claude Code (Julio) to stop");
  expect(sent.runIds).toEqual([]);
  // Saved from the editor of a message that already addresses it, the token stays, so the room keeps the run.
  const edited = encodeMentions("ask @Claude Code (Julio) to stop now", now, picks, { kept: ["rcc00000001"] });
  expect(edited.body).toBe("ask <@run:rcc00000001> to stop now");
  expect(edited.runIds).toEqual([]);
});

test("a run's messages group apart from each driver's: when the wheel passes, the new driver's posts start their own group", () => {
  const post = (author: string, at: number) => ({
    author: { memberId: author },
    asRun: { runId: "rcc00000001" },
    postedAt: at,
  });
  expect(continuesRun(groupPart(post("mana", 0)), groupPart(post("mana", 60_000)))).toBe(true);
  expect(continuesRun(groupPart(post("mana", 0)), groupPart(post("mben", 60_000)))).toBe(false);
  // The run's post and its driver's own message stay apart too.
  expect(continuesRun(groupPart(post("mana", 0)), groupPart({ author: { memberId: "mana" }, postedAt: 60_000 }))).toBe(false);
});

test("a run a direct message was opened with isn't offered once its wheel passes to someone outside it, as the room refuses it", () => {
  // The direct message is Rosa and Ana, opened with Ana's run; Ben now drives the run.
  const passed = {
    runId: "rana000001",
    label: "Codex (Ben)",
    driver: { memberId: "mben", name: "Ben" },
    accountable: { memberId: "mben", name: "Ben" },
    private: false,
    hearsYou: true,
  };
  const place = { members: [{ memberId: "mrosa" }, { memberId: "mana" }], runs: [{ runId: "rana000001" }] };
  expect(runMentionables([passed], place)).toEqual([]);
  // Hermes, Ana's agent, drives it now: Ana still answers for it, so it is offered.
  const agentDriven = { ...passed, label: "Codex (Hermes)", driver: { memberId: "mhermes", name: "Hermes" }, accountable: { memberId: "mana", name: "Ana" } };
  expect(runMentionables([agentDriven], place).map((r) => r.name)).toEqual(["Codex (Hermes)"]);
});

test("a direct message's size counts who the room adds with each run, as channels.openDirect does", () => {
  const run = (runId: string, driver: string, person = driver) => ({
    runId,
    driver: { memberId: driver, name: driver },
    accountable: { memberId: person, name: person },
  });
  // Five runs of five other people: you, the five, and the five runs.
  const five = ["ma", "mb", "mc", "md", "me"].map((m, i) => run(`r${i}`, m));
  expect(directMessageSize("mjulio", [], five)).toBe(11);
  // A picked member who also drives a picked run counts once.
  expect(directMessageSize("mjulio", ["ma"], [run("r0", "ma")])).toBe(3);
  // An agent driver joins as well as the person who added it.
  expect(directMessageSize("mjulio", [], [run("r0", "mhermes", "mana")])).toBe(4);
  // Your own run adds only the run.
  expect(directMessageSize("mjulio", [], [run("r0", "mjulio")])).toBe(2);
});

test("the new divider goes before the first message after where you had read, unless you wrote it", () => {
  const msg = (messageId: string, seq: number | undefined, author: string) => ({ messageId, seq, author: { memberId: author } });
  const list = [msg("a", undefined, "x"), msg("b", 4, "x"), msg("c", 5, "y"), msg("d", 6, "x")];
  expect(dividerBefore(list, 4, "me")).toBe("c");
  expect(dividerBefore(list, 6, "me")).toBeNull();
  expect(dividerBefore(list, undefined, "me")).toBeNull();
  expect(dividerBefore([msg("e", 7, "me"), msg("f", 8, "x")], 6, "me")).toBeNull();
  expect(dividerBefore([{ ...msg("p", 7, "x"), system: { kind: "pinned" } }, msg("q", 8, "x")], 6, "me")).toBe("q");
});

test("who reacted, and files the room would refuse, said before uploading", () => {
  expect(reactedBy(["Julio"], 1, "👍")).toBe("Julio reacted with 👍");
  expect(reactedBy(["Julio", "Ana"], 2, "👍")).toBe("Julio and Ana reacted with 👍");
  expect(reactedBy(["Julio", "Ana", "Ben"], 5, "🎉")).toBe("Julio, Ana, Ben and 2 others reacted with 🎉");
  expect(attachmentProblem({ name: "logo.svg", size: 10, type: "image/svg+xml" })).toMatch(/SVG files can't be attached/);
  expect(attachmentProblem({ name: "big.png", size: 21 * 1024 * 1024, type: "image/png" })).toMatch(/Images can be at most 20 MB/);
  expect(attachmentProblem({ name: "big.pdf", size: 51 * 1024 * 1024, type: "application/pdf" })).toMatch(/PDFs can be at most 50 MB/);
  expect(attachmentProblem({ name: "log.txt", size: 1000, type: "text/plain" })).toBeNull();
});

test("a mention picked from the list keeps its member, even when two members share a name, through typing and editing", () => {
  const twins = [
    { memberId: "manaone0001", name: "Ana", kind: "person" as const },
    { memberId: "manatwo0001", name: "Ana", kind: "person" as const },
  ];
  // Typed without the list, a shared name stays text: it can't say which Ana.
  expect(encodeMentions("@Ana hi", twins).body).toBe("@Ana hi");
  // Picking the second Ana.
  const text = "hi @Ana ";
  let picks = addPick([], "hi @an", text, 3, { kind: "member", memberId: "manatwo0001", name: "Ana", agent: false });
  expect(picks).toEqual([{ start: 3, memberId: "manatwo0001", name: "Ana" }]);
  // Typing before it moves it; typing inside it drops it.
  picks = shiftPicks(picks, text, `oh ${text}`);
  expect(picks).toEqual([{ start: 6, memberId: "manatwo0001", name: "Ana" }]);
  expect(encodeMentions(`oh ${text}`, twins, picks).body).toBe("oh hi <@manatwo0001> ");
  expect(shiftPicks(picks, `oh ${text}`, "oh hi @Anna ")).toEqual([]);
  // Editing opens with the same member picked, and saving keeps it.
  const names = new Map(twins.map((m) => [m.memberId, m.name]));
  const opened = decodeWithPicks("<@manatwo0001> and <@manaone0001>", (id) => names.get(id));
  expect(opened).toEqual({
    text: "@Ana and @Ana",
    picks: [
      { start: 0, memberId: "manatwo0001", name: "Ana" },
      { start: 9, memberId: "manaone0001", name: "Ana" },
    ],
  });
  const edited = `${opened.text}, thanks`;
  expect(encodeMentions(edited, twins, shiftPicks(opened.picks, opened.text, edited)).body).toBe("<@manatwo0001> and <@manaone0001>, thanks");
});

test("deleting the first of two mentions of members who share a name keeps the second one's member (#70)", () => {
  const twins = [
    { memberId: "manaone0001", name: "Ana", kind: "person" as const },
    { memberId: "manatwo0001", name: "Ana", kind: "person" as const },
  ];
  const text = "@Ana @Ana ";
  const picks = [
    { start: 0, memberId: "manaone0001", name: "Ana" },
    { start: 5, memberId: "manatwo0001", name: "Ana" },
  ];
  const second = [{ start: 0, memberId: "manatwo0001", name: "Ana" }];
  // The first "@Ana " selected and deleted: the text alone reads as if the second one went.
  expect(shiftPicks(picks, text, "@Ana ", { start: 0, end: 5, caret: 0 })).toEqual(second);
  expect(encodeMentions("@Ana ", twins, second).body).toBe("<@manatwo0001> ");
  // Backspace from just after it, a character at a time, ends the same way.
  let now = text;
  let moved = picks;
  for (let caret = 5; caret > 0; caret--) {
    const next = now.slice(0, caret - 1) + now.slice(caret);
    moved = shiftPicks(moved, now, next, { start: caret, end: caret, caret: caret - 1 });
    now = next;
  }
  expect({ now, moved }).toEqual({ now: "@Ana ", moved: second });
  // A refused send of the first one, put back ahead of the second typed since, keeps both members.
  const sent = { body: "@Ana", picks: [picks[0]!] };
  expect(putBack(sent, { body: "@Ana ", picks: second })).toEqual({
    body: "@Ana\n@Ana ",
    picks: [picks[0], { ...second[0], start: 5 }],
  });
});

test("a refused send comes back into the empty composer as it was, or ahead of what was typed since", () => {
  const sent = { body: "deploy at 5", picks: [] };
  expect(putBack(sent, { body: "", picks: [] })).toEqual(sent);
  expect(putBack(sent, { body: "and then", picks: [] })).toEqual({ body: "deploy at 5\nand then", picks: [] });
});

test("with more unread than the loaded messages, there's no divider yet: unread messages go on above", () => {
  const msg = (messageId: string, seq: number, author = "x") => ({ messageId, seq, author: { memberId: author } });
  const page = [msg("m60", 60), msg("m61", 61), msg("m62", 62)];
  expect(unreadMark(page, 10, "me", false)).toEqual({ above: true });
  // The channel's first message is loaded: the divider can go above it.
  expect(unreadMark(page, 10, "me", true)).toEqual({ before: "m60" });
  expect(unreadMark([msg("m10", 10), ...page], 10, "me", false)).toEqual({ before: "m60" });
  expect(unreadMark(page, 62, "me", false)).toBeNull();
});

type Main = { rows: { messageId: string; seq: number; top: number; bottom: number }[]; viewport: { top: number; bottom: number }; complete: boolean; reachesRead?: boolean };
type Panel = { rows: { messageId: string; seq: number; top: number; bottom: number }[]; viewport: { top: number; bottom: number }; parentId?: string };
/** readThrough with a fresh memory unless one is passed, every thread listed, and the list reaching the read point. */
function read(main: Main, replies: Panel | null, readSeq: number, more: { memory?: ReturnType<typeof newReadMemory>; threads?: { parentId: string; lastReplySeq?: number; firstNewSeq?: number }[]; threadsComplete?: boolean } = {}) {
  return readThrough(more.memory ?? newReadMemory(), {
    readSeq,
    main: { reachesRead: true, ...main },
    replies: replies ? { parentId: "parent", loaded: true, ...replies } : null,
    threads: more.threads ?? [],
    threadsComplete: more.threadsComplete ?? true,
  });
}

test("a channel is read through the newest message actually on screen", () => {
  const rows = [
    { messageId: "a", seq: 1, top: 0, bottom: 40 },
    { messageId: "b", seq: 2, top: 50, bottom: 90 },
    { messageId: "c", seq: 3, top: 400, bottom: 440 },
  ];
  expect(read({ rows, viewport: { top: 0, bottom: 200 }, complete: true }, null, 0).upTo).toEqual({ messageId: "b", seq: 2 });
  expect(read({ rows, viewport: { top: 0, bottom: 1000 }, complete: true }, null, 0).upTo).toEqual({ messageId: "c", seq: 3 });
  // Nothing new on screen, or nothing on screen at all (a hidden column has no height).
  expect(read({ rows, viewport: { top: 0, bottom: 200 }, complete: true }, null, 2).upTo).toBeNull();
  expect(read({ rows, viewport: { top: 0, bottom: 0 }, complete: true }, null, 0).upTo).toBeNull();
  // A list that doesn't go back to the read point may be missing messages after it (read up to
  // 0, the list starts at 5)...
  const later = rows.map((r) => ({ ...r, seq: r.seq + 4 }));
  expect(read({ rows: later, viewport: { top: 0, bottom: 1000 }, complete: true, reachesRead: false }, null, 0).upTo).toBeNull();
  // ...unless what it shows starts right after the read point.
  expect(read({ rows, viewport: { top: 0, bottom: 1000 }, complete: true, reachesRead: false }, null, 0).upTo).toEqual({ messageId: "c", seq: 3 });
});

test("a late reply read in the Replies panel doesn't mark top-level messages you haven't seen read; it's marked seen on its own", () => {
  // The list shows up to seq 4; seq 6 and 8 are below the fold. The reply (seq 10) is in the panel.
  const channel = {
    rows: [
      { messageId: "m4", seq: 4, top: 100, bottom: 140 },
      { messageId: "m6", seq: 6, top: 700, bottom: 740 },
      { messageId: "m8", seq: 8, top: 760, bottom: 800 },
    ],
    viewport: { top: 0, bottom: 600 },
    complete: true,
  };
  const replies = { rows: [{ messageId: "r10", seq: 10, top: 140, bottom: 180 }], viewport: { top: 50, bottom: 600 } };
  expect(read(channel, replies, 3)).toEqual({ upTo: { messageId: "m4", seq: 4 }, seen: ["r10"] });
  // A reply before the first unseen message still moves the read point.
  const early = { ...replies, rows: [{ messageId: "r5", seq: 5, top: 140, bottom: 180 }, ...replies.rows] };
  expect(read(channel, early, 3)).toEqual({ upTo: { messageId: "r5", seq: 5 }, seen: ["r10"] });
  // Opened at an old message, the list doesn't reach the newest: nothing past what it loaded.
  const older = { rows: [{ messageId: "m4", seq: 4, top: 100, bottom: 140 }], viewport: { top: 0, bottom: 600 }, complete: false };
  expect(read(older, replies, 3)).toEqual({ upTo: { messageId: "m4", seq: 4 }, seen: ["r10"] });
});

test("a reply read in the Replies panel marks the channel read through it, even with nothing newer in the channel's own list", () => {
  // The channel's list shows its messages up to seq 5; the reply is seq 9 and is only in the panel.
  const channel = { rows: [{ messageId: "p", seq: 5, top: 100, bottom: 140 }], viewport: { top: 0, bottom: 600 }, complete: true };
  const replies = { parentId: "p", rows: [{ messageId: "p", seq: 5, top: 60, bottom: 100 }, { messageId: "r", seq: 9, top: 140, bottom: 180 }], viewport: { top: 50, bottom: 600 } };
  const thread = [{ parentId: "p", lastReplySeq: 9, firstNewSeq: 9 }];
  expect(read(channel, replies, 5, { threads: thread })).toEqual({ upTo: { messageId: "r", seq: 9 }, seen: [] });
  // A reply scrolled out of the panel doesn't count, whatever the channel's list shows there.
  const scrolledAway = { ...replies, viewport: { top: 300, bottom: 600 } };
  expect(read(channel, scrolledAway, 5, { threads: thread })).toEqual({ upTo: null, seen: [] });
});

test("a page that starts with a pin line doesn't count as reaching where you had read up to", () => {
  const pin = { messageId: "pin", author: { memberId: "ana" }, system: { messageId: "m1" } };
  const unread = [
    { messageId: "m41", seq: 41, author: { memberId: "ana" } },
    { messageId: "m42", seq: 42, author: { memberId: "ben" } },
  ];
  // Read up to 30; the loaded page starts with a pin line, then 41 and 42: 31 to 40 aren't loaded.
  expect(unreadMark([pin, ...unread], 30, "me", false)).toEqual({ above: true });
  // Once a message at or before the read point is loaded, the divider goes before the first unread.
  expect(unreadMark([{ messageId: "m30", seq: 30, author: { memberId: "ana" } }, pin, ...unread], 30, "me", false)).toEqual({ before: "m41" });
  // With nothing older left, the pin line's page is the whole channel.
  expect(unreadMark([pin, ...unread], 30, "me", true)).toEqual({ before: "m41" });
});

test("opened at a search result or banner, the channel isn't read until it has reached that message", () => {
  // Nothing to open at: read tracking goes on.
  expect(openingAtMessage(null, "live", null, null)).toBe(false);
  // The message, or the stretch around it, is still loading: the list shows the newest page.
  expect(openingAtMessage("m5", "live", null, null)).toBe(true);
  expect(openingAtMessage("m5", "live", "m5", null)).toBe(true);
  // The older stretch is there but not scrolled to yet, then it is.
  expect(openingAtMessage("m5", "around", "m5", null)).toBe(true);
  expect(openingAtMessage("m5", "around", "m5", "m5")).toBe(false);
  // Scrolled to an earlier target, not this one.
  expect(openingAtMessage("m9", "around", "m9", "m5")).toBe(true);
});

test("messages from one person minutes apart read as one run; a gap, a day, another author or a pin line starts a new one", () => {
  const at = new Date(2026, 10, 4, 9, 41).getTime();
  const theo = (minutes: number, plain = true) => ({ authorId: "theo", at: at + minutes * 60_000, plain });
  expect(continuesRun(theo(0), theo(1))).toBe(true);
  expect(continuesRun(theo(0), theo(5))).toBe(true);
  expect(continuesRun(theo(0), theo(6))).toBe(false);
  expect(continuesRun(theo(0), { ...theo(1), authorId: "ines" })).toBe(false);
  expect(continuesRun(undefined, theo(1))).toBe(false);
  expect(continuesRun(theo(0, false), theo(1))).toBe(false);
  expect(continuesRun(theo(0), theo(1, false))).toBe(false);
  // 23:58 and 00:01 are three minutes apart but on two days.
  const late = new Date(2026, 10, 4, 23, 58).getTime();
  expect(continuesRun({ authorId: "theo", at: late, plain: true }, { authorId: "theo", at: late + 3 * 60_000, plain: true })).toBe(false);
});

test("day separators say Today, Yesterday, or the date, with the year only when it isn't this one", () => {
  const now = new Date(2026, 10, 4, 15, 0).getTime();
  expect(dayLabel(new Date(2026, 10, 4, 0, 5).getTime(), now)).toBe("Today");
  expect(dayLabel(new Date(2026, 10, 3, 23, 59).getTime(), now)).toBe("Yesterday");
  const older = dayLabel(new Date(2026, 10, 2, 12).getTime(), now);
  expect(older).toContain("2");
  expect(older).not.toContain("2026");
  expect(dayLabel(new Date(2025, 11, 31, 12).getTime(), now)).toContain("2025");
});

test("Enter inside an open ``` block makes a new line; after the block closes it sends", () => {
  const open = "here:\n```ts\nconst a = 1;";
  expect(insideCodeFence(open, open.length)).toBe(true);
  const closed = `${open}\n\`\`\``;
  expect(insideCodeFence(closed, closed.length)).toBe(false);
  expect(insideCodeFence("no code", 7)).toBe(false);
});

test("a message of only a few emoji shows larger; one with words doesn't", () => {
  expect(emojiOnly("🎉")).toBe(true);
  expect(emojiOnly(" 👍 🔥 ")).toBe(true);
  expect(emojiOnly("❤️")).toBe(true);
  expect(emojiOnly("Emoji only: 🎉")).toBe(false);
  expect(emojiOnly("ok")).toBe(false);
  expect(emojiOnly("🎉🎉🎉🎉🎉🎉🎉")).toBe(false);
  expect(emojiOnly("")).toBe(false);
});

test("search results mark where a word starts with what was searched for, in any case", () => {
  expect(matchSegments("Release notes before the release", "release")).toEqual([
    { text: "Release", hit: true },
    { text: " notes before the ", hit: false },
    { text: "release", hit: true },
  ]);
  // Not inside a word, and regex characters are plain text.
  expect(matchSegments("prerelease (v2)", "release")).toEqual([{ text: "prerelease (v2)", hit: false }]);
  expect(matchSegments("cost is $5 (v2)", "(v2)")).toEqual([{ text: "cost is $5 ", hit: false }, { text: "(v2)", hit: true }]);
});

test("a long file name is cut in the middle and keeps its extension; a short one stays whole", () => {
  expect(shortName("notes.txt")).toBe("notes.txt");
  const cut = shortName("a-really-long-file-name-for-the-quarterly-planning-offsite-agenda-final-final.txt");
  expect(cut.length).toBe(36);
  expect(cut.startsWith("a-really-long")).toBe(true);
  expect(cut.endsWith("final.txt")).toBe(true);
  expect(cut).toContain("…");
});

test("a thread opens at the first reply past your read point that someone else wrote, or at the newest", () => {
  const r = (messageId: string, seq: number, author = "ana") => ({ messageId, seq, author: { memberId: author } });
  const replies = [r("a", 3), r("b", 5, "me"), r("c", 6), r("d", 7)];
  expect(firstUnreadReply(replies, 4, "me")).toBe("c");
  expect(firstUnreadReply(replies, 2, "me")).toBe("a");
  expect(firstUnreadReply(replies, 7, "me")).toBeNull();
});

test("↑ edits your newest message in the live list, and nothing while an older stretch is open", () => {
  const m = (messageId: string, author: string, extra = {}) => ({ messageId, author: { memberId: author }, ...extra });
  const list = [m("a", "me"), m("b", "ana"), m("c", "me", { deletedAt: 1 }), m("d", "ana")];
  expect(lastEditable(list, "me", "live")?.messageId).toBe("a");
  expect(lastEditable(list, "me", "around")).toBeNull();
  expect(lastEditable([m("x", "ana")], "me", "live")).toBeNull();
});

test("a reply in the Replies panel that was never on screen stops the read point before it", () => {
  const viewport = { top: 0, bottom: 100 };
  const main = { rows: [{ messageId: "m1", seq: 1, top: 10, bottom: 40 }], viewport, complete: true };
  // The panel opened at its end: replies 2 to 4 are above its view, 5 and 6 on screen.
  const replies = {
    viewport,
    rows: [2, 3, 4].map((seq) => ({ messageId: `r${seq}`, seq, top: -300 + seq * 10, bottom: -290 + seq * 10 })).concat(
      [5, 6].map((seq) => ({ messageId: `r${seq}`, seq, top: (seq - 5) * 40 + 10, bottom: (seq - 5) * 40 + 40 })),
    ),
  };
  const memory = newReadMemory();
  const first = read(main, replies, 1, { memory });
  expect(first.upTo).toBeNull();
  // The ones on screen still stop counting as mentions.
  expect(first.seen).toEqual(["r5", "r6"]);
  // Scrolled up so 2 to 4 are on screen and 5 and 6 aren't any more: they were, so the read point
  // goes through 6.
  const up = { viewport, rows: replies.rows.map((x, i) => ({ ...x, top: 10 + i * 30 - (i > 2 ? 400 : 0), bottom: 40 + i * 30 - (i > 2 ? 400 : 0) })) };
  expect(read(main, up, 1, { memory }).upTo).toEqual({ messageId: "r6", seq: 6 });
});

test("a message on screen never carries the read point past a reply that hasn't been (readSeq 10, unseen reply 11, message 12 on screen)", () => {
  const viewport = { top: 0, bottom: 400 };
  const main = { rows: [{ messageId: "m10", seq: 10, top: 10, bottom: 40 }, { messageId: "m12", seq: 12, top: 50, bottom: 90 }], viewport, complete: true };
  const threads = [{ parentId: "m10", lastReplySeq: 11, firstNewSeq: 11 }];
  expect(read(main, null, 10, { threads }).upTo).toBeNull();
  // Where that reply starts isn't known (a long thread): the same.
  expect(read(main, null, 10, { threads: [{ parentId: "m10", lastReplySeq: 11 }] }).upTo).toBeNull();
  // Nor while the threads with unread replies are still loading, or not all listed yet.
  expect(readThrough(newReadMemory(), { readSeq: 10, main: { ...main, reachesRead: true }, replies: null, threads: null, threadsComplete: false }).upTo).toBeNull();
  expect(read(main, null, 10, { threads: [], threadsComplete: false }).upTo).toBeNull();
  // With no such thread, the message reads.
  expect(read(main, null, 10).upTo).toEqual({ messageId: "m12", seq: 12 });
});

test("following the strip through thread A (reply 12) and then B (reply 11) ends with the read point at 12", () => {
  const viewport = { top: 0, bottom: 400 };
  const main = { rows: [{ messageId: "a", seq: 9, top: 10, bottom: 40 }, { messageId: "b", seq: 10, top: 50, bottom: 90 }], viewport, complete: true };
  // As messages.unreadThreads lists them with the read point at 10: A's newest reply first.
  const threads = [
    { parentId: "a", lastReplySeq: 12, firstNewSeq: 12 },
    { parentId: "b", lastReplySeq: 11, firstNewSeq: 11 },
  ];
  const memory = newReadMemory();
  const panelOf = (parentId: string, seq: number) => ({ parentId, loaded: true, viewport, rows: [{ messageId: `r${seq}`, seq, top: 100, bottom: 140 }] });
  // A open: its reply is seen, but B's reply 11 hasn't been, so the read point stays.
  const inA = readThrough(memory, { readSeq: 10, main: { ...main, reachesRead: true }, replies: panelOf("a", 12), threads, threadsComplete: true });
  expect(inA.upTo).toBeNull();
  expect(inA.seen).toEqual(["r12"]);
  expect(memory.threadThrough.get("a")).toBe(12);
  // B open: 11 is seen, and so was 12, so the read point goes through 12 and nothing is left unread.
  const inB = readThrough(memory, { readSeq: 10, main: { ...main, reachesRead: true }, replies: panelOf("b", 11), threads, threadsComplete: true });
  expect(inB).toEqual({ upTo: { messageId: "r12", seq: 12 }, seen: [] });
});

test("a thread seen through its newest reply stops nothing; a reply that comes after stops the read point after what was seen", () => {
  const viewport = { top: 0, bottom: 400 };
  const main = { rows: [{ messageId: "p", seq: 5, top: 10, bottom: 40 }, { messageId: "m9", seq: 9, top: 50, bottom: 90 }], viewport, complete: true };
  const memory = newReadMemory();
  memory.threadThrough.set("p", 8);
  memory.seen.set(6, "r6").set(8, "r8");
  expect(read(main, null, 5, { memory, threads: [{ parentId: "p", lastReplySeq: 8, firstNewSeq: 6 }] }).upTo).toEqual({ messageId: "m9", seq: 9 });
  // Reply 10 arrives in that thread, not seen yet: the read point may go through 9, not past it.
  const later = { ...main, rows: [...main.rows, { messageId: "m11", seq: 11, top: 100, bottom: 140 }] };
  expect(read(later, null, 5, { memory, threads: [{ parentId: "p", lastReplySeq: 10, firstNewSeq: 6 }] }).upTo).toEqual({ messageId: "m9", seq: 9 });
});

test("the unread-thread pages join into one list, and a page no longer after the one before is asked for again", () => {
  const thread = (id: string) => ({ message: { messageId: id } });
  const ten = Array.from({ length: 10 }, (_, i) => thread(`t${i}`));
  // Only the first page: eleven threads, so it isn't done; the next page's cursor is offered.
  expect(mergeThreadPages([], [{ page: ten, continueCursor: "20", isDone: false }])).toEqual({ threads: ten, complete: false, next: "20", cursors: [] });
  // The second page loaded from that cursor: the eleventh thread is listed and the list is whole.
  const both = mergeThreadPages(["20"], [{ page: ten, continueCursor: "20", isDone: false }, { page: [thread("t10")], continueCursor: "", isDone: true }]);
  expect(both.threads.map((t) => t.message.messageId)).toContain("t10");
  expect(both.complete).toBe(true);
  // Still loading the second page.
  expect(mergeThreadPages(["20"], [{ page: ten, continueCursor: "20", isDone: false }, undefined])).toMatchObject({ complete: false, next: null });
  // A new reply moved a thread to the top, so the first page now ends elsewhere: the second page
  // is dropped and asked for again from the new cursor.
  const moved = mergeThreadPages(["20"], [{ page: ten, continueCursor: "24", isDone: false }, { page: [thread("t10")], continueCursor: "", isDone: true }]);
  expect(moved).toMatchObject({ complete: false, next: "24", cursors: [] });
  expect(moved.threads.map((t) => t.message.messageId)).not.toContain("t10");
});

test("a reply seen during a gap and deleted since is never the read target: the mark goes to the newest message still there, and a refused mark is tried again (#99 review)", async () => {
  const viewport = { top: 0, bottom: 400 };
  const main = { rows: [{ messageId: "m10", seq: 10, top: 10, bottom: 40 }, { messageId: "m11", seq: 11, top: 50, bottom: 90 }], viewport, complete: true };
  const memory = newReadMemory();
  // Reply 12 in thread A was on screen while thread B's reply 13 hadn't been; then 12 was deleted.
  memory.seen.set(12, "r12");
  memory.seen.set(13, "r13");
  const first = read(main, null, 10, { memory });
  expect(first.upTo).toEqual({ messageId: "r13", seq: 13 });
  const gone = new Error("No such message");
  const refusing = vi.fn(async (id: string) => {
    if (id === "r13") throw gone;
  });
  // The room refuses r13 (deleted): nothing is recorded as read, and r13 is passed over from now on.
  expect(await sendReadMark(memory, first.upTo!, refusing, (e) => e === gone)).toBe("gone");
  expect(memory.marked).toBe(0);
  const second = read(main, null, 10, { memory });
  expect(second.upTo).toEqual({ messageId: "r12", seq: 12 });
  expect(await sendReadMark(memory, second.upTo!, refusing, (e) => e === gone)).toBe("sent");
  expect(memory.marked).toBe(12);
  // Any other failure records nothing either, and the same mark can be sent again.
  memory.seen.set(14, "m14");
  const offline = async () => {
    throw new Error("offline");
  };
  expect(await sendReadMark(memory, { messageId: "m14", seq: 14 }, offline, (e) => e === gone)).toBe("failed");
  expect(memory.marked).toBe(12);
  expect(memory.seen.get(14)).toBe("m14");
  expect(await sendReadMark(memory, { messageId: "m14", seq: 14 }, async () => {}, (e) => e === gone)).toBe("sent");
  expect(memory.marked).toBe(14);
  // A mark at or before one already taken isn't sent.
  expect(await sendReadMark(memory, { messageId: "m11", seq: 11 }, refusing, (e) => e === gone)).toBe("skipped");
});

test("opening a thread whose replies are still loading never reads past its unseen reply (readSeq 10, reply 11 loading, message 12 on screen) (#99 review)", () => {
  const viewport = { top: 0, bottom: 400 };
  const main = { rows: [{ messageId: "m10", seq: 10, top: 10, bottom: 40 }, { messageId: "m12", seq: 12, top: 50, bottom: 90 }], viewport, complete: true };
  const threads = [{ parentId: "m10", lastReplySeq: 11, firstNewSeq: 11 }];
  const memory = newReadMemory();
  // The panel shows only the parent while messages.replies loads.
  const loading = { parentId: "m10", loaded: false, viewport, rows: [{ messageId: "m10", seq: 10, top: 10, bottom: 40 }] };
  expect(read(main, loading, 10, { memory, threads }).upTo).toBeNull();
  expect(memory.threadThrough.has("m10")).toBe(false);
  // Its replies came and reply 11 is on screen: now the read point goes through 12.
  const loaded = { ...loading, loaded: true, rows: [...loading.rows, { messageId: "r11", seq: 11, top: 50, bottom: 90 }] };
  expect(read(main, loaded, 10, { memory, threads }).upTo).toEqual({ messageId: "m12", seq: 12 });
});


test("a search result reads as plain words: no markdown marks, one line", () => {
  expect(plainText("**Notes from the call** (25 min)\n\n- CSV export ships *Thursday*; `iCal` waits.\n- snake_case_name stays")).toBe(
    "Notes from the call (25 min) CSV export ships Thursday; iCal waits. snake_case_name stays",
  );
});

test("a search result shows its first match with what comes before it, cut with …, and names its mentions", () => {
  const rosa = "k57f766zqnvt0gavr4e2kx15mh8hkvp5";
  const nameOf = (id: string) => (id === rosa ? "Rosa Vega" : undefined);
  const body = `<@${rosa}> I checked the export against last year's published tables for 12 stations.\n\n- 11 match to the minute.\n- Bayview is 4 minutes late on every high tide: its offset in \`stations.json\` is +4, the published table uses 0, and the rest of this sentence runs on well past the end of the excerpt.`;
  const parts = searchExcerpt(body, "bayview", nameOf, rosa);
  expect(parts[0]).toEqual({ text: "…" });
  expect(parts.at(-1)).toEqual({ text: "…" });
  expect(parts.find((p) => p.hit)).toEqual({ text: "Bayview", hit: true });
  const text = parts.map((p) => p.text).join("");
  expect(text).not.toMatch(/[`*]|<@/);
  expect(text).toContain("12 stations. 11 match");
  // From the start, the mention is kept whole and marked as you.
  const start = searchExcerpt(body, "checked", nameOf, rosa);
  expect(start[0]).toEqual({ text: "@Rosa Vega", mention: "me" });
  expect(start[2]).toEqual({ text: "checked", hit: true });
});

test("an agent that checks in on its own schedule says so in the @ list", () => {
  const team = [
    { memberId: "mduet0000001", name: "Claude Duet", kind: "agent" as const, reach: "checks_in" },
    { memberId: "mgrok0000001", name: "Grok Bot", kind: "agent" as const, reach: "webhook" },
    { memberId: "mana00000001", name: "Ana", kind: "person" as const },
  ];
  const members = memberMentionables(team, team);
  const options = mentionOptions("", members, { everyone: false });
  expect(options).toEqual([
    { kind: "member", memberId: "mana00000001", name: "Ana", agent: false },
    { kind: "member", memberId: "mduet0000001", name: "Claude Duet", agent: true, detail: CHECKS_IN },
    { kind: "member", memberId: "mgrok0000001", name: "Grok Bot", agent: true },
  ]);
});

// A run's message is stored under its driver (ADR 0029 D2), but the driver didn't write it.
const fromRun = { runId: "run1", label: "Claude Code (me)" };

test("a run's message is not one you wrote, though you drive the run", () => {
  expect(wroteIt({ author: { memberId: "me" } }, "me")).toBe(true);
  expect(wroteIt({ author: { memberId: "me" }, asRun: fromRun }, "me")).toBe(false);
  expect(wroteIt({ author: { memberId: "ana" } }, "me")).toBe(false);
});

test("the new divider goes before your run's message, which you haven't read", () => {
  const list = [
    { messageId: "m1", seq: 1, author: { memberId: "ana" } },
    { messageId: "m2", seq: 2, author: { memberId: "me" }, asRun: fromRun },
  ];
  expect(unreadMark(list, 1, "me", true)).toEqual({ before: "m2" });
});

test("a thread opens at your run's reply past your read point", () => {
  const replies = [
    { messageId: "a", seq: 3, author: { memberId: "me" } },
    { messageId: "b", seq: 4, author: { memberId: "me" }, asRun: fromRun },
  ];
  expect(firstUnreadReply(replies, 2, "me")).toBe("b");
});

test("↑ edits your own newest message, not your run's", () => {
  const list = [
    { messageId: "a", author: { memberId: "me" } },
    { messageId: "b", author: { memberId: "me" }, asRun: fromRun },
  ];
  expect(lastEditable(list, "me", "live")?.messageId).toBe("a");
});
