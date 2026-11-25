import { api } from "@uplink-room/backend/api";
import { expect, test } from "vitest";
import { clientUrlFor, MAX_COLLECTED_CHARS, RoomApiError, RoomClient, runInTerminal, waitForRuns, waitForTerminal } from "../src/client.ts";
import { bridgeSays, fetchTo, linkMachine, newBackend, newTeamWithAgent, personInTwoTeams, SITE_URL } from "./support.ts";

test("the client reaches the same function as the app and returns the same result", async () => {
  const t = newBackend();
  const { admin, teamId, key } = await newTeamWithAgent(t);
  const client = new RoomClient({ url: SITE_URL, key, fetch: fetchTo(t) });

  const { version, functions } = await client.functions();
  expect(version).toBe("v1");
  expect(functions.map((f) => f.name)).toContain("channels.list");

  const overHttp = await client.call("channels.list");
  const fromApp = await admin.query(api.channels.list, { teamId });
  expect(overHttp).toEqual(JSON.parse(JSON.stringify(fromApp)));
});

test("the client throws a RoomApiError with the code, message and status", async () => {
  const t = newBackend();
  const { key } = await newTeamWithAgent(t);

  const wrongKey = new RoomClient({ url: SITE_URL, key: "not-a-key", fetch: fetchTo(t) });
  await expect(wrongKey.call("channels.list")).rejects.toMatchObject({
    name: "RoomApiError",
    code: "unauthenticated",
    status: 401,
  });

  const client = new RoomClient({ url: SITE_URL, key, fetch: fetchTo(t) });
  const error = await client.call("no.such").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RoomApiError);
  expect(error).toMatchObject({ code: "not_found", status: 404 });
});

test("watch connects to the deployment's client URL, derived from its site URL", () => {
  expect(clientUrlFor("https://focused-fish-459.convex.site")).toBe("https://focused-fish-459.convex.cloud");
  expect(clientUrlFor("http://127.0.0.1:3211")).toBe("http://127.0.0.1:3210");
});

test("upload returns what messages.post takes, as the README shows: attachments: [await room.upload(...)]", async () => {
  const t = newBackend();
  const { admin, teamId, key, generalId } = await newTeamWithAgent(t);
  const room = new RoomClient({ url: SITE_URL, key, fetch: fetchTo(t) });
  const shot = await room.upload(new TextEncoder().encode("png bytes"), "shot.png");
  expect(Object.keys(shot).sort()).toEqual(["name", "storageId", "uploadId"]);
  const messageId = (await room.call("messages.post", {
    channelId: generalId,
    body: "The new screen",
    attachments: [shot],
  })) as string;
  const message = await admin.query(api.messages.get, { teamId, messageId: messageId as never });
  expect(message?.attachments).toMatchObject([{ name: "shot.png", kind: "image", contentType: "image/png" }]);
});

test("runInTerminal types a command and returns its output once the terminal ends", async () => {
  const t = newBackend();
  const { admin, teamId, key } = await newTeamWithAgent(t, ["room.read", "runs.start", "terminals.drive"]);
  const { token, machineId } = await linkMachine(t, admin, teamId);
  const client = new RoomClient({ url: SITE_URL, key, fetch: fetchTo(t) });
  const { terminalId } = (await client.call("runs.start", { machineId, harness: "shell" })) as { terminalId: string };
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: "pty-1", title: "Terminal", tool: "shell", access: "watch" });
  await bridgeSays(t, token, { type: "terminal_output", terminalId, seq: 1, data: "$ " });

  // The bridge answers while the helper waits: the command's echo and output, then the shell exits.
  let now = 0;
  let step = 0;
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
      step++;
      if (step === 1) await bridgeSays(t, token, { type: "terminal_output", terminalId, seq: 2, data: "npm test\r\n\u001b[32m1 passed\u001b[0m\r\n" });
      if (step === 2) await bridgeSays(t, token, { type: "terminal_ended", terminalId, reason: "exited", exitCode: 0 });
    },
  };
  const result = await runInTerminal(client, { terminalId, command: "npm test" }, clock);
  expect(result).toMatchObject({ text: "npm test\n1 passed\n", stopped: "ended", status: "ended", exitCode: 0, runState: "done" });

  const typed = await t.query(api.bridge.inbox, { token, afterSeq: 0 });
  expect(typed.messages.map((m) => m.message).find((m) => m.type === "input")).toMatchObject({ data: "npm test\n" });
  await expect(runInTerminal(client, { terminalId, command: "ls" }, clock)).rejects.toMatchObject({ code: "invalid" });
});

