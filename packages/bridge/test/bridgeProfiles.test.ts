import { expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { BridgeMessage } from "@uplink-room/protocol";
import { Bridge } from "../src/bridge.ts";
import type { TerminalHost, TerminalProcess } from "../src/terminal.ts";
import { cleanups, driver, FakeRoom, screen, setup, start, stoppableHost, term } from "./tools/bridgeFixture.ts";

test("caps profile retention, routes harness folders there, and removes expired profiles", async () => {
  let now = 1000;
  const { room, dir, bridge } = await setup({ clock: { now: () => now } });
  room.deliver({
    v: 1,
    type: "create_profile",
    profileId: "person-one",
    person: driver,
    expiresAt: 99999,
  });
  await expect
    .poll(() => room.messages.find((m) => m.type === "profile_created"))
    .toMatchObject({ expiresAt: 2000 });
  start(room, "profile-terminal", term("env", "CLAUDE_CONFIG_DIR", "CODEX_HOME"), {
    profileId: "person-one",
    harness: "claude-code",
  });
  await expect.poll(() => room.messages.find((m) => m.type === "terminal_ended")).toBeDefined();
  expect(
    room.messages
      .filter((m) => m.type === "terminal_output")
      .map((m) => m.data)
      .join(""),
  ).toContain(join(dir, "profiles", "person-one"));
  now = 2001;
  await bridge.expireProfiles();
  await expect
    .poll(() => room.messages.find((m) => m.type === "profile_expired"))
    .toMatchObject({ profileId: "person-one" });
  const { access } = await import("node:fs/promises");
  await expect(access(join(dir, "profiles", "person-one"))).rejects.toThrow();
});

test("saved profiles still expire after the bridge restarts", async () => {
  let now = 1000;
  const { room, bridge, dir } = await setup({ clock: { now: () => now } });
  room.deliver({
    v: 1,
    type: "create_profile",
    profileId: "restart",
    person: driver,
    expiresAt: 99999,
  });
  await expect.poll(() => room.messages.find((m) => m.type === "profile_created")).toBeDefined();
  await bridge.close();
  now = 3000;
  const nextRoom = new FakeRoom();
  const next = new Bridge({
    link: nextRoom,
    limits: { mostOpenAccess: "suggest", slots: 1, longestProfileMs: 1000 },
    profilesDir: join(dir, "profiles"),
    clock: { now: () => now },
  });
  cleanups.push(() => next.close());
  await next.start();
  expect(nextRoom.messages[0]).toMatchObject({ type: "register_machine" });
  expect(nextRoom.messages).toContainEqual({ v: 1, type: "profile_expired", profileId: "restart" });
});

test("a create_profile delivered again after a restart reports the saved profile instead of halting", async () => {
  let now = 1000;
  const { room, bridge, dir } = await setup({ clock: { now: () => now } });
  const create = { v: 1, type: "create_profile", profileId: "replayed", person: driver, expiresAt: 1800 } as const;
  room.deliver(create);
  await expect.poll(() => room.messages.find((m) => m.type === "profile_created")).toBeDefined();
  // The bridge crashed before saving the cursor, so the next process gets the same command.
  await bridge.close();
  now = 1500;
  const nextRoom = new FakeRoom();
  const next = new Bridge({
    link: nextRoom,
    limits: { mostOpenAccess: "suggest", slots: 1, longestProfileMs: 1000 },
    profilesDir: join(dir, "profiles"),
    clock: { now: () => now },
  });
  cleanups.push(() => next.close());
  await next.start();
  const handled = nextRoom.handler!(create) as unknown as Promise<void>;
  await expect(handled).resolves.toBeUndefined();
  // Its saved expiry, not a later one from the replayed command.
  expect(nextRoom.messages).toContainEqual({ v: 1, type: "profile_created", profileId: "replayed", expiresAt: 1800 });
});

test("profiles are deleted and expire while sharing is stopped", async () => {
  let now = 1000;
  const { room, bridge, dir } = await setup({ clock: { now: () => now } });
  for (const profileId of ["deleted", "expiring"])
    room.deliver({ v: 1, type: "create_profile", profileId, person: driver, expiresAt: 1500 });
  await expect.poll(() => room.messages.filter((m) => m.type === "profile_created").length).toBe(2);
  await bridge.stopSharing();

  room.deliver({ v: 1, type: "delete_profile", profileId: "deleted" });
  const { readdir } = await import("node:fs/promises");
  await expect.poll(() => readdir(join(dir, "profiles"))).toEqual(["expiring"]);
  now = 1501;
  await bridge.expireProfiles();
  expect(await readdir(join(dir, "profiles"))).toEqual([]);
  await expect.poll(() => room.messages).toContainEqual({ v: 1, type: "profile_expired", profileId: "expiring" });
});
test("an expired profile whose folders couldn't be removed is deleted on the next expiry pass", async () => {
  let now = 1000;
  const errors: unknown[] = [];
  const { existsSync } = await import("node:fs");
  const { room, bridge, dir } = await setup({ clock: { now: () => now }, onError: (error: unknown) => errors.push(error) });
  room.deliver({ v: 1, type: "create_profile", profileId: "busy", person: driver, expiresAt: 1500 });
  await expect.poll(() => room.messages.find((m) => m.type === "profile_created")).toBeDefined();
  const profiles = (bridge as unknown as { profiles: { delete: (id: string) => Promise<void> } }).profiles;
  const remove = profiles.delete.bind(profiles);
  let failures = 1;
  profiles.delete = async (id) => {
    if (failures-- > 0) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    return remove(id);
  };
  now = 1501;
  await bridge.expireProfiles();
  expect(existsSync(join(dir, "profiles", "busy"))).toBe(true);
  expect(errors).toHaveLength(1);
  await bridge.expireProfiles();
  expect(existsSync(join(dir, "profiles", "busy"))).toBe(false);
  await expect.poll(() => room.messages).toContainEqual({ v: 1, type: "profile_expired", profileId: "busy" });
});

test("a profile terminal whose folders can't be prepared doesn't hold up other profiles' deletion", async () => {
  const { room, dir } = await setup();
  for (const profileId of ["broken", "other"])
    room.deliver({ v: 1, type: "create_profile", profileId, person: driver, expiresAt: Date.now() + 60_000 });
  await expect.poll(() => room.messages.filter((m) => m.type === "profile_created").length).toBe(2);
  const { rm } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  // Removed outside the bridge, so preparing its environment fails.
  await rm(join(dir, "profiles", "broken"), { recursive: true, force: true });
  start(room, "broken-terminal", "anything", { profileId: "broken", harness: "opencode" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  room.deliver({ v: 1, type: "delete_profile", profileId: "other" });
  await expect.poll(() => existsSync(join(dir, "profiles", "other")), { timeout: 5_000 }).toBe(false);
});

test("expired profiles are deleted on time while the room link is stalled", async () => {
  // A link whose sends never finish once `stalled` is set, as when the room stops answering.
  let stalled = false;
  const room = new FakeRoom();
  const send = room.send.bind(room);
  room.send = (message: BridgeMessage) => (stalled ? new Promise<void>(() => {}) : send(message));
  const { dir } = await setup({ link: room, limits: { mostOpenAccess: "suggest", slots: 1, longestProfileMs: 500 } });
  for (const profileId of ["first", "second"])
    room.deliver({ v: 1, type: "create_profile", profileId, person: driver, expiresAt: Date.now() + 500 });
  await expect.poll(() => room.messages.filter((m) => m.type === "profile_created").length).toBe(2);
  stalled = true;
  // A command whose report never reaches the room holds up the command queue behind it.
  room.deliver({ v: 1, type: "start_thread", runId: "stuck", harness: "codex", startedBy: driver });
  const { readdir } = await import("node:fs/promises");
  await expect.poll(() => readdir(join(dir, "profiles")), { timeout: 3000 }).toEqual([]);
});

/**
 * For a test whose profile terminal must run to its end. On Windows, PowerShell and Node take one to
 * two seconds to print, so a profile that expires sooner ends the terminal ("stopped") before its output.
 */
const lastingProfiles = { limits: { mostOpenAccess: "suggest", slots: 1, longestProfileMs: 60_000 } };
const exited = (room: FakeRoom, terminalId: string) =>
  expect
    .poll(() => room.messages.find((m) => m.type === "terminal_ended" && m.terminalId === terminalId))
    .toMatchObject({ reason: "exited", exitCode: 0 });

test("deleting a profile waits until its terminals have stopped, even when their tree kill is slow", async () => {
  const { existsSync } = await import("node:fs");
  const { PtyGate, withTreeKill } = await import("../src/terminal.ts");
  const gate = new PtyGate();
  let alive = false;
  // A Windows terminal whose holder never answers, as when PowerShell is slow to start: only the
  // fallback, node-pty's own kill, can stop it.
  const host: TerminalHost = {
    spawn() {
      const exits: ((event: { exitCode: number }) => void)[] = [];
      alive = true;
      const fake: TerminalProcess = {
        write: () => {},
        resize: () => {},
        onData: () => ({ dispose: () => {} }),
        onExit: (listener) => (exits.push(listener), { dispose: () => {} }),
        kill: () => {
          alive = false;
          exits.forEach((listener) => listener({ exitCode: 1 }));
        },
      };
      const now = Date.now();
      return withTreeKill(fake, { pid: 4321, spawnStarted: now, spawnEnded: now }, { hold: () => new Promise(() => {}), gate });
    },
  };
  const { room, dir } = await setup({ terminalHost: host, ...lastingProfiles });
  room.deliver({ v: 1, type: "create_profile", profileId: "teammate", person: driver, expiresAt: Date.now() + 60_000 });
  await expect.poll(() => room.messages.find((m) => m.type === "profile_created")).toBeDefined();
  start(room, "profile-terminal", "anything", { profileId: "teammate", harness: "opencode" });
  await expect.poll(() => room.messages.find((m) => m.type === "terminal_started")).toBeDefined();
  const folder = join(dir, "profiles", "teammate");
  expect(existsSync(folder)).toBe(true);

  let deletedWhileAlive = false;
  const watch = setInterval(() => {
    if (alive && !existsSync(folder)) deletedWhileAlive = true;
  }, 5);
  room.deliver({ v: 1, type: "delete_profile", profileId: "teammate" });
  await expect.poll(() => existsSync(folder), { timeout: 15_000 }).toBe(false);
  clearInterval(watch);
  expect(alive).toBe(false);
  expect(deletedWhileAlive).toBe(false);
});

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const twoSlots = { limits: { mostOpenAccess: "suggest", slots: 2, longestProfileMs: 60_000 } };

test("a profile's folders stay until its terminals have exited, also ones the room stopped or unlinking ended", async () => {
  const { existsSync } = await import("node:fs");
  const { host, terminals } = stoppableHost();
  const { room, dir } = await setup({ terminalHost: host, ...twoSlots });
  const folder = (profileId: string) => join(dir, "profiles", profileId);
  for (const profileId of ["stopped", "unlinked"]) {
    room.deliver({ v: 1, type: "create_profile", profileId, person: driver, expiresAt: Date.now() + 60_000 });
    start(room, profileId, "anything", { profileId, harness: "opencode" });
  }
  await expect.poll(() => terminals.size).toBe(2);

  // Stopped by the room, the terminal leaves the bridge's list at once, while its kill is still going.
  room.deliver({ v: 1, type: "stop_terminal", terminalId: "stopped" });
  room.deliver({ v: 1, type: "delete_profile", profileId: "stopped" });
  await expect.poll(() => terminals.get("stopped")!.kills).toEqual(["kill"]);
  await sleep(500);
  expect(existsSync(folder("stopped"))).toBe(true);
  terminals.get("stopped")!.exit();
  await expect.poll(() => existsSync(folder("stopped"))).toBe(false);

  // Unlinking stops sharing, which ends room terminals the same way, before it deletes the profiles.
  room.deliver({ v: 1, type: "unlink" });
  await expect.poll(() => terminals.get("unlinked")!.kills).toEqual(["kill"]);
  await sleep(500);
  expect(existsSync(folder("unlinked"))).toBe(true);
  terminals.get("unlinked")!.exit();
  await expect.poll(() => existsSync(folder("unlinked"))).toBe(false);
});

test("a profile whose terminal won't exit keeps its folders, and refuses new terminals, until it does", async () => {
  const { existsSync } = await import("node:fs");
  const { host, terminals } = stoppableHost();
  const { room, dir } = await setup({ terminalHost: host, ...twoSlots });
  const folder = join(dir, "profiles", "stuck");
  room.deliver({ v: 1, type: "create_profile", profileId: "stuck", person: driver, expiresAt: Date.now() + 60_000 });
  start(room, "stuck", "anything", { profileId: "stuck", harness: "opencode" });
  await expect.poll(() => terminals.size).toBe(1);

  room.deliver({ v: 1, type: "delete_profile", profileId: "stuck" });
  // After PROFILE_KILL_WAIT_MS it is killed without the tree kill, and PROFILE_EXIT_WAIT_MS later
  // the deletion gives up for now. The folders are still there.
  await expect.poll(() => terminals.get("stuck")!.kills, { timeout: 5000 }).toEqual(["kill", "killNow"]);
  await sleep(5500);
  expect(existsSync(folder)).toBe(true);
  start(room, "after", "anything", { profileId: "stuck", harness: "opencode" });
  await expect
    .poll(() => room.messages.find((m) => m.type === "terminal_start_failed"))
    .toEqual({ v: 1, type: "terminal_start_failed", terminalId: "after", reason: "profile_expired" });
  expect([...terminals.keys()]).toEqual(["stuck"]);

  // Once it exits, the deletion runs again.
  terminals.get("stuck")!.exit();
  await expect.poll(() => existsSync(folder)).toBe(false);
  expect(room.messages.filter((m) => m.type === "profile_expired")).toEqual([]);
});

test("a start waiting for a kill holds up no profile's expiry, and spawns nothing on a profile that expired meanwhile", async () => {
  const { readdir } = await import("node:fs/promises");
  let now = 1000;
  let busy = true;
  let finishKill = () => {};
  const spawned: string[] = [];
  const { host: stoppable } = stoppableHost();
  // A kill is ending a shell until the test finishes it.
  const host: TerminalHost = {
    spawn(file, args, options) {
      spawned.push(String(options.env?.UPLINK_TERMINAL_REF));
      return stoppable.spawn(file, args, options);
    },
    whenIdle: () =>
      busy ? new Promise<void>((done) => (finishKill = () => ((busy = false), done()))) : Promise.resolve(),
    isIdle: () => !busy,
  };
  const { room, bridge, dir } = await setup({ clock: { now: () => now }, terminalHost: host });
  room.deliver({ v: 1, type: "create_profile", profileId: "waiting", person: driver, expiresAt: 2000 });
  await expect.poll(() => room.messages.find((m) => m.type === "profile_created")).toBeDefined();
  let waiting = false;
  const whenIdle = host.whenIdle!;
  host.whenIdle = () => ((waiting = true), whenIdle());
  start(room, "waiting-terminal", "anything", { profileId: "waiting", harness: "claude-code" });
  await expect.poll(() => waiting).toBe(true);

  now = 2001;
  const expiry = await Promise.race([bridge.expireProfiles().then(() => "done"), sleep(3000).then(() => "stuck")]);
  expect(expiry).toBe("done");
  expect(await readdir(join(dir, "profiles"))).toEqual([]);
  finishKill();
  await expect
    .poll(() => room.messages.find((m) => m.type === "terminal_start_failed"))
    .toEqual({ v: 1, type: "terminal_start_failed", terminalId: "waiting-terminal", reason: "profile_expired" });
  expect(spawned).toEqual([]);
});

test("a profile starts only under a harness that keeps its logins apart, with OpenCode's imports off", async () => {
  const { room, dir } = await setup(lastingProfiles);
  room.deliver({ v: 1, type: "create_profile", profileId: "teammate", person: driver, expiresAt: Date.now() + 60_000 });
  await expect.poll(() => room.messages.find((m) => m.type === "profile_created")).toBeDefined();

  // The room shouldn't ask for these, but the bridge refuses them itself.
  start(room, "codex-profile", term("idle"), { profileId: "teammate", harness: "codex" });
  start(room, "no-harness", term("idle"), { profileId: "teammate" });
  start(
    room,
    "opencode-profile",
    term("env", "XDG_STATE_HOME", "GROK_HOME", "OPENCODE_DISABLE_EXTERNAL_SKILLS", "OPENCODE_DISABLE_CLAUDE_CODE"),
    { profileId: "teammate", harness: "opencode" },
  );

  await exited(room, "opencode-profile");
  expect(room.messages.filter((m) => m.type === "terminal_start_failed")).toEqual([
    { v: 1, type: "terminal_start_failed", terminalId: "codex-profile", reason: "profile_not_supported" },
    { v: 1, type: "terminal_start_failed", terminalId: "no-harness", reason: "profile_not_supported" },
  ]);
  const profile = join(dir, "profiles", "teammate");
  // ConPTY on Windows adds terminal control sequences (cursor, title) around the text. The bridge
  // sends a terminal's output before reporting its exit, so the lines are all here already.
  const lines =
    screen(room)
      // oxlint-disable-next-line no-control-regex -- matching terminal control sequences is the point
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .slice(0, 4);
  expect(lines).toEqual([join(profile, "state"), join(profile, "grok"), "true", "true"]);
});

test("profiles expire on time while the room never acknowledges registration or profile creation", async () => {
  const { readdir } = await import("node:fs/promises");
  const limits = { mostOpenAccess: "suggest", slots: 1, longestProfileMs: 60_000 } as const;
  // Creation: the room never acknowledges `profile_created`.
  const creating = new FakeRoom();
  const send = creating.send.bind(creating);
  creating.send = (message: BridgeMessage) =>
    message.type === "profile_created" ? (send(message), new Promise<void>(() => {})) : send(message);
  const created = await setup({ link: creating, limits });
  creating.deliver({ v: 1, type: "create_profile", profileId: "unacknowledged", person: driver, expiresAt: Date.now() + 300 });
  await expect.poll(() => creating.messages.find((m) => m.type === "profile_created")).toBeDefined();
  await expect.poll(() => readdir(join(created.dir, "profiles")), { timeout: 3000 }).toEqual([]);

  // Restart: the room never acknowledges `register_machine`.
  let now = 1000;
  const first = await setup({ clock: { now: () => now }, limits });
  first.room.deliver({ v: 1, type: "create_profile", profileId: "saved", person: driver, expiresAt: 1500 });
  await expect.poll(() => first.room.messages.find((m) => m.type === "profile_created")).toBeDefined();
  await first.bridge.close();
  now = 2000;
  const stalled = new FakeRoom();
  stalled.send = (message: BridgeMessage) => {
    stalled.messages.push(message);
    return new Promise<void>(() => {});
  };
  const next = new Bridge({ link: stalled, limits, profilesDir: join(first.dir, "profiles"), clock: { now: () => now } });
  cleanups.push(() => next.close());
  void next.start();
  await expect.poll(() => readdir(join(first.dir, "profiles")), { timeout: 3000 }).toEqual([]);
  // The room still hears of the registration first.
  expect(stalled.messages.map((m) => m.type)).toEqual(["register_machine"]);
});

test("a terminal starting as its profile expires is refused, and nothing outlives the deletion", async () => {
  const { nodePtyHost } = await import("../src/terminal.ts");
  const { readdir } = await import("node:fs/promises");
  const spawned: string[] = [];
  const host: TerminalHost = {
    spawn(command, args, options) {
      spawned.push(String(options.env?.CLAUDE_CONFIG_DIR));
      return nodePtyHost.spawn(command, args, options);
    },
  };
  // The clock passes the deadline, and expiry runs, just after the start's own expiry check reads it.
  let now = 1000;
  let armed = false;
  let bridge: Bridge | undefined;
  const clock = {
    now: () => {
      const current = now;
      if (armed) {
        armed = false;
        now = 2001;
        queueMicrotask(() => void bridge!.expireProfiles());
      }
      return current;
    },
  };
  const context = await setup({ clock, terminalHost: host });
  bridge = context.bridge;
  const { room, dir } = context;
  room.deliver({ v: 1, type: "create_profile", profileId: "racing", person: driver, expiresAt: 2000 });
  await expect.poll(() => room.messages.find((m) => m.type === "profile_created")).toBeDefined();
  armed = true;
  start(room, "racing-terminal", term("idle"), { profileId: "racing", harness: "claude-code" });

  await expect
    .poll(() => room.messages.find((m) => m.type === "terminal_start_failed"))
    .toEqual({ v: 1, type: "terminal_start_failed", terminalId: "racing-terminal", reason: "profile_expired" });
  await expect.poll(() => room.messages).toContainEqual({ v: 1, type: "profile_expired", profileId: "racing" });
  expect(spawned).toEqual([]);
  expect(await readdir(join(dir, "profiles"))).toEqual([]);
});

test("a profile terminal gets none of the machine's sign-ins, while a machine-setup terminal keeps them", async () => {
  const machine = {
    ANTHROPIC_API_KEY: "machine-anthropic-key",
    ANTHROPIC_AUTH_TOKEN: "machine-auth-token",
    CLAUDE_CODE_OAUTH_TOKEN: "machine-oauth-token",
    OPENAI_API_KEY: "machine-openai-key",
    OPENCODE_AUTH_CONTENT: "machine-opencode-auth",
  };
  const names = Object.keys(machine);
  const { room } = await setup({ ...lastingProfiles, env: machine });
  room.deliver({ v: 1, type: "create_profile", profileId: "teammate", person: driver, expiresAt: Date.now() + 60_000 });
  await expect.poll(() => room.messages.find((m) => m.type === "profile_created")).toBeDefined();
  const output = (terminalId: string) =>
    room.messages
      .filter((m) => m.type === "terminal_output" && m.terminalId === terminalId)
      .map((m) => (m as Extract<BridgeMessage, { type: "terminal_output" }>).data)
      .join("");

  start(room, "machine-setup", term("env", ...names));
  await exited(room, "machine-setup");
  for (const value of Object.values(machine)) expect(output("machine-setup")).toContain(value);

  start(room, "profile", term("env", "CLAUDE_CONFIG_DIR", ...names), { profileId: "teammate", harness: "claude-code" });
  await exited(room, "profile");
  expect(output("profile")).toContain(join("profiles", "teammate", "claude"));
  expect(output("profile")).not.toContain("machine-");
});

test("a profile created while sharing is stopped is still made, and reported to the room", async () => {
  const { room, dir } = await setup();
  room.deliver({ v: 1, type: "stop_sharing" });
  room.deliver({ v: 1, type: "create_profile", profileId: "while-stopped", person: driver, expiresAt: Date.now() + 500 });

  await expect
    .poll(() => room.messages.find((m) => m.type === "profile_created"))
    .toMatchObject({ profileId: "while-stopped" });
  const { stat } = await import("node:fs/promises");
  expect((await stat(join(dir, "profiles", "while-stopped"))).isDirectory()).toBe(true);
});
