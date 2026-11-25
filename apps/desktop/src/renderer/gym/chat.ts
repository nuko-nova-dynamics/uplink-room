import type { World } from "./world";

/**
 * The gym's chat scene (states `chat-*`): a team that talks, as the recordings in fixtures.json
 * don't. #general has three days of messages in runs, threads, reactions, an image, code, a link
 * preview, an agent's summary and a call; #design-crit has messages you haven't read; two direct
 * messages; and search finds what was said. It answers the chat queries itself and takes the chat
 * mutations (post, edit, delete, react, pin, read marks), so a video can send, edit, reply, react and
 * search with no backend. Everything else falls back to the recorded world.
 */
type Json = Record<string, unknown>;
type Author = { kind: "person" | "agent"; memberId: string; name: string; addedBy?: { memberId: string; name: string } };
type Reaction = { emoji: string; memberIds: string[] };
type Attachment = {
  index: number;
  name: string;
  kind: "image" | "file";
  contentType: string;
  size: number;
  restricted: boolean;
  url: string | null;
  downloadUrl: string | null;
};
type Preview = { url: string; title?: string; description?: string; siteName?: string; imageUrl: string | null };
type Msg = {
  messageId: string;
  channelId: string;
  /** Its place in the channel (0 for a line the room wrote, which has none). */
  seq: number;
  /** Order of posting, for paging: every message has one. */
  order: number;
  authorId: string;
  body: string;
  format: "markdown" | "html";
  replyTo?: string;
  postedAt: number;
  editedAt?: number;
  deletedAt?: number;
  reactions: Reaction[];
  attachments: Attachment[];
  previews: Preview[];
  mentioned: string[];
  everyone: boolean;
  mentionedTasks: string[];
  mentionedRuns?: string[];
  pinned?: { at: number; by: string };
  system?: { kind: "pinned"; messageId: string } | { kind: "run"; runId: string; text: string; tone: "info" | "warn" };
  /** The runs it was sent to over A2A (ADR 0024). */
  a2aRuns?: string[];
  /** An agent's message over A2A: its run, and a thread proposal. */
  a2a?: { runId: string; proposal?: { title?: string; status: "pending" | "accepted" | "declined" | "canceled"; reason?: string; expiresAt: number; triggerMessageId: string; decidedBy?: string; decidedAt?: number } };
  /** The live runs it is addressed to (ADR 0026). */
  addressedRuns?: string[];
  /** Posted by a live run as itself: the run and its name then. authorId is its driver. */
  asRun?: { runId: string; label: string };
  /** Hosted agents it reached that the room can't follow (slice 14 of #139), as messages.get gives them. */
  deliveries?: Json[];
  /** A reply also sent to the channel shows there through a row of its own (messages.echoOf). */
  echoOf?: string;
  echoId?: string;
};

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A tide chart drawn on a canvas, as the image a teammate posted. */
function tideChart(dark: boolean): string {
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 540;
  const g = canvas.getContext("2d");
  if (!g) return "";
  g.fillStyle = dark ? "#1b1d21" : "#ffffff";
  g.fillRect(0, 0, 960, 540);
  g.strokeStyle = dark ? "#2c2f34" : "#e3e6ea";
  g.lineWidth = 1;
  for (let x = 80; x <= 900; x += 82) {
    g.beginPath();
    g.moveTo(x, 60);
    g.lineTo(x, 470);
    g.stroke();
  }
  for (let y = 60; y <= 470; y += 82) {
    g.beginPath();
    g.moveTo(80, y);
    g.lineTo(900, y);
    g.stroke();
  }
  const curve = (phase: number, color: string, amp: number) => {
    g.strokeStyle = color;
    g.lineWidth = 4;
    g.beginPath();
    for (let x = 80; x <= 900; x += 4) {
      const y = 265 - amp * Math.sin(((x - 80) / 820) * Math.PI * 3.9 + phase);
      if (x === 80) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  };
  curve(0, "#7E9DEB", 150);
  curve(0.35, dark ? "#5FC38F" : "#117A49", 132);
  g.fillStyle = dark ? "#c9ccd1" : "#3b3f45";
  g.font = "600 26px sans-serif";
  g.fillText("Harbor entrance, 7-day tide (m)", 80, 40);
  g.font = "18px sans-serif";
  for (const [i, d] of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].entries()) g.fillText(d, 96 + i * 117, 505);
  return canvas.toDataURL("image/png");
}

/** What a direct message opened with Theo's team run says, as the room words it (channels.list, its first line). */
const THEO_WARNING = "Claude Code (Theo Park)'s output is visible to the whole team, so what you send here won't stay private.";

/**
 * Talking with Icarus, an agent the team sends work over A2A (ADR 0024): a direct message while it
 * works, after it answered, while it asks, after it failed; #general with "@Icarus hey there"
 * answered inline; a thread it answers in; and a thread it proposes, pending, accepted, declined, or
 * canceled because its run was stopped.
 */

export type AgentScene =
  | "dm-working"
  | "dm-mention"
  | "dm-answered"
  | "dm-asking"
  | "dm-failed"
  | "dm-failed-line"
  | "channel-hey"
  | "thread"
  | "proposal"
  | "proposal-accepted"
  | "proposal-declined"
  | "proposal-canceled";

/** Icarus's direct message with you in the agent scenes. */
export const ICARUS_DM = "gym-dm-icarus";

/** The live runs of the runs scene (ADR 0026): yours, Ana's and Theo's, and a direct message with Theo's. */
export const GYM_RUNS = { rosa: "k57gymrunrosa01", ana: "k57gymrunana001", theo: "k57gymruntheo01", mia: "k57gymrunmia001" } as const;
export const RUN_DM = "gym-dm-run-theo";

export class ChatWorld {
  private readonly base: World;
  private readonly me: string;
  private readonly people: Record<"rosa" | "ana" | "theo" | "mia" | "hermes" | "notetaker" | "icarus" | "grok" | "duet", Author>;
  /** The hosted assistants scene: Grok Bot at its routine webhook, Duet checking in on its own schedule. */
  private readonly hosted: boolean;
  /** The A2A runs the agent scenes show (runs.get). */
  private readonly runs = new Map<string, Json>();
  private readonly members: Json[];
  private messages: Msg[] = [];
  private readonly reads = new Map<string, number>();
  private readonly firstPage = new Map<string, number>();
  private readonly cache = new Map<string, { version: number; value: unknown }>();
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private nextId = 1;
  /** Who is typing where (channels.whoIsTyping), and when each last typed. */
  private typing: { memberId: string; channelId: string; replyTo?: string; at: number; working?: boolean }[] = [];
  readonly channels: { general: string; crit: string; ana: string; theo: string; tide: string; icarus: string; runDm: string };
  /** The runs scene: live runs to mention, message and open (ADR 0026). */
  private readonly liveRuns: Json[] = [];
  private readonly inboxes = new Map<string, Json>();
  /** The ids the gym's flows and states point at. */
  readonly ids: Record<string, string> = {};

