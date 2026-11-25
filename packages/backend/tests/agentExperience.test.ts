/// <reference types="vite/client" />
/**
 * What an agent needs to work through the Room API without guessing: who it is, which task is
 * oldest and who assigned it, how to open a terminal and read it, and errors that say what to do.
 */
import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import "../convex/http";
import { argsJsonSchema, catalogEntry } from "../convex/lib/catalog";
import { plainText } from "../convex/lib/terminals";
import { addAgent, addTeammate, bridgeInbox, bridgeSays, callAsAgent, linkMachine, newRoom, newTeam } from "./setup";

const WORK = ["room.read", "messages.post", "work.manage", "runs.start", "terminals.drive"];

async function teamWithAgent(scopes = WORK) {
  const t = newRoom();
  const { teamId, admin: ana } = await newTeam(t, "Ana");
  const bea = await addTeammate(t, teamId, ana, "Bea");
  const { agentId, key } = await addAgent(t, teamId, ana, "Atlas", scopes);
  const { machineId, token } = await linkMachine(t, teamId, ana, "macbook");
  return { t, teamId, ana, bea, agentId, key, machineId, token };
}

test("members.me tells an agent its member id, its person, and the scopes its key has and lacks", async () => {
  const { t, teamId, ana, agentId, key } = await teamWithAgent(["room.read", "messages.post"]);
  const me = await callAsAgent(t, key, "members.me");
  const members = await ana.as.query(api.teams.members, { teamId });
  const atlas = members.find((m) => m.name === "Atlas")!;
  const anaMember = members.find((m) => m.name === "Ana")!;
  expect(me.result).toMatchObject({
    memberId: atlas.memberId,
    name: "Atlas",
    kind: "agent",
    role: "member",
    agentId,
    addedBy: { memberId: anaMember.memberId, name: "Ana" },
    key: { name: "test" },
    team: { teamId, name: "Nuko Nova" },
  });
  expect(me.result.scopes.map((s: { scope: string }) => s.scope)).toEqual(["room.read", "messages.post"]);
  expect(me.result.lacksScopes).toContain("calls.join");
  expect(me.result.lacksScopes).not.toContain("room.read");

  const person = await ana.as.query(api.members.me, { teamId });
  expect(person).toMatchObject({ memberId: anaMember.memberId, kind: "person", role: "admin" });
  expect(person).not.toHaveProperty("scopes");
});

