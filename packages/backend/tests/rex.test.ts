import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { addTeammate, bridgeInbox, bridgeSays, LIMITS, newRoom, newTeam, type Person, type Room } from "./setup";

const TAB = { tabRef: "block:agent", sessionRef: "session:work", session: "work", title: "Agent", command: "claude", cwd: "/Users/julio/src/app" };

/** Pairs a bridge that can open Rex tabs (its tools list rex-tabs) and registers it. */
async function linkRexMachine(t: Room, teamId: Id<"teams">, person: Person, name = "julio-mbp", tools = ["claude", "rex", "rex-tabs"]) {
  const { code } = await person.as.mutation(api.machines.createPairingCode, { teamId, name });
  const { token, machineId } = await t.mutation(api.bridge.pair, { code, hostname: `${name}.local`, os: "darwin" });
  await bridgeSays(t, token, { type: "register_machine", hostname: `${name}.local`, os: "darwin", bridgeVersion: "0.2.5", tools, limits: LIMITS });
  return { machineId: machineId as Id<"machines">, token };
}

async function rexTeam() {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const { machineId, token } = await linkRexMachine(t, teamId, julio);
  await julio.as.mutation(api.machines.updateSettings, { teamId, machineId, mostOpenAccess: "drive" });
  await bridgeSays(t, token, { type: "rex_found", running: true, tabs: [TAB], otherTabs: 2 });
  return { t, teamId, julio, machineId, token };
}

const sent = async (t: Room, token: string, type: string) => (await bridgeInbox(t, token)).filter((m: any) => m.type === type);

test("the room tells only a bridge that opens Rex tabs that it takes Rex reports", async () => {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const rex = await linkRexMachine(t, teamId, julio);
  const plain = await linkRexMachine(t, teamId, julio, "build-box", ["tmux"]);

  expect(await sent(t, rex.token, "room_features")).toEqual([{ v: 1, type: "room_features", features: ["rex"] }]);
  // An older bridge, or one without Rex, is never told, so it never sends a message this room would refuse.
  expect(await sent(t, plain.token, "room_features")).toEqual([]);
  const machines = await julio.as.query(api.machines.list, { teamId });
  expect(machines.find((m) => m.name === "julio-mbp")?.rex).toEqual({ available: true, running: undefined });
  expect(machines.find((m) => m.name === "build-box")?.rex).toEqual({ available: false, running: undefined });
});

test("found Rex tabs are the machine owner's to see, each report replaces the last, and a new bridge starts over", async () => {
  const { t, teamId, julio, machineId, token } = await rexTeam();
  const ana = await addTeammate(t, teamId, julio, "Ana");

  expect(await julio.as.query(api.rex.found, { teamId, machineId })).toMatchObject({
    available: true,
    running: true,
    otherTabs: 2,
    tabs: [{ tabRef: "block:agent", session: "work", title: "Agent", command: "claude", shared: false }],
  });
  // A teammate doesn't see the names and folders of tabs that aren't shared.
  await expect(ana.as.query(api.rex.found, { teamId, machineId })).rejects.toThrow(/belongs to Julio/);

  await bridgeSays(t, token, { type: "rex_found", running: false, tabs: [], otherTabs: 0 });
  expect(await julio.as.query(api.rex.found, { teamId, machineId })).toMatchObject({ running: false, otherTabs: 0, tabs: [] });

  await bridgeSays(t, token, { type: "rex_found", running: true, tabs: [TAB], otherTabs: 1 });
  await bridgeSays(t, token, { type: "register_machine", hostname: "julio-mbp.local", os: "darwin", bridgeVersion: "0.2.5", tools: ["rex-tabs"], limits: LIMITS });
  expect(await julio.as.query(api.rex.found, { teamId, machineId })).toMatchObject({ running: false, tabs: [] });
});

test("sharing a found Rex tab makes it a terminal, asks the bridge, and stopping only ends the share", async () => {
  const { t, teamId, julio, machineId, token } = await rexTeam();
  const terminalId = (await julio.as.mutation(api.rex.share, { teamId, machineId, tabRef: "block:agent", access: "suggest" })) as Id<"terminals">;

  expect(await sent(t, token, "share_rex_tab")).toEqual([
    { v: 1, type: "share_rex_tab", terminalId, tabRef: "block:agent", sharedBy: expect.objectContaining({ name: "Julio" }), access: "suggest" },
  ]);
  expect(await julio.as.query(api.terminals.get, { teamId, terminalId })).toMatchObject({
    status: "starting",
    inRex: "tab",
    title: "Agent",
    usesSlot: false,
    driver: { name: "Julio" },
  });
  await expect(julio.as.mutation(api.rex.share, { teamId, machineId, tabRef: "block:agent", access: "suggest" })).rejects.toThrow(/already shared/);

  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: "block:agent", title: "claude", tool: "rex", access: "suggest" });
  await bridgeSays(t, token, { type: "terminal_size", terminalId, cols: 132, rows: 40 });
  expect(await julio.as.query(api.terminals.get, { teamId, terminalId })).toMatchObject({ status: "live", size: { cols: 132, rows: 40 } });
  expect((await julio.as.query(api.rex.found, { teamId, machineId })).tabs[0]).toMatchObject({ shared: true, terminalId, kind: "tab" });

  await julio.as.mutation(api.rex.stopSharing, { teamId, terminalId });
  expect(await sent(t, token, "stop_terminal")).toEqual([{ v: 1, type: "stop_terminal", terminalId }]);
  expect(await julio.as.query(api.terminals.get, { teamId, terminalId })).toMatchObject({ status: "ended" });
});