  constructor(base: World, dark: boolean, scene?: AgentScene, runs = false, hosted = false) {
    this.base = base;
    this.hosted = hosted;
    const recordedMembers = base.members;
    this.me = base.me["memberId"] as string;
    const ana = recordedMembers.find((m) => m.memberId !== this.me)!.memberId as string;
    const rosa: Author = { kind: "person", memberId: this.me, name: recordedMembers.find((m) => m.memberId === this.me)!.name as string };
    this.people = {
      rosa,
      ana: { kind: "person", memberId: ana, name: "Ana Ruiz" },
      theo: { kind: "person", memberId: "k57gymtheopark0", name: "Theo Park" },
      mia: { kind: "person", memberId: "k57gymmiachen00", name: "Mia Chen" },
      hermes: { kind: "agent", memberId: "k57gymhermes000", name: "Hermes", addedBy: { memberId: rosa.memberId, name: rosa.name } },
      notetaker: { kind: "agent", memberId: "k57gymnotetaker", name: "Notetaker", addedBy: { memberId: ana, name: "Ana Ruiz" } },
      icarus: { kind: "agent", memberId: "k57gymicarus000", name: "Icarus", addedBy: { memberId: rosa.memberId, name: rosa.name } },
      grok: { kind: "agent", memberId: "k57gymgrokbot00", name: "Grok Bot", addedBy: { memberId: rosa.memberId, name: rosa.name } },
      duet: { kind: "agent", memberId: "k57gymduet00000", name: "Duet", addedBy: { memberId: ana, name: "Ana Ruiz" } },
    };
    this.members = [
      ...recordedMembers,
      { kind: "person", memberId: "k57gymtheopark0", name: "Theo Park", role: "member" },
      { kind: "person", memberId: "k57gymmiachen00", name: "Mia Chen", role: "member" },
      {
        kind: "agent",
        memberId: "k57gymhermes000",
        name: "Hermes",
        role: "member",
        addedBy: { memberId: rosa.memberId, name: rosa.name },
        character: { body: "hermes", color: "coral", accessory: "hermes" },
      },
      {
        kind: "agent",
        memberId: "k57gymnotetaker",
        name: "Notetaker",
        role: "member",
        addedBy: { memberId: ana, name: "Ana Ruiz" },
        character: { body: "notetaker", color: "sage", accessory: "notetaker" },
      },
      {
        kind: "agent",
        memberId: "k57gymicarus000",
        name: "Icarus",
        role: "member",
        addedBy: { memberId: rosa.memberId, name: rosa.name },
        character: { body: "scribe", color: "teal", accessory: "scribe" },
      },
    ];
    this.channels = {
      general: base.general,
      crit: base.privateChannel,
      ana: base.dm,
      theo: "gym-dm-theo",
      tide: base.channels.find((c) => c.projectId !== undefined)?.channelId ?? "gym-tide",
      icarus: ICARUS_DM,
      runDm: RUN_DM,
    };
    if (hosted) {
      this.members.push(
        { kind: "agent", memberId: "k57gymgrokbot00", name: "Grok Bot", role: "member", addedBy: { memberId: rosa.memberId, name: rosa.name }, character: { body: "deploy", color: "blue", accessory: "deploy" }, reach: "webhook" },
        { kind: "agent", memberId: "k57gymduet00000", name: "Duet", role: "member", addedBy: { memberId: ana, name: "Ana Ruiz" }, character: { body: "scribe", color: "sage", accessory: "scribe" }, reach: "checks_in" },
      );
    }
    this.write(tideChart(dark));
    if (scene) this.writeAgent(scene);
    if (runs) this.writeRuns();
    if (hosted) this.writeHosted();
  }

  // ---------- hosted assistants (slice 14 of #139) ----------

  /**
   * #general with Grok Bot, reached at its routine webhook (one send went out, one failed), and Duet,
   * which checks in on its own schedule (one message it has seen and answered, one still waiting).
   * Sample data.
   */
  private writeHosted(): void {
    const { rosa, ana, grok, duet } = this.people;
    const now = Date.now();
    const ago = (minutes: number) => now - minutes * MIN;
    const g = this.channels.general;
    const to = (a: Author) => ({ kind: a.kind, memberId: a.memberId, name: a.name, ...(a.addedBy ? { addedBy: a.addedBy } : {}) });
    const tokenOf = (a: Author) => `<@${a.memberId}>`;
    this.add(g, ana.memberId, ago(52), `${tokenOf(duet)} can you book the Bayview site visit for Thursday morning?`, {
      mentioned: [duet.memberId],
      deliveries: [{ to: to(duet), via: "check_in", status: "seen", at: ago(52), settledAt: ago(31) }],
    });
    this.add(g, duet.memberId, ago(30), "Booked Thursday at 9:00 with the harbor office. They want the crew list by Wednesday.", {});
    this.add(g, rosa.memberId, ago(14), `${tokenOf(grok)} what changed in the tide export this week?`, {
      mentioned: [grok.memberId],
      deliveries: [{ to: to(grok), via: "webhook", status: "sent", at: ago(14), settledAt: ago(14) }],
    });
    this.add(g, grok.memberId, ago(11), "Three changes landed: heights are rounded to the centimeter, Bayview lost its +4 minute correction, and the CSV now carries each station's ID.", {});
    this.add(g, ana.memberId, ago(6), `${tokenOf(grok)} open an issue for the missing Kingston readings`, {
      mentioned: [grok.memberId],
      deliveries: [
        {
          to: to(grok),
          via: "webhook",
          status: "failed",
          reason: "The webhook answered HTTP 401: invalid routine key. Check that the key is the routine's current key.",
          at: ago(6),
          settledAt: ago(6),
        },
      ],
    });
    this.add(g, ana.memberId, ago(2), `${tokenOf(duet)} add the crew list to Thursday's invite too`, {
      mentioned: [duet.memberId],
      deliveries: [{ to: to(duet), via: "check_in", status: "waiting", at: ago(2) }],
    });
    this.reads.set(g, this.lastSeq(g));
  }

  // ---------- live runs in chat (ADR 0026) ----------