test("a missing scope's error names who can add it", async () => {
  const { t, key } = await teamWithAgent(["room.read"]);
  const posted = await callAsAgent(t, key, "tasks.create", { title: "x" });
  expect(posted).toMatchObject({ status: 403, error: { code: "forbidden" } });
  expect(posted.error!.message).toMatch(/^This agent key \("test"\) doesn't have the "work.manage" scope \(/);
  expect(posted.error!.message).toContain("Ana, who added Atlas, can add it in the app (Settings, Agents) or with agents.setKeyScopes");
});

test("the board lists tasks oldest first, with when each was made and who made it", async () => {
  const { t, teamId, ana, bea, key } = await teamWithAgent();
  const anaId = (await ana.as.query(api.members.me, { teamId })).memberId;
  const first = await bea.as.mutation(api.tasks.create, { teamId, title: "Run the tests", ownerId: anaId });
  const second = await ana.as.mutation(api.tasks.create, { teamId, title: "Write the FAQ" });

  const board = await callAsAgent(t, key, "tasks.board");
  expect(board.result.map((c: { taskId: string }) => c.taskId)).toEqual([first, second]);
  expect(board.result[0]).toMatchObject({ owner: { name: "Ana" }, createdBy: { name: "Bea", memberId: bea.memberId }, state: "not_started" });
  expect(board.result[0].createdAt).toBeLessThanOrEqual(board.result[1].createdAt);
  const inbox = await ana.as.query(api.inbox.get, { teamId });
  expect(inbox.for).toMatchObject({ memberId: anaId, name: "Ana" });
});

test("an agent opens a terminal without a task as an unfiled run, and reads it as plain text", async () => {
  const { t, key, machineId, token, teamId, ana } = await teamWithAgent();
  const started = await callAsAgent(t, key, "runs.start", { machineId, harness: "shell", cwd: "/repo" });
  expect(started.ok).toBe(true);
  const { runId, terminalId } = started.result as { runId: Id<"runs">; terminalId: Id<"terminals"> };
  const unfiled = await ana.as.query(api.runs.unfiled, { teamId });
  expect(unfiled).toMatchObject([{ runId, title: "Terminal on macbook", harness: "shell" }]);
  // An agent reads a shell as text, so the bridge runs it without colors; a person's shell keeps them.
  expect((await bridgeInbox(t, token)).find((m: any) => m.type === "start_terminal")).toMatchObject({ terminalId, cwd: "/repo", noColor: true });
  const own = await ana.as.mutation(api.runs.start, { teamId, machineId, harness: "shell" });
  expect((await bridgeInbox(t, token)).find((m: any) => m.type === "start_terminal" && m.terminalId === own.terminalId)).not.toHaveProperty("noColor");

  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: "pty-1", title: "Terminal", tool: "shell", access: "watch" });
  await bridgeSays(t, token, {
    type: "terminal_output",
    terminalId,
    seq: 1,
    data: "\u001b[1m%\u001b[0m   \r \r\rana@macbook repo % \u001b[?2004hn\bnpm test\u001b[?2004l\r\r\n\u001b[32m✔ passes\u001b[39m\r\n",
  });
  const read = await callAsAgent(t, key, "terminals.read", { terminalId });
  expect(read.result).toMatchObject({ text: "ana@macbook repo % npm test\n✔ passes\n", status: "live", runId, more: false });
  const cursor = read.result.cursor;

  await bridgeSays(t, token, { type: "terminal_output", terminalId, seq: 2, data: "done\r\n" });
  const next = await callAsAgent(t, key, "terminals.read", { terminalId, afterSeq: cursor });
  expect(next.result.text).toBe("done\n");

  // Stopping says what changed; a stop doesn't record an exit code.
  const { t: t2, key: k2, machineId: m2 } = await teamWithAgent();
  const other = await callAsAgent(t2, k2, "runs.start", { machineId: m2, harness: "shell" });
  const stopped = await callAsAgent(t2, k2, "runs.stop", { runId: other.result.runId });
  expect(stopped.result).toEqual({ runId: other.result.runId, state: "stopped", terminalId: other.result.terminalId });

  await bridgeSays(t, token, { type: "terminal_ended", terminalId, reason: "exited", exitCode: 1 });
  const ended = await callAsAgent(t, key, "terminals.read", { terminalId, afterSeq: next.result.cursor });
  expect(ended.result).toMatchObject({ text: "", status: "ended", exitCode: 1, runState: "failed" });
});

