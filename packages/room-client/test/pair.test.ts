/**
 * `uplink pair` (ADR 0027, ADR 0034): two people's Claude Code sessions, with no team in common,
 * pair with a code. Each session joins the room by itself if it hasn't (in no team: it can only pair,
 * D13), hears the other's messages through the hooks `uplink join` adds, and answers with
 * `uplink reply` and `uplink say --in pair`. The room is the real backend in convex-test; the
 * harness processes and the keepers are stood in.
 */
import { api } from "@uplink-room/backend/api";
import { readFile, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { main, type CliIo } from "../src/cli.ts";
import { listJoined } from "../src/joined.ts";
import { savedName } from "../src/joinCommands.ts";
import { browserFor, fetchToRoomAndClerk, personInTwoTeams, SITE_URL, tempDir, newBackend, type Backend } from "./support.ts";
import type { FakeClerk } from "../../backend/tests/fakeClerk";

const PROGRAM = ["/usr/local/bin/node", "/opt/uplink/src/cli.ts"];

/** One person's Claude Code session, its harness process `pid`, in its own project folder. */
async function claudeSession(t: Backend, clerk: FakeClerk, home: string, sessionId: string, pid: number) {
  const project = await tempDir("uplink-pair-project-");
  const claudeConfig = await tempDir("uplink-pair-claude-config-");
  const env = { UPLINK_HOME: home, CLAUDE_CODE_SESSION_ID: sessionId, CLAUDE_CONFIG_DIR: claudeConfig };
  const keepers: string[] = [];
  const io = (stdin = ""): CliIo => ({
    fetch: fetchToRoomAndClerk(t, clerk),
    env,
    stdin: async () => stdin,
    harnessProcess: async () => ({ pid, args: "claude --model claude-haiku-5-5" }),
    parents: async () => [pid + 1, pid],
    startKeeper: (key) => void keepers.push(key),
    isRunning: (p) => p === pid,
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
  const hook = (event: string, name: string) => run(["hook", "claude", event, "--home", home], JSON.stringify({ session_id: sessionId, hook_event_name: name }));
  return { env, project, keepers, run, hook };
}

/** Julio (in two teams) and Pepe (in none), each signed in on their own computer's command line. */
async function twoPeople() {
  const t = newBackend();
  const julio = await personInTwoTeams(t);
  const pepeHome = await tempDir("uplink-pair-pepe-");
  await main(["login", "--url", SITE_URL], {
    fetch: fetchToRoomAndClerk(t, julio.clerk),
    stdout: () => {},
    stderr: () => {},
    env: { UPLINK_HOME: pepeHome },
    openBrowser: browserFor(julio.clerk, { subject: "user_pepe", name: "Pepe", email: "pepe@example.com" }).open,
  });
  const julioSession = await claudeSession(t, julio.clerk, julio.home, "11111111-2f4d-4c55-9d0e-4b2c0a1f9e11", 4242);
  const pepeSession = await claudeSession(t, julio.clerk, pepeHome, "22222222-2f4d-4c55-9d0e-4b2c0a1f9e22", 5252);
  return { t, julio, pepeHome, julioSession, pepeSession };
}

const contextOf = (stdout: string) => JSON.parse(stdout).hookSpecificOutput.additionalContext as string;

test("uplink pair makes a code, another person's session joins with uplink pair <code>, and each hears the other mid-turn", async () => {
  const { julio, julioSession, pepeSession } = await twoPeople();

  // Julio's session hasn't joined: uplink pair joins it, in no team, and makes the code.
  const made = await julioSession.run(["pair"]);
  expect(made).toMatchObject({ code: 0, stderr: "" });
  const code = /Pair code ([A-Z]+-\d{4}-[A-Z]+-\d{4})/.exec(made.stdout)?.[1];
  expect(code).toBeDefined();
  expect(made.stdout).toMatch(/works once, for 10 minutes/);
  expect(made.stdout).toMatch(new RegExp(`uplink pair ${code}`));
  const [julioJoin] = await listJoined(julioSession.env);
  expect(julioJoin!.session).toMatchObject({ label: "Claude Code (Julio)", via: "hooks" });
  expect(julioJoin!.session.teamId).toBeUndefined();
  expect(julioSession.keepers).toHaveLength(1);

  // Pepe's session joins with the code, typed in lower case.
  const joined = await pepeSession.run(["pair", code!.toLowerCase()]);
  expect(joined).toMatchObject({ code: 0, stderr: "" });
  expect(joined.stdout).toMatch(/^This session is in a Pair with Julio now, as Claude Code \(Pepe\)/);
  expect(joined.stdout).toMatch(/uplink say --in pair "text"/);
  const settings = JSON.parse(await readFile(join(pepeSession.project, ".claude", "settings.local.json"), "utf8"));
  expect(Object.keys(settings.hooks)).toContain("PostToolUse");

  // Julio's run says something; Pepe's next tool call brings it into his turn.
  const said = await julioSession.run(["say", "--in", "pair", "which schema are you on?"]);
  expect(said).toMatchObject({ code: 0 });
  expect(said.stdout).toMatch(/^Posted in a Pair with Pepe as Claude Code \(Julio\)/);
  const messageId = /message ([^)]+)\)/.exec(said.stdout)![1]!;
  const heard = contextOf((await pepeSession.hook("post-tool-use", "PostToolUse")).stdout);
  expect(heard).toContain(`Message ${messageId} in a Pair with Julio, from Claude Code (Julio), a run Julio drives. Julio is accountable for it and is not this run's driver.`);
  expect(heard).toContain("> which schema are you on?");
  expect(heard).toContain("uplink reply <message id>");
  expect(heard).toContain('uplink say --in pair "text"');
  // A Pair message comes from outside the run's team, and its label doesn't say otherwise.
  expect(heard).not.toMatch(/team/);

  // Pepe's run answers; Julio hears it.
  expect(await pepeSession.run(["reply", messageId, "v2"])).toMatchObject({ code: 0 });
  expect(contextOf((await julioSession.hook("post-tool-use", "PostToolUse")).stdout)).toContain("from Claude Code (Pepe), a run Pepe drives");

  // Julio reads it in the app too.
  const [pair] = await julio.admin.query(api.pairs.list, {});
  expect(pair!.runs.map((r) => r.label).sort()).toEqual(["Claude Code (Julio)", "Claude Code (Pepe)"]);
});

test("a run sends files in its Pair with --file, and the other run saves them with uplink download (ADR 0048)", async () => {
  const { julioSession, pepeSession } = await twoPeople();
  const code = /Pair code ([A-Z]+-\d{4}-[A-Z]+-\d{4})/.exec((await julioSession.run(["pair"])).stdout)![1]!;
  await pepeSession.run(["pair", code]);
  await writeFile(join(julioSession.project, "crash.png"), "png bytes");
  await writeFile(join(julioSession.project, "crash.png.log"), "LoadMap, CleanupWorld");

  // Julio's run is in no team: its files go to the Pair all the same.
  const said = await julioSession.run(["say", "--in", "pair", "--file", "crash.png", "--file", "crash.png.log", "the crash"]);
  expect(said).toMatchObject({ code: 0, stderr: "" });
  const messageId = /message ([^)]+)\)/.exec(said.stdout)![1]!;
  const heard = contextOf((await pepeSession.hook("post-tool-use", "PostToolUse")).stdout);
  expect(heard).toContain(`It has 2 attached files. Save them with: uplink download ${messageId}`);

  const into = await tempDir("uplink-pair-download-");
  const saved = await pepeSession.run(["download", messageId, "--dir", into]);
  expect(saved).toMatchObject({ code: 0, stderr: "" });
  expect(saved.stdout).toBe(`Saved 2 files of message ${messageId}:\n${join(into, "crash.png")}\n${join(into, "crash.png.log")}\n`);
  expect(await readFile(join(into, "crash.png"), "utf8")).toBe("png bytes");
  expect(await readFile(join(into, "crash.png.log"), "utf8")).toBe("LoadMap, CleanupWorld");

  // Again into the same folder: what is there stays, a symlink isn't written through, and the new
  // copies take new names.
  const outside = join(await tempDir("uplink-pair-outside-"), "target");
  await writeFile(outside, "untouched");
  await writeFile(join(into, "crash.png"), "mine");
  await symlink(outside, join(into, "crash (2).png"));
  const again = await pepeSession.run(["download", messageId, "--dir", into]);
  expect(again.stdout).toContain(join(into, "crash (3).png"));
  expect(await readFile(join(into, "crash.png"), "utf8")).toBe("mine");
  expect(await readFile(outside, "utf8")).toBe("untouched");
  expect(await readFile(join(into, "crash (3).png"), "utf8")).toBe("png bytes");

  // With no --dir, a new folder only this user can open.
  const fresh = await pepeSession.run(["download", messageId]);
  // The first saved path's folder, in this platform's own path form.
  const folder = dirname(fresh.stdout.split("\n")[1]!);
  if (process.platform !== "win32") {
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect((await stat(join(folder, "crash.png"))).mode & 0o777).toBe(0o600);
  }

  // Only a Pair message of this run's.
  expect((await pepeSession.run(["download", "not-a-message"])).code).not.toBe(0);
});