  /** Three live runs, messages to and from them in #general, a direct message with Theo's run, and their inboxes. */
  private writeRuns(): void {
    const { rosa, ana, theo } = this.people;
    const now = Date.now();
    const ago = (minutes: number) => now - minutes * MIN;
    const machine = (this.base.get<Json[]>("machines:list") ?? [])[0];
    const machineRef = machine ? { machineId: machine["machineId"], name: machine["name"] } : { machineId: "gym-machine", name: "rosa-mbp" };
    const who = (a: Author) => ({ kind: a.kind, memberId: a.memberId, name: a.name });
    const live = (runId: string, harness: string, label: string, driver: Author, task: string, hears: "anyone" | "driver", hearing: string, startedAt: number, more: Json = {}) => {
      const row = {
        runId,
        token: `<@run:${runId}>`,
        label,
        harness,
        state: "working",
        title: task,
        private: false,
        task: { taskId: `gym-task-${runId}`, title: task },
        driver: who(driver),
        accountable: who(driver),
        machine: machineRef,
        via: "terminal",
        hears,
        hearsYou: hears === "anyone" || driver.memberId === this.me,
        hearing,
        // Every run here is a team run: the whole team can see its terminal (ADR 0039).
        visibleToTeam: true,
        startedAt,
      };
      this.liveRuns.push(row);
      this.runs.set(runId, {
        runId,
        harness,
        title: task,
        state: "working",
        private: false,
        driver: who(driver),
        machine: machineRef,
        startedAt,
        stateChangedAt: startedAt + 30_000,
        step: "Running pnpm test export",
        taskId: this.base.taskId,
        ...more,
      });
    };
    live(GYM_RUNS.rosa, "claude-code", "Claude Code (Rosa Vega)", rosa, "Round tide heights in the CSV export", "anyone", "mid_task", ago(48), {
      terminalId: this.base.terminalId,
    });
    live(GYM_RUNS.ana, "codex", "Codex (Ana Ruiz)", ana, "Fix the DST offset at Bayview", "driver", "between_turns", ago(35));
    live(GYM_RUNS.theo, "claude-code", "Claude Code (Theo Park)", theo, "Refresh the tide chart every 6 minutes", "anyone", "unknown", ago(20));

    const g = this.channels.general;
    const toRosaRun = this.add(g, ana.memberId, ago(9), `<@run:${GYM_RUNS.rosa}> when the export is done, release the crane model. I'm taking over the rigging.`, {
      addressedRuns: [GYM_RUNS.rosa],
    });
    const fromAnaRun = this.add(g, ana.memberId, ago(7), `<@run:${GYM_RUNS.rosa}> Bayview's offset is 0 on main now, so the export can drop the +4 minute correction.`, {
      addressedRuns: [GYM_RUNS.rosa],
      asRun: { runId: GYM_RUNS.ana, label: "Codex (Ana Ruiz)" },
    });
    this.add(g, rosa.memberId, ago(4), "Export is done and the crane model is released, it's yours. I dropped the +4 minute correction too.", {
      asRun: { runId: GYM_RUNS.rosa, label: "Claude Code (Rosa Vega)" },
    });
    this.reads.set(g, this.lastSeq(g));

    const dm = this.channels.runDm;
    // The room's first line when the direct message opened (ADR 0039, amended 2026-11-05).
    this.add(dm, theo.memberId, ago(17), "", { system: { kind: "run", runId: GYM_RUNS.theo, text: THEO_WARNING, tone: "info" } });
    this.add(dm, rosa.memberId, ago(16), "Does the chart refresh keep the zoom level someone set?", {});
    this.add(dm, theo.memberId, ago(15), "Yes. It keeps the zoom and the station, and only redraws the curve.", {
      asRun: { runId: GYM_RUNS.theo, label: "Claude Code (Theo Park)" },
    });
    this.add(dm, rosa.memberId, ago(2), "Good. Can it pause while a call is sharing the chart?", {});
    this.reads.set(dm, this.lastSeq(dm));

    const place = (channelId: string) => (channelId === g ? "#general" : "a direct message");
    this.inboxes.set(GYM_RUNS.rosa, {
      runId: GYM_RUNS.rosa,
      label: "Claude Code (Rosa Vega)",
      waiting: 1,
      messages: [
        {
          messageId: fromAnaRun,
          channelId: g,
          place: place(g),
          text: "@Claude Code (Rosa Vega) Bayview's offset is 0 on main now, so the export can drop the +4 minute correction.",
          attachments: 0,
          from: { member: who(ana), run: { runId: GYM_RUNS.ana, label: "Codex (Ana Ruiz)" } },
          accountable: who(ana),
          fromDriver: false,
          status: "waiting",
          at: ago(7),
        },
        {
          messageId: toRosaRun,
          channelId: g,
          place: place(g),
          text: "@Claude Code (Rosa Vega) when the export is done, release the crane model. I'm taking over the rigging.",
          attachments: 0,
          from: { member: who(ana) },
          accountable: who(ana),
          fromDriver: false,
          status: "delivered",
          how: "mid_task",
          at: ago(9),
        },
        {
          messageId: "gym-msg-rosa-own",
          channelId: dm,
          place: "a direct message",
          text: "Run the export against all 12 stations, not just Bayview.",
          attachments: 0,
          from: { member: who(rosa) },
          accountable: who(rosa),
          fromDriver: true,
          status: "delivered",
          how: "next_turn",
          at: ago(40),
        },
      ],
    });
    this.inboxes.set(GYM_RUNS.ana, { runId: GYM_RUNS.ana, label: "Codex (Ana Ruiz)", waiting: 2 });
    this.inboxes.set(GYM_RUNS.theo, { runId: GYM_RUNS.theo, label: "Claude Code (Theo Park)", waiting: 2 });

    // Mia's Codex session joined by itself with uplink join (ADR 0032): no machine, terminal or
    // thread, and no state of its own, so it is Live while it lasts.
    const mia = this.people.mia;
    const joinedAt = ago(14);
    this.liveRuns.push({
      runId: GYM_RUNS.mia,
      token: `<@run:${GYM_RUNS.mia}>`,
      label: "Codex (Mia Chen)",
      harness: "codex",
      state: "unknown",
      private: false,
      driver: who(mia),
      accountable: who(mia),
      via: "joined",
      hears: "anyone",
      hearsYou: true,
      hearing: "mid_task",
      visibleToTeam: true,
      startedAt: joinedAt,
    });
    this.runs.set(GYM_RUNS.mia, {
      runId: GYM_RUNS.mia,
      harness: "codex",
      state: "unknown",
      private: false,
      driver: who(mia),
      joined: true,
      startedAt: joinedAt,
      stateChangedAt: joinedAt,
    });
    this.inboxes.set(GYM_RUNS.mia, { runId: GYM_RUNS.mia, label: "Codex (Mia Chen)", waiting: 0 });
    this.joinedRoster = true;
  }

  /** The runs scene has a joined run, which the roster lists as its own harness's (ADR 0032). */
  private joinedRoster = false;

  // ---------- talking with Icarus over A2A (ADR 0024) ----------

  /** A run sent to Icarus, as runs.get shows it. */
  private run(id: string, title: string, state: string, opts: { failReason?: string; question?: string; answer?: string; place?: string; following?: boolean; artifacts?: Json[] } = {}): string {
    const runId = `gym-run-icarus-${id}`;
    const at = Date.now() - 4 * MIN;
    const me = { memberId: this.me, name: this.people.rosa.name, kind: "person" };
    const ended = state === "done" || state === "failed" || state === "stopped";
    this.runs.set(runId, {
      runId,
      harness: "a2a",
      title,
      state,
      ...(opts.failReason ? { failReason: opts.failReason } : {}),
      ...(opts.question ? { prompt: { kind: "question", text: opts.question } } : {}),
      private: false,
      driver: me,
      canReply: true,
      startedAt: at,
      stateChangedAt: at + 20_000,
      ...(ended ? { endedAt: at + 20_000 } : {}),
      a2a: {
        agent: { agentId: "gym-agent-icarus", memberId: this.people.icarus.memberId, name: "Icarus" },
        connected: true,
        canCancel: "supported",
        externalState: { working: "TASK_STATE_WORKING", waiting: "TASK_STATE_INPUT_REQUIRED", done: "TASK_STATE_COMPLETED", failed: "TASK_STATE_FAILED", stopped: "TASK_STATE_CANCELED" }[state],
        observedAt: at + 20_000,
        contextId: "gym-context-icarus",
        taskId: `gym-task-${id}`,
        following: opts.following ?? !ended,
        delivery: "sent",
        ...(opts.answer ? { lastMessage: opts.answer } : {}),
        artifacts: opts.artifacts ?? [],
        lastContactAt: at + 20_000,
        replies: state === "working" ? "task" : state === "waiting" ? "task" : "conversation",
        ...(opts.place ? { place: { channelId: opts.place } } : {}),
        messages: [{ kind: "start", text: title, at, status: "sent", by: me }],
      },
    });
    return runId;
  }

  /** Icarus in the roster: the most urgent state among its runs, idle with none live. */
  private icarusRoster(): { state: string; runs: number; line?: string } {
    const live = [...this.runs.values()].filter((r) => ["working", "waiting", "failed"].includes(r["state"] as string));
    const state = ["waiting", "failed", "working"].find((st) => live.some((r) => r["state"] === st)) ?? "idle";
    // What the room's roster says it's on: its most urgent live run's title.
    const lead = live.find((r) => r["state"] === state);
    const line = lead?.["title"] as string | undefined;
    return { state, runs: live.length, ...(line ? { line } : {}) };
  }