test("a thread run still needs a task, and a run on a machine says which arguments it lacks", async () => {
  const { t, key, machineId, teamId, ana } = await teamWithAgent();
  const taskId = await ana.as.mutation(api.tasks.create, { teamId, title: "Done already" });
  const { runId } = await ana.as.mutation(api.runs.start, { teamId, taskId, machineId, harness: "shell" });
  await ana.as.mutation(api.tasks.keepRun, { teamId, taskId, runId });
  const closed = await callAsAgent(t, key, "runs.start", { taskId, machineId, harness: "shell" });
  expect(closed.error!.message).toBe(
    `This task is closed (tasks.keepRun kept run ${runId}), so it takes no new runs. Leave out taskId to start an unfiled run, and link the task in your report with messages.post mentionedTasks.`,
  );
  const thread = await callAsAgent(t, key, "runs.start", { machineId, harness: "claude-code", via: "thread" });
  expect(thread.error!.message).toMatch(/^A thread run needs taskId/);
  const noHarness = await callAsAgent(t, key, "runs.start", { machineId });
  expect(noHarness.error!.message).toMatch(/^A run on a machine also needs harness \(claude-code, codex/);
  const wrong = await callAsAgent(t, key, "runs.start", { machineId, harness: "claude" });
  expect(wrong.error!.message).toContain("Use shell for a plain terminal");
});

test("runs.start runs one shell command, which needs terminals.drive as typing does", async () => {
  const { t, key, machineId, token } = await teamWithAgent();
  const ran = await callAsAgent(t, key, "runs.start", { machineId, harness: "shell", command: "npm test" });
  expect(ran.ok).toBe(true);
  expect((await bridgeInbox(t, token)).find((m: any) => m.type === "start_terminal")).toMatchObject({ command: "npm test", harness: "shell" });

  const notShell = await callAsAgent(t, key, "runs.start", { machineId, harness: "codex", command: "rm -rf /" });
  expect(notShell.error).toMatchObject({ code: "invalid" });

  const { t: t2, key: startOnly, machineId: m2 } = await teamWithAgent(["room.read", "runs.start"]);
  const refused = await callAsAgent(t2, startOnly, "runs.start", { machineId: m2, harness: "shell", command: "npm test" });
  expect(refused).toMatchObject({ status: 403, error: { code: "forbidden" } });
  expect(refused.error!.message).toContain('"terminals.drive"');
  // Without a command the same key still opens an interactive shell, as before.
  expect((await callAsAgent(t2, startOnly, "runs.start", { machineId: m2, harness: "shell" })).ok).toBe(true);
});

test("an agent reads its person's Inbox with view 'person'", async () => {
  const { t, teamId, ana, key, machineId, token } = await teamWithAgent();
  const taskId = await ana.as.mutation(api.tasks.create, { teamId, title: "Deploy" });
  const { runId, terminalId } = await ana.as.mutation(api.runs.start, { teamId, taskId, machineId, harness: "claude-code" });
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: "pty-1", title: "Deploy", tool: "claude-code", access: "watch" });
  await bridgeSays(t, token, {
    type: "run_state_changed",
    source: { kind: "terminal", terminalId },
    state: "waiting",
    prompt: { promptId: "p1", kind: "approval", text: "Allow deploy?" },
  });

  const own = await callAsAgent(t, key, "inbox.get");
  expect(own.result).toMatchObject({ for: { name: "Atlas", kind: "agent" }, needsYou: [] });
  expect(own.result.personView).toContain("Ana, who added you, sees theirs in the app; read it with inbox.get view: 'person'");
  const person = await callAsAgent(t, key, "inbox.get", { view: "person" });
  expect(person.result).toMatchObject({ for: { name: "Ana", kind: "person" }, needsYou: [{ taskId, createdBy: { name: "Ana" } }] });
  expect(person.result.needsYou[0].runs[0]).toMatchObject({ runId, state: "waiting" });
  expect(person.result).not.toHaveProperty("personView");
  // A person's own Inbox needs no pointer.
  expect(await ana.as.query(api.inbox.get, { teamId })).not.toHaveProperty("personView");
});

test("tool schemas say what an argument takes and where its ids come from", () => {
  const schema = argsJsonSchema(catalogEntry("runs.start")!.args, catalogEntry("runs.start")!.argDocs) as any;
  expect(schema.properties.harness.enum).toEqual(["claude-code", "codex", "grok-build", "opencode", "cursor", "hermes-agent", "shell"]);
  expect(schema.properties.harness.description).toContain("'shell' for a plain terminal");
  expect(schema.properties.machineId.description).toContain("A machineId, from machines.list");
  expect(schema.properties.taskId.description).toMatch(/^The task this work is for\. .*\. A taskId, from tasks\.board/);
  const post = argsJsonSchema(catalogEntry("messages.post")!.args) as any;
  expect(post.properties.channelId.description).toContain("from channels.list");
  // The app's paginationOpts stays out of what agents see; cursor and limit page for them.
  const list = argsJsonSchema(catalogEntry("messages.list")!.args, catalogEntry("messages.list")!.argDocs) as any;
  expect(Object.keys(list.properties)).toEqual(["teamId", "channelId", "cursor", "limit"]);
  const answer = argsJsonSchema(catalogEntry("terminals.answerWheelRequest")!.args) as any;
  expect(answer.properties.requestId.description).toBe("A requestId, from terminals.wheelRequests");
});