test("uplink pair --resume puts a new session back in its person's Pair, and uplink pair --end ends it", async () => {
  const { t, julio, julioSession, pepeSession } = await twoPeople();
  const code = /Pair code ([A-Z]+-\d{4}-[A-Z]+-\d{4})/.exec((await julioSession.run(["pair"])).stdout)![1]!;
  await pepeSession.run(["pair", code]);

  // Pepe's session ends; a new one of his rejoins the same Pair.
  expect(await pepeSession.run(["leave"])).toMatchObject({ code: 0 });
  const next = await claudeSession(t, julio.clerk, pepeSession.env.UPLINK_HOME, "33333333-2f4d-4c55-9d0e-4b2c0a1f9e33", 6262);
  const resumed = await next.run(["pair", "--resume"]);
  expect(resumed).toMatchObject({ code: 0, stderr: "" });
  expect(resumed.stdout).toMatch(/^This session is in a Pair with Julio now, as Claude Code \(Pepe\)/);
  await julioSession.run(["say", "--in", "pair", "welcome back"]);
  expect(contextOf((await next.hook("post-tool-use", "PostToolUse")).stdout)).toContain("> welcome back");

  // Either person ends it, with their own sign-in.
  const ended = await next.run(["pair", "--end"]);
  expect(ended).toMatchObject({ code: 0 });
  expect(ended.stdout).toMatch(/Ended the Pair with Julio/);
  expect((await julio.admin.query(api.pairs.list, {}))[0]).toMatchObject({ endReason: "ended" });
  const after = await julioSession.run(["say", "--in", "pair", "anyone?"]);
  expect(after.code).toBe(1);
});

test("uplink join without --team joins in no team, and says it can only pair", async () => {
  const { julioSession } = await twoPeople();
  const joined = await julioSession.run(["join"]);
  expect(joined).toMatchObject({ code: 0, stderr: "" });
  expect(joined.stdout).toMatch(/^This session joined Uplink Room as Claude Code \(Julio\), in no team: it can only pair\./);
  expect(joined.stdout).toMatch(/uplink pair/);
  const said = await julioSession.run(["say", "--in", "#general", "hello"]);
  expect(said.code).toBe(1);
  expect(said.stderr).toMatch(/only pair/);
});

test("uplink download saves under names any system takes", () => {
  expect(savedName("why?.txt")).toBe("why_.txt");
  expect(savedName('a<b>:c"d|e*.log')).toBe("a_b__c_d_e_.log");
  expect(savedName("CON.txt")).toBe("_CON.txt");
  expect(savedName("notes. ")).toBe("notes");
  expect(savedName("../../etc/passwd")).toBe("passwd");
  expect(savedName("..")).toBe("file");
});