  private writeAgent(scene: AgentScene): void {
    const { rosa, ana, icarus } = this.people;
    const now = Date.now();
    const ago = (minutes: number) => now - minutes * MIN;
    const mention = `<@${icarus.memberId}>`;
    const dm = this.channels.icarus;
    const g = this.channels.general;
    const say = (channelId: string, who: Author, at: number, body: string, more: Partial<Msg> = {}) => this.add(channelId, who.memberId, at, body, more);
    const fromIcarus = (channelId: string, at: number, body: string, runId: string, more: Partial<Msg> = {}) =>
      say(channelId, icarus, at, body, { a2a: { runId }, ...more });

    if (scene.startsWith("dm-")) {
      // Earlier today: one finished exchange, so the conversation has history.
      const first = this.run("dm-1", "Tides at Bayview", "done", {
        place: dm,
        answer: "High tide at Bayview is 06:42 and 19:10 today.",
        // What the agent made, as A2A artifacts: a table it read the times from.
        artifacts: [
          {
            artifactId: "gym-artifact-bayview",
            name: "bayview-tides-today.csv",
            text: "time,height_m,type\n06:42,1.8,high\n12:55,0.3,low\n19:10,2.1,high\n01:20,0.4,low",
            urls: [],
            truncated: false,
            hasData: false,
          },
        ],
      });
      say(dm, rosa, ago(52), "When is high tide at Bayview today?", { a2aRuns: [first] });
      fromIcarus(dm, ago(51), "High tide at Bayview is **06:42** and **19:10** today (local time). The 19:10 one is the higher of the two, at 2.1 m.", first);
      if (scene === "dm-working" || scene === "dm-mention") {
        const run = this.run("dm-2", "Compare with last year's table", "working", { place: dm });
        say(dm, rosa, ago(1), "Can you compare that with last year's published table for the same date?", scene === "dm-mention" ? { mentionedRuns: [run] } : { a2aRuns: [run] });
        fromIcarus(dm, ago(1) + 20_000, "Reading last year's table from the harbor authority's archive.", run);
        this.typing.push({ memberId: icarus.memberId, channelId: dm, at: ago(1), working: true });
      } else if (scene === "dm-answered") {
        const run = this.run("dm-2", "Compare with last year's table", "done", { place: dm });
        say(dm, rosa, ago(6), "Can you compare that with last year's published table for the same date?", { a2aRuns: [run] });
        fromIcarus(
          dm,
          ago(5),
          "Last year on the same date high tide was at 06:31 and 18:58, so this year is about **11 minutes later**. That matches the station's new offset of +4 minutes plus the lunar cycle.\n\n- [bayview-2025.pdf](https://example.com/bayview-2025.pdf)",
          run,
        );
      } else if (scene === "dm-asking") {
        const run = this.run("dm-2", "Release note for Bayview", "waiting", { place: dm, question: "Which release note: the CSV export one, or the DST fix?" });
        say(dm, rosa, ago(3), "Draft a line for the release note about Bayview.", { a2aRuns: [run] });
        fromIcarus(dm, ago(2), "Which release note: the CSV export one, or the DST fix?", run);
      } else {
        const reason = "Icarus couldn't finish: the harbor authority's archive answered HTTP 503.";
        const run = this.run("dm-2", "Compare with last year's table", "failed", { place: dm, failReason: reason });
        say(dm, rosa, ago(4), "Can you compare that with last year's published table for the same date?", { a2aRuns: [run] });
        if (scene === "dm-failed-line") fromIcarus(dm, ago(3), "The archive did not answer this request.", run);
        else say(dm, icarus, ago(3), "", { system: { kind: "run", runId: run, text: reason, tone: "warn" } });
      }
      this.reads.set(dm, this.lastSeq(dm));
      return;
    }

    if (scene === "channel-hey") {
      const hey = this.run("hey", "@Icarus hey there", "done", { place: g });
      say(g, rosa, ago(2), `${mention} hey there`, { mentioned: [icarus.memberId], a2aRuns: [hey] });
      fromIcarus(g, ago(2) + 15_000, "Hi Rosa. I can look up tide times and published tables, or draft release notes. What do you need?", hey, { mentioned: [this.me] });
      this.typing = [];
      this.reads.set(g, this.lastSeq(g));
      return;
    }

    if (scene === "thread") {
      const root = say(g, ana, ago(30), "Release notes for Thursday: who has the list of fixes?");
      const run = this.run("thread", "Release notes for Thursday", "done", { place: g });
      this.add(g, rosa.memberId, ago(12), `${mention} draft them from this week's merged pull requests`, { replyTo: root, mentioned: [icarus.memberId], a2aRuns: [run] });
      fromIcarus(
        g,
        ago(11),
        "Here's a draft from the 6 pull requests merged this week:\n\n- CSV export for tide tables, by station and date range.\n- Bayview's offset is now 0, matching the published table.\n- The chart updates every 6 minutes without a reload.\n\nThe iCal export waits for the DST fix, so I left it out.",
        run,
        { replyTo: root },
      );
      this.add(g, ana.memberId, ago(8), `${mention} can you add the DST fix as a known issue?`, { replyTo: root, mentioned: [icarus.memberId], a2aRuns: [this.run("thread-2", "Known issue", "working", { place: g })] });
      this.typing = [{ memberId: icarus.memberId, channelId: g, replyTo: root, at: ago(8), working: true }];
      this.ids["agentThread"] = root;
      this.reads.set(g, this.lastSeq(g));
      return;
    }

    // A thread Icarus proposes for the work it was asked.
    const asked = this.run("plan", "Plan the Q3 station migration", scene === "proposal" ? "waiting" : scene === "proposal-canceled" ? "stopped" : "done", { place: g });
    const trigger = say(g, rosa, ago(3), `${mention} plan the migration of the 12 stations to the new feed for Q3`, { mentioned: [icarus.memberId], a2aRuns: [asked] });
    const expiresAt = scene === "proposal" ? now + 24_000 : ago(2);
    const proposal = fromIcarus(g, ago(3) + 10_000, "This looks like it should be its own thread. Want me to open it?", asked, { mentioned: [this.me] });
    const decided =
      scene === "proposal"
        ? {}
        : scene === "proposal-canceled"
          ? { decidedAt: ago(2), reason: `No thread opened: ${this.people.rosa.name} stopped the run.` }
          : { decidedBy: this.me, decidedAt: ago(2) };
    this.find(proposal)!.a2a!.proposal = {
      title: "Q3 station migration",
      status: scene === "proposal" ? "pending" : scene === "proposal-accepted" ? "accepted" : scene === "proposal-canceled" ? "canceled" : "declined",
      expiresAt,
      triggerMessageId: trigger,
      ...decided,
    };
    const plan = "Here's a first plan, one station a week:\n\n1. Bayview and Harbor Entrance first: they already send to the new feed.\n2. The 5 northern stations next, after their offsets are checked.\n3. The rest by the end of September, with the old feed kept read-only until October.";
    if (scene === "proposal-accepted") {
      const next = this.run("plan-2", "Plan the Q3 station migration", "done", { place: g });
      fromIcarus(g, ago(1), plan, next, { replyTo: trigger });
      this.ids["agentThread"] = trigger;
    } else if (scene === "proposal-declined") {
      const next = this.run("plan-2", "Plan the Q3 station migration", "done", { place: g });
      fromIcarus(g, ago(1), plan, next);
    }
    this.typing = [];
    this.reads.set(g, this.lastSeq(g));
  }

  // ---------- the conversation ----------

