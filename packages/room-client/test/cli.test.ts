import { api } from "@uplink-room/backend/api";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { CLIENT_ID, type FakeClerk } from "../../backend/tests/fakeClerk";
import { RoomClient } from "../src/client.ts";
import { main, type CliIo } from "../src/cli.ts";
import {
  bridgeSays,
  browserFor,
  fetchTo,
  fetchToRoomAndClerk,
  linkMachine,
  listed as asList,
  newBackend,
  newTeamWithAgent,
  personInTwoTeams,
  SITE_URL,
  tempDir,
  useFakeClerk,
  type Backend,
} from "./support.ts";

async function run(t: ReturnType<typeof newBackend>, argv: string[], env: Record<string, string>, stdin = "") {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    fetch: fetchTo(t),
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
    env,
    stdin: async () => stdin,
  });
  return { code, stdout, stderr };
}

test("a generated subcommand reaches the same function as the app", async () => {
  const t = newBackend();
  const { admin, teamId, key, generalId } = await newTeamWithAgent(t);
  const env = { UPLINK_URL: SITE_URL, UPLINK_AGENT_KEY: key };

  const listed = await run(t, ["functions"], env);
  expect(listed.code).toBe(0);
  expect(listed.stdout).toMatch(/^messages\.post +mutation +messages\.post +/m);

  const posted = await run(
    t,
    ["messages", "post", "--channel-id", generalId, "--body", "Deployed 0.4.2", "--json"],
    env,
  );
  expect(posted).toMatchObject({ code: 0, stderr: "" });

  const messages = asList(await admin.query(api.messages.list, { teamId, channelId: generalId }));
  expect(messages).toMatchObject([
    { body: "Deployed 0.4.2", author: { name: "Deploy bot", kind: "agent" } },
  ]);
  expect(JSON.parse(posted.stdout)).toBe(messages[0]!.messageId);

  const viaCall = await run(t, ["call", "messages.list", `channelId=${generalId}`, "--json"], env);
  expect(JSON.parse(viaCall.stdout)).toEqual(JSON.parse(JSON.stringify(messages)));
});

test("login saves the config with mode 0600 and the environment overrides it", async () => {
  const t = newBackend();
  const { key } = await newTeamWithAgent(t);
  const home = await tempDir("uplink-cli-");

  const login = await run(t, ["login", "--url", `${SITE_URL}/`, "--key", key], {
    UPLINK_HOME: home,
  });
  expect(login.code).toBe(0);
  const file = join(home, "cli.json");
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ url: SITE_URL, key });
  // Windows has no Unix file modes; the file sits in the person's own profile there.
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

  expect((await run(t, ["call", "channels.list"], { UPLINK_HOME: home })).code).toBe(0);

  const overridden = await run(t, ["call", "channels.list"], {
    UPLINK_HOME: home,
    UPLINK_AGENT_KEY: "bad",
  });
  expect(overridden.code).not.toBe(0);
  expect(overridden.stderr).toMatch(/^unauthenticated: /);
});

test("an API error exits non-zero with the code and message on stderr", async () => {
  const t = newBackend();
  const { key, generalId } = await newTeamWithAgent(t, ["room.read"]);
  const env = { UPLINK_URL: SITE_URL, UPLINK_AGENT_KEY: key };

  const denied = await run(t, ["messages", "post", "--channel-id", generalId, "--body", "hi"], env);
  expect(denied.code).toBe(1);
  expect(denied.stdout).toBe("");
  expect(denied.stderr).toMatch(/^forbidden: .+/);

  const unconfigured = await run(t, ["functions"], {
    UPLINK_HOME: await tempDir("uplink-cli-"),
  });
  expect(unconfigured.code).toBe(1);
  expect(unconfigured.stderr).toMatch(/^not_configured: /);
});

