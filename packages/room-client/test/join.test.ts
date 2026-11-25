/**
 * `uplink join` (ADR 0027, ADR 0032): a Claude Code or Codex session joins a team as a live run of
 * its signed-in person, hears its messages through hooks (or Codex's app server), answers as the run,
 * and leaves. The room is the real backend in convex-test; the harness process, the keeper's start
 * and Codex are stood in.
 */
import { api } from "@uplink-room/backend/api";
import { execFileSync } from "node:child_process";
import { readFile, realpath, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { main, type CliIo } from "../src/cli.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startChannel } from "../src/channel.ts";
import { RoomClient } from "../src/client.ts";
import { createRoomMcpServer } from "../src/mcp.ts";
import { announceChannel, listJoined, readJoined, readWaiting, saveJoined, writeWaiting } from "../src/joined.ts";
import { fetchToRoomAndClerk, personInTwoTeams, tempDir, type Backend } from "./support.ts";
import { newBackend } from "./support.ts";

const SESSION = "0b7e6c1a-2f4d-4c55-9d0e-4b2c0a1f9e11";
const PROGRAM = ["/usr/local/bin/node", "/opt/uplink/src/cli.ts"];

/** Julio, signed in on the command line, in a Claude Code session started in a project folder. */
async function session(opts: { harnessArgs?: string; env?: Record<string, string>; running?: number[]; cwd?: string; harnessCwd?: string } = {}) {
  const t = newBackend();
  const julio = await personInTwoTeams(t);
  const project = opts.cwd ?? (await tempDir("uplink-join-project-"));
  const keepers: string[] = [];
  // Claude Code's own config (~/.claude.json): this test's, not the person's running the tests.
  const claudeConfig = await tempDir("uplink-join-claude-config-");
  const env = { UPLINK_HOME: julio.home, CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_CONFIG_DIR: claudeConfig, ...opts.env };
  const io = (stdin = ""): CliIo => ({
    fetch: fetchToRoomAndClerk(t, julio.clerk),
    env,
    stdin: async () => stdin,
    harnessProcess: async () => ({ pid: 4242, args: opts.harnessArgs ?? "claude --model claude-haiku-5-5", ...(opts.harnessCwd ? { cwd: opts.harnessCwd } : {}) }),
    parents: async () => [4243, 4242],
    startKeeper: (key) => void keepers.push(key),
    isRunning: (pid) => pid === 4242 || (opts.running ?? []).includes(pid),
    program: PROGRAM,
    cwd: () => project,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 2)),
  });
  async function run(argv: string[], stdin = "") {
    let stdout = "";
    let stderr = "";
    const code = await main(argv, { ...io(stdin), stdout: (s) => void (stdout += s), stderr: (s) => void (stderr += s) });
    return { code, stdout, stderr };
  }
  return { t, julio, project, env, keepers, run, io };
}

const settingsOf = async (project: string) => JSON.parse(await readFile(join(project, ".claude", "settings.local.json"), "utf8"));

async function liveRuns(t: Backend, julio: Awaited<ReturnType<typeof personInTwoTeams>>) {
  return julio.admin.query(api.runs.live, { teamId: julio.teamId as never });
}

test("uplink join makes this Claude Code session a live run, with hooks in the project's local settings and no credential in them", async () => {
  const { t, julio, project, env, keepers, run } = await session();

  const joined = await run(["join", "--team", "Nuko Nova", "--title", "payments"]);
  expect(joined).toMatchObject({ code: 0, stderr: "" });
  expect(joined.stdout).toMatch(/^This session joined Nuko Nova as Claude Code \(Julio\)/);
  expect(joined.stdout).toMatch(/after each tool call during a turn, and wake it when it is idle/);
  expect(joined.stdout).toMatch(/uplink reply <message id> "text"/);

  const [live] = await liveRuns(t, julio);
  expect(live).toMatchObject({ label: "Claude Code (Julio)", title: "payments", via: "joined", hearing: "mid_task" });

  const hook = (event: string, extra = {}) => ({
    type: "command",
    command: PROGRAM[0],
    args: [PROGRAM[1], "hook", "claude", event, "--home", env.UPLINK_HOME],
    timeout: 30,
    ...extra,
  });
  const settings = await settingsOf(project);
  expect(settings).toEqual({
    hooks: {
      PostToolUse: [{ matcher: "*", hooks: [hook("post-tool-use")] }],
      PostToolUseFailure: [{ matcher: "*", hooks: [hook("post-tool-use")] }],
      UserPromptSubmit: [{ hooks: [hook("user-prompt-submit")] }],
      Stop: [{ hooks: [hook("stop", { asyncRewake: true, timeout: 604800 })] }],
      StopFailure: [{ hooks: [hook("stop-failure", { asyncRewake: true, timeout: 604800 })] }],
      SessionStart: [{ hooks: [hook("session-start", { asyncRewake: true, timeout: 604800 })] }],
      SessionEnd: [{ hooks: [hook("session-end", { timeout: 10 })] }],
    },
  });
  const { key, session: saved } = (await listJoined(env))[0]!;
  expect(saved).toMatchObject({ token: expect.stringMatching(/^urj_/), runId: live!.runId, harnessPid: 4242, via: "hooks" });
  expect(JSON.stringify(settings)).not.toMatch(/urj_|urs_/);
  // Windows keeps no POSIX mode (a file reads 0o666); the folder in the person's profile keeps it theirs.
  if (process.platform !== "win32") expect((await stat(join(env.UPLINK_HOME, "joined", `${key}.json`))).mode & 0o777).toBe(0o600);
  expect(keepers).toEqual([key]);
});