test("runInTerminal stops when the shell's prompt comes back, and says when it can't tell", async () => {
  const t = newBackend();
  const { admin, teamId, key } = await newTeamWithAgent(t, ["room.read", "runs.start", "terminals.drive"]);
  const { token, machineId } = await linkMachine(t, admin, teamId);
  const client = new RoomClient({ url: SITE_URL, key, fetch: fetchTo(t) });
  const { terminalId } = (await client.call("runs.start", { machineId, harness: "shell" })) as { terminalId: string };
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: "pty-1", title: "Terminal", tool: "shell", access: "watch" });
  await bridgeSays(t, token, { type: "terminal_output", terminalId, seq: 1, data: "ana@macbook billing % " });

  let now = 0;
  let seq = 1;
  const say = (data: string) => bridgeSays(t, token, { type: "terminal_output", terminalId, seq: ++seq, data });
  const clock = (script: Record<number, string>) => {
    let step = 0;
    return { now: () => now, sleep: async (ms: number) => { now += ms; step++; if (script[step]) await say(script[step]!); } };
  };
  const done = await runInTerminal(client, { terminalId, command: "node --version" }, clock({ 1: "node --version\r\nv24.22.1\r\n", 2: "ana@macbook billing % " }));
  // The prompt line hasn't ended, so its trailing space stays (a resumed read would go on from it).
  expect(done).toMatchObject({ text: "node --version\nv24.22.1\nana@macbook billing % ", stopped: "prompt", finished: true });
  expect(done).not.toHaveProperty("hint");

  const slow = await runInTerminal(client, { terminalId, command: "npm test", idleMs: 1000 }, clock({ 1: "npm test\r\n> building…\r\n" }));
  expect(slow).toMatchObject({ stopped: "quiet", finished: false });
  expect(slow.hint).toContain(`terminals.read {terminalId, afterSeq: ${slow.cursor}}`);
});

test("waitForTerminal returns a one-shot command's whole output and exit code once it ends", async () => {
  const t = newBackend();
  const { admin, teamId, key } = await newTeamWithAgent(t, ["room.read", "runs.start", "terminals.drive"]);
  const { token, machineId } = await linkMachine(t, admin, teamId);
  const client = new RoomClient({ url: SITE_URL, key, fetch: fetchTo(t) });
  const { terminalId } = (await client.call("runs.start", { machineId, harness: "shell", command: "npm test" })) as { terminalId: string };
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: "pty-1", title: "npm test", tool: "shell", access: "watch" });
  await bridgeSays(t, token, { type: "terminal_output", terminalId, seq: 1, data: "> test\r\n" });

  let now = 0;
  let step = 0;
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
      step++;
      if (step === 1) await bridgeSays(t, token, { type: "terminal_output", terminalId, seq: 2, data: "1 passed, 1 failed\r\n" });
      if (step === 3) await bridgeSays(t, token, { type: "terminal_ended", terminalId, reason: "exited", exitCode: 1 });
    },
  };
  const result = await waitForTerminal(client, { terminalId }, clock);
  expect(result).toMatchObject({ text: "> test\n1 passed, 1 failed\n", stopped: "ended", finished: true, exitCode: 1, runState: "failed" });

  // A shell that never ends comes back at waitMs with a hint.
  const { terminalId: shell } = (await client.call("runs.start", { machineId, harness: "shell" })) as { terminalId: string };
  await bridgeSays(t, token, { type: "terminal_started", terminalId: shell, localRef: "pty-2", title: "Terminal", tool: "shell", access: "watch" });
  const waited = await waitForTerminal(client, { terminalId: shell, waitMs: 2000 }, { now: () => now, sleep: async (ms) => void (now += ms) });
  expect(waited).toMatchObject({ stopped: "timeout", finished: false, status: "live" });
  expect(waited.hint).toContain("an interactive shell ends only when you type exit");
});