test("upload sends a file for an attachment, and messages post keeps it", async () => {
  const t = newBackend();
  const { admin, teamId, key, generalId } = await newTeamWithAgent(t);
  const env = { UPLINK_URL: SITE_URL, UPLINK_AGENT_KEY: key };
  const dir = await tempDir("uplink-upload-");
  const file = join(dir, "build.log");
  await writeFile(file, "all green");

  const uploaded = await run(t, ["upload", file, "--json"], env);
  expect(uploaded).toMatchObject({ code: 0, stderr: "" });
  const attachment = JSON.parse(uploaded.stdout) as { uploadId: string; storageId: string; name: string };
  expect(attachment.name).toBe("build.log");

  const posted = await run(
    t,
    ["messages", "post", "--channel-id", generalId, "--body", "Nightly build", "--attachments", JSON.stringify([attachment]), "--json"],
    env,
  );
  expect(posted).toMatchObject({ code: 0, stderr: "" });
  const message = await admin.query(api.messages.get, { teamId, messageId: JSON.parse(posted.stdout) });
  expect(message?.attachments).toMatchObject([{ name: "build.log", kind: "file", contentType: "text/plain", size: 9 }]);

  const missing = await run(t, ["upload", join(dir, "nope.png")], env);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toMatch(/^usage: Could not read/);
});

test("an agent makes a private channel from the command line; only its members, not the team's admin, see it", async () => {
  const t = newBackend();
  const { admin, teamId, key } = await newTeamWithAgent(t, ["room.read", "messages.post", "work.manage"]);
  const env = { UPLINK_URL: SITE_URL, UPLINK_AGENT_KEY: key };

  const made = await run(t, ["channels", "createPrivate", "--name", "release-notes", "--json"], env);
  expect(made).toMatchObject({ code: 0, stderr: "" });
  const channelId = JSON.parse(made.stdout);
  const members = await run(t, ["channels", "members", "--channel-id", channelId, "--json"], env);
  expect(JSON.parse(members.stdout)).toMatchObject({ kind: "private", members: [{ name: "Deploy bot" }], canRemove: true });
  // Julio is the team's admin, and not in it.
  expect((await admin.query(api.channels.list, { teamId })).some((c) => c.channelId === channelId)).toBe(false);

  expect(await run(t, ["channels", "leave", "--channel-id", channelId], env)).toMatchObject({ code: 0 });
  const after = await run(t, ["channels", "members", "--channel-id", channelId], env);
  expect(after.code).not.toBe(0);
  expect(after.stderr).toMatch(/not_found/);
});

test("a subcommand takes key=value pairs, and a module's help lists each function in one line", async () => {
  const t = newBackend();
  const { key, generalId } = await newTeamWithAgent(t);
  const env = { UPLINK_URL: SITE_URL, UPLINK_AGENT_KEY: key };

  const flags = await run(t, ["messages", "list", "--channel-id", generalId, "--json"], env);
  const pairs = await run(t, ["messages", "list", `channelId=${generalId}`, "limit=5", "--json"], env);
  expect(pairs).toMatchObject({ code: 0, stderr: "" });
  expect(pairs.stdout).toBe(flags.stdout);

  const bad = await run(t, ["messages", "list", generalId], env);
  expect(bad.code).toBe(1);
  expect(bad.stderr).toMatch(/^usage: Expected key=value or a --flag/);

  const help = await run(t, ["messages", "--help"], env);
  const listed = help.stdout.replace(/\s+/g, " ");
  expect(listed).toContain("list channelId=ID [+2 more] Page through a channel's messages, newest first, without replies (see messages.replies).");
  expect(listed).not.toContain("Returns { page, continueCursor, isDone }");
  expect((await run(t, ["inbox", "--help"], env)).stdout).toMatch(/get \[view=mine\|person\|team\]/);
  expect((await run(t, ["--help"], env)).stdout).toMatch(/tasks +Room API: board, create, createMany, get, keepRun, linkPullRequest, queue, unlinkPullRequest, unqueue, update/);

  // An unknown function shows its module's commands, and the guide is one command away.
  const unknown = await run(t, ["tasks", "list"], env);
  expect(unknown.stderr).toContain("unknown command 'list'");
  expect(unknown.stderr).toMatch(/board \[\+2 more\]/);
  expect((await run(t, ["guide"], env)).stdout).toMatch(/^Start here\. You are a member of the team\./);

  const runHelp = await run(t, ["runs", "start", "--help"], env);
  expect(runHelp.stdout.replace(/\s+/g, " ")).toContain("One of: claude-code, codex, grok-build, opencode, cursor, hermes-agent, shell.");
});