  private write(chart: string): void {
    const { rosa, ana, theo, mia, hermes, notetaker } = this.people;
    const g = this.channels.general;
    const now = Date.now();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    // Earlier days at set hours; today counted back from now, so it is always in the past.
    const day = (n: number, h: number, m: number) => today.getTime() - n * 24 * HOUR + h * HOUR + m * MIN;
    const ago = (minutes: number) => now - minutes * MIN;
    const say = (channelId: string, who: Author, at: number, body: string, more: Partial<Msg> = {}) => this.add(channelId, who.memberId, at, body, more);
    const reply = (parent: string, who: Author, at: number, body: string, more: Partial<Msg> = {}) =>
      this.add(this.find(parent)!.channelId, who.memberId, at, body, { replyTo: parent, ...more });
    const react = (id: string, emoji: string, ...who: Author[]) => {
      this.find(id)!.reactions.push({ emoji, memberIds: who.map((w) => w.memberId) });
    };
    const mention = (who: Author) => `<@${who.memberId}>`;
    const task = this.base.taskId;

    // Two days ago: the export, a code question, a pull request.
    say(g, ana, day(2, 9, 2), "Morning all. Plan for today: finish the CSV export, then the harbor-entrance chart.");
    say(g, theo, day(2, 9, 4), "Morning! I'll take the chart.");
    say(g, theo, day(2, 9, 4) + 20_000, "Does anyone know where the station offsets live now?");
    say(g, rosa, day(2, 9, 7), "In `stations.json`, under `offsets`. They moved there last week.");
    const offsets = say(
      g,
      rosa,
      day(2, 9, 8),
      "Roughly:\n\n```ts\nconst offset = stations[id].offsets.high ?? 0;\nconst local = addMinutes(prediction.at, offset);\n```",
    );
    react(offsets, "🙏", theo);
    say(g, theo, day(2, 9, 10), "Perfect, thanks.");
    say(g, mia, day(2, 10, 31), "Heads up: the staging deploy is paused until the migration finishes. Should be about 20 minutes.");
    say(g, mia, day(2, 11, 2), "Staging is back.");
    const pr = say(g, ana, day(2, 14, 15), "Export PR is up: https://github.com/harbor-labs/tide-tables/pull/212", {
      previews: [
        {
          url: "https://github.com/harbor-labs/tide-tables/pull/212",
          title: "Export tide tables as CSV and iCal · Pull Request #212",
          description: "Adds a station picker, a date range and two formats. Times are local to the station.",
          siteName: "GitHub",
          imageUrl: null,
        },
      ],
    });
    react(pr, "👀", rosa, theo);
    say(g, rosa, day(2, 14, 40), "Reviewing now.");
    say(g, rosa, day(2, 15, 12), "Left a few notes. The iCal times are off by the DST change in March; the rest looks good.");
    say(g, ana, day(2, 15, 14), "Good catch. Fixing.");

    // Yesterday: a chart, a thread, a call with notes, Hermes' summary, a pin.
    say(g, theo, day(1, 9, 20), "First pass at the harbor-entrance chart:", {
      attachments: [
        { index: 0, name: "harbor-entrance-7day.png", kind: "image", contentType: "image/png", size: 182_400, restricted: false, url: chart, downloadUrl: null },
      ],
    });
    const chartThread = say(g, theo, day(1, 9, 21), "Blue is predicted, green is observed. Feedback welcome before I wire it to live data.");
    react(chartThread, "🔥", ana, mia);
    react(chartThread, "👍", rosa);
    reply(chartThread, ana, day(1, 9, 30), "Love it. Can the observed line be dashed, so it reads in print too?");
    reply(chartThread, theo, day(1, 9, 33), "Yes, easy.");
    reply(chartThread, mia, day(1, 9, 41), "Could the y-axis start at the lowest tide instead of 0? The swing is hard to see.");
    reply(chartThread, rosa, day(1, 9, 44), "+1 to Mia. And label the units on the axis, not just the title.");
    const done = reply(chartThread, theo, day(1, 10, 2), "All three done in the next push.");
    this.alsoInChannel(done);
    this.ids["chartThread"] = chartThread;
    say(g, ana, day(1, 10, 58), "Quick call about the export in 5, here in #general.");
    this.ids["callStart"] = String(day(1, 11, 3));
    const notes = say(
      g,
      notetaker,
      day(1, 11, 29),
      "**Notes from the call** (25 min, Ana, Rosa, Theo)\n\n- CSV export ships Thursday; iCal waits for the DST fix.\n- Theo wires the chart to live readings after the export ships.\n- Rosa writes the release note.",
    );
    react(notes, "✅", ana, rosa, theo);
    const decision = say(g, ana, day(1, 11, 35), "Pinning the decision: **CSV ships Thursday, iCal after the DST fix.**", {
      pinned: { at: day(1, 11, 36), by: ana.memberId },
    });
    say(g, ana, day(1, 11, 36), "", { system: { kind: "pinned", messageId: decision } });
    say(g, hermes, day(1, 13, 5), `${mention(rosa)} I checked the export against last year's published tables for 12 stations.\n\n- 11 match to the minute.\n- Bayview is 4 minutes late on every high tide: its offset in \`stations.json\` is +4, the published table uses 0.\n\nWant me to open a task for Bayview?`, {
      mentioned: [rosa.memberId],
    });
    say(g, rosa, day(1, 13, 12), `Yes please, ${mention(hermes)}. Assign it to me.`, { mentioned: [hermes.memberId] });
    say(g, hermes, day(1, 13, 13), "Done: the task is on the Tide Tables board.", { mentionedTasks: [task] });
    const oops = say(g, mia, day(1, 15, 20), "deploying to prod now", { deletedAt: day(1, 15, 21) });
    reply(oops, theo, day(1, 15, 21), "Wait, staging first?");
    reply(oops, mia, day(1, 15, 22), "Yes, wrong channel. Deleted, all fine.");
    say(g, theo, day(1, 16, 40), "Chart v2 is pushed. Dashed observed line, tighter y-axis, units on the axis.");
    say(g, rosa, day(1, 16, 52), "Looks great. Merging after CI.", { editedAt: day(1, 16, 53) });
    say(g, mia, day(1, 17, 5), "🎉");

    // Today: a busy hour or two, then a question for you.
    say(g, ana, ago(95), "Morning. CI on main is green and the export is on staging.");
    say(g, ana, ago(94), "Release note draft, anyone? I can start one if Rosa is busy.");
    say(g, rosa, ago(88), "I have it. Should be in the doc by 10.");
    say(g, theo, ago(80), "Live readings for the chart: the station feed sends every 6 minutes, so I'll poll every 6 and cache in between.");
    say(g, theo, ago(80) + 15_000, "Unless someone knows of a push feed?");
    say(g, mia, ago(73), "There isn't one, polling is right.");
    for (let i = 0; i < 6; i++) {
      say(g, [ana, theo, mia][i % 3]!, ago(66 - i * 7), [
        "Staging export: 12 stations, 7 days, 0.4 s.",
        "Nice. Is that cold or warm?",
        "Cold. Warm is under 0.1 s.",
        "Then we don't need the job queue for v1.",
        "Agreed, we can add it when someone asks for a year.",
        "Writing that down in the decisions doc.",
      ][i]!);
    }
    say(g, rosa, ago(24), "Release note is in the doc. Two lines for the DST fix, since people will ask.");
    const question = say(g, ana, ago(14), `${mention(rosa)} can you check the release note mentions Bayview? People there will notice the 4 minutes.`, {
      mentioned: [rosa.memberId],
    });
    react(question, "👍", theo);
    say(g, theo, ago(9), "Chart is wired to live readings on staging. It updates every 6 minutes without a reload.");
    say(g, theo, ago(8), "Try it on Bayview, the observed line is right on the predicted one now.");
    this.ids["question"] = question;
    this.typing.push({ memberId: theo.memberId, channelId: g, at: now });
    this.typing.push({ memberId: ana.memberId, channelId: g, replyTo: chartThread, at: now });

    // #design-crit: you read up to two days ago; Ana and Mia posted since.
    const crit = this.channels.crit;
    say(crit, rosa, day(2, 16, 0), "Header spacing pass, round two. Screenshots coming.");
    say(crit, ana, day(2, 16, 30), "The new spacing reads much calmer.");
    this.reads.set(crit, this.lastSeq(crit));
    say(crit, mia, ago(130), "Two things on the board cards:");
    say(crit, mia, ago(130) + 30_000, "1. The owner's face and the run marks are the same size, so it's hard to tell who owns a card.\n2. The age on the right wraps at the smallest window.");
    say(crit, ana, ago(100), "Agree on 1. For 2, could the age drop below the title instead of wrapping?");
    say(crit, mia, ago(96), `${mention(rosa)} what do you think?`, { mentioned: [rosa.memberId] });
    for (const [who, minutes, body] of [
      [ana, 90, "I tried the age under the title in the prototype. It reads well at 960 px."],
      [mia, 88, "And the owner's face could go to 20 px, with the run marks at 14."],
      [ana, 85, "Yes. Then the faces line up with the state dots too."],
      [mia, 80, "Mocking it now."],
      [mia, 61, "Here's the card with both changes: the age sits under the title, and the owner's face is the bigger one."],
      [ana, 58, "Much clearer. One nit: the age is muted on muted when the card is hovered."],
      [mia, 55, "Good catch, it should stay at the muted token on hover."],
      [ana, 41, "Shall we ship it with the board pass on Thursday?"],
    ] as const) {
      say(crit, who, ago(minutes), body);
    }

    // Direct messages.
    const dm = this.channels.ana;
    say(dm, ana, day(1, 18, 2), "Can you join the call in #general at 3 tomorrow?");
    say(dm, rosa, day(1, 18, 5), "Yes, see you there.");
    say(dm, ana, ago(180), "Also, thanks for catching the DST thing. That would have been a bad Monday.");
    say(dm, rosa, ago(176), "Happy to. It was the tests, really.");
    for (const id of [g, dm, this.channels.tide]) this.reads.set(id, this.lastSeq(id));
    const theoDm = this.channels.theo;
    say(theoDm, theo, ago(26), "Do you have five minutes after lunch to look at the chart colors?");
    this.reads.set(theoDm, 0);
  }

