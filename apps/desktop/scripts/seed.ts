import { randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@uplink-room/backend/api";

/**
 * Fills a team with the work the screenshots show, through the same Room API
 * the app uses. It also plays a bridge's side (pair, register, start terminals,
 * report run states and output), since no bridge runs against this backend
 * here, and gives three agents their own agent keys over HTTP.
 */

type Json = Record<string, unknown>;
const DAY = 24 * 60 * 60 * 1000;

export type Seeded = {
  teamId: string;
  terminals: Record<string, string>;
  tasks: Record<string, string>;
  channels: Record<string, string>;
  /** Things that happen once the app is open, for the sound cues and banners to react to. */
  later: {
    /**
     * Two runs I drive start waiting: an approval that can be undone, and a deploy that can't.
     * Their prompt ids are UUIDs, as the bridge makes them, so banner ids have their real length.
     */
    needsYou(): Promise<void>;
    /** Hermes passes me back the wheel of the tile map terminal. */
    wheelToMe(): Promise<void>;
    /** The website deploy that waits on me finishes, as if answered on another computer. */
    finishDeploy(): Promise<void>;
    /** The save slots approval is answered on another computer, and Claude Code works on. */
    saveSlotsMovesOn(): Promise<void>;
  };
};

export async function seed(opts: {
  convexUrl: string;
  siteUrl: string;
  teamId: string;
  token: () => Promise<string>;
}): Promise<Seeded> {
  const client = new ConvexHttpClient(opts.convexUrl);
  const teamId = opts.teamId;
  // Clerk session tokens last 60 seconds, so each call asks for a fresh one.
  const call = async <T>(kind: "query" | "mutation", ref: unknown, args: Json): Promise<T> => {
    client.setAuth(await opts.token());
    const fn = (kind === "query" ? client.query : client.mutation).bind(client) as (
      r: unknown,
      a: Json,
    ) => Promise<T>;
    return fn(ref, { teamId, ...args });
  };
  const m = <T = unknown>(ref: unknown, args: Json = {}) => call<T>("mutation", ref, args);
  const q = <T = unknown>(ref: unknown, args: Json = {}) => call<T>("query", ref, args);

  async function asAgent<T = unknown>(key: string, fn: string, args: Json = {}): Promise<T> {
    const res = await fetch(`${opts.siteUrl}/api/v1/call`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ fn, args }),
    });
    const body = (await res.json()) as { ok: boolean; result?: T; error?: { message: string } };
    if (!body.ok) throw new Error(`${fn} as an agent: ${body.error?.message}`);
    return body.result as T;
  }

  // ---- agents, with their keys ----
  const agentSpecs = [
    {
      name: "Hermes",
      connection: "a2a",
      character: { body: "hermes", color: "coral", accessory: "hermes" },
      scopes: ["room.read", "messages.post", "terminals.drive"],
    },
    {
      name: "Notetaker",
      connection: "mcp",
      character: { body: "notetaker", color: "sage", accessory: "notetaker" },
      scopes: ["room.read", "messages.post"],
    },
    {
      name: "Deploy bot",
      connection: "http",
      character: { body: "deploy", color: "blue", accessory: "deploy" },
      scopes: ["room.read", "messages.post"],
    },
  ] as const;
  const keys: Record<string, string> = {};
  for (const spec of agentSpecs) {
    const agentId = await m<string>(api.agents.add, {
      name: spec.name,
      connection: spec.connection,
      character: spec.character,
    });
    const made = await m<{ secret: string }>(api.agents.createKey, {
      agentId,
      name: "Local test",
      scopes: [...spec.scopes],
    });
    keys[spec.name] = made.secret;
  }
  const members = await q<{ memberId: string; name: string; kind: string }[]>(api.teams.members);
  const memberId = (name: string) => members.find((x) => x.name === name)!.memberId;

  // ---- projects, channels, tasks ----
  const reef = await m<string>(api.projects.create, {
    name: "Reef Runner",
    repos: ["nuko-nova/reef-runner"],
  });
  const site = await m<string>(api.projects.create, {
    name: "Website",
    repos: ["nuko-nova/website"],
  });
  const channelsList = await q<{ channelId: string; name: string; projectId?: string }[]>(
    api.channels.list,
  );
  const reefChannel = channelsList.find((c) => c.projectId === reef)!.channelId;
  const general = channelsList.find((c) => c.name === "general")!.channelId;
  await m(api.channels.create, { name: "random" });

  const task = async (title: string, projectId: string, description?: string) =>
    m<string>(api.tasks.create, { title, projectId, ...(description ? { description } : {}) });
  const tSave = await task(
    "Save slots on the title screen",
    reef,
    "Three slots, each showing playtime and the last level. Save to disk on every checkpoint.",
  );
  const tTiles = await task("Tile map loader", reef);
  const tAudio = await task("Fix audio pop on level start", reef);
  const tShip = await task("Ship 0.4.2", reef);
  await task("Add controller support", reef);
  await task("Write the release notes", reef);
  const tFooter = await task("Fix footer links", site);
  await task("Redo the pricing table", site);
  // A task with no project and no runs yet: it shows on the No project board.
  await m(api.tasks.create, { title: "Renew the signing certificate" });

  // ---- machines, with a bridge's side played here ----
  type Bridge = { token: string; machineId: string };
  const bridge = async (name: string, team: boolean): Promise<Bridge> => {
    const pairing = await m<{ code: string }>(api.machines.createPairingCode, {
      name,
      ...(team ? { belongsToTeam: true } : {}),
    });
    client.setAuth(await opts.token());
    const paired = (await client.mutation(api.bridge.pair, {
      code: pairing.code,
      hostname: `${name}.local`,
      os: team ? "Linux x64" : "macOS arm64",
    })) as { token: string; machineId: string };
    await client.mutation(api.bridge.send, {
      token: paired.token,
      messages: [
        {
          v: 1,
          type: "register_machine",
          hostname: `${name}.local`,
          os: team ? "Linux x64" : "macOS arm64",
          bridgeVersion: "0.1.0",
          tools: ["tmux", "claude-code", "t3code"],
          limits: { mostOpenAccess: "open", slots: 4, longestProfileMs: 30 * DAY },
        },
      ],
    });
    return { token: paired.token, machineId: paired.machineId };
  };
  const send = async (b: Bridge, ...messages: Json[]) => {
    // The bridge authenticates with its token; a person's session token, which expires after a
    // minute, would only get the call refused once it is stale (as in `later`, below).
    client.clearAuth();
    await client.mutation(api.bridge.send, {
      token: b.token,
      messages: messages.map((x) => ({ v: 1, ...x })) as never,
    });
  };
  const mbp = await bridge("julio-mbp", false);
  const box = await bridge("build-linux", true);
  await m(api.machines.updateSettings, {
    machineId: mbp.machineId,
    mostOpenAccess: "open",
    slots: 2,
    longestProfileMs: 14 * DAY,
  });
  await m(api.machines.updateSettings, {
    machineId: box.machineId,
    mostOpenAccess: "drive",
    slots: 3,
    longestProfileMs: 7 * DAY,
  });

  const terminals: Record<string, string> = {};
  /** Starts a run on a task, then has the "bridge" report the terminal live with its output and state. */
  async function run(
    key: string,
    o: {
      task: string;
      harness: string;
      on: Bridge;
      access: string;
      title: string;
      output: string[];
      state?: Json;
      end?: number;
    },
  ) {
    const started = await m<{ runId: string; terminalId: string }>(api.runs.start, {
      taskId: o.task,
      harness: o.harness,
      machineId: o.on.machineId,
      repo: "nuko-nova/reef-runner",
      access: o.access,
    });
    terminals[key] = started.terminalId;
    await send(o.on, {
      type: "terminal_started",
      terminalId: started.terminalId,
      localRef: `local-${key}`,
      title: o.title,
      tool: o.harness,
      access: o.access,
    });
    let seq = 0;
    await send(
      o.on,
      ...o.output.map((data) => ({
        type: "terminal_output",
        terminalId: started.terminalId,
        seq: ++seq,
        data,
      })),
    );
    if (o.state)
      await send(o.on, {
        type: "run_state_changed",
        source: { kind: "terminal", terminalId: started.terminalId },
        ...o.state,
      });
    if (o.end !== undefined)
      await send(o.on, { type: "terminal_ended", terminalId: started.terminalId, exitCode: o.end });
    return started;
  }

  const esc = "\x1b[";
  const dim = (s: string) => `${esc}2m${s}${esc}0m`;
  const green = (s: string) => `${esc}32m${s}${esc}0m`;
  const amber = (s: string) => `${esc}33m${s}${esc}0m`;
  const bold = (s: string) => `${esc}1m${s}${esc}0m`;
  const claudeScreen = [
    `${dim("~/reef-runner")} ${bold("claude")}\r\n`,
    `\r\n${bold("Claude Code")} ${dim("v2.4")}  ${dim("nuko-nova/reef-runner")}\r\n\r\n`,
    `${amber(">")} Add three save slots to the title screen. Save on every checkpoint.\r\n\r\n`,
    `${green("●")} I'll start with the save format, then the slot picker.\r\n\r\n`,
    `${green("●")} ${bold("Read")}(src/title/TitleScreen.ts)\r\n  ${dim("⎿  Read 212 lines")}\r\n\r\n`,
    `${green("●")} ${bold("Write")}(src/save/SaveSlot.ts)\r\n  ${dim("⎿  Wrote 64 lines")}\r\n\r\n`,
    `${green("●")} ${bold("Bash")}(pnpm test save)\r\n  ${dim("⎿  ")}${green("✓")} 11 passed ${dim("(1.4s)")}\r\n\r\n`,
    `${green("●")} Wiring the slot picker into the title screen\r\n\r\n${amber("✻")} Working… ${dim("(esc to interrupt)")}\r\n`,
  ];
  const codexScreen = [
    `${dim("~/reef-runner")} ${bold("codex")}\r\n\r\n`,
    `${bold("OpenAI Codex")}  ${dim("nuko-nova/reef-runner")}\r\n\r\n`,
    `${amber(">")} Load the level from a Tiled map file.\r\n\r\n`,
    `${amber("?")} Codex wants to run ${bold("pnpm add -D tiled-map")}\r\n  ${dim("Allow once · Allow always · Deny")}\r\n`,
  ];

  // build-linux is the team machine: runs there use its three slots.
  await run("save-claude", {
    task: tSave,
    harness: "claude-code",
    on: box,
    access: "drive",
    title: "Save slots on the title screen",
    output: claudeScreen,
    state: { state: "working", harness: "claude-code" },
  });
  await run("save-codex", {
    task: tSave,
    harness: "codex",
    on: box,
    access: "drive",
    title: "Save slots on the title screen",
    output: codexScreen,
    state: {
      state: "waiting",
      prompt: {
        kind: "approval",
        text: "Codex wants to run pnpm add -D tiled-map",
        action: "pnpm add -D tiled-map",
      },
    },
  });
  const audio = await run("audio", {
    task: tAudio,
    harness: "codex",
    on: box,
    access: "drive",
    title: "Fix audio pop on level start",
    output: [`${green("✓")} Fixed: ramp the gain over 12ms\r\n`],
    end: 0,
  });
  void audio;
  const deploy = await run("preview", {
    task: tShip,
    harness: "shell",
    on: box,
    access: "drive",
    title: "Deploy preview",
    output: [`${dim("$")} ./deploy-preview.sh\r\nBuilding… \r\n`],
    state: { state: "working", harness: "shell" },
  });
  await m(api.terminals.passWheel, { terminalId: deploy.terminalId, to: memberId("Deploy bot") });

  // julio-mbp is mine: an Open terminal, then the machine's limit drops to Drive, so it shows "Drive, was Open".
  const tiles = await run("tiles", {
    task: tTiles,
    harness: "claude-code",
    on: mbp,
    access: "open",
    title: "Tile map loader",
    output: [
      `${dim("~/reef-runner")} ${bold("claude")}\r\n\r\n${amber(">")} Parse Tiled JSON maps into level data.\r\n\r\n${green("●")} ${bold("Bash")}(pnpm build)\r\n`,
    ],
    state: {
      state: "waiting",
      prompt: {
        kind: "approval",
        text: "Claude Code wants to run pnpm build --filter maps",
        action: "pnpm build --filter maps",
      },
    },
  });
  await run("ship", {
    task: tShip,
    harness: "codex",
    on: mbp,
    access: "suggest",
    title: "Ship 0.4.2",
    output: [`${amber("?")} Codex wants to run ${bold("deploy 0.4.2")}\r\n`],
    state: {
      state: "waiting",
      prompt: {
        kind: "approval",
        text: "Codex wants to run deploy 0.4.2",
        action: "deploy 0.4.2",
        hardToUndo: true,
      },
    },
  });
  await run("footer", {
    task: tFooter,
    harness: "claude-code",
    on: mbp,
    access: "watch",
    title: "Fix footer links",
    output: [`${bold("error")}: could not resolve link /pricing\r\n`],
    end: 1,
  });
  // A retry beside the failed attempt keeps the task in Working, showing as Failed.
  await run("footer-retry", {
    task: tFooter,
    harness: "codex",
    on: mbp,
    access: "watch",
    title: "Fix footer links",
    output: [`${dim("~/website")} ${bold("codex")}\r\n`],
    state: { state: "working", harness: "codex" },
  });
  // A second waiting run on the tile map task that I drive (the first goes to Hermes below), so my
  // Inbox row leads with my own approval.
  await run("tiles-codex", {
    task: tTiles,
    harness: "codex",
    on: mbp,
    access: "suggest",
    title: "Tile map loader",
    output: [`${amber("?")} Codex wants to run ${bold("pnpm add tiled-map")}\r\n`],
    state: {
      state: "waiting",
      prompt: {
        kind: "approval",
        text: "Codex wants to run pnpm add tiled-map",
        action: "pnpm add tiled-map",
      },
    },
  });
  await m(api.machines.updateSettings, { machineId: mbp.machineId, mostOpenAccess: "drive" });
  await m(api.terminals.passWheel, { terminalId: tiles.terminalId, to: memberId("Hermes") });

  // Hermes uses its own key: it suggests a command on the terminal I drive.
  await asAgent(keys["Hermes"]!, "terminals.suggest", {
    terminalId: terminals["save-claude"],
    command: "pnpm test --filter save",
  });
  await asAgent(keys["Hermes"]!, "terminals.requestWheel", { terminalId: terminals["save-codex"] });

  // Threads started in T3 Code: no task, so they are unfiled.
  await send(
    mbp,
    {
      type: "run_state_changed",
      source: { kind: "thread", threadRef: "t3-thread-31" },
      state: "working",
      harness: "claude-code",
      repo: "nuko-nova/reef-runner",
      title: "Try a lighter sprite atlas",
    },
    {
      type: "run_state_changed",
      source: { kind: "thread", threadRef: "t3-thread-32" },
      state: "done",
      harness: "codex",
      repo: "nuko-nova/website",
      title: "Compress hero images",
    },
    {
      type: "run_state_changed",
      source: { kind: "thread", threadRef: "t3-thread-33" },
      state: "working",
      harness: "opencode",
      title: "Spike: voxel fog",
    },
  );

  // ---- messages ----
  await m(api.messages.post, {
    channelId: reefChannel,
    body: "Morning. Save slots are close: the picker works, and **Codex** is waiting on a dependency.\n\n| Task | State |\n|---|---|\n| Save slots | working |\n| Tile map loader | waiting on Hermes |\n\n```ts\nconst slot = await saves.load(2);\n```",
    mentionedTasks: [tSave],
  });
  await asAgent(keys["Notetaker"]!, "messages.post", {
    channelId: reefChannel,
    body: "## Standup notes\n- Save slots: picker done, checkpoint saves next\n- Tile maps: waiting on `pnpm build --filter maps`\n- 0.4.2 needs a person to approve the deploy",
  });
  const chart = `<!doctype html><html><body style="margin:0;font:13px system-ui;background:#fff;color:#15171a"><div style="padding:14px 16px"><b>Playtime per save slot</b><svg viewBox="0 0 320 110" width="100%" style="display:block;margin-top:8px;max-width:360px"><g fill="#4f6fb3"><rect x="20" y="30" width="56" height="70" rx="4"/><rect x="110" y="55" width="56" height="45" rx="4"/><rect x="200" y="12" width="56" height="88" rx="4"/></g><g font-size="11" fill="#5b6069" text-anchor="middle"><text x="48" y="108">Slot 1</text><text x="138" y="108">Slot 2</text><text x="228" y="108">Slot 3</text></g></svg></div></body></html>`;
  await asAgent(keys["Notetaker"]!, "messages.post", {
    channelId: reefChannel,
    format: "html",
    body: chart,
  });
  await m(api.messages.post, { channelId: general, body: "Welcome to the team. Say hi here." });
  await m(api.files.save, {
    projectId: reef,
    name: "design-notes.md",
    content:
      "# Save slots\n\nThree slots. Each shows **playtime** and the last level.\n\n- Save on every checkpoint\n- Never overwrite a slot without asking\n",
  });

  const board = await q<{ taskId: string; title: string }[]>(api.tasks.board, {});
  const tasks = Object.fromEntries(board.map((t) => [t.title, t.taskId]));
  const me = members.find((x) => x.kind === "person")!.memberId;
  const later: Seeded["later"] = {
    async needsYou() {
      await send(box, {
        type: "run_state_changed",
        source: { kind: "terminal", terminalId: terminals["save-claude"] },
        state: "waiting",
        prompt: {
          kind: "approval",
          text: "Claude Code wants to run pnpm test --filter save",
          action: "pnpm test --filter save",
          promptId: randomUUID(),
        },
      });
      await send(mbp, {
        type: "run_state_changed",
        source: { kind: "terminal", terminalId: terminals["footer-retry"] },
        state: "waiting",
        prompt: {
          kind: "approval",
          text: "Codex wants to run deploy website --prod",
          action: "deploy website --prod",
          hardToUndo: true,
          promptId: randomUUID(),
        },
      });
    },
    async saveSlotsMovesOn() {
      await send(box, {
        type: "run_state_changed",
        source: { kind: "terminal", terminalId: terminals["save-claude"] },
        state: "working",
      });
    },
    async finishDeploy() {
      await send(mbp, {
        type: "run_state_changed",
        source: { kind: "terminal", terminalId: terminals["footer-retry"] },
        state: "done",
      });
    },
    async wheelToMe() {
      await asAgent(keys["Hermes"]!, "terminals.passWheel", {
        terminalId: terminals["tiles"],
        to: me,
      });
    },
  };
  return { teamId, terminals, tasks, channels: { reef: reefChannel, general }, later };
}