test("plainText keeps what a terminal shows last on each line", () => {
  expect(plainText("Progress 10%\rProgress 100%\r\n")).toBe("Progress 100%\n");
  expect(plainText("\u001b]0;title\u0007ab\bc\u001b[K\r\n")).toBe("ac\n");
  expect(plainText("tab\there\u0007\n")).toBe("tab\there\n");
});

test("no_free_slot names the caller's own terminals there, which it can end", async () => {
  const { t, key, machineId, teamId, ana } = await teamWithAgent();
  await ana.as.mutation(api.machines.updateSettings, { teamId, machineId, slots: 1 });
  const first = await callAsAgent(t, key, "runs.start", { machineId, harness: "shell" });
  const second = await callAsAgent(t, key, "runs.start", { machineId, harness: "shell" });
  expect(second).toMatchObject({ status: 409, error: { code: "no_free_slot" } });
  expect(second.error!.message).toBe(
    `macbook has no free slot: its one slot is in use. It's yours: end it with runs.stop (terminalId ${first.result.terminalId}, runId ${first.result.runId}). Or pick another machine, or ask whoever it belongs to.`,
  );
});

test("plainText applies erase-in-line, and a converter fed in chunks gives the same text as one read", async () => {
  const { TerminalText } = await import("@uplink-room/protocol/terminalText");
  expect(plainText("FAILED\r\u001b[KOK\n")).toBe("OK\n");
  expect(plainText("FAILED\r\u001b[0KOK\n")).toBe("OK\n");
  // Erase from the line's start through the cursor (column 3), then write there.
  expect(plainText("abcdef\b\b\b\u001b[1KX\n")).toBe("   Xef\n");
  expect(plainText("abcdef\r\u001b[2Kxy\n")).toBe("xy\n");
  expect(plainText("abc\b\b\u001b[Kz\n")).toBe("az\n");
  const raw = "https://example.com/secret\r\n\u001b[32mgreen\u001b[0m\r\nProgress 10%\rProgress 100%\r\n🚀 done\r\n\u001b]0;title\u0007end";
  const whole = plainText(raw);
  for (let cut = 1; cut < raw.length; cut++) {
    const text = new TerminalText();
    text.push(raw.slice(0, cut));
    text.push(raw.slice(cut));
    expect(text.text()).toBe(whole);
  }
  expect(whole).toBe("https://example.com/secret\ngreen\nProgress 100%\n🚀 done\nend");
});