  /** Shows a reply in its channel's list too (Also send to #channel). */
  private alsoInChannel(replyId: string): void {
    const reply = this.find(replyId)!;
    reply.echoId = this.add(reply.channelId, reply.authorId, reply.postedAt + 1, "", { echoOf: replyId });
  }

  private add(channelId: string, authorId: string, at: number, body: string, more: Partial<Msg> = {}): string {
    const order = this.nextId++;
    const messageId = `gym-msg-${order}`;
    this.messages.push({
      messageId,
      channelId,
      order,
      // A line the room wrote ("Ana pinned a message") has no seq, as in the room.
      seq: more.system || more.echoOf ? 0 : this.lastSeq(channelId) + 1,
      authorId,
      body,
      format: "markdown",
      postedAt: at,
      reactions: [],
      attachments: [],
      previews: [],
      mentioned: [],
      everyone: /(^|[^\w@])@everyone\b/i.test(body),
      mentionedTasks: [],
      ...more,
    });
    return messageId;
  }

  // ---------- reading ----------

  private find(id: string): Msg | undefined {
    return this.messages.find((m) => m.messageId === id);
  }
  private lastSeq(channelId: string): number {
    return Math.max(0, ...this.messages.filter((m) => m.channelId === channelId).map((m) => m.seq));
  }
  private author(id: string): Author {
    return Object.values(this.people).find((p) => p.memberId === id) ?? { kind: "person", memberId: id, name: "Former member" };
  }
  private repliesOf(id: string): Msg[] {
    return this.messages.filter((m) => m.replyTo === id).sort((a, b) => a.order - b.order);
  }
  private top(channelId: string): Msg[] {
    return this.messages.filter((m) => m.channelId === channelId && !m.replyTo).sort((a, b) => b.order - a.order);
  }
  private view(m: Msg): Json {
    if (m.echoOf) {
      const reply = this.find(m.echoOf)!;
      const parent = this.find(reply.replyTo!)!;
      return { ...this.view(reply), threadOf: { messageId: parent.messageId, author: this.author(parent.authorId), excerpt: parent.body.slice(0, 140) } };
    }
    const replies = this.repliesOf(m.messageId);
    const deleted = m.deletedAt !== undefined;
    const name = (id: string) => this.author(id).name;
    return {
      messageId: m.messageId,
      channelId: m.channelId,
      ...(m.seq ? { seq: m.seq } : {}),
      author: this.author(m.authorId),
      format: m.format,
      body: deleted ? "" : m.body,
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      replyCount: replies.length,
      ...(replies.length ? { lastReplyAt: replies.at(-1)!.postedAt, lastReplySeq: replies.at(-1)!.seq } : {}),
      repliers: [...new Set(replies.filter((r) => r.deletedAt === undefined).map((r) => r.authorId).reverse())].slice(0, 3).map((id) => this.author(id)),
      mentionedTasks: m.mentionedTasks,
      mentionedRuns: [...(m.mentionedRuns ?? []), ...(m.a2aRuns ?? []), ...(m.a2a ? [m.a2a.runId] : [])],
      addressedRuns: deleted
        ? []
        : (m.addressedRuns ?? []).map((runId) => ({ runId, label: (this.liveRuns.find((r) => r["runId"] === runId)?.["label"] as string) ?? "A run" })),
      ...(m.asRun ? { asRun: m.asRun } : {}),
      a2aRuns: m.a2aRuns ?? [],
      deliveries: deleted ? [] : (m.deliveries ?? []),
      ...(m.a2a
        ? {
            a2a: {
              runId: m.a2a.runId,
              ...(m.a2a.proposal
                ? {
                    proposal: {
                      ...m.a2a.proposal,
                      decidedBy: m.a2a.proposal.decidedBy ? this.author(m.a2a.proposal.decidedBy) : undefined,
                      canDecide: m.a2a.proposal.status === "pending",
                    },
                  }
                : {}),
            },
          }
        : {}),
      mentionedAgents: m.mentioned.filter((id) => this.author(id).kind === "agent"),
      mentionedMembers: m.mentioned,
      mentionsEveryone: m.everyone,
      mentionsMe: !deleted && (m.authorId !== this.me || m.asRun !== undefined) && (m.mentioned.includes(this.me) || m.everyone),
      reactions: deleted
        ? []
        : m.reactions
            .filter((r) => r.memberIds.length)
            .map((r) => ({ emoji: r.emoji, count: r.memberIds.length, mine: r.memberIds.includes(this.me), names: r.memberIds.slice(0, 10).map(name) })),
      attachments: deleted ? [] : m.attachments,
      previews: deleted ? [] : m.previews,
      previewsHidden: false,
      ...(m.pinned ? { pinned: { at: m.pinned.at, by: this.author(m.pinned.by) } } : {}),
      ...(m.system ? { system: m.system } : {}),
      ...(m.editedAt !== undefined ? { editedAt: m.editedAt } : {}),
      ...(deleted ? { deletedAt: m.deletedAt } : {}),
      postedAt: m.postedAt,
    };
  }
  private readSeq(channelId: string): number {
    return this.reads.get(channelId) ?? 0;
  }
  private unread(channelId: string): { unread: number; mentions: number } {
    const read = this.readSeq(channelId);
    const fresh = this.messages.filter((m) => m.channelId === channelId && m.seq > read && (m.authorId !== this.me || m.asRun !== undefined) && !m.system && m.deletedAt === undefined);
    return { unread: fresh.length, mentions: fresh.filter((m) => m.mentioned.includes(this.me) || m.everyone).length };
  }