test("--stdin reads an argument from standard input, so a Markdown body never passes through the shell", async () => {
  const t = newBackend();
  const { admin, teamId, key, generalId } = await newTeamWithAgent(t);
  const env = { UPLINK_URL: SITE_URL, UPLINK_AGENT_KEY: key };
  const body = "Tests: `1 passed`, $HOME stays literal\n- ✖ `formatInvoiceDate`";
  const posted = await run(t, ["messages", "post", `channelId=${generalId}`, "--stdin", "body", "--json"], env, `${body}\n`);
  expect(posted).toMatchObject({ code: 0, stderr: "" });
  const message = await admin.query(api.messages.get, { teamId, messageId: JSON.parse(posted.stdout) });
  expect(message?.body).toBe(body);

  const wrong = await run(t, ["messages", "post", `channelId=${generalId}`, "--stdin", "text"], env, "hi");
  expect(wrong.stderr).toMatch(/^usage: --stdin names an argument messages\.post takes, such as channelId, body/);
});

test("run-in-terminal passes the command's own flags through to the terminal", async () => {
  const t = newBackend();
  const { admin, teamId, key } = await newTeamWithAgent(t, ["room.read", "runs.start", "terminals.drive"]);
  const env = { UPLINK_URL: SITE_URL, UPLINK_AGENT_KEY: key };
  const { token, machineId } = await linkMachine(t, admin, teamId);
  const started = await run(t, ["runs", "start", `machineId=${machineId}`, "harness=shell", "--json"], env);
  const { terminalId } = JSON.parse(started.stdout) as { terminalId: string };
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: "pty-1", title: "Terminal", tool: "shell", access: "watch" });

  const ran = await run(t, ["run-in-terminal", terminalId, "node", "--version", "--wait-ms", "1000"], env);
  expect(ran.code).toBe(0);
  const { messages } = await t.query(api.bridge.inbox, { token, afterSeq: 0 });
  expect(messages.map((m) => m.message).find((m) => m.type === "input")).toMatchObject({ data: "'node' '--version'\n" });
  expect(ran.stdout).toContain("the command may still be running");
});

test("help marks the functions this key lacks the scope for", async () => {
  const t = newBackend();
  const { key } = await newTeamWithAgent(t, ["room.read"]);
  const help = await run(t, ["messages", "--help"], { UPLINK_URL: SITE_URL, UPLINK_AGENT_KEY: key });
  const text = help.stdout.replace(/\s+/g, " ");
  expect(text).toContain("[your key lacks messages.post] Post a message in a channel or direct message.");
  expect(text).not.toContain("[your key lacks room.read]");
});

test("run-in-terminal keeps each argument whole for a POSIX shell, and sends one argument as typed", async () => {
  const { commandLine } = await import("../src/cli.ts");
  const words = ["node", "-e", "console.log('hello world')"];
  const line = commandLine(words);
  expect(line).toBe(`'node' '-e' 'console.log('\\''hello world'\\'')'`);
  expect(commandLine(["ls *.js | wc -l"])).toBe("ls *.js | wc -l");
  expect(commandLine(["exit", "0"])).toBe("'exit' '0'");
  // Every word is quoted, so no shell expands one: zsh's =word, ~, a glob.
  expect(commandLine(["printf", "%s", "=ls"])).toBe("'printf' '%s' '=ls'");
  if (process.platform !== "win32") {
    // A real POSIX shell splits it back into the same three arguments.
    const { spawnSync } = await import("node:child_process");
    const echoed = spawnSync("/bin/sh", ["-c", `printf '%s\\n' ${commandLine(["-e", "console.log('hello world')", "a b", "$HOME", "*"])}`], { encoding: "utf8" });
    expect(echoed.stdout).toBe("-e\nconsole.log('hello world')\na b\n$HOME\n*\n");
    const { existsSync } = await import("node:fs");
    if (existsSync("/bin/zsh")) {
      const zsh = spawnSync("/bin/zsh", ["-c", commandLine(["printf", "%s|", "=ls", "~", "*.none"])], { encoding: "utf8" });
      expect(zsh.stdout).toBe("=ls|~|*.none|");
    }
  }

  const t = newBackend();
  const { admin, teamId, key } = await newTeamWithAgent(t, ["room.read", "runs.start", "terminals.drive"]);
  const env = { UPLINK_URL: SITE_URL, UPLINK_AGENT_KEY: key };
  const { token, machineId } = await linkMachine(t, admin, teamId);
  const started = await run(t, ["runs", "start", `machineId=${machineId}`, "harness=shell", "--json"], env);
  const { terminalId } = JSON.parse(started.stdout) as { terminalId: string };
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: "pty-1", title: "Terminal", tool: "shell", access: "watch" });
  await run(t, ["run-in-terminal", terminalId, ...words, "--wait-ms", "1000"], env);
  const { messages } = await t.query(api.bridge.inbox, { token, afterSeq: 0 });
  expect(messages.map((m) => m.message).find((m) => m.type === "input")).toMatchObject({ data: `${line}\n` });
});