test("reading from a cursor never drops output: a chunk bigger than maxChars comes in parts, top first", async () => {
  const { t, key, machineId, token } = await teamWithAgent();
  const started = await callAsAgent(t, key, "runs.start", { machineId, harness: "shell" });
  const terminalId = started.result.terminalId as string;
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: "pty-1", title: "Terminal", tool: "shell", access: "watch" });
  // One 30,000-character chunk with the failure at the top and colors across the cut points.
  const lines = ["FAILED: 3 tests (see below)"];
  for (let i = 0; lines.join("\r\n").length < 30_000; i++) lines.push(`\u001b[31mline ${i} ${"x".repeat(40)}\u001b[0m`);
  const raw = `${lines.join("\r\n")}\r\n`;
  await bridgeSays(t, token, { type: "terminal_output", terminalId, seq: 1, data: raw });

  let afterSeq = 0;
  let afterOffset = 0;
  let joined = "";
  let reads = 0;
  for (;;) {
    const read = await callAsAgent(t, key, "terminals.read", { terminalId, afterSeq, afterOffset, maxChars: 8000 });
    if (reads === 0) {
      expect(read.result.text.startsWith("FAILED: 3 tests (see below)\n")).toBe(true);
      expect(read.result).toMatchObject({ more: true, cursor: 0 });
      expect(read.result.cursorOffset).toBeGreaterThan(0);
      expect(read.result.cursorOffset).toBeLessThanOrEqual(8000);
    }
    reads++;
    joined += read.result.text;
    if (!read.result.more) break;
    afterSeq = read.result.cursor;
    afterOffset = read.result.cursorOffset;
    expect(reads).toBeLessThan(10);
  }
  expect(reads).toBe(4);
  // No line here is redrawn with \r across a cut, so the parts join into exactly the whole text.
  expect(joined).toBe(plainText(raw));
});

test("a process killed by a signal ends failed, with exit code 128 + the signal", async () => {
  const { t, key, machineId, token } = await teamWithAgent();
  const started = await callAsAgent(t, key, "runs.start", { machineId, harness: "shell", command: "sleep 100" });
  const terminalId = started.result.terminalId as string;
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: "pty-1", title: "sleep", tool: "shell", access: "watch" });
  await bridgeSays(t, token, { type: "terminal_ended", terminalId, reason: "exited", exitCode: 0, signal: 15 });
  const read = await callAsAgent(t, key, "terminals.read", { terminalId });
  expect(read.result).toMatchObject({ status: "ended", exitCode: 143, runState: "failed" });
});

test("the converter caps a line, however far erase-in-line and printing push its column", async () => {
  const { MAX_LINE, TerminalText } = await import("@uplink-room/protocol/terminalText");
  const text = new TerminalText();
  // 32,000 printable characters then ESC[2K, with no \r: the line empties but the column keeps growing.
  for (let i = 0; i < 6; i++) text.push(`${"x".repeat(32_000)}\u001b[2K`);
  text.push("y");
  expect(text.text().length).toBeLessThanOrEqual(MAX_LINE);
  expect(text.length).toBeLessThanOrEqual(MAX_LINE);
  expect(text.consumed).toBe(6 * 32_004 + 1);
});

test("a budget smaller than one escape sequence or character still reads it whole", async () => {
  const { takeUnits } = await import("@uplink-room/protocol/terminalText");
  // ESC[31m is 5 characters: with a budget of 4 it comes whole, with the next character.
  expect(takeUnits("\u001b[31mFAIL", 4)).toEqual({ end: 6, incomplete: false });
  expect(takeUnits("🚀ok", 1)).toEqual({ end: 2, incomplete: false });
  expect(takeUnits("ab\u001b[31mcd", 3)).toEqual({ end: 2, incomplete: false });
  expect(takeUnits("ok \u001b[3", 100)).toEqual({ end: 3, incomplete: true });
  expect(takeUnits("done\r", 100)).toEqual({ end: 4, incomplete: true });

  const { t, key, machineId, token } = await teamWithAgent();
  const started = await callAsAgent(t, key, "runs.start", { machineId, harness: "shell" });
  const terminalId = started.result.terminalId as string;
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: "pty-1", title: "Terminal", tool: "shell", access: "watch" });
  await bridgeSays(t, token, { type: "terminal_output", terminalId, seq: 1, data: "\u001b[31mFAIL\u001b[0m 🚀\r\n" });
  let afterSeq = 0;
  let afterOffset = 0;
  const texts: string[] = [];
  for (let reads = 0; reads < 20; reads++) {
    const read = await callAsAgent(t, key, "terminals.read", { terminalId, afterSeq, afterOffset, maxChars: 1 });
    texts.push(read.result.text);
    if (!read.result.more) break;
    expect([read.result.cursor, read.result.cursorOffset]).not.toEqual([afterSeq, afterOffset]);
    afterSeq = read.result.cursor;
    afterOffset = read.result.cursorOffset;
  }
  expect(texts.slice(0, 2)).toEqual(["F", "A"]);
  expect(texts.join("")).toBe("FAIL 🚀\n");
  expect(texts).toContain("🚀");
});

