import fixtures from "./fixtures.json";
import { fixtureTable, keyOf, type Fixture } from "./fakeConvex";

/**
 * The gym's sample team: the query results recorded from a sample team on the development
 * deployment (fixtures.json), moved in time so the newest thing happened two minutes ago, and
 * reshaped per state (empty, long names, many channels, many members).
 */
type Json = Record<string, unknown>;
type Row = Json & { memberId?: string; channelId?: string; name?: string };

const recorded = fixtures as Fixture[];

/** Every timestamp in the recordings, moved by the same amount. */
function shifted(value: unknown, by: number): unknown {
  if (Array.isArray(value)) return value.map((v) => shifted(v, by));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shifted(v, by)]));
  }
  return typeof value === "number" && value > 1.7e12 && value < 2e12 ? value + by : value;
}

/** The newest moment something happened: a time ending in "At", not one in the future ("keptUntil", "expiresAt"). */
function newest(value: unknown, key = ""): number {
  if (Array.isArray(value)) return Math.max(0, ...value.map((v) => newest(v, key)));
  if (value && typeof value === "object")
    return Math.max(0, ...Object.entries(value).map(([k, v]) => newest(v, k)));
  const happened = key.endsWith("At") && !/expires|until/i.test(key);
  return happened && typeof value === "number" && value > 1.7e12 && value < 2e12 ? value : 0;
}

export class World {
  readonly table: Map<string, unknown>;
  /** #general's id, found by name before any state renames it. */
  readonly general: string;
  constructor() {
    const by = Date.now() - 120_000 - Math.max(...recorded.map((f) => newest(f.value)));
    this.table = fixtureTable(recorded.map((f) => ({ ...f, value: shifted(f.value, by) })));
    this.general = this.channel((c) => c.name === "general" && c.kind === "channel");
    // Its bridge was online while it ran the terminal and the Space; the recording ended after it stopped.
    this.each("machines:list", (v) =>
      (v as Json[]).map((m) => ({ ...m, online: true, lastSeenAt: Date.now() - 20_000 })),
    );
    // Waiting invites (#95): one emailed, one whose email failed, one about to expire, so Members shows
    // every row state and its actions (copy link, resend, regenerate, revoke) can be opened.
    if (!this.get<unknown[]>("invites:list")?.length) {
      const me = this.me;
      const person = this.members.find((m) => m.memberId === me["memberId"]) ?? me;
      const by = { memberId: person.memberId, name: person.name };
      const now = Date.now();
      const day = 86_400_000;
      this.set("invites:list", {}, [
        {
          inviteId: "gym-invite-1",
          email: "cmoran@miamiweb.ai",
          role: "member",
          invitedAt: now - 2 * day,
          invitedBy: by,
          expiresAt: now + 5 * day,
          sendEmail: true,
          canCopyLink: true,
          remindedAt: null,
          emailState: { kind: "invite", status: "sent", at: now - 2 * day, error: null },
        },
        {
          inviteId: "gym-invite-2",
          email: "lena.okafor@example.com",
          role: "admin",
          invitedAt: now - 3 * 3_600_000,
          invitedBy: by,
          expiresAt: now + 7 * day - 3 * 3_600_000,
          sendEmail: true,
          canCopyLink: true,
          remindedAt: null,
          emailState: {
            kind: "invite",
            status: "failed",
            at: now - 3 * 3_600_000,
            error: "The address bounced.",
          },
        },
        {
          inviteId: "gym-invite-3",
          email: "sam@harborlabs.dev",
          role: "member",
          invitedAt: now - 6 * day,
          invitedBy: by,
          expiresAt: now + 20 * 3_600_000,
          sendEmail: true,
          canCopyLink: true,
          remindedAt: now - 3 * day,
          emailState: { kind: "reminder", status: "sent", at: now - 3 * day, error: null },
        },
      ]);
    }
    // The board asks for closed tasks too (#102, includeClosed). The recording came before that,
    // and none of its tasks was closed, so the same answer stands.
    // A copy: the loop adds keys to the table it reads.
    for (const [key, value] of Array.from(this.table.entries())) {
      if (!key.startsWith("tasks:board ")) continue;
      const args = JSON.parse(key.slice("tasks:board ".length)) as Json;
      this.set("tasks:board", { ...args, includeClosed: true }, value);
    }
  }
  get<T = unknown>(udfPath: string, args: Json = {}): T {
    return this.table.get(keyOf(udfPath, args)) as T;
  }
  set(udfPath: string, args: Json, value: unknown): void {
    this.table.set(keyOf(udfPath, args), value);
  }
  /** A file save in the gym answers the same version contract as the backend. */
  saveFile(args: Json): { version: number } {
    const fileId = args["fileId"] as string;
    const file = this.get<Json>("files:get", { fileId });
    const version = Number(file?.["version"] ?? 0) + 1;
    this.set("files:get", { fileId }, { ...file, content: args["content"], version });
    return { version };
  }

  /** Rewrites every recorded value of one query. */
  each(udfPath: string, change: (value: unknown, key: string) => unknown): void {
    for (const [key, value] of this.table)
      if (key.startsWith(`${udfPath} `)) this.table.set(key, change(value, key));
  }
  /** Renames people, channels, projects and the team everywhere they appear. */
  rename(names: Record<string, string>): void {
    for (const [key, value] of this.table) {
      this.table.set(
        key,
        JSON.parse(JSON.stringify(value), (_k, v: unknown) =>
          typeof v === "string" && v in names ? names[v] : v,
        ),
      );
    }
  }