  private channelRows(): Json[] {
    const recorded = this.base.channels;
    const row = (c: Json): Json => {
      const id = c["channelId"] as string;
      const last = this.messages.filter((m) => m.channelId === id).sort((a, b) => b.seq - a.seq)[0];
      return { ...c, lastSeq: this.lastSeq(id), readSeq: this.readSeq(id), ...this.unread(id), ...(last ? { lastMessageAt: last.postedAt } : {}) };
    };
    const theo = this.members.find((m) => m["memberId"] === "k57gymtheopark0")!;
    const me = this.members.find((m) => m["memberId"] === this.me)!;
    const pick = (m: Json) => ({ kind: m["kind"], memberId: m["memberId"], name: m["name"] });
    const dm = recorded.find((c) => c.kind === "direct")!;
    return [
      ...recorded.map((c) =>
        c.kind === "private"
          ? row({ ...c, members: [...((c["members"] as Json[]) ?? []), pick(this.members.find((m) => m["memberId"] === "k57gymmiachen00")!)] })
          : row(c),
      ),
      row({ ...dm, channelId: this.channels.theo, name: "Theo Park", members: [pick(me), pick(theo)] }),
      row({ ...dm, channelId: this.channels.icarus, name: "Icarus", members: [pick(me), pick(this.members.find((m) => m["memberId"] === "k57gymicarus000")!)] }),
      ...(this.liveRuns.length
        ? [
            row({
              ...dm,
              channelId: this.channels.runDm,
              name: "Claude Code (Theo Park), Theo Park",
              members: [pick(me), pick(theo)],
              runs: [{ runId: GYM_RUNS.theo, label: "Claude Code (Theo Park)", warning: THEO_WARNING, seenBy: "team" }],
            }),
          ]
        : []),
    ];
  }

  /** The chat queries, or undefined for the recorded world to answer. */
  answer(udfPath: string, args: Json): unknown {
    const key = `${udfPath} ${JSON.stringify(args, (k, v: unknown) => (k === "teamId" || k === "id" ? undefined : v))}`;
    const hit = this.cache.get(key);
    if (hit && hit.version === this.version) return hit.value;
    const value = this.compute(udfPath, args);
    if (value === undefined) return undefined;
    this.cache.set(key, { version: this.version, value });
    return value;
  }