test("a read from a cursor stops before an unfinished escape sequence, so the next one gets it whole", async () => {
  const { t, key, machineId, token } = await teamWithAgent();
  const started = await callAsAgent(t, key, "runs.start", { machineId, harness: "shell" });
  const terminalId = started.result.terminalId as string;
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: "pty-1", title: "Terminal", tool: "shell", access: "watch" });
  await bridgeSays(t, token, { type: "terminal_output", terminalId, seq: 1, data: "ok \u001b[3" });
  const first = await callAsAgent(t, key, "terminals.read", { terminalId, afterSeq: 0 });
  expect(first.result).toMatchObject({ text: "ok ", cursor: 0, cursorOffset: 3, more: false });
  // Without a cursor too: its cursor goes before the sequence.
  expect((await callAsAgent(t, key, "terminals.read", { terminalId })).result).toMatchObject({ cursor: 0, cursorOffset: 3 });

  await bridgeSays(t, token, { type: "terminal_output", terminalId, seq: 2, data: "1mred\u001b[0m\r\n" });
  const next = await callAsAgent(t, key, "terminals.read", { terminalId, afterSeq: 0, afterOffset: 3 });
  expect(next.result).toMatchObject({ text: "red\n", cursor: 2, cursorOffset: 0, more: false, gap: false });
});

test("a read from a cursor whose next chunks were dropped says so and goes on from what's kept", async () => {
  const { t, key, machineId, token } = await teamWithAgent();
  const started = await callAsAgent(t, key, "runs.start", { machineId, harness: "shell" });
  const terminalId = started.result.terminalId as Id<"terminals">;
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: "pty-1", title: "Terminal", tool: "shell", access: "watch" });
  const big = (label: string) => `${label}\r\n${"y".repeat(20_000)}\r\n`;
  for (const [i, data] of ["first\r\n", big("second"), big("third")].entries()) {
    await bridgeSays(t, token, { type: "terminal_output", terminalId, seq: i + 1, data });
  }
  const drop = (seq: number) =>
    t.run(async (ctx) => {
      const row = await ctx.db
        .query("terminalOutput")
        .withIndex("by_terminal_seq", (q) => q.eq("terminalId", terminalId).eq("seq", seq))
        .unique();
      if (row) await ctx.db.delete(row._id);
    });

  // The first chunk was pruned: a read from the start goes on from chunk 2, and its cursor moves.
  await drop(1);
  const a = await callAsAgent(t, key, "terminals.read", { terminalId, afterSeq: 0, maxChars: 8000 });
  expect(a.result).toMatchObject({ gap: true, more: true, cursor: 1 });
  expect(a.result.text.startsWith("second\n")).toBe(true);
  const b = await callAsAgent(t, key, "terminals.read", { terminalId, afterSeq: a.result.cursor, afterOffset: a.result.cursorOffset, maxChars: 8000 });
  expect(b.result.gap).toBe(false);
  expect(b.result.cursorOffset).toBeGreaterThan(a.result.cursorOffset);

  // Then the chunk the cursor points into is pruned too: the stale offset is dropped.
  await drop(2);
  const c = await callAsAgent(t, key, "terminals.read", { terminalId, afterSeq: b.result.cursor, afterOffset: b.result.cursorOffset, maxChars: 8000 });
  expect(c.result).toMatchObject({ gap: true, cursor: 2 });
  expect(c.result.text.startsWith("third\n")).toBe(true);
});