const PEPE = { subject: "user_pepe", name: "Pepe", email: "pepe@example.com" };

async function signInRun(t: Backend, clerk: FakeClerk, argv: string[], env: Record<string, string>, io: Partial<CliIo> = {}) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    fetch: fetchToRoomAndClerk(t, clerk),
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
    env,
    ...io,
  });
  return { code, stdout, stderr };
}

test("login signs a person in through the browser and saves only the room's token, with mode 0600", async () => {
  const t = newBackend();
  const clerk = await useFakeClerk();
  const home = await tempDir("uplink-cli-");
  const browser = browserFor(clerk, PEPE);

  const login = await signInRun(t, clerk, ["login", "--url", SITE_URL, "--name", "Pepe's laptop"], { UPLINK_HOME: home }, { openBrowser: browser.open });
  expect(login).toMatchObject({ code: 0 });
  expect(login.stdout).toMatch(/Signed in as Pepe \(pepe@example\.com\)/);
  // The authorize request: PKCE S256, a loopback redirect, and no refresh token asked for.
  const authorize = new URL(browser.opened[0]!);
  expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
    client_id: CLIENT_ID,
    response_type: "code",
    code_challenge_method: "S256",
    scope: "openid profile email",
    redirect_uri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/),
    state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
  });

  const file = join(home, "cli.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  expect(saved).toEqual({ url: SITE_URL, signIn: expect.stringMatching(/^urs_[0-9a-f]{48}$/) });
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  // No secret reaches the terminal: not the room's token, nor Clerk's.
  expect(`${login.stdout}${login.stderr}`).not.toMatch(/urs_|eyJ|oat_|ort_/);
  // Clerk's tokens aren't kept: the command line revokes both once the room has the sign-in.
  expect(clerk.revoked.sort()).toEqual(["access_token:oat_", "refresh_token:ort_"]);

  const whoami = await signInRun(t, clerk, ["whoami"], { UPLINK_HOME: home });
  expect(whoami).toMatchObject({ code: 0, stderr: "" });
  expect(whoami.stdout).toMatch(/^Pepe \(pepe@example\.com\), signed in on this computer as "Pepe's laptop" until \d{4}-\d{2}-\d{2}\.\nNo team yet\./);
  const me = await signInRun(t, clerk, ["people", "me", "--json"], { UPLINK_HOME: home });
  expect(JSON.parse(me.stdout)).toMatchObject({ name: "Pepe", teams: [] });
  const help = await signInRun(t, clerk, ["people", "signIns", "--help"], { UPLINK_HOME: home });
  expect(help.stdout.replace(/\s+/g, " ")).toContain("(account: for a person signed in with uplink login, in no team)");
});

test("login --device shows a code to enter on another device, and signs in once it's approved", async () => {
  const t = newBackend();
  const clerk = await useFakeClerk();
  const home = await tempDir("uplink-cli-");
  let shown = "";
  const login = await signInRun(t, clerk, ["login", "--url", SITE_URL, "--device"], { UPLINK_HOME: home }, {
    openBrowser: () => {
      throw new Error("--device never opens a browser here");
    },
    // The person reads the code on this terminal and approves it on their phone.
    stderr: (text) => {
      shown += text;
      const code = /enter the code (\S+)/.exec(text)?.[1];
      if (code) clerk.approveDevice(code, PEPE);
    },
  });
  expect(login).toMatchObject({ code: 0 });
  expect(shown).toContain(`open ${clerk.issuer}/device in a browser on any device and enter the code WDJB-`);
  expect(clerk.requests.find((r) => r.path === "/oauth/device_authorization")?.form).toMatchObject({ client_id: CLIENT_ID, scope: "openid profile email", nonce: expect.any(String) });
  expect(JSON.parse(await readFile(join(home, "cli.json"), "utf8"))).toEqual({ url: SITE_URL, signIn: expect.stringMatching(/^urs_/) });
});

test("a sign-in denied in the browser saves nothing", async () => {
  const t = newBackend();
  const clerk = await useFakeClerk();
  const home = await tempDir("uplink-cli-");
  const denied = await signInRun(t, clerk, ["login", "--url", SITE_URL], { UPLINK_HOME: home }, { openBrowser: browserFor(clerk, PEPE, "deny").open });
  expect(denied.code).toBe(1);
  expect(denied.stderr).toMatch(/^access_denied: Sign-in was canceled in the browser\./m);
  await expect(stat(join(home, "cli.json"))).rejects.toThrow(/ENOENT/);
});