  private compute(udfPath: string, args: Json): unknown {
    const channelId = args["channelId"] as string | undefined;
    const ours = (id: string | undefined) => id !== undefined && Object.values(this.channels).includes(id);
    switch (udfPath) {
      case "teams:members":
        return this.members;
      case "runs:get":
        return this.runs.get(args["runId"] as string);
      case "runs:live":
        return this.liveRuns.length ? this.liveRuns : undefined;
      case "runs:inbox":
        return this.inboxes.get(args["runId"] as string);
      case "channels:list":
        return this.channelRows();
      case "teams:roster":
        return [
          { kind: "agent", memberId: "k57gymhermes000", name: "Hermes", character: { body: "hermes", color: "coral", accessory: "hermes" }, state: "idle", runs: 0 },
          { kind: "agent", memberId: "k57gymnotetaker", name: "Notetaker", character: { body: "notetaker", color: "sage", accessory: "notetaker" }, state: "idle", runs: 0 },
          { kind: "agent", memberId: "k57gymicarus000", name: "Icarus", character: { body: "scribe", color: "teal", accessory: "scribe" }, ...this.icarusRoster() },
          ...(this.hosted
            ? [
                { kind: "agent", memberId: "k57gymgrokbot00", name: "Grok Bot", character: { body: "deploy", color: "blue", accessory: "deploy" }, state: "idle", runs: 0, reach: "webhook" },
                { kind: "agent", memberId: "k57gymduet00000", name: "Duet", character: { body: "scribe", color: "sage", accessory: "scribe" }, state: "idle", runs: 0, reach: "checks_in" },
              ]
            : []),
          ...((this.base.get("teams:roster", {}) as Json[]) ?? []),
          ...(this.joinedRoster ? [{ kind: "harness", name: "codex", state: "unknown", runs: 1, joined: 1 }] : []),
        ];
      case "channels:whoIsTyping": {
        if (!ours(channelId)) return undefined;
        return this.typing
          .filter((t) => t.channelId === channelId && t.memberId !== this.me)
          .map((t) => ({ member: this.author(t.memberId), at: t.at, ...(t.replyTo ? { replyTo: t.replyTo } : {}), ...(t.working ? { working: true } : {}) }));
      }
      case "members:presence": {
        const now = Date.now();
        return [
          { memberId: this.me, lastSeenAt: now, active: true },
          { memberId: this.people.ana.memberId, lastSeenAt: now - 20_000, active: true },
          { memberId: this.people.theo.memberId, lastSeenAt: now - 40_000, active: false },
          { memberId: this.people.mia.memberId, lastSeenAt: now - 3 * HOUR, active: false },
        ];
      }
      case "messages:list": {
        if (!ours(channelId)) return undefined;
        const opts = args["paginationOpts"] as { numItems: number; cursor: string | null };
        const all = this.top(channelId!);
        if (opts.cursor === null) {
          let edge = this.firstPage.get(channelId!);
          if (edge === undefined) {
            edge = all[Math.min(opts.numItems, all.length) - 1]?.order ?? 0;
            this.firstPage.set(channelId!, edge);
          }
          const page = all.filter((m) => m.order >= edge!);
          return { page: page.map((m) => this.view(m)), isDone: !all.some((m) => m.order < edge!), continueCursor: String(edge), splitCursor: null, pageStatus: null };
        }
        const below = all.filter((m) => m.order < Number(opts.cursor)).slice(0, opts.numItems);
        const edge = below.at(-1)?.order ?? 0;
        return {
          page: below.map((m) => this.view(m)),
          isDone: !all.some((m) => m.order < edge),
          continueCursor: String(edge),
          splitCursor: null,
          pageStatus: null,
        };
      }
      case "messages:replies": {
        const parent = this.find(args["messageId"] as string);
        return parent ? this.repliesOf(parent.messageId).map((m) => this.view(m)) : undefined;
      }
      case "messages:get": {
        const id = args["messageId"] as string;
        if (!id.startsWith("gym-msg-")) return undefined;
        const m = this.find(id);
        return m ? this.view(m) : null;
      }
      case "messages:around": {
        const m = this.find(args["messageId"] as string);
        if (!m) return (args["messageId"] as string).startsWith("gym-msg-") ? null : undefined;
        const anchor = (m.replyTo ? this.find(m.replyTo) : m) ?? m;
        const rows = this.top(anchor.channelId).reverse();
        const at = rows.findIndex((r) => r.messageId === anchor.messageId);
        const n = Math.min(Number(args["limit"] ?? 25), 50);
        return {
          messages: rows.slice(Math.max(0, at - n), at + n + 1).map((r) => this.view(r)),
          anchorId: anchor.messageId,
          targetId: m.messageId,
          hasOlder: at - n > 0,
          hasNewer: at + n + 1 < rows.length,
        };
      }
      case "messages:unreadThreads": {
        if (!ours(channelId)) return undefined;
        const read = this.readSeq(channelId!);
        const page = this.top(channelId!)
          .map((parent) => ({ parent, replies: this.repliesOf(parent.messageId) }))
          .filter(({ replies }) => (replies.at(-1)?.seq ?? 0) > read)
          .map(({ parent, replies }) => {
            const fresh = replies.filter((r) => r.seq > read);
            return { parent, fresh, others: fresh.filter((r) => r.authorId !== this.me).length };
          })
          .filter((t) => t.others > 0)
          .sort((a, b) => b.fresh.at(-1)!.seq - a.fresh.at(-1)!.seq)
          .map((t) => ({ message: this.view(t.parent), newReplies: t.others, moreNew: false, firstNewSeq: t.fresh[0]!.seq }));
        return { page, continueCursor: "", isDone: true };
      }
      case "channels:pins": {
        if (!ours(channelId)) return undefined;
        return this.messages
          .filter((m) => m.channelId === channelId && m.pinned && m.deletedAt === undefined)
          .sort((a, b) => b.pinned!.at - a.pinned!.at)
          .map((m) => this.view(m));
      }
      case "channels:members": {
        if (channelId !== this.channels.crit) return undefined;
        const recorded = this.base.get<Json & { members: Json[] }>("channels:members", { channelId });
        return { ...recorded, members: [...recorded.members, { addedAt: Date.now() - 40 * 24 * HOUR, kind: "person", memberId: "k57gymmiachen00", name: "Mia Chen", addedBy: this.author(this.me) }] };
      }
      case "calls:list": {
        if (!ours(channelId)) return undefined;
        if (channelId !== this.channels.general) return [];
        const start = Number(this.ids["callStart"]);
        const who = [this.people.ana, this.people.rosa, this.people.theo, this.people.notetaker].map((p) => ({ kind: p.kind, memberId: p.memberId, name: p.name }));
        return [
          {
            callId: "gym-call-yesterday",
            channelId,
            startedAt: start,
            endedAt: start + 25 * MIN,
            startedBy: who[0],
            everyone: who,
            participants: [],
            proposals: [],
            hasTranscript: false,
          },
        ];
      }
      case "messages:search": {
        const words = String(args["query"] ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        if (!words.length) return { results: [], cursor: null, isDone: true };
        const channels = new Map(this.channelRows().map((c) => [c["channelId"] as string, c]));
        const results = this.messages
          .filter((m) => m.deletedAt === undefined && !m.system && channels.has(m.channelId))
          .filter((m) => words.every((w) => m.body.toLowerCase().includes(w)))
          .filter((m) => !args["channelId"] || m.channelId === args["channelId"])
          .filter((m) => !args["authorId"] || m.authorId === args["authorId"])
          .filter((m) => args["from"] === undefined || m.postedAt >= Number(args["from"]))
          .filter((m) => args["to"] === undefined || m.postedAt <= Number(args["to"]))
          .filter((m) => args["has"] !== "attachment" || m.attachments.length > 0)
          .filter((m) => args["has"] !== "link" || /https?:\/\//.test(m.body))
          .sort((a, b) => b.postedAt - a.postedAt)
          .map((m) => {
            const c = channels.get(m.channelId)!;
            return { ...this.view(m), channel: { channelId: m.channelId, kind: c["kind"], name: c["name"] } };
          });
        return { results, cursor: null, isDone: true };
      }
      default:
        return undefined;
    }
  }

  // ---------- writing ----------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    this.version++;
    for (const listener of Array.from(this.listeners)) listener();
  }

  /** The chat mutations; undefined for one the scene doesn't take. */
  async mutate(udfPath: string, args: Json): Promise<unknown> {
    const id = args["messageId"] as string | undefined;
    const m = id ? this.find(id) : undefined;
    switch (udfPath) {
      case "messages:post": {
        const channelId = args["channelId"] as string;
        const messageId = this.add(channelId, this.me, Date.now(), String(args["body"] ?? ""), {
          ...(args["replyTo"] ? { replyTo: args["replyTo"] as string } : {}),
          mentioned: (args["mentionedMembers"] as string[] | undefined) ?? [],
          everyone: args["mentionEveryone"] === true,
          mentionedTasks: (args["mentionedTasks"] as string[] | undefined) ?? [],
          ...(args["addressedRuns"] ? { addressedRuns: args["addressedRuns"] as string[] } : {}),
        });
        if (args["alsoInChannel"] === true) this.alsoInChannel(messageId);
        this.reads.set(channelId, Math.max(this.readSeq(channelId), this.lastSeq(channelId)));
        this.changed();
        return messageId;
      }
      case "messages:edit":
        if (!m) return null;
        m.body = String(args["body"] ?? "");
        m.editedAt = Date.now();
        this.changed();
        return null;
      case "messages:delete":
        if (!m) return null;
        if (m.echoId) this.messages = this.messages.filter((x) => x.messageId !== m.echoId);
        if (this.repliesOf(m.messageId).length) m.deletedAt = Date.now();
        else this.messages = this.messages.filter((x) => x !== m);
        this.changed();
        return null;
      case "messages:react":
      case "messages:unreact": {
        if (!m) return null;
        const emoji = args["emoji"] as string;
        let r = m.reactions.find((x) => x.emoji === emoji);
        if (!r) m.reactions.push((r = { emoji, memberIds: [] }));
        r.memberIds = udfPath === "messages:react" ? [...new Set([...r.memberIds, this.me])] : r.memberIds.filter((x) => x !== this.me);
        this.changed();
        return null;
      }
      case "messages:pin":
      case "messages:unpin":
        if (!m) return null;
        if (udfPath === "messages:pin") m.pinned = { at: Date.now(), by: this.me };
        else delete m.pinned;
        this.changed();
        return null;
      case "channels:markRead": {
        const channelId = args["channelId"] as string;
        const upTo = args["upTo"] ? this.find(args["upTo"] as string)?.seq : this.lastSeq(channelId);
        if (upTo !== undefined && upTo > this.readSeq(channelId)) {
          this.reads.set(channelId, upTo);
          this.changed();
        }
        return null;
      }
      case "channels:markUnread": {
        const channelId = args["channelId"] as string;
        const from = this.find(args["from"] as string);
        if (from) {
          this.reads.set(channelId, Math.min(this.readSeq(channelId), from.seq - 1));
          this.changed();
        }
        return { readSeq: this.readSeq(channelId) };
      }
      case "messages:answerProposal": {
        const proposal = m?.a2a?.proposal;
        if (!proposal || proposal.status !== "pending") return null;
        proposal.status = args["open"] ? "accepted" : "declined";
        proposal.decidedBy = this.me;
        proposal.decidedAt = Date.now();
        this.changed();
        return { open: args["open"] };
      }
      case "runs:setHears": {
        const run = this.liveRuns.find((r) => r["runId"] === args["runId"]);
        if (!run) return undefined;
        run["hears"] = args["hears"];
        this.changed();
        return { runId: run["runId"], hears: args["hears"] };
      }
      case "channels:openDirect":
        return { channelId: (args["runIds"] as string[] | undefined)?.length ? this.channels.runDm : this.channels.theo, warnings: [] };
      case "channels:markSeen":
      case "channels:setNotify":
      case "channels:typing":
      case "members:heartbeat":
        return null;
      default:
        return undefined;
    }
  }

  /** A teammate posts, as during a video; posting ends their typing, as in the room. */
  teammatePosts(who: "ana" | "theo" | "mia", channel: keyof ChatWorld["channels"], body: string, replyTo?: string): string {
    const memberId = this.people[who].memberId;
    this.typing = this.typing.filter((t) => !(t.memberId === memberId && t.channelId === this.channels[channel]));
    const id = this.add(this.channels[channel], memberId, Date.now(), body, replyTo ? { replyTo } : {});
    this.changed();
    return id;
  }

  /** A teammate starts writing (channels.typing), in the channel or in a thread. */
  teammateTypes(who: "ana" | "theo" | "mia", channel: keyof ChatWorld["channels"], replyTo?: string): void {
    const memberId = this.people[who].memberId;
    const channelId = this.channels[channel];
    this.typing = [...this.typing.filter((t) => !(t.memberId === memberId && t.channelId === channelId)), { memberId, channelId, at: Date.now(), ...(replyTo ? { replyTo } : {}) }];
    this.changed();
  }
}