  get me(): Row {
    return this.get<Row[]>("teams:mine")[0]!;
  }
  get members(): Row[] {
    return this.get<Row[]>("teams:members");
  }
  get channels(): Row[] {
    return this.get<Row[]>("channels:list");
  }
  channel(pred: (c: Row) => boolean): string {
    return this.channels.find(pred)!.channelId!;
  }
  get privateChannel(): string {
    return this.channel((c) => c.kind === "private");
  }
  get dm(): string {
    return this.channel((c) => c.kind === "direct");
  }
  get projectId(): string {
    return this.get<Row[]>("projects:list")[0]!["projectId"] as string;
  }
  get terminalId(): string {
    return this.get<Row[]>("terminals:list")[0]!["terminalId"] as string;
  }
  get spaceId(): string {
    return [...this.table.keys()]
      .find((k) => k.startsWith("spaces:get "))!
      .match(/"spaceId":"([^"]+)"/)![1]!;
  }
  get taskId(): string {
    return [...this.table.keys()]
      .find((k) => k.startsWith("tasks:get "))!
      .match(/"taskId":"([^"]+)"/)![1]!;
  }

  /**
   * The sample task finished and settled: three runs, one failed a day ago and two done, so it sits
   * in Done on its board and its panel says Settled instead of offering Settle.
   */
  settledTask(): void {
    const day = Date.now() - 86_400_000;
    const settle = (task: Json): Json => {
      const [first] = task["runs"] as Json[];
      const ended = (n: number, state: "done" | "failed"): Json => ({
        ...first,
        runId: `${first!["runId"] as string}-${n}`,
        state,
        prompt: undefined,
        terminalId: undefined,
        startedAt: day - n * 600_000,
        stateChangedAt: day + n * 60_000,
        endedAt: day + n * 60_000,
        ...(state === "failed" ? { failReason: "The agent exited with an error." } : {}),
      });
      return {
        ...task,
        state: "failed",
        settled: true,
        column: "done",
        waitingOn: [],
        runs: [ended(0, "failed"), ended(1, "done"), ended(2, "done")],
      };
    };
    const id = this.taskId;
    this.each("tasks:get", (v) => settle(v as Json));
    this.each("tasks:board", (v) => (v as Json[]).map((t) => (t["taskId"] === id ? settle(t) : t)));
  }

  /** The sample task, yours, with one run that finished: its panel offers Keep this run. */
  oneRunTask(): void {
    const me = this.members.find((m) => m.memberId === this.me["memberId"])!;
    const owner = { kind: me["kind"], memberId: me.memberId, name: me.name };
    const finish = (task: Json): Json => {
      const [first] = task["runs"] as Json[];
      const at = Date.now() - 600_000;
      return {
        ...task,
        owner,
        state: "done",
        runs: [{ ...first, state: "done", prompt: undefined, stateChangedAt: at, endedAt: at }],
      };
    };
    this.each("tasks:get", (v) => finish(v as Json));
  }

  /**
   * The sample task as a step in a plan (ADR 0050, ADR 0051): it waits for a fix still open, is
   * queued on the build box, and links two pull requests, one approved and passing, one failing.
   */
  plannedTask(): void {
    const me = this.members.find((m) => m.memberId === this.me["memberId"])!;
    const plan = (task: Json): Json => ({
      ...task,
      needs: [
        { taskId: "gym-task-schema", title: "Add the invoices table", closed: true },
        { taskId: "gym-task-fix", title: "Fix the rounding in invoice totals", closed: false },
      ],
      queued: {
        machine: { machineId: "gym-machine-build", name: "build-box" },
        harness: "claude-code",
        via: "terminal",
        queuedAt: Date.now() - 3_600_000,
        queuedBy: me,
      },
      pullRequests: [
        { pullRequestId: "gym-pr-1", repo: "nuko-nova/billing", number: 412, title: "Round invoice totals once", url: "https://github.com/nuko-nova/billing/pull/412", state: "open", review: "approved", reviews: [], checks: "passing", checkSuites: [], updatedAt: Date.now() },
        { pullRequestId: "gym-pr-2", repo: "nuko-nova/billing", number: 415, title: "Show totals in the customer's currency", url: "https://github.com/nuko-nova/billing/pull/415", state: "draft", review: "changes_requested", reviews: [], checks: "failing", checkSuites: [], updatedAt: Date.now() },
      ],
    });
    this.each("tasks:get", (v) => plan(v as Json));
  }

  /** A team with nothing in it yet: #general and you. */
  empty(): void {
    const me = this.members.find((m) => m.memberId === this.me["memberId"])!;
    for (const [key, value] of this.table) {
      if (key.startsWith("teams:mine ")) continue;
      if (key.startsWith("teams:members ")) this.table.set(key, [me]);
      else if (key.startsWith("channels:list ")) {
        this.table.set(
          key,
          this.channels
            .filter((c) => c.channelId === this.general)
            .map((c) => ({ ...c, lastSeq: 0, unread: 0, readSeq: 0 })),
        );
      } else if (Array.isArray(value)) this.table.set(key, []);
      else if (value && typeof value === "object" && "page" in value)
        this.table.set(key, { ...value, page: [], isDone: true });
      else if (value && typeof value === "object" && key.startsWith("inbox:get ")) {
        this.table.set(
          key,
          Object.fromEntries(Object.entries(value).map(([k, v]) => [k, Array.isArray(v) ? [] : v])),
        );
      }
    }
  }

  /** People, added to the team (and to the private channel, and to the call when there is one). */
  addPeople(names: string[]): Row[] {
    const people = names.map((name, i) => ({
      kind: "person",
      memberId: `gym-member-${i}`,
      name,
      role: "member",
    }));
    this.each("teams:members", (v) => [...(v as Row[]), ...people]);
    this.each("channels:list", (v) =>
      (v as Row[]).map((c) =>
        c.kind === "private"
          ? { ...c, members: [...((c["members"] as Row[]) ?? []), ...people] }
          : c,
      ),
    );
    this.each("channels:members", (v) => {
      const detail = v as Json & { members: Row[] };
      return { ...detail, members: [...detail.members, ...people] };
    });
    return people;
  }

  /** Channels and direct messages, some unread, a few with mentions, for the sidebar's long list. */
  addChannels(names: string[], people: Row[]): void {
    const base = this.channels.find((c) => c.kind === "channel")!;
    const channels = names.map((name, i) => ({
      ...base,
      channelId: `gym-channel-${i}`,
      name,
      projectId: undefined,
      lastSeq: 4,
      readSeq: i % 3 === 0 || i % 7 === 0 ? 1 : 4,
      unread: i % 3 === 0 || i % 7 === 0 ? 3 : 0,
      mentions: i % 7 === 0 ? 1 : 0,
    }));
    const me = this.members.find((m) => m.memberId === this.me["memberId"])!;
    const dms = people.slice(0, 10).map((p, i) => ({
      ...base,
      channelId: `gym-dm-${i}`,
      kind: "direct",
      name: p.name,
      members: [me, p],
      lastSeq: 2,
      readSeq: i % 4 === 0 ? 1 : 2,
      unread: i % 4 === 0 ? 1 : 0,
      mentions: 0,
    }));
    this.each("channels:list", (v) => [...(v as Row[]), ...channels, ...dms]);
  }

  /** A member of the sample team, by name. */
  member(name: string): Row {
    return this.members.find((m) => m.name === name)!;
  }

  /** The terminal as its screen sees it: who drives and started it, its access, and who has it open. */
  terminalSeen(change: { driver?: Row; startedBy?: Row; access?: string; watching?: Row[] }): void {
    const view = (m: Row) => ({ kind: m["kind"], memberId: m.memberId, name: m.name });
    this.each("terminals:get", (v) => ({
      ...(v as Json),
      ...(change.driver ? { driver: view(change.driver) } : {}),
      ...(change.startedBy ? { startedBy: view(change.startedBy) } : {}),
      ...(change.access ? { access: change.access } : {}),
      ...(change.watching ? { watching: change.watching.map(view) } : {}),
    }));
  }

  /** "Who typed what": the terminal's input log, oldest entry first, `ago` seconds before now. */
  typed(
    entries: { by: Row; data: string; ago: number; suggestedBy?: Row; kind?: "typed" | "reply" }[],
  ): void {
    const view = (m: Row) => ({ kind: m["kind"], memberId: m.memberId, name: m.name });
    const page = entries
      .map((e) => ({
        data: e.data,
        at: Date.now() - e.ago * 1000,
        by: view(e.by),
        ...(e.suggestedBy ? { suggestedBy: view(e.suggestedBy) } : {}),
        kind: e.kind ?? "typed",
      }))
      .reverse();
    this.set(
      "terminals:inputLog",
      { terminalId: this.terminalId, paginationOpts: { numItems: 60, cursor: null } },
      { page, isDone: true, continueCursor: "" },
    );
  }

  /** The sample T3 Code thread run the thread states open (ADR 0022). */
  readonly threadRunId = "gym-thread-run";

  /**
   * A T3 Code thread on the sample machine: Codex rounding tide heights in the CSV export, with a
   * turn's work, a checkpoint, a plan and an answer still streaming (sample data).
   */
  threadScene(
    variant: "driver" | "watcher" | "question" | "long" | "pairing" | "suggestions",
    /**
     * ADR 0043: the thread's access and its machine's limit (the header menu at each level), what the
     * agent may do and the machine's cap on it, and a sent message that carried a screenshot and a log.
     */
    extra: {
      access?: string;
      mostOpen?: string;
      mode?: string;
      cap?: string;
      files?: boolean;
      overCap?: boolean;
    } = {},
  ): void {
    const me = this.members.find((m) => m.memberId === this.me["memberId"])!;
    const ana = this.members.find((m) => m.memberId !== me.memberId)!;
    const machine = this.get<Json[]>("machines:list")[0]!;
    const who = (m: Row) => ({ kind: "person", memberId: m.memberId, name: m.name });
    const driver = variant === "watcher" ? ana : me;
    const runId = this.threadRunId;
    const now = Date.now();
    const t0 = now - 7 * 60_000;
    const at = (minutes: number) => t0 + minutes * 60_000;
    const items: Json[] = [
      {
        itemId: "t01",
        order: 1,
        kind: "message",
        role: "user",
        turnRef: "r1",
        status: "completed",
        at: at(0),
        text: "The CSV export shows tide heights like 1.2350000001. Round them to the centimeter, and keep the minus sign for heights below datum.",
      },
      {
        itemId: "t02",
        order: 2,
        kind: "reasoning",
        turnRef: "r1",
        status: "completed",
        at: at(0.2),
        text: 'Heights are formatted in src/export/csv.ts. toFixed(2) alone would print -0.004 as "-0.00", so a height that rounds to zero needs its sign dropped.',
      },
      {
        itemId: "t03",
        order: 3,
        kind: "tool",
        tool: "command",
        turnRef: "r1",
        status: "completed",
        at: at(0.4),
        title: "rg -n height src/export",
        input: "rg -n height src/export",
        output:
          "src/export/csv.ts:18:  row.push(String(reading.height));\nsrc/export/csv.ts:31:export function formatHeight(height: number) {",
        exitCode: 0,
      },
      {
        itemId: "t04",
        order: 4,
        kind: "file_change",
        turnRef: "r1",
        status: "completed",
        at: at(1.1),
        title: "src/export/csv.ts",
        additions: 6,
        deletions: 2,
        diff: "@@ -29,4 +29,8 @@\n-export function formatHeight(height: number) {\n-  return String(height);\n+export function formatHeight(height: number) {\n+  // Half away from zero, to the centimeter; never -0.00.\n+  const rounded = Math.sign(height) * Math.round(Math.abs(height) * 100) / 100;\n+  return (rounded === 0 ? 0 : rounded).toFixed(2);\n }",
      },
      {
        itemId: "t05",
        order: 5,
        kind: "tool",
        tool: "command",
        turnRef: "r1",
        status: "completed",
        at: at(1.6),
        title: "pnpm test export",
        input: "pnpm test export",
        output:
          " FAIL  src/export/csv.test.ts > rounds heights below datum\n   expected '-0.01', received '-0.00'\n Tests  1 failed | 13 passed (14)",
        exitCode: 1,
        failed: true,
      },
      {
        itemId: "t06",
        order: 6,
        kind: "tool",
        tool: "command",
        turnRef: "r1",
        status: "completed",
        at: at(2.4),
        title: "pnpm test export",
        input: "pnpm test export",
        output: " Tests  14 passed (14)",
        exitCode: 0,
      },
      {
        itemId: "t07",
        order: 7,
        kind: "message",
        role: "assistant",
        turnRef: "r1",
        status: "completed",
        at: at(2.6),
        text: "Heights now round to the centimeter in `src/export/csv.ts`:\n\n- `formatHeight` rounds half away from zero, so `-0.005` becomes `-0.01`.\n- A height that rounds to zero prints `0.00`, never `-0.00`.\n\nThe export tests pass (14), including a new one for heights below datum.",
      },
      {
        itemId: "t08",
        order: 8,
        kind: "checkpoint",
        turnRef: "r1",
        status: "completed",
        at: at(2.7),
        turn: 1,
        files: [
          { path: "src/export/csv.ts", additions: 6, deletions: 2 },
          { path: "src/export/csv.test.ts", additions: 18, deletions: 0 },
        ],
      },
      {
        itemId: "t09",
        order: 9,
        kind: "message",
        role: "user",
        messageRef: "uplink-room:gym-msg-1",
        turnRef: "r2",
        status: "completed",
        at: at(4),
        text: "Also add the station name as the first column.",
      },
      {
        itemId: "t10",
        order: 10,
        kind: "plan",
        turnRef: "r2",
        status: "completed",
        at: at(4.2),
        steps: [
          { text: "Read how stations are loaded for an export", status: "completed" },
          { text: "Add station_name to the header and every row", status: "running" },
          { text: "Update the export tests", status: "pending" },
        ],
      },
      {
        itemId: "t11",
        order: 11,
        kind: "tool",
        tool: "command",
        turnRef: "r2",
        status: "completed",
        at: at(4.5),
        title: "sed -n 1,40p src/stations.ts",
        input: "sed -n 1,40p src/stations.ts",
        output:
          "export async function loadStations(region: string) {\n  return db.stations.where({ region }).toArray();\n}",
        exitCode: 0,
      },
    ];
    if (variant === "question") {
      items.push({
        itemId: "t12",
        order: 12,
        kind: "request",
        request: "question",
        turnRef: "r2",
        status: "running",
        at: at(5),
        text: "Stations without a name: leave the column empty, or use the station id? (Leave it empty / Use the station id)",
      });
    } else {
      items.push({
        itemId: "t12",
        order: 12,
        kind: "message",
        role: "assistant",
        turnRef: "r2",
        status: "running",
        streaming: true,
        at: at(5),
        text: "Adding `station_name` as the first column. Stations load once per export, so the name comes from the same list without another query",
      });
    }
    // A stopped thread's last answer is finished.
    if (extra.overCap)
      items[items.length - 1] = {
        ...items[items.length - 1]!,
        streaming: false,
        status: "completed",
      };
    let page = [...items].reverse();
    let isDone = true;
    if (variant === "long") {
      // A long thread: the room has more of it than the first page.
      const older = Array.from({ length: 70 }, (_, i) => ({
        itemId: `l${String(i).padStart(3, "0")}`,
        order: -100 + i,
        kind: i % 3 === 0 ? "message" : "tool",
        ...(i % 3 === 0
          ? {
              role: i % 6 === 0 ? "user" : "assistant",
              text:
                i % 6 === 0
                  ? `Check the readings for station ${8410140 + i}.`
                  : `Station ${8410140 + i} has every reading from March: 2,976 rows.`,
            }
          : {
              tool: "command",
              title: `pnpm export --station ${8410140 + i}`,
              input: `pnpm export --station ${8410140 + i}`,
              output: "wrote 2976 rows",
              exitCode: 0,
            }),
        turnRef: `old${Math.floor(i / 3)}`,
        status: "completed",
        at: t0 - (70 - i) * 60_000,
      }));
      page = [...items, ...older]
        .sort((a, b) => (b["order"] as number) - (a["order"] as number))
        .slice(0, 80);
      isDone = false;
    }
    const pairing = variant === "pairing";
    const t3 = pairing
      ? { state: "needs_pairing", reason: "expired", expiresAt: now - 2 * 86_400_000 }
      : { state: "connected", expiresAt: now + 20 * 86_400_000 };
    this.each("machines:list", (v) =>
      (v as Json[]).map((m) => ({ ...m, online: true, tools: ["t3code", "claude"], t3 })),
    );
    // The room stopped it: T3 Code took no mode within the machine's cap (ADR 0043).
    const state = extra.overCap
      ? "stopped"
      : pairing
        ? "unknown"
        : variant === "question"
          ? "waiting"
          : "working";
    // The roster lists the thread's harness too, as the room does for every live run.
    this.set("teams:roster", {}, [
      ...this.get<Json[]>("teams:roster"),
      {
        kind: "harness",
        name: "codex",
        state: state === "unknown" ? "working" : state,
        runs: 1,
        line: "Round tide heights to the centimeter in the CSV export",
      },
    ]);
    this.set(
      "runs:get",
      { runId },
      {
        runId,
        harness: "codex",
        title: "Round tide heights to the centimeter in the CSV export",
        repo: "harbor-labs/tide-tables",
        state,
        private: false,
        driver: who(driver),
        machine: { machineId: machine["machineId"], name: machine["name"] },
        threadRef: "uplink-room-gym-thread",
        startedAt: t0,
        stateChangedAt: variant === "question" ? at(5) : t0 + 30_000,
        ...(variant === "question"
          ? {
              prompt: {
                kind: "question",
                text: "Stations without a name: leave the column empty, or use the station id? (Leave it empty / Use the station id)",
                promptId: "gym-question",
                questions: [
                  {
                    id: "missing_name",
                    header: "Stations without a name",
                    question: "What goes in station_name when a station has no name?",
                    options: [
                      {
                        label: "Leave it empty",
                        description: "An empty cell, so the column stays sortable.",
                      },
                      { label: "Use the station id", description: "For example 8410140." },
                    ],
                    allowCustomAnswer: true,
                  },
                ],
              },
            }
          : {}),
      },
    );
    this.each("machines:list", (v) =>
      (v as Json[]).map((m) => ({ ...m, mostPermissiveMode: extra.cap ?? "full-access" })),
    );
    this.set(
      "threads:get",
      { runId },
      {
        runId,
        threadRef: "uplink-room-gym-thread",
        access: extra.access ?? (variant === "watcher" ? "watch" : "drive"),
        runtimeMode: extra.mode ?? "approval-required",
        runtimeModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
        ...(extra.mode && extra.mode !== "approval-required"
          ? { runtimeModeSetBy: who(driver), runtimeModeSetAt: at(3.9) }
          : {}),
        changesMode: true,
        takesFiles: true,
        open: !extra.overCap,
        ...(extra.overCap ? { runtimeModeOverCap: true } : {}),
        startedBy: who(driver),
        driver: who(driver),
        watching: variant === "watcher" ? [who(me), who(ana)] : [who(me), who(ana)],
        showsConversation: true,
        takesMessages: true,
        takesAnswers: true,
        older: variant === "long",
        t3Link: pairing
          ? undefined
          : "https://app.t3.codes/threads/d67cf93e-fb75-4ceb-b17c-9a1a733b6787/uplink-room-gym-thread",
        machine: {
          machineId: machine["machineId"],
          name: machine["name"],
          mostOpenAccess: extra.mostOpen ?? "open",
          mostPermissiveMode: extra.cap ?? "full-access",
          t3,
          passesWheel: true,
        },
      },
    );
    // The room names who sent a message it sent (threads.items' sentBy), with the room's copy of its files (ADR 0043).
    const shot =
      "data:image/svg+xml;utf8," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="420" viewBox="0 0 720 420"><rect width="720" height="420" fill="#f7f8fa"/><rect x="0" y="0" width="720" height="44" fill="#eef0f3"/><text x="24" y="28" font-family="Helvetica" font-size="16" fill="#15171a">tide-heights-march.csv</text><g font-family="Menlo" font-size="15" fill="#15171a"><text x="24" y="92">station,time,height_m</text><text x="24" y="124">8410140,2026-03-01T00:00,1.2350000001</text><text x="24" y="156">8410140,2026-03-01T00:06,-0.0049999</text><text x="24" y="188" fill="#9a5b00">8410140,2026-03-01T00:12,-0.00</text></g></svg>',
      );
    const withSenders = page.map((i) =>
      i["messageRef"] === "uplink-room:gym-msg-1"
        ? {
            ...i,
            sentBy: who(driver),
            ...(extra.files
              ? {
                  attachments: [
                    { name: "tide-heights-march.png", kind: "image", size: 48_211 },
                    { name: "export-run.log", kind: "file", size: 3_920 },
                  ],
                  roomFiles: [
                    { name: "tide-heights-march.png", kind: "image", size: 48_211, url: shot },
                    { name: "export-run.log", kind: "file", size: 3_920, url: null },
                  ],
                }
              : {}),
          }
        : i,
    );
    this.set(
      "threads:items",
      { runId, paginationOpts: { numItems: 80, cursor: null } },
      { page: withSenders, isDone, continueCursor: isDone ? "" : "gym-more" },
    );
    this.set("threads:wheelRequests", { runId }, []);
    this.set(
      "threads:suggestions",
      { runId },
      variant === "suggestions"
        ? [
            {
              suggestionId: "gym-sugg-1",
              text: "Use the station id when a station has no name, so every row can be joined back.",
              from: who(ana),
            },
          ]
        : [],
    );
    const sentPage = {
      page: [
        {
          messageId: "gym-msg-1",
          messageRef: "uplink-room:gym-msg-1",
          text: "Also add the station name as the first column.",
          status: "sent",
          at: at(4),
          by: who(driver),
        },
      ],
      isDone: true,
      continueCursor: "",
    };
    this.set(
      "threads:messages",
      { runId, paginationOpts: { numItems: 30, cursor: null } },
      sentPage,
    );
    this.set(
      "threads:diff",
      { runId, turn: 1 },
      {
        turn: 1,
        status: "ready",
        at: at(3),
        diff: 'diff --git a/src/export/csv.ts b/src/export/csv.ts\n--- a/src/export/csv.ts\n+++ b/src/export/csv.ts\n@@ -29,4 +29,8 @@ export function formatRow(reading: Reading) {\n-export function formatHeight(height: number) {\n-  return String(height);\n+export function formatHeight(height: number) {\n+  // Half away from zero, to the centimeter; never -0.00.\n+  const rounded = Math.sign(height) * Math.round(Math.abs(height) * 100) / 100;\n+  return (rounded === 0 ? 0 : rounded).toFixed(2);\n }\ndiff --git a/src/export/csv.test.ts b/src/export/csv.test.ts\n--- a/src/export/csv.test.ts\n+++ b/src/export/csv.test.ts\n@@ -40,0 +41,4 @@\n+test("rounds heights below datum", () => {\n+  expect(formatHeight(-0.005)).toBe("-0.01");\n+  expect(formatHeight(-0.004)).toBe("0.00");\n+});',
      },
    );
  }

  /** Every machine's bridge says its T3 Code pairing ended (ADR 0021), as after 30 days. */
  t3PairingEnded(): void {
    this.each("machines:list", (v) =>
      (v as Json[]).map((m) => ({
        ...m,
        tools: ["t3code", "claude"],
        t3: { state: "needs_pairing", reason: "expired", expiresAt: Date.now() - 2 * 86_400_000 },
      })),
    );
  }

  /**
   * A teammate's machine beside yours (ADR 0025): Axel Loiko's loiko-mini (sample data), at
   * `mostOpenAccess`, online, with one of its two slots in use. Returns Axel.
   */
  teammateMachine(mostOpenAccess: "watch" | "suggest" | "drive" | "open"): Row {
    const [axel] = this.addPeople(["Axel Loiko"]);
    const base = this.get<Json[]>("machines:list")[0]!;
    const loiko = {
      ...base,
      machineId: "gym-machine-loiko",
      name: "loiko-mini",
      hostname: "loiko-mini.local",
      belongsTo: {
        kind: "person",
        member: { kind: "person", memberId: axel!.memberId, name: axel!.name },
      },
      mostOpenAccess,
      limits: { ...(base["limits"] as Json), mostOpenAccess: "open" },
      slots: 2,
      slotsInUse: 1,
      liveTerminals: 1,
      online: true,
      lastSeenAt: Date.now() - 15_000,
    };
    this.each("machines:list", (v) => [...(v as Json[]), loiko]);
    return axel!;
  }

  /**
   * Your machine at `mostOpenAccess`, with a terminal Ana Ruiz started on it (sample data). At Drive
   * she drives it. At Suggest the wheel has come to you and every terminal there dropped to Suggest.
   */
  myMachineAt(mostOpenAccess: "suggest" | "drive"): void {
    const machineId = this.get<Json[]>("machines:list")[0]!["machineId"] as string;
    const view = (m: Row) => ({ kind: m["kind"], memberId: m.memberId, name: m.name });
    const me = this.members.find((m) => m.memberId === this.me["memberId"])!;
    const ana = this.member("Ana Ruiz");
    const below = mostOpenAccess === "suggest";
    const lowered = (t: Json) =>
      below ? { ...t, access: "suggest", loweredFrom: t["access"] } : t;
    this.each("machines:list", (v) =>
      (v as Json[]).map((m) =>
        m["machineId"] === machineId
          ? { ...m, mostOpenAccess, slotsInUse: 1, liveTerminals: 2 }
          : m,
      ),
    );
    this.each("terminals:list", (v, key) => {
      if (!key.includes(machineId)) return v;
      const [first] = v as Json[];
      const anas: Json = {
        ...first,
        terminalId: "gym-terminal-ana",
        runId: "gym-run-ana",
        title: "Bump the tide model to the 2026 constants",
        tool: "codex",
        startedBy: view(ana),
        driver: view(below ? me : ana),
        access: "drive",
        usesSlot: true,
        watching: [view(ana)],
      };
      return [...(v as Json[]), anas].map(lowered);
    });
  }

  /**
   * Your run's terminal on Axel Loiko's loiko-mini after he set it to Suggest (ADR 0025): the wheel
   * went to him, and your terminal dropped from Drive to Suggest. Sample data.
   */
  handedOver(): void {
    const axel = this.teammateMachine("suggest");
    const me = this.members.find((m) => m.memberId === this.me["memberId"])!;
    const view = (m: Row) => ({ kind: m["kind"], memberId: m.memberId, name: m.name });
    this.each("terminals:get", (v) => ({
      ...(v as Json),
      machine: { machineId: "gym-machine-loiko", mostOpenAccess: "suggest", name: "loiko-mini" },
      startedBy: view(me),
      driver: view(axel),
      access: "suggest",
      loweredFrom: "drive",
      usesSlot: true,
      watching: [view(me), view(axel)],
    }));
  }

  /** The Space is shared at Drive and its view is ready, at an address nobody answers on (the sample has no machine). */
  spaceReady(): void {
    this.each("spaces:get", (v) => ({ ...(v as Json), access: "drive" }));
    this.each("spaces:myView", (v) => ({
      ...(v as Json),
      status: "ready",
      urls: ["http://127.0.0.1:9/view"],
    }));
  }

  /**
   * An A2A agent, Icarus (sample data, added by Ana), with its endpoint as a2a.get answers it and
   * the runs sent to it as a2a.runs does (ADR 0012, ADR 0018). `peer` and `runs` reshape them.
   */
  a2aAgent(
    opts: { peer?: (peer: Json) => Json; runs?: (agent: Row, me: Row) => Json[] } = {},
  ): void {
    const now = Date.now();
    const ana = this.members.find((m) => m.name === "Ana Ruiz") ?? this.members[0]!;
    const meRow = this.members.find((m) => m.memberId === this.me["memberId"])!;
    const by = { memberId: ana.memberId, name: ana.name, kind: "person" };
    const agentId = "gym-agents-icarus";
    const agent: Row = {
      kind: "agent",
      memberId: "gym-member-icarus",
      name: "Icarus",
      role: "member",
      addedBy: { memberId: ana.memberId, name: ana.name },
      agentId,
      character: { body: "hermes", color: "coral", accessory: "hermes" },
    };
    this.each("teams:members", (v) => [...(v as Row[]), agent]);
    this.set("agents:keys", { agentId }, []);
    const peer: Json = {
      peerId: "gym-a2a-icarus",
      agentId,
      agent: { memberId: agent.memberId, name: agent.name },
      cardUrl: "https://icarus.example.com/.well-known/agent-card.json",
      endpointUrl: "https://icarus.example.com/",
      status: "ready",
      checkedAt: now - 3 * 3_600_000,
      card: {
        name: "Icarus",
        description: "Hermes Agent on a VPS. Takes research and coding tasks.",
        version: "1.0.0",
        protocolVersion: "1.0",
        streaming: true,
        pushNotifications: true,
        skills: [
          { id: "web", name: "Web search" },
          { id: "terminal", name: "Terminal" },
        ],
        security: [{ name: "bearer", kind: "bearer" }],
        needsCredential: true,
      },
      protocol: { speaks: "1.0", declared: "1.0", learned: false },
      connection: null,
      cancel: "unknown",
      listTasks: "unknown",
      sendWork: "team",
      connectedBy: by,
      credential: { kind: "bearer", hint: "…k3Q9", setAt: now - 3 * 3_600_000, setBy: by },
    };
    this.set("a2a:get", { agentId }, opts.peer ? opts.peer(peer) : peer);
    this.set("a2a:runs", { agentId, limit: 20 }, opts.runs ? opts.runs(agent, meRow) : []);
  }

  /**
   * The task's runs with a three-turn conversation with Icarus beside the recorded terminal run
   * (ADR 0041, sample data): the first message its gateway refused, the same ask again answered with
   * a result, and a follow-up it is working on now. All three share one conversation.
   */
  a2aTaskConversation(): void {
    this.a2aAgent();
    const now = Date.now();
    const meRow = this.members.find((m) => m.memberId === this.me["memberId"])!;
    const me = { kind: "person", memberId: meRow.memberId, name: meRow.name };
    const agent = { agentId: "gym-agents-icarus", memberId: "gym-member-icarus", name: "Icarus" };
    const refused =
      "Icarus doesn't answer SendMessage, the A2A 1.0 method its Agent Card promises, or message/send from A2A 0.3. It said: “method not found”. Check that the address on its Agent Card is its A2A endpoint.";
    const run = (id: string, startedAt: number, state: string, more: Json, a2a: Json): Json => ({
      runId: `gym-run-task-icarus-${id}`,
      taskId: this.taskId,
      harness: "a2a",
      title: "Export tide tables as CSV",
      state,
      private: false,
      driver: me,
      canReply: true,
      startedAt,
      stateChangedAt: startedAt + 40_000,
      ...more,
      a2a: {
        agent,
        connected: true,
        canCancel: "supported",
        conversationId: "gym-conversation-task-icarus",
        contextId: "gym-context-task-icarus",
        following: state === "working",
        delivery: "sent",
        artifacts: [],
        lastContactAt: startedAt + 40_000,
        observedAt: startedAt + 40_000,
        statusAt: startedAt + 40_000,
        replies: state === "working" ? "task" : "conversation",
        ...a2a,
      },
    });
    const ask =
      "Check the CSV export against NOAA's published Bayview table for today, and tell me which rows differ.";
    const runs = [
      run(
        "1",
        now - 26 * 60_000,
        "failed",
        { failReason: refused, endedAt: now - 26 * 60_000 + 3_000 },
        {
          delivery: "failed",
          following: false,
          messages: [{ kind: "start", text: ask, at: now - 26 * 60_000, status: "failed", by: me }],
        },
      ),
      run(
        "2",
        now - 18 * 60_000,
        "done",
        { endedAt: now - 18 * 60_000 + 95_000 },
        {
          externalState: "TASK_STATE_COMPLETED",
          taskId: "gym-task-icarus-2",
          statusAt: now - 18 * 60_000 + 95_000,
          lastMessage:
            "Two rows differ, both on the evening high tide:\n\n- **Bayview 8410140**: the export has 6.2 ft at 4:12 PM, NOAA has 6.24 ft. The export rounds to one decimal.\n- **Pier 39**: the export is an hour early. Its timestamp is in standard time; NOAA's table switched to daylight time on Sunday.",
          artifacts: [
            {
              artifactId: "gym-artifact-diff",
              name: "bayview-diff.csv",
              text: "station,time,export_ft,noaa_ft\n8410140,16:12,6.2,6.24\n9414290,17:48,5.9,5.9",
              urls: ["https://icarus.example.com/files/bayview-diff.csv"],
              hasData: false,
            },
          ],
          messages: [{ kind: "start", text: ask, at: now - 18 * 60_000, status: "sent", by: me }],
        },
      ),
      run(
        "3",
        now - 3 * 60_000,
        "working",
        {},
        {
          externalState: "TASK_STATE_WORKING",
          taskId: "gym-task-icarus-3",
          lastMessage: "Reading the export code for how it rounds heights",
          messages: [
            {
              kind: "start",
              text: "Fix the rounding so it keeps two decimals, and say which file you'd change.",
              at: now - 3 * 60_000,
              status: "sent",
              by: me,
            },
          ],
        },
      ),
    ];
    this.each("tasks:get", (v) => {
      const task = v as Json;
      return { ...task, state: "working", runs: [...(task["runs"] as Json[]), ...runs] };
    });
  }

  /**
   * A roster with an agent of each reach (ADR 0044, sample data): Icarus over A2A, Grok Bot at its
   * routine webhook and Duet checking in on its own schedule, each in teams.roster with its agentId,
   * so Give to an agent lists all three. Two more open tasks give the roster's "Give it a task" a list.
   */
  rosterAgents(): void {
    this.a2aAgent();
    const meRow = this.members.find((m) => m.memberId === this.me["memberId"])!;
    const addedBy = { memberId: meRow.memberId, name: meRow.name };
    const grok: Row = {
      kind: "agent",
      memberId: "gym-member-grok",
      name: "Grok Bot",
      role: "member",
      addedBy,
      agentId: "gym-agents-grok",
      character: { body: "deploy", color: "blue", accessory: "deploy" },
      reach: "webhook",
    };
    const duet: Row = {
      kind: "agent",
      memberId: "gym-member-duet",
      name: "Duet",
      role: "member",
      addedBy,
      agentId: "gym-agents-duet",
      character: { body: "watch", color: "teal", accessory: "watch" },
      reach: "checks_in",
    };
    this.each("teams:members", (v) => [...(v as Row[]), grok, duet]);
    const icarus = this.members.find((m) => m.name === "Icarus")!;
    this.set("a2a:list", {}, [this.get("a2a:get", { agentId: "gym-agents-icarus" })]);
    const entry = (m: Row, reach: string) => ({
      kind: "agent",
      memberId: m.memberId,
      agentId: m["agentId"],
      name: m.name,
      character: m["character"],
      state: "idle",
      runs: 0,
      reach,
      takesYourWork: true,
    });
    this.set("teams:roster", {}, [
      entry(icarus, "a2a"),
      entry(grok, "webhook"),
      entry(duet, "checks_in"),
      ...this.get<Json[]>("teams:roster"),
    ]);
    const [first] = this.get<Json[]>("tasks:board");
    const now = Date.now();
    const more = (id: string, title: string, at: number): Json => ({
      ...first,
      taskId: `gym-task-${id}`,
      title,
      runs: [],
      state: "not_started",
      column: "not_started",
      waitingOn: [],
      createdAt: at,
    });
    this.set("tasks:board", {}, [
      ...this.get<Json[]>("tasks:board"),
      more("pier39", "Fix Pier 39's daylight time offset", now - 40 * 60_000),
      more("noaa", "Compare the export with NOAA's published tables", now - 3 * 3_600_000),
    ]);
  }

  /**
   * The task given to Grok Bot at its routine webhook (ADR 0044, sample data): the room sent it the
   * task, and Grok Bot reported back with a question, so the run waits on you in the task's chat.
   */
  givenTaskRun(): void {
    this.rosterAgents();
    const now = Date.now();
    const meRow = this.members.find((m) => m.memberId === this.me["memberId"])!;
    const me = { kind: "person", memberId: meRow.memberId, name: meRow.name };
    const question =
      "The export has two Bayview stations, 8410140 and 8410145. Which one should the CSV use, or both?";
    const run: Json = {
      runId: "gym-run-task-grok",
      taskId: this.taskId,
      harness: "agent",
      title: "Export tide tables as CSV",
      state: "waiting",
      prompt: { kind: "question", text: question },
      private: false,
      driver: me,
      canReply: true,
      startedAt: now - 9 * 60_000,
      stateChangedAt: now - 2 * 60_000,
      given: {
        agent: {
          memberId: "gym-member-grok",
          agentId: "gym-agents-grok",
          name: "Grok Bot",
          character: { body: "deploy", color: "blue", accessory: "deploy" },
        },
        reach: "webhook",
        delivery: { status: "sent" },
        lastMessage: { text: question, at: now - 2 * 60_000 },
        messages: [
          {
            kind: "start",
            text: "Export tide tables as CSV, one file per station, heights to two decimals.",
            from: me,
            at: now - 9 * 60_000,
          },
        ],
      },
    };
    this.each("tasks:get", (v) => {
      const task = v as Json;
      return {
        ...task,
        state: "waiting",
        waitingOn: [me],
        runs: [...(task["runs"] as Json[]), run],
      };
    });
    this.each("teams:roster", (v) =>
      (v as Json[]).map((e) =>
        e["agentId"] === "gym-agents-grok"
          ? { ...e, state: "waiting", runs: 1, line: "Export tide tables as CSV" }
          : e,
      ),
    );
  }

  /**
   * A busy morning (sample data): several agents at once, so the Inbox and the sidebar show the load a
   * manager carries. Two runs wait on you (an approval and a question with named choices), three work,
   * two are done and wait to be settled.
   */
  /**
   * Grok Bot is your Link (ADR 0049): the Inbox opens on your conversation with it. You asked for a
   * change and it started a thread, which its card follows; you asked a question and it answered,
   * so its reply offers Make it a task. Call after busyTeam or rosterAgents, which add Grok Bot.
   */
  linkConversation(): void {
    const channelId = "gym-dm-link";
    const meRow = this.members.find((m) => m.memberId === this.me["memberId"])!;
    const me = { memberId: meRow.memberId, name: meRow.name, kind: "person" };
    const grok = {
      memberId: "gym-member-grok",
      name: "Grok Bot",
      kind: "agent",
      character: { body: "deploy", color: "blue", accessory: "deploy" },
    };
    this.set(
      "members:link",
      {},
      {
        memberId: grok.memberId,
        agentId: "gym-agents-grok",
        name: grok.name,
        channelId,
        reach: "webhook",
      },
    );
    const runId = "gym-run-link";
    const now = Date.now();
    this.set(
      "runs:get",
      { runId },
      {
        runId,
        taskId: this.taskId,
        harness: "claude-code",
        title: "Bump the tide model to the 2026 constants",
        repo: "harbor-labs/tide-tables",
        state: "working",
        private: false,
        driver: { ...me, role: "admin" },
        machine: { machineId: "gym-machine-hopper", name: "hopper" },
        threadRef: { threadId: "gym-thread-link" },
        startedAt: now - 4 * 60_000,
        stateChangedAt: now - 4 * 60_000,
        canReply: false,
        settled: false,
      },
    );
    const message = (
      n: number,
      author: Json,
      body: string,
      minutesAgo: number,
      runs: string[] = [],
    ) => ({
      messageId: `gym-link-msg-${n}`,
      channelId,
      seq: n,
      author,
      format: "markdown",
      body,
      replyCount: 0,
      repliers: [],
      mentionedTasks: [],
      mentionedRuns: runs,
      addressedRuns: [],
      reactions: [],
      attachments: [],
      deliveries: [],
      at: now - minutesAgo * 60_000,
    });
    this.linkMessages(channelId, [
      message(1, me, "can someone bump the tide model to the 2026 constants", 6),
      message(2, grok, "On it. Claude Code is starting on hopper.", 5, [runId]),
      message(3, me, "and is the CSV export done?", 2),
      message(
        4,
        grok,
        "**Almost.** Icarus exported March and April, and it's asking one thing about rounding before it does the rest.",
        1,
      ),
    ]);
  }

  /**
   * Your Link can't be reached: Grok Bot's routine webhook was removed while your last message was
   * on its way, so that send failed with the room's reason, and the box starts a thread until the
   * room can reach it again. Call after linkConversation.
   */
  /**
   * The Link conversation's messages, as the Inbox asks for them: its latest page (6) and what
   * Show earlier messages loads (40). The gym answers each query by its exact arguments.
   */
  linkMessages(channelId: string, list: Json[]): void {
    this.set("messages:list", { channelId, limit: 40 }, list);
    this.set("messages:list", { channelId, limit: 6 }, list.slice(-6));
  }

  linkUnreachable(): void {
    const link = this.get<Json>("members:link", {});
    this.set("members:link", {}, { ...link, reach: null });
    const channelId = link["channelId"] as string;
    const list = this.get<Json[]>("messages:list", { channelId, limit: 40 });
    const mine = list.find((m) => (m["author"] as Json)["kind"] === "person")!;
    const grok = list.find((m) => (m["author"] as Json)["kind"] === "agent")!["author"] as Json;
    this.linkMessages(channelId, [
      ...list,
      {
        ...mine,
        messageId: "gym-link-msg-5",
        seq: list.length + 1,
        body: "can you also check why the Bayview station feed stopped at 6am?",
        mentionedRuns: [],
        deliveries: [
          {
            to: grok,
            via: "webhook",
            status: "failed",
            reason: "Grok Bot's webhook was changed or removed before this was sent.",
            at: Date.now() - 30_000,
            settledAt: Date.now() - 29_000,
          },
        ],
        at: Date.now() - 30_000,
      },
    ]);
    // The roster no longer lists it as reachable, so it isn't offered as a Link.
    this.each("teams:roster", (v) =>
      (v as Json[]).map((e) => (e["agentId"] === link["agentId"] ? { ...e, reach: null } : e)),
    );
  }

  busyTeam(): void {
    this.rosterAgents();
    const now = Date.now();
    const meRow = this.members.find((m) => m.memberId === this.me["memberId"])!;
    const me = { kind: "person", memberId: meRow.memberId, name: meRow.name };
    const mine = this.get<Json>("inbox:get", { view: "mine" });
    const base = (mine["working"] as Json[])[0]!;
    const baseRun = (base["runs"] as Json[])[0]!;
    const agent = (id: string, name: string, character: Json) => ({
      memberId: `gym-member-${id}`,
      agentId: `gym-agents-${id}`,
      name,
      character,
    });
    const grok = agent("grok", "Grok Bot", { body: "deploy", color: "blue", accessory: "deploy" });
    const icarus = this.members.find((m) => m.name === "Icarus")!;
    const icarusAgent = {
      memberId: icarus.memberId,
      agentId: icarus["agentId"],
      name: "Icarus",
      character: icarus["character"],
    };
    const duet = agent("duet", "Duet", { body: "watch", color: "teal", accessory: "watch" });
    const row = (
      id: string,
      title: string,
      minutesAgo: number,
      run: Json,
      state: string,
      waitingOn: Json[] = [],
    ): Json => ({
      ...base,
      taskId: `gym-task-${id}`,
      title,
      state,
      waitingOn,
      changedAt: now - minutesAgo * 60_000,
      runs: [
        {
          ...baseRun,
          runId: `gym-run-${id}`,
          taskId: `gym-task-${id}`,
          startedAt: now - (minutesAgo + 20) * 60_000,
          stateChangedAt: now - minutesAgo * 60_000,
          ...run,
        },
      ],
    });
    const given = (a: Json, text: string, minutesAgo: number): Json => ({
      harness: "agent",
      canReply: true,
      machine: undefined,
      terminalId: undefined,
      given: {
        agent: a,
        reach: "webhook",
        delivery: { status: "sent" },
        lastMessage: { text, at: now - minutesAgo * 60_000 },
        messages: [],
      },
    });
    const needsYou = [
      row(
        "tiles",
        "Load the harbor map tiles",
        2,
        {
          harness: "codex",
          state: "waiting",
          prompt: {
            kind: "approval",
            text: "Codex wants to run pnpm add -D tiled-map",
            action: "pnpm add -D tiled-map",
            promptId: "gym-prompt-tiles",
          },
        },
        "waiting",
        [me],
      ),
      row(
        "tilesource",
        "Pick the harbor map's tile source",
        4,
        {
          harness: "codex",
          state: "waiting",
          prompt: {
            kind: "question",
            text: "Which tile source should the harbor map use?",
            promptId: "gym-prompt-tilesource",
            questions: [
              {
                id: "source",
                header: "Which tile source should the harbor map use?",
                question: "Which tile source should the harbor map use?",
                options: [
                  { label: "OpenSeaMap", description: "Free, community charts" },
                  { label: "NOAA ENC", description: "Official US charts, US waters only" },
                  { label: "Both", description: "NOAA where it covers, OpenSeaMap elsewhere" },
                ],
              },
            ],
          },
        },
        "waiting",
        [me],
      ),
      row(
        "bayview",
        "Export Bayview's stations",
        6,
        {
          ...given(grok, "Which station should the CSV use?", 6),
          state: "waiting",
          prompt: {
            kind: "question",
            text: "The export has two Bayview stations, 8410140 and 8410145. Which one should the CSV use, or both?",
          },
        },
        "waiting",
        [me],
      ),
    ];
    const working = [
      { ...base, changedAt: now - 1 * 60_000 },
      row(
        "noaa",
        "Compare the export with NOAA's published tables",
        4,
        { ...given(icarusAgent, "Checked 14 of 31 stations", 4), state: "working" },
        "working",
      ),
      row(
        "pier39",
        "Fix Pier 39's daylight time offset",
        11,
        { ...given(duet, "Reading the station's timezone rules", 11), state: "working" },
        "working",
      ),
    ];
    const done = [
      row(
        "round",
        "Round tide heights to the centimeter",
        35,
        { harness: "codex", state: "done" },
        "done",
      ),
      row(
        "notes",
        "Write release notes for 0.3",
        80,
        { ...given(grok, "Release notes are in docs/releases/0.3.md", 80), state: "done" },
        "done",
      ),
    ];
    for (const args of [{}, { view: "mine" }, { view: "team" }])
      this.set("inbox:get", args, { needsYou, working, done });
    this.each("teams:roster", (v) =>
      (v as Json[]).map((e) =>
        e["agentId"] === "gym-agents-grok"
          ? { ...e, state: "waiting", runs: 2, line: "Export Bayview's stations" }
          : e["agentId"] === icarus["agentId"]
            ? {
                ...e,
                state: "working",
                runs: 1,
                line: "Compare the export with NOAA's published tables",
              }
            : e["agentId"] === "gym-agents-duet"
              ? { ...e, state: "working", runs: 1, line: "Fix Pier 39's daylight time offset" }
              : e,
      ),
    );
    this.set("teams:roster", {}, [
      ...this.get<Json[]>("teams:roster"),
      {
        kind: "harness",
        name: "codex",
        runs: 2,
        state: "waiting",
        line: "Load the harbor map tiles",
      },
    ]);
  }

  /**
   * Grok Bot, approved through the connector and reached at a routine webhook (slice 14 of #139),
   * as webhooks.get answers it (sample data). `set` false: no webhook yet, so its panel offers Add.
   */
  grokWebhook(opts: { set?: boolean } = {}): void {
    const now = Date.now();
    const meRow = this.members.find((m) => m.memberId === this.me["memberId"])!;
    const agentId = "gym-agents-grok";
    const set = opts.set !== false;
    const grok: Row = {
      kind: "agent",
      memberId: "gym-member-grok",
      name: "Grok Bot",
      role: "member",
      addedBy: { memberId: meRow.memberId, name: meRow.name },
      agentId,
      character: { body: "deploy", color: "blue", accessory: "deploy" },
      reach: set ? "webhook" : "checks_in",
    };
    this.each("teams:members", (v) => [grok, ...(v as Row[])]);
    this.set("agents:keys", { agentId }, [
      {
        keyId: "gym-key-grok",
        name: "Connector: Grok Bot",
        prefix: "urk_51c0",
        scopes: ["room.read", "messages.post"],
        createdAt: now - 3 * 86_400_000,
      },
    ]);
    this.set(
      "webhooks:get",
      { agentId },
      set
        ? {
            url: "https://api.grokbot.example/v1/routines/rt_8c41f2/webhook",
            hint: "…Q7wz",
            setAt: now - 26 * 3_600_000,
            setBy: { memberId: meRow.memberId, name: meRow.name, kind: "person" },
          }
        : null,
    );
    this.set("connectors:list", {}, [
      {
        connectorId: "gym-connector-grok",
        clientId: "c6f1d2a9e4b7",
        clientName: "Grok Bot",
        label: "Grok Bot",
        createdAt: now - 3 * 86_400_000,
        lastSeenAt: now - 40 * 60_000,
        status: "approved",
        team: { teamId: this.me["teamId"], name: this.me["name"] },
        agent: { agentId, name: "Grok Bot" },
        approvedAt: now - 3 * 86_400_000,
      },
    ]);
  }

  /**
   * Hosted assistants through the remote connector (ADR 0031), as connectors.list answers it (sample
   * data): Claude and Grok Bot waiting for you, Meta AI whose key was revoked, and Duet approved as an
   * agent you added. `waiting` false leaves only the ended and approved ones.
   */
  connectors(opts: { waiting?: boolean } = {}): void {
    const now = Date.now();
    const meRow = this.members.find((m) => m.memberId === this.me["memberId"])!;
    const agentId = "gym-agents-duet";
    const duet: Row = {
      kind: "agent",
      memberId: "gym-member-duet",
      name: "Duet",
      role: "member",
      addedBy: { memberId: meRow.memberId, name: meRow.name },
      agentId,
      character: { body: "watch", color: "teal", accessory: "watch" },
      // It joined through the connector and has no other way in (slice 14 of #139).
      reach: "checks_in",
    };
    // First among the agents, so Settings, Agents opens on it.
    this.each("teams:members", (v) => [duet, ...(v as Row[])]);
    this.set("agents:keys", { agentId }, [
      {
        keyId: "gym-key-duet",
        name: "Connector: Claude",
        prefix: "urk_7f3a",
        scopes: ["room.read", "messages.post"],
        createdAt: now - 2 * 86_400_000,
      },
    ]);
    const team = { teamId: this.me["teamId"], name: this.me["name"] };
    const waiting = [
      {
        connectorId: "gym-connector-claude",
        clientId: "https://claude.ai/oauth/mcp-client-metadata",
        clientName: "Claude",
        label: "Claude",
        createdAt: now - 4 * 60_000,
        lastSeenAt: now - 4 * 60_000,
        status: "pending",
      },
      {
        connectorId: "gym-connector-grok",
        clientId: "c6f1d2a9e4b7",
        clientName: "Grok Bot",
        label: "Grok Bot",
        createdAt: now - 3 * 3_600_000,
        lastSeenAt: now - 3 * 3_600_000,
        status: "pending",
      },
    ];
    this.set("connectors:list", {}, [
      ...(opts.waiting === false ? [] : waiting),
      {
        connectorId: "gym-connector-duet",
        clientId: "https://claude.ai/oauth/mcp-client-metadata",
        clientName: "Claude",
        label: "Claude",
        createdAt: now - 2 * 86_400_000,
        lastSeenAt: now - 25 * 60_000,
        status: "approved",
        team,
        agent: { agentId, name: "Duet" },
        approvedAt: now - 2 * 86_400_000,
      },
      {
        connectorId: "gym-connector-muse",
        clientId: "https://meta.ai/connectors/client.json",
        clientName: "Meta AI",
        label: "Meta AI",
        createdAt: now - 6 * 86_400_000,
        lastSeenAt: now - 86_400_000,
        status: "ended",
        why: "its agent key was revoked",
        team,
        agent: { agentId: "gym-agents-muse", name: "Muse" },
        approvedAt: now - 6 * 86_400_000,
      },
    ]);
  }

  /**
   * Rex on the sample machine (ADR 0019): its bridge opens Rex tabs, and Rex runs there or not. While
   * it runs, the sample terminal is a run the room started in Rex, beside two tabs Rosa opened
   * through Uplink Room and three she opened in Rex directly. `size` is the tab's size, as Rex reports it.
   */
  rex(running: boolean, size: { cols: number; rows: number } = { cols: 100, rows: 30 }): void {
    const machineId = this.get<Row[]>("machines:list")[0]!["machineId"] as string;
    const terminalId = this.terminalId;
    this.each("machines:list", (v) =>
      (v as Json[]).map((m) => ({
        ...m,
        tools: [...(m["tools"] as string[]), "rex", "rex-tabs"],
        rex: { available: true, running },
      })),
    );
    this.set(
      "rex:found",
      { machineId },
      running
        ? {
            available: true,
            running: true,
            otherTabs: 3,
            checkedAt: Date.now() - 20_000,
            tabs: [
              {
                tabRef: "block:01a1a7c8-2440-7ec1-900b-5e9c660a2cfb",
                session: "Uplink Room",
                title: "Export tide tables as CSV",
                command: "claude -- 'Export the tide tables as CSV, one file per station'",
                cwd: "~/src/tide-tables",
                shared: true,
                terminalId,
                kind: "run",
              },
              {
                tabRef: "block:01a1a7cd-22af-7121-9fa6-7252d2fed810",
                session: "tide-tables",
                title: "claude",
                command: "claude",
                cwd: "~/src/tide-tables",
                shared: false,
              },
              {
                tabRef: "block:01a1a7d2-1b04-7a3c-8f11-0c2d5e6f7a88",
                session: "tide-tables",
                title: "pnpm dev",
                command: "pnpm dev",
                cwd: "~/src/tide-tables",
                shared: false,
              },
            ],
          }
        : { available: true, running: false, otherTabs: 0, tabs: [] },
    );
    if (!running) return;
    const inRex = (t: Json) =>
      t["terminalId"] === terminalId ? { ...t, tool: "rex", inRex: "run", size } : t;
    this.each("terminals:list", (v) => (v as Json[]).map(inRex));
    this.each("terminals:get", (v) => inRex(v as Json));
  }

  /**
   * The sample terminal's screen as a full-width program draws it in a Rex tab of `cols` by `rows`
   * (sample data): a boxed table of five days of tide predictions, with its right edge and status line
   * at the tab's far edges, so a screen larger than the pane shows where it ends.
   */
  wideScreen(cols: number, rows: number): void {
    const inner = cols - 2;
    const row = (text: string) => `│${text.padEnd(inner).slice(0, inner)}│`;
    const columns = [
      "Station",
      "Lat",
      "Lon",
      "Date",
      "High 1",
      "m",
      "Low 1",
      "m",
      "High 2",
      "m",
      "Low 2",
      "m",
      "Range m",
      "Datum",
      "Source",
      "Updated",
    ];
    const widths = [16, 8, 9, 12, 8, 6, 8, 6, 8, 6, 8, 6, 9, 7, 44, 16];
    const line = (cells: string[]) => " " + cells.map((c, i) => c.padEnd(widths[i]!)).join(" ");
    const stations: [string, string, string, string[]][] = [
      [
        "Boston",
        "42.35",
        "-71.05",
        ["04:12", "3.41", "10:31", "0.12", "16:38", "3.18", "22:49", "0.21", "3.29"],
      ],
      [
        "Portland ME",
        "43.66",
        "-70.25",
        ["04:05", "3.12", "10:20", "0.08", "16:29", "2.94", "22:41", "0.17", "3.04"],
      ],
      [
        "Woods Hole",
        "41.52",
        "-70.67",
        ["01:47", "0.71", "06:58", "0.09", "13:55", "0.66", "19:12", "0.11", "0.62"],
      ],
      [
        "Newport",
        "41.50",
        "-71.33",
        ["01:12", "1.32", "07:26", "0.05", "13:24", "1.21", "19:41", "0.10", "1.27"],
      ],
      [
        "New London",
        "41.36",
        "-72.09",
        ["02:03", "0.98", "08:14", "0.07", "14:18", "0.91", "20:30", "0.12", "0.91"],
      ],
      [
        "The Battery",
        "40.70",
        "-74.01",
        ["00:41", "1.62", "06:58", "0.04", "13:02", "1.49", "19:15", "0.09", "1.58"],
      ],
      [
        "Sandy Hook",
        "40.47",
        "-74.01",
        ["00:22", "1.71", "06:37", "0.06", "12:44", "1.58", "18:56", "0.10", "1.65"],
      ],
      [
        "Atlantic City",
        "39.36",
        "-74.42",
        ["23:58", "1.39", "06:09", "0.03", "12:18", "1.27", "18:30", "0.08", "1.36"],
      ],
    ];
    const screen = [
      `┌─ Export tide tables ${"─".repeat(inner - 21)}┐`,
      row(""),
      row(line(columns)),
      row(line(widths.map((w) => "─".repeat(w)))),
      // Each day's tides come about 50 minutes later than the day before's.
      ...[0, 1, 2, 3, 4].flatMap((day) =>
        stations.map(([name, lat, lon, values]) => {
          const shifted = values.map((v, i) => {
            if (i === 8) return v;
            if (i % 2 === 1) return (Number(v) + day * 0.03).toFixed(2);
            const [h, m] = v.split(":").map(Number) as [number, number];
            const at = (h * 60 + m + day * 50) % 1440;
            return `${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`;
          });
          return row(
            line([
              name,
              lat,
              lon,
              `2026-11-0${4 + day}`,
              ...shifted,
              "MLLW",
              "harmonic predictions, 6-minute interval",
              "2026-11-04 06:00",
            ]),
          );
        }),
      ),
      row(""),
      row(" Writing out/2026-11-04/*.csv, one file per station and day"),
    ];
    const status = ` 40 of 2060 predictions   q quit   ↑↓ scroll   e export `;
    while (screen.length < rows - 2) screen.push(row(""));
    screen.push(row(status.padEnd(inner - 14) + `${cols} × ${rows} `.padStart(14)));
    screen.push(`└${"─".repeat(inner)}┘`);
    this.set(
      "terminals:output",
      { afterSeq: 0, terminalId: this.terminalId },
      {
        chunks: [{ data: "\x1b[H\x1b[2J" + screen.join("\r\n"), seq: 1 }],
        cursor: 1,
        more: false,
        outputSeq: 1,
      },
    );
  }

  /** Your media in the live call, as calls.updateMedia would report it. */
  setMyMedia(me: string, media: { muted: boolean; camera: boolean; screen: boolean }): void {
    this.each("calls:live", (v) =>
      (v as Json[]).map((call) => ({
        ...call,
        participants: (call["participants"] as Row[]).map((p) =>
          p.memberId === me ? { ...p, ...media } : p,
        ),
      })),
    );
  }

  /** You and others in a live call in #general. */
  /** A live call in #general: the first two members and `extra`, or only `extra` without `withFirst`. */
  liveCall(
    extra: Row[] = [],
    { withFirst = true }: { withFirst?: boolean } = {},
  ): { callId: string; channelId: string } {
    const call = { callId: "gym-call", channelId: this.general };
    const people = [...(withFirst ? this.members.slice(0, 2) : []), ...extra].map((m, i) => ({
      kind: m.kind,
      memberId: m.memberId,
      name: m.name,
      // An agent in a gym call takes notes, as the Notetaker does.
      takesNotes: m.kind === "agent",
      muted: i % 3 === 2,
      camera: false,
      screen: false,
      joinedAt: Date.now() - 250_000 + i * 1000,
    }));
    this.each("calls:live", () => [
      { ...call, startedAt: Date.now() - 252_000, participants: people },
    ]);
    return call;
  }
}