test("logout revokes this computer's sign-in, and a second login revokes the one it replaces", async () => {
  const t = newBackend();
  const clerk = await useFakeClerk();
  const home = await tempDir("uplink-cli-");
  const env = { UPLINK_HOME: home };
  const open = browserFor(clerk, PEPE).open;
  const saved = async () => JSON.parse(await readFile(join(home, "cli.json"), "utf8")) as { url: string; signIn?: string };
  const works = async (token: string) =>
    new RoomClient({ url: SITE_URL, key: token, fetch: fetchTo(t) }).call("people.me").then(() => true, () => false);

  expect(await signInRun(t, clerk, ["login", "--url", SITE_URL, "--name", "first"], env, { openBrowser: open })).toMatchObject({ code: 0 });
  const first = (await saved()).signIn!;
  // The URL is remembered, so a second login needn't repeat it.
  expect(await signInRun(t, clerk, ["login", "--name", "second"], env, { openBrowser: open })).toMatchObject({ code: 0 });
  const second = (await saved()).signIn!;
  expect(await works(first)).toBe(false);
  expect(await works(second)).toBe(true);

  const out = await signInRun(t, clerk, ["logout"], env);
  expect(out).toMatchObject({ code: 0, stdout: "Signed out: this computer's sign-in is revoked.\n" });
  expect(await saved()).toEqual({ url: SITE_URL });
  expect(await works(second)).toBe(false);
  expect((await signInRun(t, clerk, ["whoami"], env)).stderr).toMatch(/^not_configured: Not signed in\./);
});

test("login says when the deployment doesn't take command-line sign-ins", async () => {
  const t = newBackend();
  const clerk = await useFakeClerk();
  vi.stubEnv("CLERK_CLI_CLIENT_ID", "");
  const login = await signInRun(t, clerk, ["login", "--url", SITE_URL], { UPLINK_HOME: await tempDir("uplink-cli-") }, { openBrowser: browserFor(clerk, PEPE).open });
  expect(login.code).toBe(1);
  expect(login.stderr).toMatch(/^not_configured: .*CLERK_CLI_CLIENT_ID.*uplink login --key/);
});