/** A room client whose terminal prints forever, as `yes` does, for the helpers' limits. */
function endlessTerminal(chunk: string, clock: { now: () => number }, msPerCall = 50) {
  let seq = 0;
  let calls = 0;
  const client = {
    key: "an agent key",
    async call(fn: string, args: Record<string, unknown>) {
      calls++;
      (clock as { now: () => number; advance?: (ms: number) => void }).advance?.(msPerCall);
      if (fn === "terminals.read") return { text: "$ ", cursor: seq, more: false, status: "live" };
      if (fn === "terminals.input") return null;
      if (fn === "terminals.output") {
        const after = Number(args.afterSeq);
        seq = Math.max(seq, after + 1);
        return { chunks: [{ seq: after + 1, data: chunk }], cursor: after + 1, more: true, outputSeq: after + 100, status: "live" };
      }
      throw new Error(`unexpected ${fn}`);
    },
  } as unknown as RoomClient;
  return { client, calls: () => calls };
}

function fakeClock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => void (now += ms), advance: (ms: number) => void (now += ms) };
}

test("a command that never stops printing can't hold the helpers or fill memory", async () => {
  // Lots of output: they stop at the cap, with the cursor to read on from.
  const clock = fakeClock();
  const { client } = endlessTerminal("y\r\n".repeat(4000), clock);
  const ran = await runInTerminal(client, { terminalId: "t1", command: "yes" }, clock);
  expect(ran).toMatchObject({ stopped: "limit", finished: false, truncated: true });
  // The budget counts input: 50,000 characters of "y\r\n" read as about 33,000 of text.
  expect(ran.text.length).toBeLessThanOrEqual(MAX_COLLECTED_CHARS);
  expect(ran.text.length).toBeGreaterThan(MAX_COLLECTED_CHARS / 2);
  // The budget ended inside a chunk, just before a \r\n: the cursor points inside it, before the pair.
  expect(ran.hint).toContain(`terminals.read {terminalId, afterSeq: ${ran.cursor}, afterOffset: ${ran.cursorOffset}}`);
  expect(ran.cursorOffset % 3).toBe(1);
  const waited = await waitForTerminal(endlessTerminal("y\r\n".repeat(4000), clock).client, { terminalId: "t1" }, clock);
  expect(waited).toMatchObject({ stopped: "limit", truncated: true });

  // A trickle that never pauses: the deadline holds, though more output is always waiting.
  const slow = fakeClock();
  const trickle = endlessTerminal("y\r\n", slow, 200);
  const timed = await runInTerminal(trickle.client, { terminalId: "t1", command: "yes", waitMs: 5000 }, slow);
  expect(timed).toMatchObject({ stopped: "timeout", finished: false, truncated: true });
  expect(timed.waitedMs).toBeLessThan(5000 + 20 * 200 + 1000);
  const waitedSlow = await waitForTerminal(endlessTerminal("y\r\n", slow, 200).client, { terminalId: "t1", waitMs: 5000 }, slow);
  expect(waitedSlow).toMatchObject({ stopped: "timeout", truncated: true });
});

test("the helpers join chunks exactly: no added newlines, and a split escape or \\r still applies", async () => {
  const t = newBackend();
  const { admin, teamId, key } = await newTeamWithAgent(t, ["room.read", "runs.start", "terminals.drive"]);
  const { token, machineId } = await linkMachine(t, admin, teamId);
  const client = new RoomClient({ url: SITE_URL, key, fetch: fetchTo(t) });
  const { terminalId } = (await client.call("runs.start", { machineId, harness: "shell", command: "curl" })) as { terminalId: string };
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: "pty-1", title: "curl", tool: "shell", access: "watch" });
  const pieces = ["https://example.", "com/secret\r\n\u001b[3", "2mgreen\u001b[0m\r\nProgress 10%\r", "Progress 100%\r\n"];
  for (const [i, data] of pieces.entries()) await bridgeSays(t, token, { type: "terminal_output", terminalId, seq: i + 1, data });
  await bridgeSays(t, token, { type: "terminal_ended", terminalId, reason: "exited", exitCode: 0 });
  const result = await waitForTerminal(client, { terminalId }, { now: () => 0, sleep: async () => {} });
  expect(result).toMatchObject({ text: "https://example.com/secret\ngreen\nProgress 100%\n", stopped: "ended", truncated: false });
});