export const LONG_NAMES = {
  team: "Northeast Regional Harbor Operations and Tide Forecasting",
  channel: "harbor-operations-announcements-and-weekly-updates",
  person: "Anastasia Bartholomew-Villanueva de la Cruz",
  project: "Tide tables export and the long-term forecasting archive",
};

export const MANY_PEOPLE = [
  "Ben Okafor",
  "Chloe Martin",
  "Dev Patel",
  "Elena Rossi",
  "Farah Haddad",
  "Gus Lindqvist",
  "Hana Sato",
  "Ivan Petrov",
  "Jada Brooks",
  "Kofi Mensah",
  "Lena Fischer",
  "Mateo Silva",
  "Nora Quinn",
  "Omar Aziz",
  "Priya Raman",
  "Quinn Taylor",
  "Rafa Ortega",
  "Sofia Novak",
  "Tomas Berg",
  "Uma Iyer",
  "Vera Kim",
  "Wes Carter",
  "Xin Li",
  "Yara Nasser",
];

export const MANY_CHANNELS = [
  "announcements",
  "design",
  "design-crit-archive",
  "engineering",
  "infra",
  "incidents",
  "releases",
  "release-0-4",
  "release-0-5",
  "qa",
  "support",
  "support-escalations",
  "sales",
  "marketing",
  "website",
  "docs",
  "random",
  "music",
  "pets",
  "standup",
  "planning",
  "roadmap",
  "research",
  "hiring",
  "ops",
  "billing",
  "security",
  "legal",
  "events",
  "watercooler",
];