test("login refuses a deployment address that isn't HTTPS or this computer, before anything is sent", async () => {
  const t = newBackend();
  const clerk = await useFakeClerk();
  const sent: string[] = [];
  const watched: typeof fetch = async (input, init) => {
    sent.push(new Request(input, init).url);
    return fetchToRoomAndClerk(t, clerk)(input, init);
  };
  const home = await tempDir("uplink-cli-");
  for (const argv of [
    ["login", "--url", "http://room.example.com"],
    ["login", "--url", "http://room.example.com", "--key", "urk_x"],
  ]) {
    const refused = await signInRun(t, clerk, argv, { UPLINK_HOME: home }, { fetch: watched, openBrowser: browserFor(clerk, PEPE).open });
    expect(refused.code, argv.join(" ")).toBe(1);
    expect(refused.stderr).toMatch(/^insecure_url: .*https:\/\//m);
  }
  expect(sent).toEqual([]);
  await expect(stat(join(home, "cli.json"))).rejects.toThrow(/ENOENT/);
});

test("a replaced sign-in the room couldn't revoke is reported, kept, and revoked by logout --pending", async () => {
  const t = newBackend();
  const clerk = await useFakeClerk();
  const home = await tempDir("uplink-cli-");
  const env = { UPLINK_HOME: home };
  const open = browserFor(clerk, PEPE).open;
  const saved = async () => JSON.parse(await readFile(join(home, "cli.json"), "utf8")) as { url: string; signIn?: string; key?: string };
  const works = async (token: string) =>
    new RoomClient({ url: SITE_URL, key: token, fetch: fetchTo(t) }).call("people.me").then(() => true, () => false);
  // The room can't be reached with these tokens, as when the network drops mid-login.
  const unreachable = new Set<string>();
  const flaky: typeof fetch = async (input, init) => {
    const auth = new Request(input, init).headers.get("authorization") ?? "";
    if (unreachable.has(auth.replace(/^Bearer /, ""))) throw new TypeError("fetch failed");
    return fetchToRoomAndClerk(t, clerk)(input, init);
  };

  await signInRun(t, clerk, ["login", "--url", SITE_URL, "--name", "first"], env, { openBrowser: open });
  const first = (await saved()).signIn!;
  unreachable.add(first);
  const second = await signInRun(t, clerk, ["login", "--name", "second"], env, { openBrowser: open, fetch: flaky });
  expect(second.code).toBe(0);
  expect(second.stderr).toMatch(/couldn't revoke the sign-in this one replaces.*uplink logout --pending/is);
  expect(await works(first)).toBe(true);

  // An agent key saved over the second sign-in, while the room can't be reached either.
  const secondToken = (await saved()).signIn!;
  unreachable.add(secondToken);
  const { key } = await newTeamWithAgent(t);
  const keyed = await signInRun(t, clerk, ["login", "--key", key], env, { fetch: flaky });
  expect(keyed.code).toBe(0);
  expect(keyed.stderr).toMatch(/couldn't revoke the sign-in this one replaces.*uplink logout --pending/is);
  expect(await saved()).toMatchObject({ url: SITE_URL, key });
  expect((await saved()).signIn).toBeUndefined();

  // Still unreachable: logout --pending says so and keeps them.
  const stillDown = await signInRun(t, clerk, ["logout", "--pending"], env, { fetch: flaky });
  expect(stillDown.code).toBe(1);
  expect(stillDown.stderr).toMatch(/2 replaced sign-ins.*still work/i);

  unreachable.clear();
  const retried = await signInRun(t, clerk, ["logout", "--pending"], env);
  expect(retried).toMatchObject({ code: 0, stdout: "Revoked 2 replaced sign-ins.\n" });
  expect(await works(first)).toBe(false);
  expect(await works(secondToken)).toBe(false);
  // The agent key stays saved: --pending only ends what was replaced.
  expect(await saved()).toEqual({ url: SITE_URL, key });
});

test("signed in as a person in two teams, run-in-terminal and wait-for-terminal find the terminal's team, and upload takes --team-id", async () => {
  const t = newBackend();
  const { admin, sideTeamId, sideGeneralId, bridgeToken: token, machineId, home } = await personInTwoTeams(t);
  const env = { UPLINK_HOME: home };

  const started = await run(t, ["runs", "start", "--team-id", sideTeamId, `machineId=${machineId}`, "harness=shell", "--json"], env);
  expect(started).toMatchObject({ code: 0, stderr: "" });
  const { terminalId } = JSON.parse(started.stdout) as { terminalId: string };
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: "pty-1", title: "Terminal", tool: "shell", access: "watch" });
  await bridgeSays(t, token, { type: "terminal_output", terminalId, seq: 1, data: "$ " });

  const ran = await run(t, ["run-in-terminal", terminalId, "node", "--version", "--wait-ms", "1000", "--json"], env);
  expect(ran).toMatchObject({ code: 0, stderr: "" });
  const { messages } = await t.query(api.bridge.inbox, { token, afterSeq: 0 });
  expect(messages.map((m) => m.message).find((m) => m.type === "input")).toMatchObject({ data: "'node' '--version'\n" });

  await bridgeSays(t, token, { type: "terminal_ended", terminalId, reason: "exited", exitCode: 0 });
  const waited = await run(t, ["wait-for-terminal", terminalId, "--team-id", sideTeamId, "--json"], env);
  expect(waited).toMatchObject({ code: 0, stderr: "" });
  expect(JSON.parse(waited.stdout)).toMatchObject({ stopped: "ended", exitCode: 0 });

  const file = join(home, "shot.png");
  await writeFile(file, "png bytes");
  expect((await run(t, ["upload", file], env)).stderr).toMatch(/^invalid: You're in 2 teams: pass teamId/);
  const uploaded = await run(t, ["upload", file, "--team-id", sideTeamId, "--json"], env);
  expect(uploaded).toMatchObject({ code: 0, stderr: "" });
  const posted = await run(t, ["messages", "post", "--team-id", sideTeamId, "--channel-id", sideGeneralId, "--body", "Shot", "--attachments", `[${uploaded.stdout.trim()}]`, "--json"], env);
  expect(posted).toMatchObject({ code: 0, stderr: "" });
  const message = await admin.query(api.messages.get, { teamId: sideTeamId as never, messageId: JSON.parse(posted.stdout) });
  expect(message?.attachments).toMatchObject([{ name: "shot.png" }]);
});