/** A room client whose terminal holds the given chunks, as terminals.output pages them. */
function terminalWith(chunks: string[], status: "live" | "ended" = "live") {
  const client = {
    key: "an agent key",
    async call(fn: string, args: Record<string, unknown>) {
      if (fn === "terminals.read") return { text: "$ ", cursor: 0, cursorOffset: 0, more: false, status };
      if (fn === "terminals.input") return null;
      if (fn === "terminals.output") {
        const after = Number(args.afterSeq);
        const page = chunks.slice(after, after + 16).map((data, i) => ({ seq: after + i + 1, data }));
        const cursor = page.at(-1)?.seq ?? after;
        return { chunks: page, cursor, more: cursor < chunks.length, outputSeq: chunks.length, status };
      }
      throw new Error(`unexpected ${fn}`);
    },
  } as unknown as RoomClient;
  return client;
}

test("the read budget counts input, so an oversized first chunk or a runaway column can't pass it", async () => {
  const clock = { now: () => 0, sleep: async () => {} };
  // An old terminal's single 120,000-character chunk: it takes 50,000, and the cursor points inside it.
  const legacy = terminalWith(["z".repeat(120_000)], "ended");
  const first = await waitForTerminal(legacy, { terminalId: "t1" }, clock);
  expect(first).toMatchObject({ stopped: "limit", truncated: true, cursor: 0, cursorOffset: MAX_COLLECTED_CHARS });
  expect(first.text.length).toBe(MAX_COLLECTED_CHARS);
  const second = await waitForTerminal(legacy, { terminalId: "t1", afterSeq: 0, afterOffset: first.cursorOffset }, clock);
  expect(second).toMatchObject({ cursor: 0, cursorOffset: 2 * MAX_COLLECTED_CHARS });
  const third = await waitForTerminal(legacy, { terminalId: "t1", afterSeq: 0, afterOffset: second.cursorOffset }, clock);
  expect(third).toMatchObject({ stopped: "ended", cursor: 1, cursorOffset: 0, truncated: false });
  expect(first.text.length + second.text.length + third.text.length).toBe(120_000);

  // 32,000 characters then ESC[2K, with no \r, over and over: the line stays empty, the column grows.
  const runaway = terminalWith(Array.from({ length: 40 }, () => `${"x".repeat(32_000)}\u001b[2K`).concat(["y"]));
  const ran = await waitForTerminal(runaway, { terminalId: "t1" }, clock);
  expect(ran).toMatchObject({ stopped: "limit", truncated: true });
  expect(ran.text.length).toBeLessThanOrEqual(MAX_COLLECTED_CHARS);
});

test("a helper that stops between the halves of an escape sequence resumes before it", async () => {
  const live = terminalWith(["ok \u001b[3"]);
  const waited = await waitForTerminal(live, { terminalId: "t1", waitMs: 1000 }, fakeClock());
  expect(waited).toMatchObject({ stopped: "timeout", text: "ok ", cursor: 0, cursorOffset: 3 });
  const later = terminalWith(["ok \u001b[3", "1mred\u001b[0m\r\n"], "ended");
  const resumed = await waitForTerminal(later, { terminalId: "t1", afterSeq: waited.cursor, afterOffset: waited.cursorOffset }, fakeClock());
  expect(resumed).toMatchObject({ stopped: "ended", text: "red\n", cursor: 2, cursorOffset: 0 });
});

test("the client sends a credential only over HTTPS, or plain HTTP to this computer", () => {
  const sent: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    sent.push(String(input));
    return new Response("{}");
  }) as typeof globalThis.fetch;
  for (const url of ["http://room.example.com", "http://10.0.0.5:3211", "ws://room.example.com"]) {
    expect(() => new RoomClient({ url, key: "urk_x", fetch }), url).toThrow(expect.objectContaining({ code: "insecure_url" }));
  }
  // A local backend: 127.0.0.1, ::1 or localhost.
  for (const url of ["http://127.0.0.1:3211", "http://[::1]:3211", "http://localhost:3211", "https://room.example.com"]) {
    expect(() => new RoomClient({ url, key: "urk_x", fetch }), url).not.toThrow();
  }
  // A live watch goes to its own address, which must be secure too.
  expect(() => new RoomClient({ url: "https://room.example.com", convexUrl: "http://room.example.com", key: "urk_x", fetch })).toThrow(
    expect.objectContaining({ code: "insecure_url" }),
  );
  expect(sent).toEqual([]);
});