test("only whoever the machine belongs to shares its Rex tabs, only found ones, and within its limit", async () => {
  const { t, teamId, julio, machineId } = await rexTeam();
  const ana = await addTeammate(t, teamId, julio, "Ana");

  await expect(ana.as.mutation(api.rex.share, { teamId, machineId, tabRef: "block:agent", access: "watch" })).rejects.toThrow(/belongs to Julio/);
  await expect(julio.as.mutation(api.rex.share, { teamId, machineId, tabRef: "block:other", access: "watch" })).rejects.toThrow(/found/);
  await expect(julio.as.mutation(api.rex.share, { teamId, machineId, tabRef: "block:agent", access: "open" })).rejects.toThrow(/at most drive/);
  await julio.as.mutation(api.machines.stopSharing, { teamId, machineId });
  await expect(julio.as.mutation(api.rex.share, { teamId, machineId, tabRef: "block:agent", access: "watch" })).rejects.toThrow(/stopped/);
});

test("a tab shared from the machine itself is a Rex tab in the room", async () => {
  const { t, teamId, julio, token } = await rexTeam();
  await bridgeSays(t, token, { type: "terminal_started", localRef: "block:agent", title: "claude", tool: "rex", access: "drive" });
  const [terminal] = await julio.as.query(api.terminals.list, { teamId });
  expect(terminal).toMatchObject({ inRex: "tab", startedBy: { name: "Julio" } });
});

test("a tab shared from the machine before the bridge's first report is a Rex tab, from its start message", async () => {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const { token } = await linkRexMachine(t, teamId, julio);
  // `share-rex` right after the tab's host connects: no `rex_found` has named the tab yet.
  await bridgeSays(t, token, {
    type: "terminal_started",
    localRef: "block:agent",
    title: "claude",
    tool: "rex",
    access: "suggest",
    rex: { sessionRef: "session:work", tabRef: "block:agent" },
  });
  const [terminal] = await julio.as.query(api.terminals.list, { teamId });
  expect(terminal).toMatchObject({ inRex: "tab" });
});

test("a tab shared before the bridge's report and without saying it's in Rex becomes a Rex tab at the next report", async () => {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const { token } = await linkRexMachine(t, teamId, julio);
  await bridgeSays(t, token, { type: "terminal_started", localRef: "block:agent", title: "claude", tool: "rex", access: "suggest" });
  expect((await julio.as.query(api.terminals.list, { teamId }))[0]).not.toHaveProperty("inRex");
  await bridgeSays(t, token, { type: "rex_found", running: true, tabs: [{ ...TAB, terminalRef: "block:agent" }], otherTabs: 0 });
  expect((await julio.as.query(api.terminals.list, { teamId }))[0]).toMatchObject({ inRex: "tab" });
});

test("a run In Rex sends the harness's command with its first prompt, as a Rex tab named for the task", async () => {
  const { t, teamId, julio, machineId, token } = await rexTeam();
  const taskId = await julio.as.mutation(api.tasks.create, { teamId, title: "Fix invoice totals" });

  const { terminalId } = await julio.as.mutation(api.runs.start, {
    teamId,
    taskId,
    harness: "claude-code",
    machineId,
    via: "rex",
    cwd: "~/src/billing",
    prompt: "Don't round -0.5 up",
  });

  expect(await sent(t, token, "start_terminal")).toEqual([
    expect.objectContaining({ terminalId, inRex: true, title: "Fix invoice totals", command: "claude -- 'Don'\\''t round -0.5 up'", cwd: "~/src/billing" }),
  ]);
  expect(await julio.as.query(api.terminals.get, { teamId, terminalId: terminalId! })).toMatchObject({ inRex: "run" });

  await julio.as.mutation(api.runs.start, { teamId, taskId, harness: "opencode", machineId, via: "rex", prompt: "Add tests" });
  expect((await sent(t, token, "start_terminal")).at(-1)).toMatchObject({ command: "opencode --prompt='Add tests'" });
});

test("a run In Rex is refused without Rex tabs on the machine, while Rex isn't running, with a profile, and for a shell with a prompt", async () => {
  const { t, teamId, julio, machineId, token } = await rexTeam();
  const taskId = await julio.as.mutation(api.tasks.create, { teamId, title: "Fix invoice totals" });
  const plain = await linkRexMachine(t, teamId, julio, "build-box", ["tmux"]);
  const start = (more: Record<string, unknown>) =>
    julio.as.mutation(api.runs.start, { teamId, taskId, harness: "claude-code", machineId, via: "rex", ...more } as never);

  await expect(start({ machineId: plain.machineId })).rejects.toThrow(/can't open Rex tabs/);
  await expect(start({ harness: "shell", prompt: "hi" })).rejects.toThrow(/plain shell takes no first prompt/);
  const profileId = await julio.as.mutation(api.profiles.create, { teamId, machineId, name: "mine", keepForMs: 86_400_000 });
  await expect(start({ profileId })).rejects.toThrow(/machine setup/);
  await bridgeSays(t, token, { type: "rex_found", running: false, tabs: [], otherTabs: 0 });
  await expect(start({})).rejects.toThrow(/Rex isn't running on julio-mbp/);
});


test("a Hermes run In Rex submits its literal first prompt through chat --query", async () => {
  const { t, teamId, julio, machineId, token } = await rexTeam();
  const taskId = await julio.as.mutation(api.tasks.create, { teamId, title: "Check Hermes" });
  await julio.as.mutation(api.runs.start, {
    teamId,
    taskId,
    harness: "hermes-agent",
    machineId,
    via: "rex",
    prompt: "--don't run $(whoami)",
  });
  expect((await sent(t, token, "start_terminal")).at(-1)).toMatchObject({
    command: "hermes chat --query='--don'\\''t run $(whoami)'",
  });
});