test("a hook hands the session its messages mid-turn, and an idle session's waiter wakes it", async () => {
  const { t, julio, env, run } = await session();
  await run(["join", "--team", "Nuko Nova"]);
  const [live] = await liveRuns(t, julio);
  const post = (body: string) => julio.admin.mutation(api.messages.post, { teamId: julio.teamId as never, channelId: julio.generalId as never, body });
  const hookInput = (event: string) => JSON.stringify({ session_id: SESSION, hook_event_name: event });

  const first = await post(`<@run:${live!.runId}> also run the migration's dry run`);
  const during = await run(["hook", "claude", "post-tool-use", "--home", env.UPLINK_HOME], hookInput("PostToolUse"));
  expect(during.code).toBe(0);
  const output = JSON.parse(during.stdout);
  expect(output.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  expect(output.hookSpecificOutput.additionalContext).toContain(
    `Message ${first} in #general, from Julio, a person. Julio is accountable for it and is this run's driver.\n> @Claude Code (Julio) also run the migration's dry run`,
  );
  // Delivered once.
  expect((await run(["hook", "claude", "post-tool-use"], hookInput("PostToolUse"))).stdout).toBe("");

  // The turn ends: the Stop waiter waits while idle, and exits 2 with the next message, which wakes the session.
  const { key } = (await listJoined(env))[0]!;
  const waiter = run(["hook", "claude", "stop"], hookInput("Stop"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = await post(`<@run:${live!.runId}> are you still there?`);
  await writeWaiting(env, key, 1);
  const woke = await waiter;
  expect(woke.code).toBe(2);
  expect(woke.stderr).toContain(`Message ${second} in #general`);
  expect(woke.stdout).toBe("");

  const inbox = await julio.admin.query(api.runs.inbox, { teamId: julio.teamId as never, runId: live!.runId });
  expect(inbox.messages!.map((m) => [m.messageId, m.status, m.how])).toEqual([
    [second, "delivered", "next_turn"],
    [first, "delivered", "mid_task"],
  ]);
});

test("a message is delivered only once its hook has written it: a hook whose output can't be written leaves it to come again", async () => {
  const { t, julio, run, io } = await session();
  await run(["join", "--team", "Nuko Nova"]);
  const [live] = await liveRuns(t, julio);
  const post = (body: string) => julio.admin.mutation(api.messages.post, { teamId: julio.teamId as never, channelId: julio.generalId as never, body });
  const statuses = async () => (await julio.admin.query(api.runs.inbox, { teamId: julio.teamId as never, runId: live!.runId })).messages!.map((m) => [m.messageId, m.status]);
  const hookInput = JSON.stringify({ session_id: SESSION, hook_event_name: "PostToolUse" });

  // Claude Code stopped reading the hook (it timed out, or the session closed): the write fails.
  const lost = await post(`<@run:${live!.runId}> first`);
  const broken = await main(["hook", "claude", "post-tool-use"], {
    ...io(hookInput),
    stdout: () => {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    },
    stderr: () => {},
  });
  expect(broken).toBe(1);
  expect(await statuses()).toEqual([[lost, "waiting"]]);

  // A hook that writes its output says so, and that message is delivered.
  const second = await post(`<@run:${live!.runId}> second`);
  expect((await run(["hook", "claude", "post-tool-use"], hookInput)).stdout).toContain(`Message ${second}`);
  expect(await statuses()).toEqual([
    [second, "delivered"],
    [lost, "waiting"],
  ]);
  // So does uplink inbox, once it has printed them.
  const third = await post(`<@run:${live!.runId}> third`);
  expect((await run(["inbox"])).stdout).toContain(`Message ${third}`);
  expect((await statuses())[0]).toEqual([third, "delivered"]);
});

test("a turn that ends in an API error still leaves the session idle with a waiter, which a message wakes", async () => {
  const { t, julio, env, project, run } = await session();
  await run(["join", "--team", "Nuko Nova"]);
  const [live] = await liveRuns(t, julio);
  const { key } = (await listJoined(env))[0]!;
  // Claude Code fires StopFailure instead of Stop when a turn ends in an API error (code.claude.com/docs/en/hooks).
  expect((await settingsOf(project)).hooks.StopFailure).toEqual([
    { hooks: [{ type: "command", command: PROGRAM[0], args: [PROGRAM[1], "hook", "claude", "stop-failure", "--home", env.UPLINK_HOME], timeout: 604800, asyncRewake: true }] },
  ]);
  await run(["hook", "claude", "post-tool-use"], JSON.stringify({ session_id: SESSION, hook_event_name: "PostToolUse" }));

  const waiter = run(["hook", "claude", "stop-failure"], JSON.stringify({ session_id: SESSION, hook_event_name: "StopFailure", error: "rate_limit" }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const messageId = await julio.admin.mutation(api.messages.post, { teamId: julio.teamId as never, channelId: julio.generalId as never, body: `<@run:${live!.runId}> try again?` });
  await writeWaiting(env, key, 1);
  const woke = await waiter;
  expect(woke.code).toBe(2);
  expect(woke.stderr).toContain(`Message ${messageId} in #general`);
});

test("a subagent's hooks touch nothing: its tool calls leave the messages and the idle session's waiter alone", async () => {
  const { t, julio, env, run } = await session();
  await run(["join", "--team", "Nuko Nova"]);
  const [live] = await liveRuns(t, julio);
  const { key } = (await listJoined(env))[0]!;
  const waiter = run(["hook", "claude", "stop"], JSON.stringify({ session_id: SESSION, hook_event_name: "Stop" }));
  await new Promise((resolve) => setTimeout(resolve, 30));

  // A background subagent works while the main session is idle: Claude Code runs the same hooks
  // inside it, with the parent's session_id and the subagent's agent_id (code.claude.com/docs/en/hooks).
  const messageId = await julio.admin.mutation(api.messages.post, { teamId: julio.teamId as never, channelId: julio.generalId as never, body: `<@run:${live!.runId}> ping` });
  await writeWaiting(env, key, 1);
  const subagent = { session_id: SESSION, agent_id: "agent-abc123", agent_type: "Explore" };
  for (const event of ["post-tool-use", "user-prompt-submit"]) {
    expect(await run(["hook", "claude", event], JSON.stringify({ ...subagent, hook_event_name: "PostToolUse" }))).toEqual({ code: 0, stdout: "", stderr: "" });
  }

  // The session stays idle, so its own waiter takes the message and wakes it.
  const woke = await waiter;
  expect(woke.code).toBe(2);
  expect(woke.stderr).toContain(`Message ${messageId} in #general`);
});

test("a newer waiter replaces the older one, and a session that never joined gets nothing from the hooks", async () => {
  const { env, run } = await session();
  await run(["join", "--team", "Nuko Nova"]);
  const older = run(["hook", "claude", "stop"], JSON.stringify({ session_id: SESSION }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const newer = run(["hook", "claude", "session-start"], JSON.stringify({ session_id: SESSION, source: "resume" }));
  expect(await older).toMatchObject({ code: 0, stdout: "", stderr: "" });
  await run(["leave"]);
  expect(await newer).toMatchObject({ code: 0 });

  const stranger = await run(["hook", "claude", "post-tool-use"], JSON.stringify({ session_id: "another-session" }));
  expect(stranger).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(await listJoined(env)).toEqual([]);
});

test("uplink join starts the run closed, --open opens it, and uplink open and close switch it (ADR 0044)", async () => {
  const { t, julio, run } = await session();

  const joined = await run(["join", "--team", "Nuko Nova"]);
  expect(joined.stdout).toMatch(/It is closed: only you and your agents can see it or message it/);
  expect(await liveRuns(t, julio)).toEqual([expect.objectContaining({ open: false })]);

  const opened = await run(["open"]);
  expect(opened).toMatchObject({
    code: 0,
    stdout: expect.stringMatching(
      /^Claude Code \(Julio\) in Nuko Nova: It is open: anyone in the team can see it and message it/,
    ),
  });
  expect(await liveRuns(t, julio)).toEqual([expect.objectContaining({ open: true })]);
  expect(JSON.parse((await run(["close", "--json"])).stdout)).toEqual({
    runId: expect.any(String),
    open: false,
  });
  expect(await liveRuns(t, julio)).toEqual([expect.objectContaining({ open: false })]);

  const again = await run(["join", "--team", "Nuko Nova", "--open", "--json"]);
  expect(JSON.parse(again.stdout)).toMatchObject({ open: true });
  expect(await liveRuns(t, julio)).toEqual([expect.objectContaining({ open: true })]);
});

test("uplink inbox, say and reply act as the joined run; uplink inbox get is still the Inbox function", async () => {
  const { t, julio, run } = await session();
  await run(["join", "--team", "Nuko Nova"]);
  const [live] = await liveRuns(t, julio);
  const asked = await julio.admin.mutation(api.messages.post, { teamId: julio.teamId as never, channelId: julio.generalId as never, body: `<@run:${live!.runId}> status?` });

  const inbox = await run(["inbox"]);
  expect(inbox.code).toBe(0);
  expect(inbox.stdout).toContain(`Message ${asked} in #general, from Julio`);
  expect((await run(["inbox"])).stdout).toBe("No new messages for Claude Code (Julio).\n");

  const replied = await run(["reply", asked, "migrated 40 of 52 tables"]);
  expect(replied).toMatchObject({ code: 0, stdout: expect.stringMatching(/^Replied in a thread in #general as Claude Code \(Julio\)/) });
  const said = await run(["say", "--in", "#general", "done with the migration"]);
  expect(said.stdout).toMatch(/^Posted in #general as Claude Code \(Julio\)/);
  const messages = (await julio.admin.query(api.messages.list, { teamId: julio.teamId as never, channelId: julio.generalId as never })) as any[];
  expect(messages.at(-1)).toMatchObject({ body: "done with the migration", asRun: { runId: live!.runId, label: "Claude Code (Julio)" } });

  const own = await run(["inbox", "get", `teamId=${julio.teamId}`, "--json"]);
  expect(own.code).toBe(0);
  expect(JSON.parse(own.stdout)).toMatchObject({ needsYou: [] });
});

test("uplink say --file sends files with the run's message, read from the session's folder (ADR 0047)", async () => {
  const { julio, project, run } = await session();
  await run(["join", "--team", "Nuko Nova"]);
  await writeFile(join(project, "render.png"), "png bytes");
  await writeFile(join(project, "render.log"), "frame 1 ok");

  const said = await run(["say", "--in", "#general", "--file", "render.png", "--file", "render.log", "the render"]);
  expect(said).toMatchObject({ code: 0, stdout: expect.stringMatching(/^Posted in #general as Claude Code \(Julio\)/) });
  const messages = (await julio.admin.query(api.messages.list, { teamId: julio.teamId as never, channelId: julio.generalId as never })) as any[];
  expect(messages.at(-1)).toMatchObject({
    body: "the render",
    asRun: { label: "Claude Code (Julio)" },
    attachments: [
      { name: "render.png", kind: "image", contentType: "image/png" },
      { name: "render.log", kind: "file" },
    ],
  });
  const missing = await run(["say", "--in", "#general", "--file", "gone.png", "hi"]);
  expect(missing.code).not.toBe(0);
  expect(missing.stderr).toContain("Could not read gone.png");
  expect(((await julio.admin.query(api.messages.list, { teamId: julio.teamId as never, channelId: julio.generalId as never })) as any[]).length).toBe(messages.length);
});

test("a process outside the session can't act as it by naming its session id: not its commands, hooks or channel", async () => {
  const { t, julio, env, run, io } = await session();
  await run(["join", "--team", "Nuko Nova"]);
  const [live] = await liveRuns(t, julio);
  const asked = await julio.admin.mutation(api.messages.post, { teamId: julio.teamId as never, channelId: julio.generalId as never, body: `<@run:${live!.runId}> status?` });

  // Another program of the same person, not started by the session's Claude Code (pid 4242), with
  // CLAUDE_CODE_SESSION_ID set to the session's id.
  const outsider = async (argv: string[], stdin = "") => {
    let stdout = "";
    let stderr = "";
    const code = await main(argv, { ...io(stdin), parents: async () => [5001, 5000, 1], stdout: (s) => void (stdout += s), stderr: (s) => void (stderr += s) });
    return { code, stdout, stderr };
  };
  for (const argv of [["inbox"], ["reply", asked, "forged"], ["say", "--in", "#general", "forged"], ["leave"]]) {
    expect(await outsider(argv)).toMatchObject({ code: 1, stderr: expect.stringMatching(/^not_joined: .*started from it/) });
  }
  expect(await outsider(["hook", "claude", "post-tool-use"], JSON.stringify({ session_id: SESSION, hook_event_name: "PostToolUse" }))).toEqual({ code: 0, stdout: "", stderr: "" });

  // Nor a channel server it starts.
  const server = createRoomMcpServer(new RoomClient({ url: "https://room.test", key: julio.signIn, fetch: io().fetch }), { channel: true });
  const pushed: unknown[] = [];
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "0.0.0" });
  client.fallbackNotificationHandler = async (notification) => void pushed.push(notification);
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const joined = (await listJoined(env))[0]!;
  await saveJoined(env, { ...joined.session, via: "channel" });
  // Were it to watch the run, the watch's first count would start a push at once.
  const stop = startChannel(server, env, { fetch: io().fetch, parents: async () => [5000, 1], watch: (_c, onUpdate) => (onUpdate(1), () => {}) });
  await new Promise((resolve) => setTimeout(resolve, 150));
  stop();
  expect(pushed).toEqual([]);

  // The run itself still has its message, and nothing was posted as it.
  await saveJoined(env, joined.session);
  expect((await run(["inbox"])).stdout).toContain(`Message ${asked} in #general`);
  const messages = (await julio.admin.query(api.messages.list, { teamId: julio.teamId as never, channelId: julio.generalId as never })) as any[];
  expect(messages.some((m) => m.body === "forged")).toBe(false);
  expect(await liveRuns(t, julio)).toHaveLength(1);
});

test("uplink leave ends the run and takes out the hooks, leaving the person's own settings", async () => {
  const { t, julio, project, env, run } = await session();
  await mkdir(join(project, ".claude"), { recursive: true });
  const own = { permissions: { allow: ["Bash(npm test)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } };
  await writeFile(join(project, ".claude", "settings.local.json"), JSON.stringify(own));
  await run(["join", "--team", "Nuko Nova"]);
  expect((await settingsOf(project)).hooks.Stop).toHaveLength(2);

  const left = await run(["leave"]);
  expect(left).toMatchObject({ code: 0, stdout: "Left: Claude Code (Julio) is no longer a live run in Nuko Nova.\n" });
  expect(await liveRuns(t, julio)).toEqual([]);
  expect(await settingsOf(project)).toEqual(own);
  expect(await listJoined(env)).toEqual([]);
  expect(await run(["inbox"])).toMatchObject({ code: 1, stderr: expect.stringMatching(/^not_joined: /) });
});

test("joining again with --no-hooks or --channel takes out the hooks that no longer apply, and keeps another session's", async () => {
  const { project, run, io } = await session();
  const exists = () => stat(join(project, ".claude", "settings.local.json")).then(() => true, () => false);

  await run(["join", "--team", "Nuko Nova"]);
  await run(["join", "--team", "Nuko Nova", "--no-hooks"]);
  expect(await exists()).toBe(false);
  await run(["join", "--team", "Nuko Nova"]);
  await run(["join", "--team", "Nuko Nova", "--channel"]);
  expect(Object.keys((await settingsOf(project)).hooks)).toEqual(["SessionEnd"]);
  await run(["leave"]);
  expect(await exists()).toBe(false);

  // Another session of the project joined with hooks: this one's rejoin and leave leave them be.
  const other = (argv: string[]) => main(argv, { ...io(), env: { ...io().env, CLAUDE_CODE_SESSION_ID: "another-session" }, stdout: () => {} });
  await run(["join", "--team", "Nuko Nova"]);
  await other(["join", "--team", "Nuko Nova"]);
  await run(["join", "--team", "Nuko Nova", "--channel"]);
  await run(["leave"]);
  expect(Object.keys((await settingsOf(project)).hooks)).toContain("PostToolUse");
  await other(["leave"]);
  expect(await exists()).toBe(false);
});

test("joins and leaves at the same moment in one project never lose a session's hooks or leave hooks behind", async () => {
  const { project, io } = await session();
  const exists = () => stat(join(project, ".claude", "settings.local.json")).then(() => true, () => false);
  const as = (id: string) => (argv: string[]) => main(argv, { ...io(), env: { ...io().env, CLAUDE_CODE_SESSION_ID: id }, stdout: () => {} });
  const [a, b] = [as("session-a"), as("session-b")];

  // Two joins at once, one of them with only the SessionEnd hook: neither edit overwrites the other.
  await Promise.all([a(["join", "--team", "Nuko Nova"]), b(["join", "--team", "Nuko Nova", "--channel"])]);
  expect(Object.keys((await settingsOf(project)).hooks)).toContain("PostToolUse");
  // Two leaves at once: the last one out takes the hooks out.
  await Promise.all([a(["leave"]), b(["leave"])]);
  expect(await exists()).toBe(false);

  // A leave while another session joins: the new session keeps its hooks.
  await a(["join", "--team", "Nuko Nova"]);
  await Promise.all([a(["leave"]), b(["join", "--team", "Nuko Nova"])]);
  expect(Object.keys((await settingsOf(project)).hooks)).toContain("PostToolUse");
  await b(["leave"]);
  expect(await exists()).toBe(false);
});

test("join needs the person's own sign-in, and with --setting-sources project the hooks go where the session reads them", async () => {
  // A computer where nobody signed in: an agent key or nothing can't join (a join with no team is uplink pair's, pair.test.ts).
  const signedOut = await session({ env: { UPLINK_HOME: await tempDir("uplink-join-signed-out-") } });
  const refused = await signedOut.run(["join"]);
  expect(refused).toMatchObject({ code: 1, stderr: expect.stringMatching(/^not_signed_in: uplink join acts as you/) });

  const { project, run } = await session({ harnessArgs: "claude --setting-sources project --model claude-haiku-5-5" });
  const joined = await run(["join", "--team", "Nuko Nova"]);
  expect(joined.stdout).toMatch(/doesn't read \.claude\/settings\.local\.json \(--setting-sources project\)/);
  const shared = JSON.parse(await readFile(join(project, ".claude", "settings.json"), "utf8"));
  expect(Object.keys(shared.hooks)).toContain("PostToolUse");
  await run(["leave"]);
  await expect(readFile(join(project, ".claude", "settings.json"), "utf8")).rejects.toThrow(/ENOENT/);
});

/** A git repository with a commit, a subdirectory and a worktree, at their real paths (as git names them). */
async function repository() {
  const top = await realpath(await tempDir("uplink-join-repo-"));
  const main = join(top, "main");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "ignore" });
  await mkdir(join(main, "sub", "deeper"), { recursive: true });
  git(top, "init", "-q", main);
  git(main, "commit", "-q", "--allow-empty", "-m", "start");
  git(main, "worktree", "add", "-q", join(top, "wt"));
  return { main, sub: join(main, "sub"), deeper: join(main, "sub", "deeper"), worktree: join(top, "wt") };
}

test("the hooks go where the session reads them: shared settings in its primary working directory, local ones at the main checkout's root", async () => {
  const repo = await repository();
  const exists = (file: string) => stat(file).then(() => true, () => false);
  const project = "claude --setting-sources project --model claude-haiku-5-5";

  // Started in a subdirectory, with the command run further down: the shared file where it started.
  const sub = await session({ harnessArgs: project, harnessCwd: repo.sub, cwd: repo.deeper });
  expect((await sub.run(["join", "--team", "Nuko Nova"])).stdout).toContain(join(repo.sub, ".claude", "settings.json"));
  expect(await exists(join(repo.main, ".claude", "settings.json"))).toBe(false);
  await sub.run(["leave"]);

  // A worktree session reads the worktree's own shared file.
  const worktree = await session({ harnessArgs: project, harnessCwd: repo.worktree, cwd: repo.worktree });
  expect((await worktree.run(["join", "--team", "Nuko Nova"])).stdout).toContain(join(repo.worktree, ".claude", "settings.json"));
  await worktree.run(["leave"]);

  // Its local file is the main checkout's (code.claude.com/docs/en/settings), except on Windows.
  const local = await session({ harnessCwd: repo.worktree, cwd: repo.worktree });
  const where = process.platform === "win32" ? repo.worktree : repo.main;
  expect((await local.run(["join", "--team", "Nuko Nova"])).stdout).toContain(join(where, ".claude", "settings.local.json"));
});

test("a Codex session hears through Codex's app server: steered during a turn, queued when idle", async () => {
  const codexHome = await tempDir("uplink-codex-home-");
  await mkdir(join(codexHome, "app-server-control"), { recursive: true });
  await writeFile(join(codexHome, "app-server-control", "app-server-control.sock"), "");
  const { t, julio, env, run, io } = await session({ env: { CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "thr-7", CODEX_HOME: codexHome } });
  const joined = await run(["join", "--team", "Nuko Nova"]);
  expect(joined.stdout).toMatch(/turn\/steer on Codex's app server/);
  const [live] = await liveRuns(t, julio);
  expect(live).toMatchObject({ label: "Codex (Julio)", hearing: "mid_task" });

  const delivered: string[] = [];
  let turn: string | undefined = "turn-1";
  const codex = async () => ({
    activeTurn: async () => turn,
    steer: async (thread: string, turnId: string, text: string) => void delivered.push(`steer ${thread} ${turnId}: ${text}`),
    queue: async (thread: string, text: string) => void delivered.push(`queue ${thread}: ${text}`),
    close: () => {},
  });
  let update: (n: number) => void = () => {};
  const watching = new Promise<void>((resolve) => (update = () => resolve()));
  const { key } = (await listJoined(env))[0]!;
  const stop = new AbortController();
  const { keep } = await import("../src/joinedRun.ts");
  const keeper = keep(env, key, { ...io(), codex, watch: (_client, onUpdate) => ((update(0), (update = onUpdate)), () => {}) }, stop.signal);
  await watching;

  const post = (body: string) => julio.admin.mutation(api.messages.post, { teamId: julio.teamId as never, channelId: julio.generalId as never, body });
  await post(`<@run:${live!.runId}> while you work`);
  update(1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  turn = undefined;
  await post(`<@run:${live!.runId}> when you're idle`);
  update(1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  stop.abort();
  await keeper;
  expect(delivered).toEqual([
    expect.stringMatching(/^steer thr-7 turn-1: Uplink Room: 1 new message[\s\S]*> @Codex \(Julio\) while you work/),
    expect.stringMatching(/^queue thr-7: Uplink Room: 1 new message[\s\S]*> @Codex \(Julio\) when you're idle/),
  ]);
});

test("more messages than one take holds, or a Codex app server that isn't up yet, still reach the session with no further update", async () => {
  const codexHome = await tempDir("uplink-codex-home-");
  await mkdir(join(codexHome, "app-server-control"), { recursive: true });
  await writeFile(join(codexHome, "app-server-control", "app-server-control.sock"), "");
  const { t, julio, env, run, io } = await session({ env: { CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "thr-7", CODEX_HOME: codexHome } });
  await run(["join", "--team", "Nuko Nova"]);
  const [live] = await liveRuns(t, julio);
  for (let i = 0; i < 25; i++) {
    await julio.admin.mutation(api.messages.post, { teamId: julio.teamId as never, channelId: julio.generalId as never, body: `<@run:${live!.runId}> note ${i}` });
  }

  const queued: string[] = [];
  let opens = 0;
  const codex = async () => {
    // The first connection finds no app server listening yet.
    if (++opens === 1) throw new Error("connect ECONNREFUSED");
    return { activeTurn: async () => undefined, steer: async () => {}, queue: async (_thread: string, text: string) => void queued.push(text), close: () => {} };
  };
  const { key } = (await listJoined(env))[0]!;
  const stop = new AbortController();
  const { keep } = await import("../src/joinedRun.ts");
  // One update says 25 wait, and none comes after.
  const keeper = keep(env, key, { ...io(), codex, watch: (_client, onUpdate) => (onUpdate(25), () => {}) }, stop.signal);
  for (let i = 0; i < 100 && queued.join("\n").match(/> @Codex \(Julio\) note/g)?.length !== 25; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  stop.abort();
  await keeper;
  expect(queued.join("\n").match(/> @Codex \(Julio\) note/g)).toHaveLength(25);
  expect(queued).toHaveLength(2);
});

test("a channel delivers a burst of messages, and retries when the room couldn't be reached, with no further update", async () => {
  const { t, julio, env, project, run, io } = await session({
    harnessArgs: "claude --dangerously-load-development-channels server:uplink-room --model claude-haiku-5-5",
    running: [4250],
  });
  await writeFile(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { "uplink-room": { command: "uplink-mcp", args: ["--channel"] } } }));
  await announceChannel(env, SESSION, 4250);
  await run(["join", "--team", "Nuko Nova"]);
  const [live] = await liveRuns(t, julio);
  for (let i = 0; i < 25; i++) {
    await julio.admin.mutation(api.messages.post, { teamId: julio.teamId as never, channelId: julio.generalId as never, body: `<@run:${live!.runId}> note ${i}` });
  }

  const server = createRoomMcpServer(new RoomClient({ url: "https://room.test", key: julio.signIn, fetch: io().fetch }), { channel: true });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "0.0.0" });
  const pushed: string[] = [];
  client.fallbackNotificationHandler = async (notification) => void pushed.push(String(notification.params?.content));
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  // The room can't be reached for the first take.
  let takes = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(init?.body ?? "").includes('"joined.take"') && ++takes === 1) throw new TypeError("fetch failed");
    return io().fetch!(input, init);
  };
  // A live watch sends the current count when it starts: 25 wait, and no update comes after.
  const stop = startChannel(server, env, { fetch, sleep: io().sleep, parents: async () => [4242, 1], watch: (_c, onUpdate) => (onUpdate(25), () => {}) });
  for (let i = 0; i < 100 && pushed.join("\n").match(/> @Claude Code \(Julio\) note/g)?.length !== 25; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  stop();
  expect(pushed.join("\n").match(/> @Claude Code \(Julio\) note/g)).toHaveLength(25);
});

test("the keeper ends the run when the harness process exits", async () => {
  const { t, julio, env, run, io } = await session();
  await run(["join", "--team", "Nuko Nova"]);
  const { key } = (await listJoined(env))[0]!;
  let alive = true;
  const { keep } = await import("../src/joinedRun.ts");
  const keeper = keep(env, key, { ...io(), isRunning: () => alive, watch: (_client, onUpdate) => (onUpdate(0), () => {}) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await liveRuns(t, julio)).toHaveLength(1);
  alive = false;
  expect(await keeper).toBe("session_ended");
  expect(await liveRuns(t, julio)).toEqual([]);
  expect(await readJoined(env, key)).toBeUndefined();
});

test("a development channel flag that names only another server leaves the session on hooks", async () => {
  const { t, julio, project, env, run } = await session({
    harnessArgs: "claude --dangerously-load-development-channels server:webhook --model claude-haiku-5-5",
    running: [4250],
  });
  await writeFile(
    join(project, ".mcp.json"),
    JSON.stringify({ mcpServers: { webhook: { command: "bun", args: ["webhook.ts"] }, "uplink-room": { command: "uplink-mcp", args: ["--channel"] } } }),
  );
  await announceChannel(env, SESSION, 4250);
  const joined = await run(["join", "--team", "Nuko Nova"]);
  expect(joined.stdout).toMatch(/after each tool call during a turn, and wake it when it is idle/);
  expect((await liveRuns(t, julio))[0]).toMatchObject({ hearing: "mid_task" });
  expect(Object.keys((await settingsOf(project)).hooks)).toContain("PostToolUse");
});

test("a join that finds no harness process says its run ends after a cap, and the keeper ends it then", async () => {
  const { t, julio, env, io } = await session();
  const unfound = (argv: string[]) => {
    let stdout = "";
    return main(argv, { ...io(), harnessProcess: async () => undefined, stdout: (s) => void (stdout += s) }).then((code) => ({ code, stdout }));
  };
  const joined = await unfound(["join", "--team", "Nuko Nova"]);
  expect(joined.stdout).toMatch(/found no process for this session, so its run ends 12 hours after it joined/);
  const { key, session: saved } = (await listJoined(env))[0]!;
  expect(saved.harnessPid).toBeUndefined();

  let clock = saved.joinedAt;
  const { keep } = await import("../src/joinedRun.ts");
  const keeper = keep(env, key, { ...io(), now: () => clock, watch: (_client, onUpdate) => (onUpdate(0), () => {}) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await liveRuns(t, julio)).toHaveLength(1);
  clock += 12 * 60 * 60 * 1000;
  expect(await keeper).toBe("unwatched");
  expect(await liveRuns(t, julio)).toEqual([]);
  expect(await readJoined(env, key)).toBeUndefined();
});

test("with uplink-mcp --channel in a session started with the development channels flag, the session hears through the channel", async () => {
  const { t, julio, project, env, run, io } = await session({
    harnessArgs: "claude --dangerously-load-development-channels server:uplink-room --model claude-haiku-5-5",
    running: [4250],
  });
  // The project's MCP config names the uplink-mcp --channel server uplink-room; this Claude Code
  // session started it, and it says it runs for the session.
  await writeFile(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { "uplink-room": { command: "uplink-mcp", args: ["--channel"] } } }));
  await announceChannel(env, SESSION, 4250);
  const joined = await run(["join", "--team", "Nuko Nova"]);
  expect(joined.stdout).toMatch(/through the uplink-room channel \(uplink-mcp\), between turns/);
  const [live] = await liveRuns(t, julio);
  expect(live).toMatchObject({ hearing: "between_turns" });
  // Only the hook that ends the run when the session ends.
  expect(Object.keys((await settingsOf(project)).hooks)).toEqual(["SessionEnd"]);

  const server = createRoomMcpServer(new RoomClient({ url: "https://room.test", key: julio.signIn, fetch: io().fetch }), { channel: true });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "0.0.0" });
  const pushed: { method: string; params?: Record<string, unknown> }[] = [];
  client.fallbackNotificationHandler = async (notification) => void pushed.push(notification);
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  expect(client.getServerCapabilities()?.experimental).toEqual({ "claude/channel": {} });

  const messageId = await julio.admin.mutation(api.messages.post, { teamId: julio.teamId as never, channelId: julio.generalId as never, body: `<@run:${live!.runId}> ping` });
  // Claude Code (4242) started this server. A live watch sends the current count when it starts.
  const stop = startChannel(server, env, { fetch: io().fetch, parents: async () => [4242, 1], watch: (_client, onUpdate) => (onUpdate(1), () => {}) });
  for (let i = 0; i < 100 && !pushed.length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  stop();
  expect(pushed).toMatchObject([
    {
      method: "notifications/claude/channel",
      params: { content: expect.stringContaining(`Message ${messageId} in #general, from Julio`), meta: { message_ids: messageId, run: "Claude Code (Julio)" } },
    },
  ]);
});

test("a channel closes its connection to the room when the session joins again and when it stops", async () => {
  const { julio, env, project, run, io } = await session({
    harnessArgs: "claude --dangerously-load-development-channels server:uplink-room --model claude-haiku-5-5",
    running: [4250],
  });
  await writeFile(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { "uplink-room": { command: "uplink-mcp", args: ["--channel"] } } }));
  await announceChannel(env, SESSION, 4250);
  await run(["join", "--team", "Nuko Nova"]);
  const server = createRoomMcpServer(new RoomClient({ url: "https://room.test", key: julio.signIn, fetch: io().fetch }), { channel: true });
  const watched: RoomClient[] = [];
  const closed: RoomClient[] = [];
  const watch = (client: RoomClient) => {
    watched.push(client);
    client.close = async () => void closed.push(client);
    return () => {};
  };
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  };
  const stop = startChannel(server, env, { fetch: io().fetch, parents: async () => [4242, 1], watch });
  await until(() => watched.length === 1);

  // The session joins again: a new run token, which the channel watches with a new connection.
  const { session: joined } = (await listJoined(env))[0]!;
  await saveJoined(env, { ...joined, token: `${joined.token}-again` });
  await until(() => watched.length === 2);
  expect(closed).toEqual([watched[0]]);

  stop();
  await until(() => closed.length === 2);
  expect(closed).toEqual(watched);
});

test("a session that joined without hooks takes nothing through the project's hooks that another session left there", async () => {
  const { t, julio, env, run } = await session();
  await run(["join", "--team", "Nuko Nova", "--no-hooks"]);
  const [live] = await liveRuns(t, julio);
  await julio.admin.mutation(api.messages.post, { teamId: julio.teamId as never, channelId: julio.generalId as never, body: `<@run:${live!.runId}> status?` });
  const { key } = (await listJoined(env))[0]!;
  await writeWaiting(env, key, 1);
  const hook = await run(["hook", "claude", "post-tool-use"], JSON.stringify({ session_id: SESSION, hook_event_name: "PostToolUse" }));
  expect(hook).toMatchObject({ code: 0, stdout: "" });
  const inbox = await julio.admin.query(api.runs.inbox, { teamId: julio.teamId as never, runId: live!.runId });
  expect(inbox.messages!.map((m) => m.status)).toEqual(["waiting"]);
});

test("the keeper's count on disk is always the newest, however fast the updates come", async () => {
  const { env, run, io } = await session();
  await run(["join", "--team", "Nuko Nova"]);
  const { key } = (await listJoined(env))[0]!;
  const { keep } = await import("../src/joinedRun.ts");
  const stop = new AbortController();
  // 200 updates in one go, alternating, the last saying one message waits.
  const keeper = keep(env, key, { ...io(), watch: (_client, onUpdate) => { for (let i = 0; i < 200; i++) onUpdate(i % 2 === 0 ? 0 : 1); return () => {}; } }, stop.signal);
  await expect.poll(() => readWaiting(env, key)).toBe(1);
  stop.abort();
  await keeper;
});