test("a person signed in from the command line, in two teams, uses runInTerminal, waitForTerminal and upload", async () => {
  const t = newBackend();
  const { admin, sideTeamId, sideGeneralId, bridgeToken: token, machineId, signIn } = await personInTwoTeams(t);
  const client = new RoomClient({ url: SITE_URL, key: signIn, fetch: fetchTo(t) });
  const instant = { now: () => 0, sleep: async () => {} };

  // A shell they drive, in the second team: the helpers find its team from the terminal.
  const shell = (await client.call("runs.start", { teamId: sideTeamId, machineId, harness: "shell" })) as { terminalId: string };
  await bridgeSays(t, token, { type: "terminal_started", terminalId: shell.terminalId, localRef: "pty-1", title: "Terminal", tool: "shell", access: "watch" });
  await bridgeSays(t, token, { type: "terminal_output", terminalId: shell.terminalId, seq: 1, data: "$ " });
  let step = 0;
  const bridge = {
    now: () => step * 400,
    sleep: async () => {
      step++;
      if (step === 1) await bridgeSays(t, token, { type: "terminal_output", terminalId: shell.terminalId, seq: 2, data: "exit 0\r\n" });
      if (step === 2) await bridgeSays(t, token, { type: "terminal_ended", terminalId: shell.terminalId, reason: "exited", exitCode: 0 });
    },
  };
  expect(await runInTerminal(client, { terminalId: shell.terminalId, command: "exit 0" }, bridge)).toMatchObject({ text: "exit 0\n", stopped: "ended", exitCode: 0 });

  const ran = (await client.call("runs.start", { teamId: sideTeamId, machineId, harness: "shell", command: "echo hi" })) as { terminalId: string };
  await bridgeSays(t, token, { type: "terminal_started", terminalId: ran.terminalId, localRef: "pty-2", title: "Terminal", tool: "shell", access: "watch" });
  await bridgeSays(t, token, { type: "terminal_output", terminalId: ran.terminalId, seq: 1, data: "hi\r\n" });
  await bridgeSays(t, token, { type: "terminal_ended", terminalId: ran.terminalId, reason: "exited", exitCode: 0 });
  expect(await waitForTerminal(client, { terminalId: ran.terminalId }, instant)).toMatchObject({ text: "hi\n", stopped: "ended", exitCode: 0 });
  // Or named outright.
  expect(await waitForTerminal(client, { terminalId: ran.terminalId, teamId: sideTeamId }, instant)).toMatchObject({ stopped: "ended" });

  // An upload has nothing to find a team from, so it takes teamId; without one the room asks for it.
  const bytes = new TextEncoder().encode("png bytes");
  await expect(client.upload(bytes, "shot.png")).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/pass teamId/) });
  const shot = await client.upload(bytes, "shot.png", undefined, { teamId: sideTeamId });
  const messageId = (await client.call("messages.post", { teamId: sideTeamId, channelId: sideGeneralId, body: "The new screen", attachments: [shot] })) as string;
  const message = await admin.query(api.messages.get, { teamId: sideTeamId as never, messageId: messageId as never });
  expect(message?.attachments).toMatchObject([{ name: "shot.png", kind: "image" }]);
});

test("waitForRuns returns once a run the agent started changes state, with the cursor to wait from next", async () => {
  const t = newBackend();
  const { admin, teamId, key } = await newTeamWithAgent(t, ["room.read", "runs.start", "terminals.drive"]);
  const { token, machineId } = await linkMachine(t, admin, teamId);
  const client = new RoomClient({ url: SITE_URL, key, fetch: fetchTo(t) });
  const { runId, terminalId } = (await client.call("runs.start", { machineId, harness: "shell", command: "npm test" })) as { runId: string; terminalId: string };
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: "pty-1", title: "npm test", tool: "shell", access: "watch" });

  let now = 0;
  let step = 0;
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
      if (++step === 2) {
        // Real time passes too, so the run's change is after the cursor the wait started from.
        await new Promise((resolve) => setTimeout(resolve, 5));
        await bridgeSays(t, token, { type: "terminal_ended", terminalId, reason: "exited", exitCode: 0 });
      }
    },
  };
  const result = await waitForRuns(client, {}, clock);
  expect(result).toMatchObject({ stopped: "changed", changes: [{ runId, state: "done" }] });
  const quiet = await waitForRuns(client, { after: result.cursor, waitMs: 4000 }, { now: () => now, sleep: async (ms) => void (now += ms) });
  expect(quiet).toMatchObject({ stopped: "timeout", changes: [] });
});
