import type { InventorySpecimen, InventoryVariant } from "./InventoryPage";
import { inventoryScenes } from "./inventoryScenes";
import type { Route } from "../Shell";
import type { PermissionsState, PermissionStatus } from "../../main/permissionsSpec";
import { LONG_NAMES, MANY_CHANNELS, MANY_PEOPLE, type World } from "./world";
import type { GitHubScene } from "./github";
import { GYM_PAIRS, type PairScene } from "./pairs";
import { GYM_RUNS, ICARUS_DM, RUN_DM, type AgentScene } from "./chat";
import type { T3ThreadsScene } from "./t3threads";

/**
 * Every screen and state the gym renders (`gym.html?state=<id>`). scripts/gym.ts captures each in
 * dark and light at the default and smallest window sizes, records its interactions, and runs the
 * Impeccable detector on it.
 */
export type GymState = {
  id: string;
  isolation?: InventoryVariant;
  specimen?: InventorySpecimen;
  inventoryPage?: "browser" | "cloud" | "invite" | "space";
  inventoryVariant?: string;
  /** What the judge and the proof folder call it. */
  title: string;
  route?: (w: World) => Route;
  task?: (w: World) => string;
  setup?: "welcome" | "devices" | "permissions" | "pair" | "done";
  /** "live" reads this computer's real states and asks nothing; the others are simulated. */
  permissions?:
    | "live"
    | Record<"microphone" | "camera" | "screen" | "notifications", PermissionStatus>;
  pairFails?: boolean;
  /** Controlled pending/failure response for invite dialog captures. */
  inviteOutcome?: "loading" | "error";
  notificationsOn?: boolean;
  /** This computer's current pairing, for the setup's link step. */
  linkedAs?: string;
  /** The pairing couldn't be read: setup's link step offers Retry, not the link form. */
  linkError?: string;
  call?: "connected" | "many" | "join-fails";
  loading?: boolean;
  /** A channel whose queries answer not_found, as when you're removed from it while it's open. */
  gone?: (w: World) => string;
  /** Reshapes the sample team before the shell renders. */
  world?: (w: World) => void;
  /** The chat scene (gym/chat.ts): a team that talks, and chat that answers sends, edits and reactions. */
  chat?: boolean;
  /** With `chat`: a conversation with Icarus, an agent the team sends work over A2A (ADR 0024). */
  agent?: AgentScene;
  /** With `chat`: live runs to mention, message and open (ADR 0026, slice 3 of #139). */
  runs?: boolean;
  /** With `chat`: Grok Bot at its routine webhook and Duet checking in on its own schedule (slice 14 of #139). */
  hosted?: boolean;
  /** The run whose panel opens over the route. */
  run?: string;
  /** Videos scripts/gym.ts records of this state, one per flow (chatFlows there), instead of the chrome tour. */
  flows?: string[];
  /** What a new terminal runs for `uplink-bridge` on this (simulated, installed) computer; "missing" when unset. */
  cli?: "ours" | "missing" | "stale" | "other" | "occupied" | "relative" | "error";
  /**
   * `uplink` and `uplink-mcp` beside the bridge (ADR 0042): "missing" while the bridge is on PATH, as
   * after an update from 0.2.11; otherwise they follow `cli`.
   */
  tools?: "missing";
  /** The uplink skill in Claude Code and Codex: none, both current, or Codex's from an earlier version. Default: none. */
  skills?: "none" | "current" | "outdated";
  /** Settings, Machines' Link a machine dialog, opened by scripts/gym.ts with a code made: which machine, and its system. */
  link?: "this" | "other";
  linkOs?: "macOS" | "Linux" | "Windows";
  /** This room has no bridge release (machines.bridgeRelease answers null). */
  noRelease?: boolean;
  /** The team's connected GitHub accounts and synced repos (gym/github.ts). Default: an organization and a personal account. */
  github?: GitHubScene;
  /** Your Pairs (gym/pairs.ts): none, or three (a live one, one with an agent and unread messages, an ended one). Default: some. */
  pairs?: PairScene;
  /** Signed in and in no team: the no-team home (views/NoTeam.tsx) instead of a team's shell. */
  noTeam?: boolean;
  /** Start or join a Pair opens on its join form with this code typed, refused as a wrong code is. */
  pairJoin?: string;
  /** A Pair opens as if the last message sent hadn't reached these runs, their inboxes full. */
  pairMissed?: string[];
  /** Settings, Machines: the machine is this computer, and its bridge lists T3 Code threads (gym/t3threads.ts). */
  t3Threads?: T3ThreadsScene;
};

const NOT_ASKED = {
  microphone: "not-determined",
  camera: "not-determined",
  screen: "not-determined",
  notifications: "unknown",
} as const;
const DENIED = {
  microphone: "denied",
  camera: "denied",
  screen: "denied",
  notifications: "unknown",
} as const;
const GRANTED = {
  microphone: "granted",
  camera: "granted",
  screen: "granted",
  notifications: "unknown",
} as const;

const general = (w: World): Route => ({ name: "channel", channelId: w.general as never });
const terminal = (w: World): Route => ({ name: "terminal", terminalId: w.terminalId as never });
const github = (): Route => ({ name: "settings", section: "github" });
/** You (Rosa Vega) as a member of the team, and Ana Ruiz as its admin. */
const asMember = (w: World): void => {
  w.each("teams:mine", (v) =>
    (v as Record<string, unknown>[]).map((t) => ({ ...t, role: "member" })),
  );
  w.each("teams:members", (v) =>
    (v as Record<string, unknown>[]).map((m) =>
      m["name"] === "Rosa Vega"
        ? { ...m, role: "member" }
        : m["name"] === "Ana Ruiz"
          ? { ...m, role: "admin" }
          : m,
    ),
  );
};
const icarusDm: Route = { name: "channel", channelId: ICARUS_DM as never };

export const STATES: GymState[] = [
  { id: "inbox", title: "Inbox", route: () => ({ name: "inbox" }) },
  {
    id: "inbox-proposals",
    title: "Inbox: tasks proposed from a call",
    route: () => ({ name: "inbox" }),
    world: (w) => {
      const me = w.members.find((m) => m.memberId === w.me["memberId"])!;
      const view = (m: typeof me) => ({ memberId: m.memberId, name: m.name, kind: m.kind });
      const from = {
        proposedBy: { memberId: "gym-notetaker", name: "Notetaker", kind: "agent" },
        status: "pending",
        callId: "gym-call",
        channelId: w.general,
        where: "#general",
        callStartedAt: Date.now() - 50 * 60_000,
      };
      const proposals = [
        {
          ...from,
          proposalId: "gym-proposal-1",
          title: "Fix the save slot bug",
          description: "Saves made after a level change load the old level.",
          owner: view(me),
        },
        { ...from, proposalId: "gym-proposal-2", title: "Order the new monitors" },
      ];
      w.each("inbox:get", (v) => ({ ...(v as object), proposals }));
    },
  },
  {
    id: "inbox-busy",
    title: "Inbox on a busy morning: two decisions, three agents working, two done",
    route: () => ({ name: "inbox" }),
    world: (w) => w.busyTeam(),
  },
  {
    id: "inbox-link",
    title:
      "Inbox as your conversation with Grok Bot, your Link: a thread it started, and an answer",
    route: () => ({ name: "inbox" }),
    world: (w) => {
      w.busyTeam();
      w.linkConversation();
    },
  },
  {
    id: "inbox-link-unreachable",
    title:
      "Inbox with a Link the room can't reach: your last message to Grok Bot failed, and the box starts a thread",
    route: () => ({ name: "inbox" }),
    world: (w) => {
      w.busyTeam();
      w.linkConversation();
      w.linkUnreachable();
    },
  },
  {
    id: "task",
    title: "Task drawer over the Inbox",
    route: () => ({ name: "inbox" }),
    task: (w) => w.taskId,
  },
  // ADR 0050 and 0051: a task that waits for others, is queued for a machine, and links pull requests.
  {
    id: "task-planned",
    title: "Task drawer: waits for a fix, queued on build-box, two linked pull requests",
    route: () => ({ name: "inbox" }),
    task: (w) => w.taskId,
    world: (w) => w.plannedTask(),
  },
  {
    id: "task-one-run",
    title: "Task drawer: your task with one finished run, which you can keep",
    route: () => ({ name: "inbox" }),
    task: (w) => w.taskId,
    world: (w) => w.oneRunTask(),
  },
  {
    id: "task-settled",
    title: "Task drawer: settled, 1 of 3 runs failed",
    route: () => ({ name: "inbox" }),
    task: (w) => w.taskId,
    world: (w) => w.settledTask(),
  },
  // ADR 0041: an agent conversation on a task is one chat, beside the terminal run's card.
  {
    id: "task-a2a-conversation",
    title:
      "Task drawer: a three-turn conversation with Icarus as one chat (its first message refused), beside a terminal run",
    route: () => ({ name: "inbox" }),
    task: (w) => w.taskId,
    world: (w) => w.a2aTaskConversation(),
  },
  // ADR 0044: a task given to any agent in the roster. scripts/gymPrepare.ts opens each.
  {
    id: "start-run-roster",
    title: "Start a run: An agent from the roster, Grok Bot at its routine webhook picked",
    route: () => ({ name: "inbox" }),
    task: (w) => w.taskId,
    world: (w) => w.rosterAgents(),
  },
  {
    id: "project-give-agent",
    title: "Project board: Give to an agent from a card",
    route: (w) => ({ name: "project", projectId: w.projectId as never }),
    world: (w) => w.rosterAgents(),
  },
  {
    id: "roster-give-task",
    title: "Roster: Grok Bot's Give it a task menu, with the open tasks",
    route: () => ({ name: "inbox" }),
    world: (w) => w.rosterAgents(),
  },
  {
    id: "task-given-run",
    title: "Task drawer: a run given to Grok Bot, which asks a question",
    route: () => ({ name: "inbox" }),
    task: (w) => w.taskId,
    world: (w) => w.givenTaskRun(),
  },
  // scripts/gym.ts opens Start a run from the task drawer and picks Shell.
  {
    id: "start-run-shell",
    title: "Start a run with Shell picked",
    route: () => ({ name: "inbox" }),
    task: (w) => w.taskId,
  },
  { id: "channel", title: "Channel (#general)", route: general },
  {
    id: "dm",
    title: "Direct message",
    route: (w) => ({ name: "channel", channelId: w.dm as never }),
  },
  {
    id: "private",
    title: "Private channel",
    route: (w) => ({ name: "channel", channelId: w.privateChannel as never }),
  },
  { id: "call", title: "In a call", route: general, call: "connected" },
  {
    id: "call-others",
    title: "A call you're not in, with an agent taking notes",
    route: general,
    world: (w) => {
      const ana = w.members.find((m) => m.memberId !== w.me["memberId"])!;
      const [ben] = w.addPeople(["Ben Okafor"]);
      const notetaker = { kind: "agent", memberId: "gym-notetaker", name: "Notetaker" };
      w.liveCall([ana, ben!, notetaker], { withFirst: false });
    },
  },
  {
    id: "people-status",
    title: "People: custom statuses, presence, and a teammate in a call",
    route: general,
    world: (w) => {
      const ana = w.members.find((m) => m.memberId !== w.me["memberId"])!;
      w.liveCall([ana], { withFirst: false });
      w.each("teams:members", (v) =>
        (v as { memberId: string; status?: string }[]).map((m) =>
          m.memberId === w.me["memberId"] ? { ...m, status: "Reviewing the call PR" } : m,
        ),
      );
    },
  },
  { id: "browser", title: "Shared browser panel", route: general },
  {
    id: "project",
    title: "Project board",
    route: (w) => ({ name: "project", projectId: w.projectId as never }),
  },
  {
    id: "project-settled",
    title: "Project board: a settled task with a failed run, in Done",
    route: (w) => ({ name: "project", projectId: w.projectId as never }),
    world: (w) => w.settledTask(),
  },
  { id: "settings", title: "Settings", route: () => ({ name: "settings", section: "machines" }) },
  {
    id: "settings-setup",
    title: "Settings, Setup",
    route: () => ({ name: "settings", section: "setup" }),
    permissions: "live",
  },
  // Every other section of Settings, so each pane is seen and judged, not just Machines.
  ...(
    [
      ["profiles", "Profiles"],
      ["agents", "Agents"],
      ["members", "Members, with waiting invites"],
      ["browsers", "Shared browsers"],
      ["chat", "Chat"],
      ["calls", "Calls"],
      ["appearance", "Appearance"],
      ["notifications", "Notifications"],
      ["privacy", "Privacy"],
      ["updates", "Updates"],
      ["diagnostics", "Diagnostics"],
      ["activity", "Activity"],
    ] as const
  ).map(([section, label]) => ({
    id: `settings-${section}`,
    title: `Settings, ${label}`,
    route: () => ({ name: "settings", section }) as Route,
  })),
  {
    id: "settings-t3-pairing",
    title: "Settings, Machines with a T3 Code pairing that ended",
    route: () => ({ name: "settings", section: "machines" }),
    world: (w) => w.t3PairingEnded(),
  },
  // This computer's T3 Code threads, private until shared (ADR 0045). scripts/t3-threads-shots.ts searches, picks and saves.
  ...(
    ["list", "save-fails", "empty", "bridge-off", "unavailable", "other-environment"] as const
  ).map((scene): GymState => ({
    id: scene === "list" ? "settings-t3-threads" : `settings-t3-threads-${scene}`,
    title: `Settings, Machines: this computer's T3 Code threads${scene === "list" ? "" : `, ${scene.replace("-", " ")}`}`,
    route: () => ({ name: "settings", section: "machines" }),
    t3Threads: scene,
    world: (w) =>
      w.each("machines:list", (v) =>
        (v as Record<string, unknown>[]).map((m) => ({ ...m, tools: ["t3code", "claude-code"] })),
      ),
  })),
  {
    id: "settings-agents-empty",
    title: "Settings, Agents with none yet",
    route: () => ({ name: "settings", section: "agents" }),
    world: (w) => w.empty(),
  },
  // Hosted assistants through the remote connector (ADR 0031): connections waiting for approval, one that ended, and Duet, approved.
  {
    id: "settings-connectors-waiting",
    title: "Settings, Agents: hosted assistants waiting for your approval",
    route: () => ({ name: "settings", section: "agents" }),
    world: (w) => w.connectors(),
  },
  {
    id: "settings-connector-review",
    title: "Settings, Agents: approving Claude, with its name and scopes",
    route: () => ({ name: "settings", section: "agents" }),
    world: (w) => w.connectors(),
  },
  {
    id: "settings-connector-agent",
    title: "Settings, Agents: Duet, an agent that joined through the connector",
    route: () => ({ name: "settings", section: "agents" }),
    world: (w) => w.connectors({ waiting: false }),
  },
  // uplink-bridge in a terminal (components/BridgeCli.tsx) and Link a machine (views/settings/Machines.tsx).
  {
    id: "settings-setup-cli-ours",
    title: "Settings, Setup: uplink-bridge on PATH",
    route: () => ({ name: "settings", section: "setup" }),
    permissions: GRANTED,
    cli: "ours",
  },
  {
    id: "settings-setup-cli-missing",
    title: "Settings, Setup: uplink-bridge not on PATH",
    route: () => ({ name: "settings", section: "setup" }),
    permissions: GRANTED,
    cli: "missing",
  },
  {
    id: "settings-setup-cli-stale",
    title: "Settings, Setup: uplink-bridge points at another copy of the app",
    route: () => ({ name: "settings", section: "setup" }),
    permissions: GRANTED,
    cli: "stale",
  },
  {
    id: "settings-setup-cli-other",
    title: "Settings, Setup: another install comes first on PATH",
    route: () => ({ name: "settings", section: "setup" }),
    permissions: GRANTED,
    cli: "other",
  },
  {
    id: "settings-setup-cli-occupied",
    title: "Settings, Setup: another install is where the app would link",
    route: () => ({ name: "settings", section: "setup" }),
    permissions: GRANTED,
    cli: "occupied",
  },
  {
    id: "settings-setup-cli-relative",
    title: "Settings, Setup: a relative folder comes first on PATH",
    route: () => ({ name: "settings", section: "setup" }),
    permissions: GRANTED,
    cli: "relative",
  },
  {
    id: "link-machine-this",
    title: "Link a machine: this computer, uplink-bridge not on PATH",
    route: () => ({ name: "settings", section: "machines" }),
    link: "this",
    cli: "missing",
  },
  {
    id: "link-machine-this-busy",
    title: "Link a machine: linking this computer",
    route: () => ({ name: "settings", section: "machines" }),
    link: "this",
    cli: "missing",
  },
  {
    id: "link-machine-this-check-failed",
    title: "Link a machine: this computer, the PATH check failed",
    route: () => ({ name: "settings", section: "machines" }),
    link: "this",
    cli: "error",
  },
  {
    id: "link-machine-this-on-path",
    title: "Link a machine: this computer, uplink-bridge on PATH",
    route: () => ({ name: "settings", section: "machines" }),
    link: "this",
    cli: "ours",
  },
  {
    id: "link-machine-other",
    title: "Link a machine: another machine, Linux steps",
    route: () => ({ name: "settings", section: "machines" }),
    link: "other",
    linkOs: "Linux",
  },
  {
    id: "link-machine-other-windows",
    title: "Link a machine: another machine, Windows steps",
    route: () => ({ name: "settings", section: "machines" }),
    link: "other",
    linkOs: "Windows",
  },
  {
    id: "link-machine-no-release",
    title: "Link a machine: another machine, no bridge release in this room",
    route: () => ({ name: "settings", section: "machines" }),
    link: "other",
    noRelease: true,
  },
  { id: "terminal", title: "Terminal: you drive, nobody else watching", route: terminal },
  {
    id: "terminal-watched",
    title: "Terminal: you drive at Suggest, three teammates watching, and what you typed",
    route: terminal,
    world: (w) => {
      const [axel, mia] = w.addPeople(["Axel Loiko", "Mia Chen"]);
      const me = w.member("Rosa Vega");
      const ana = w.member("Ana Ruiz");
      w.terminalSeen({ access: "suggest", watching: [me, ana, axel!, mia!] });
      w.typed([
        { by: me, data: "claude\r", ago: 300 },
        // Claude Code turns on focus reporting and asks for device attributes; the screen answers.
        { by: me, data: "\x1b[I\x1b[?1;2c", ago: 295, kind: "reply" },
        { by: me, data: "Export the tide tables as CSV.\r", ago: 280 },
        { by: me, data: "\x1b[B\x1b[B\r", ago: 200 },
        { by: me, data: "pnpm tset\x7f\x7f\x7fest\r", ago: 120 },
        { by: me, data: "pnpm build\r", ago: 60, suggestedBy: ana },
        { by: me, data: "\x03", ago: 20 },
      ]);
    },
  },
  {
    id: "terminal-watcher",
    title: "Terminal: Ana drives at Suggest, you watch",
    route: terminal,
    world: (w) => {
      const ana = w.member("Ana Ruiz");
      w.terminalSeen({
        driver: ana,
        startedBy: ana,
        access: "suggest",
        watching: [ana, w.member("Rosa Vega")],
      });
    },
  },
  // GitHub (ADR 0020): Settings, GitHub in each state, and the repo picker.
  {
    id: "settings-github-none",
    title: "Settings, GitHub: no account connected",
    route: github,
    github: "none",
  },
  {
    id: "settings-github-unconfigured",
    title: "Settings, GitHub: the deployment has no GitHub App",
    route: github,
    github: "unconfigured",
  },
  {
    id: "settings-github",
    title: "Settings, GitHub: an admin's view, an organization, your account and Ana's",
    route: github,
    github: "accounts",
  },
  {
    id: "settings-github-member",
    title: "Settings, GitHub: a member's view, your account and the team's organization",
    route: github,
    github: "member-own",
    world: asMember,
  },
  {
    id: "settings-github-member-org",
    title: "Settings, GitHub: a member's view, the team's organization and no account of yours yet",
    route: github,
    github: "member-org",
    world: asMember,
  },
  {
    id: "settings-github-member-none",
    title: "Settings, GitHub: a member's view, nothing connected yet",
    route: github,
    github: "member-none",
    world: asMember,
  },
  {
    id: "settings-github-suspended",
    title: "Settings, GitHub: a suspended installation",
    route: github,
    github: "suspended",
  },
  {
    id: "settings-github-avatar-error",
    title: "Settings, GitHub: avatar failed to load",
    route: github,
    github: "avatar-error",
  },
  {
    id: "settings-github-disconnect-busy",
    title: "Settings, GitHub: disconnect in progress",
    route: github,
    github: "disconnect-busy",
  },
  {
    id: "settings-github-disconnect-error",
    title: "Settings, GitHub: disconnect failed",
    route: github,
    github: "disconnect-error",
  },
  {
    id: "settings-github-syncing",
    title: "Settings, GitHub: syncing",
    route: github,
    github: "syncing",
  },
  {
    id: "settings-github-stalled",
    title: "Settings, GitHub: a sync that didn't finish",
    route: github,
    github: "stalled",
  },
  {
    id: "settings-github-error",
    title: "Settings, GitHub: a sync error",
    route: github,
    github: "error",
  },
  // The person who started a connect confirms it in the app once GitHub sends them back.
  {
    id: "settings-github-confirm",
    title: "Settings, GitHub: Finish connecting, GitHub signed in and listed three accounts",
    route: github,
    github: "confirm",
  },
  {
    id: "settings-github-confirm-checking",
    title: "Settings, GitHub: Finish connecting, asking GitHub about the organization",
    route: github,
    github: "confirm-checking",
  },
  {
    id: "settings-github-confirm-refused",
    title: "Settings, GitHub: Finish connecting, GitHub no longer lists you as an owner",
    route: github,
    github: "confirm-refused",
  },
  {
    id: "settings-github-confirm-connected",
    title: "Settings, GitHub: Finish connecting, connected and syncing",
    route: github,
    github: "confirm-connected",
  },
  {
    id: "settings-github-confirm-member",
    title: "Settings, GitHub: Finish connecting, a member's view",
    route: github,
    github: "confirm-member",
    world: asMember,
  },
  {
    id: "repo-picker-new",
    title: "New project: searching synced repos",
    route: () => ({ name: "inbox" }),
    github: "accounts",
  },
  {
    id: "repo-picker-typed",
    title: "New project: a repo typed by hand, no GitHub connected",
    route: () => ({ name: "inbox" }),
    github: "none",
  },
  {
    id: "repo-picker-repos",
    title: "A project's Repos: a synced repo and one that isn't connected",
    route: (w) => ({ name: "project", projectId: w.projectId as never }),
    github: "accounts",
    world: (w) =>
      w.each("projects:list", (v) =>
        (v as Record<string, unknown>[]).map((p) => ({
          ...p,
          repos: ["github.com/harbor-labs/tide-tables", "harbor-labs/legacy-tides"],
        })),
      ),
  },
  // A T3 Code thread's conversation (ADR 0022).
  {
    id: "thread-driver",
    title: "Thread: you drive it, an answer streaming",
    route: (w) => ({ name: "thread", runId: w.threadRunId as never }),
    world: (w) => w.threadScene("driver"),
  },
  {
    id: "thread-watcher",
    title: "Thread: a teammate drives it, you watch",
    route: (w) => ({ name: "thread", runId: w.threadRunId as never }),
    world: (w) => w.threadScene("watcher"),
  },
  {
    id: "thread-question",
    title: "Thread: waiting on a question",
    route: (w) => ({ name: "thread", runId: w.threadRunId as never }),
    world: (w) => w.threadScene("question"),
  },
  {
    id: "thread-long",
    title: "Thread: a long thread with earlier messages",
    route: (w) => ({ name: "thread", runId: w.threadRunId as never }),
    world: (w) => w.threadScene("long"),
  },
  {
    id: "thread-tools",
    title: "Thread: a turn's tool calls opened",
    route: (w) => ({ name: "thread", runId: w.threadRunId as never }),
    world: (w) => w.threadScene("driver"),
  },
  {
    id: "thread-diff",
    title: "Thread: a turn's diff opened",
    route: (w) => ({ name: "thread", runId: w.threadRunId as never }),
    world: (w) => w.threadScene("driver"),
  },
  {
    id: "thread-pairing",
    title: "Thread: its machine's T3 Code pairing ended",
    route: (w) => ({ name: "thread", runId: w.threadRunId as never }),
    world: (w) => w.threadScene("pairing"),
  },
  {
    id: "thread-suggestions",
    title: "Thread: a teammate's suggested message waits for you",
    route: (w) => ({ name: "thread", runId: w.threadRunId as never }),
    world: (w) => w.threadScene("suggestions"),
  },
  // ADR 0043: files sent into a thread, what its agent may do, and the header menu at each access level.
  {
    id: "thread-files",
    title: "Thread: a sent screenshot and log, and a file waiting in the box",
    route: (w) => ({ name: "thread", runId: w.threadRunId as never }),
    world: (w) => w.threadScene("driver", { files: true, mode: "full-access" }),
  },
  {
    id: "thread-over-cap",
    title:
      "Thread: stopped by the room because T3 Code kept Full access over the machine's Ask before acting",
    route: (w) => ({ name: "thread", runId: w.threadRunId as never }),
    world: (w) =>
      w.threadScene("driver", { mode: "full-access", cap: "approval-required", overCap: true }),
  },
  {
    id: "thread-mode-menu",
    title: "Thread: the header menu with what Codex may do, the machine allowing up to Auto",
    route: (w) => ({ name: "thread", runId: w.threadRunId as never }),
    world: (w) => w.threadScene("driver", { mode: "auto-accept-edits", cap: "auto" }),
  },
  {
    id: "thread-menu-view",
    title: "Thread: the header menu at View, the machine allowing up to Suggest",
    route: (w) => ({ name: "thread", runId: w.threadRunId as never }),
    world: (w) => w.threadScene("driver", { access: "watch", mostOpen: "suggest" }),
  },
  {
    id: "thread-menu-suggest",
    title: "Thread: the header menu at Suggest, the machine allowing up to Suggest",
    route: (w) => ({ name: "thread", runId: w.threadRunId as never }),
    world: (w) => w.threadScene("driver", { access: "suggest", mostOpen: "suggest" }),
  },
  {
    id: "thread-menu-drive",
    title: "Thread: the header menu at Ask for control, the machine allowing up to Ask for control",
    route: (w) => ({ name: "thread", runId: w.threadRunId as never }),
    world: (w) => w.threadScene("driver", { access: "drive", mostOpen: "drive" }),
  },
  {
    id: "thread-menu-open",
    title: "Thread: the header menu at Take control",
    route: (w) => ({ name: "thread", runId: w.threadRunId as never }),
    world: (w) => w.threadScene("driver", { access: "open", mostOpen: "open" }),
  },
  {
    id: "thread-menu-watcher",
    title: "Thread: the header menu for a teammate, the machine allowing up to Suggest",
    route: (w) => ({ name: "thread", runId: w.threadRunId as never }),
    world: (w) =>
      w.threadScene("watcher", { access: "suggest", mostOpen: "suggest", mode: "full-access" }),
  },
  {
    id: "start-run-mode",
    title: "Start a run: what Claude Code may do, the machine allowing up to Auto",
    route: () => ({ name: "inbox" }),
    task: (w) => w.taskId,
    world: (w) =>
      w.each("machines:list", (v) =>
        (v as Record<string, unknown>[]).map((m) => ({ ...m, mostPermissiveMode: "auto" })),
      ),
  },
  {
    id: "settings-machine-mode",
    title: "Settings, Machines: the most an agent may do on its own",
    route: () => ({ name: "settings", section: "machines" }),
    world: (w) =>
      w.each("machines:list", (v) =>
        (v as Record<string, unknown>[]).map((m) => ({
          ...m,
          mostPermissiveMode: "auto-accept-edits",
        })),
      ),
  },
  {
    id: "space",
    title: "Space whose machine can't be reached",
    route: (w) => ({ name: "space", spaceId: w.spaceId as never }),
    world: (w) => w.spaceReady(),
  },
  // Rex tabs (ADR 0019).
  {
    id: "settings-rex",
    title: "Settings, a machine with Rex tabs",
    route: () => ({ name: "settings", section: "machines" }),
    world: (w) => w.rex(true),
  },
  {
    id: "settings-rex-empty",
    title: "Settings, Rex with no shareable tabs",
    route: () => ({ name: "settings", section: "machines" }),
    world: (w) => {
      w.rex(true);
      w.each("rex:found", (value) => ({ ...(value as object), tabs: [], otherTabs: 0 }));
    },
  },
  {
    id: "settings-rex-many",
    title: "Settings, many shareable Rex tabs",
    route: () => ({ name: "settings", section: "machines" }),
    world: (w) => {
      w.rex(true);
      w.each("rex:found", (value) => {
        const found = value as { tabs: Record<string, unknown>[] };
        return {
          ...found,
          tabs: Array.from({ length: 24 }, (_, i) => ({
            ...found.tabs[i % found.tabs.length],
            tabRef: `gym-rex-${i}`,
            title: `Station ${i + 1} terminal`,
          })),
        };
      });
    },
  },
  {
    id: "settings-machines-empty",
    title: "Settings, no machines",
    route: () => ({ name: "settings", section: "machines" }),
    world: (w) => w.each("machines:list", () => []),
  },
  {
    id: "settings-machines-many",
    title: "Settings, many machines",
    route: () => ({ name: "settings", section: "machines" }),
    world: (w) =>
      w.each("machines:list", (value) => {
        const machines = value as Record<string, unknown>[];
        return [
          ...machines,
          ...Array.from({ length: 24 }, (_, i) => ({
            ...machines[0],
            machineId: `gym-machine-${i}`,
            name: `harbor-station-${i + 1}`,
            online: i % 3 !== 0,
          })),
        ];
      }),
  },
  {
    id: "settings-rex-stopped",
    title: "Settings, a machine where Rex isn't running",
    route: () => ({ name: "settings", section: "machines" }),
    world: (w) => w.rex(false),
  },
  {
    id: "start-run-rex",
    title: "Start a run In Rex",
    route: () => ({ name: "inbox" }),
    task: (w) => w.taskId,
    world: (w) => w.rex(true),
  },
  {
    id: "start-run-rex-off",
    title: "Start a run, In Rex off while Rex isn't running",
    route: () => ({ name: "inbox" }),
    task: (w) => w.taskId,
    world: (w) => w.rex(false),
  },
  {
    id: "terminal-rex",
    title: "Terminal of a run In Rex",
    route: (w) => ({ name: "terminal", terminalId: w.terminalId as never }),
    world: (w) => w.rex(true),
  },
  {
    id: "terminal-rex-wide",
    title: "Terminal of a Rex tab larger than the window, scrolled",
    route: (w) => ({ name: "terminal", terminalId: w.terminalId as never }),
    world: (w) => {
      w.rex(true, { cols: 220, rows: 56 });
      w.wideScreen(220, 56);
    },
  },
  // Who may start runs on a personal machine (ADR 0025). scripts/gymPrepare.ts opens Start a run.
  {
    id: "start-run-teammate-suggest",
    title: "Start a run: a teammate's machine set to Suggest can't take your run",
    route: () => ({ name: "inbox" }),
    task: (w) => w.taskId,
    world: (w) => void w.teammateMachine("suggest"),
  },
  {
    id: "start-run-teammate-drive",
    title: "Start a run: a teammate's machine at Drive takes it in a free slot",
    route: () => ({ name: "inbox" }),
    task: (w) => w.taskId,
    world: (w) => void w.teammateMachine("drive"),
  },
  {
    id: "settings-machine-suggest",
    title: "Settings, Machines: your machine at Suggest, a teammate's terminal handed to you",
    route: () => ({ name: "settings", section: "machines" }),
    world: (w) => w.myMachineAt("suggest"),
  },
  {
    id: "settings-machine-drive",
    title: "Settings, Machines: your machine at Drive, a teammate driving a terminal on it",
    route: () => ({ name: "settings", section: "machines" }),
    world: (w) => w.myMachineAt("drive"),
  },
  {
    id: "terminal-handed-over",
    title: "Terminal: your run on a teammate's machine after it was set to Suggest",
    route: terminal,
    world: (w) => w.handedOver(),
  },
  { id: "search", title: "Search", route: () => ({ name: "search", query: "tide" }) },
  {
    id: "empty",
    title: "Empty team (Inbox)",
    route: () => ({ name: "inbox" }),
    world: (w) => w.empty(),
  },
  { id: "empty-channel", title: "Empty channel", route: general, world: (w) => w.empty() },
  { id: "loading", title: "Loading", route: general, loading: true },
  {
    id: "error-removed",
    title: "Error: removed from a private channel while it's open",
    route: (w) => ({ name: "channel", channelId: w.privateChannel as never }),
    gone: (w) => w.privateChannel,
  },
  { id: "error-call", title: "Error: a call can't start", route: general, call: "join-fails" },
  {
    id: "long-names",
    title: "Long names",
    route: general,
    world: (w) =>
      w.rename({
        "Harbor Labs": LONG_NAMES.team,
        general: LONG_NAMES.channel,
        "Ana Ruiz": LONG_NAMES.person,
        "Tide Tables": LONG_NAMES.project,
      }),
  },
  {
    id: "many-channels",
    title: "Many channels and direct messages",
    route: () => ({ name: "inbox" }),
    world: (w) => w.addChannels(MANY_CHANNELS, w.addPeople(MANY_PEOPLE)),
  },
  {
    id: "many-members",
    title: "Many members (private channel)",
    route: (w) => ({ name: "channel", channelId: w.privateChannel as never }),
    world: (w) => void w.addPeople(MANY_PEOPLE),
  },
  {
    id: "call-notes",
    title: "In a call with an agent taking notes",
    route: general,
    call: "many",
    world: (w) =>
      w.each("teams:members", (v) => [
        ...(v as { memberId: string }[]),
        { kind: "agent", memberId: "gym-notetaker", name: "Notetaker", role: "member" },
      ]),
  },
  {
    id: "call-many",
    title: "A call with many people",
    route: general,
    call: "many",
    world: (w) => void w.addPeople(MANY_PEOPLE.slice(0, 10)),
  },
  // The chat scene, for chat's judge: channels and direct messages as a team uses them.
  {
    id: "chat-general",
    title: "Chat: #general, three days of messages",
    route: general,
    chat: true,
    flows: ["send", "edit", "react", "thread"],
  },
  {
    id: "chat-thread",
    title: "Chat: a thread open in Replies",
    route: general,
    chat: true,
    flows: [],
  },
  {
    id: "chat-unread",
    title: "Chat: a private channel with unread messages",
    route: (w) => ({ name: "channel", channelId: w.privateChannel as never }),
    chat: true,
    flows: ["unread"],
  },
  {
    id: "chat-dm",
    title: "Chat: a direct message",
    route: (w) => ({ name: "channel", channelId: w.dm as never }),
    chat: true,
    flows: [],
  },
  {
    id: "chat-search",
    title: "Chat: search results",
    route: () => ({ name: "search", query: "Bayview" }),
    chat: true,
    flows: ["search"],
  },
  { id: "chat-pins", title: "Chat: pinned messages", route: general, chat: true, flows: [] },
  { id: "chat-picker", title: "Chat: the reaction picker", route: general, chat: true, flows: [] },
  // Talking with an A2A agent in chat (ADR 0024): a direct message in each of its run's states,
  // Julio's "@Icarus hey there" answered inline in #general, a thread, and a thread it proposes.
  // Live runs in chat (ADR 0026): the @ list, messages to and from runs, a direct message with a
  // run, and a run's panel as its driver and as a teammate sees it.
  {
    id: "runs-mention-list",
    title: "Runs in chat: typing @c lists members, then live runs with their tasks",
    route: general,
    chat: true,
    runs: true,
    flows: [],
  },
  {
    id: "runs-in-channel",
    title: "Runs in chat: a message to a run, and messages runs posted, in #general",
    route: general,
    chat: true,
    runs: true,
    flows: [],
  },
  {
    id: "runs-dm",
    title: "Runs in chat: a direct message with Theo's Claude Code run",
    route: () => ({ name: "channel", channelId: RUN_DM as never }),
    chat: true,
    runs: true,
    flows: [],
  },
  {
    id: "runs-dm-thread",
    title:
      "Runs in chat: a thread in the direct message with Theo's team run, whose reply box says the whole team sees its output",
    route: () => ({ name: "channel", channelId: RUN_DM as never }),
    chat: true,
    runs: true,
    flows: [],
  },
  {
    id: "runs-new-dm",
    title: "Runs in chat: the new direct message picker with live runs",
    route: general,
    chat: true,
    runs: true,
    flows: [],
  },
  {
    id: "runs-new-dm-team-run",
    title:
      "Runs in chat: Theo's team run picked, and the picker says the whole team sees its output",
    route: general,
    chat: true,
    runs: true,
    flows: [],
  },
  {
    id: "runs-panel-driver",
    title: "Runs in chat: your run's panel, its inbox and who can message it",
    route: general,
    chat: true,
    runs: true,
    run: GYM_RUNS.rosa,
    flows: [],
  },
  {
    id: "runs-panel-teammate",
    title: "Runs in chat: a teammate's run that takes messages only from its driver",
    route: general,
    chat: true,
    runs: true,
    run: GYM_RUNS.ana,
    flows: [],
  },
  {
    id: "runs-panel-waiting",
    title: "Runs in chat: a run whose machine can't deliver messages yet",
    route: general,
    chat: true,
    runs: true,
    run: GYM_RUNS.theo,
    flows: [],
  },
  // A session that joined by itself (ADR 0032): Live in the roster, and its panel says it has chat only.
  {
    id: "runs-panel-joined",
    title: "Joined run: Mia's Codex session that joined by itself, in the roster and its panel",
    route: general,
    chat: true,
    runs: true,
    run: GYM_RUNS.mia,
    flows: [],
  },
  // Pairs, people in no team and CLI sign-ins (slice 12 of #139).
  {
    id: "pairs-empty",
    title: "Pairs: none yet, with both ways in",
    route: () => ({ name: "pairs" }),
    pairs: "none",
  },
  {
    id: "pair-active",
    title: "Pairs: a live Pair with two runs in it",
    route: () => ({ name: "pair", pairId: GYM_PAIRS.pepe }),
  },
  {
    id: "pair-ended",
    title: "Pairs: an ended Pair, still readable",
    route: () => ({ name: "pair", pairId: GYM_PAIRS.marco }),
  },
  {
    id: "pair-code",
    title: "Pairs: a fresh pair code, shown once with its 10 minutes",
    route: () => ({ name: "pair", pairId: GYM_PAIRS.pepe, code: true }),
  },
  {
    id: "pair-not-delivered",
    title: "Pairs: a message a run's full inbox didn't take, named under the box",
    route: () => ({ name: "pair", pairId: GYM_PAIRS.pepe }),
    pairMissed: ["Claude Code (Pepe Ortiz)"],
  },
  {
    id: "pair-refused",
    title: "Pairs: a refused code on the join form",
    route: () => ({ name: "pairs" }),
    pairJoin: "RIVER-4812-MAPLE-0937",
  },
  {
    id: "no-team",
    title: "Signed in with no team: their Pairs, and making or joining a team",
    noTeam: true,
  },
  {
    id: "cli-signins",
    title: "Settings, Command line: signed-in computers with Revoke",
    route: () => ({ name: "settings", section: "commandLine" }),
    cli: "ours",
    skills: "current",
  },
  // On this computer (components/AgentSetup.tsx, ADR 0042): uplink and uplink-mcp, the skill, the MCP server.
  {
    id: "cli-agents-new",
    title: "Settings, Command line: nothing set up on this Mac yet",
    route: () => ({ name: "settings", section: "commandLine" }),
    cli: "missing",
    skills: "none",
  },
  {
    id: "cli-agents-updated",
    title:
      "Settings, Command line: the bridge on PATH, uplink not yet, Codex's skill from an earlier version",
    route: () => ({ name: "settings", section: "commandLine" }),
    cli: "ours",
    tools: "missing",
    skills: "outdated",
  },
  // Hosted assistants (ADR 0028, slice 14 of #139): Grok Bot's routine webhook sends, and Duet, which checks in on its own schedule.
  {
    id: "hosted-in-channel",
    title:
      "Hosted assistants: messages sent to Grok Bot's webhook, one failed, and Duet's seen and waiting",
    route: general,
    chat: true,
    hosted: true,
    flows: [],
  },
  {
    id: "hosted-mention-list",
    title: "Hosted assistants: the @ list says Duet checks in on its own schedule",
    route: general,
    chat: true,
    hosted: true,
    flows: [],
  },
  {
    id: "settings-agent-webhook",
    title:
      "Settings, Agents: Grok Bot's routine webhook, its key shown by its last four characters",
    route: () => ({ name: "settings", section: "agents" }),
    world: (w) => w.grokWebhook(),
  },
  {
    id: "settings-agent-webhook-add",
    title: "Settings, Agents: adding a routine webhook to Grok Bot",
    route: () => ({ name: "settings", section: "agents" }),
    world: (w) => w.grokWebhook({ set: false }),
  },
  {
    id: "agent-dm-working",
    title: "Agent chat: a direct message while Icarus works",
    route: () => icarusDm,
    chat: true,
    agent: "dm-working",
    flows: [],
  },
  {
    id: "agent-dm-answered",
    title: "Agent chat: a direct message Icarus answered",
    route: () => icarusDm,
    chat: true,
    agent: "dm-answered",
    flows: [],
  },
  {
    id: "agent-dm-asking",
    title: "Agent chat: Icarus asks a question in a direct message",
    route: () => icarusDm,
    chat: true,
    agent: "dm-asking",
    flows: [],
  },
  {
    id: "agent-dm-failed",
    title: "Agent chat: Icarus's run failed in a direct message",
    route: () => icarusDm,
    chat: true,
    agent: "dm-failed",
    flows: [],
  },
  {
    id: "agent-channel-hey",
    title: 'Agent chat: "@Icarus hey there" answered inline in #general',
    route: general,
    chat: true,
    agent: "channel-hey",
    flows: [],
  },
  {
    id: "agent-thread",
    title: "Agent chat: Icarus answers in a thread, and works on a follow-up",
    route: general,
    chat: true,
    agent: "thread",
    flows: [],
  },
  {
    id: "agent-proposal",
    title: "Agent chat: Icarus proposes a thread, with its countdown",
    route: general,
    chat: true,
    agent: "proposal",
    flows: [],
  },
  {
    id: "agent-proposal-accepted",
    title: "Agent chat: the proposed thread opened, Icarus answers in it",
    route: general,
    chat: true,
    agent: "proposal-accepted",
    flows: [],
  },
  {
    id: "agent-proposal-declined",
    title: "Agent chat: the proposed thread declined, Icarus answers inline",
    route: general,
    chat: true,
    agent: "proposal-declined",
    flows: [],
  },
  {
    id: "agent-proposal-canceled",
    title: "Agent chat: the proposed thread canceled, its run was stopped",
    route: general,
    chat: true,
    agent: "proposal-canceled",
    flows: [],
  },
  // An A2A agent's settings (ADR 0012, ADR 0018): a run its gateway didn't take, and Check connection's results.
  {
    id: "agent-run-refused",
    title: "Settings, Agents: a run the agent's gateway didn't take",
    route: () => ({ name: "settings", section: "agents" }),
    world: (w) => w.a2aAgent({ runs: refusedRun }),
  },
  {
    id: "agent-check-ok",
    title: "Settings, Agents: Check connection finds A2A 0.3 behind a 1.0 card",
    route: () => ({ name: "settings", section: "agents" }),
    world: (w) =>
      w.a2aAgent({
        peer: (peer) => ({
          ...peer,
          protocol: { speaks: "0.3", declared: "1.0", learned: true },
          connection: {
            status: "ok",
            at: Date.now() - 90_000,
            by: { memberId: w.me["memberId"], name: myName(w), kind: "person" },
            dialect: "0.3",
            summary:
              "Icarus answered tasks/get over A2A 0.3 and took the room's token. Its Agent Card says A2A 1.0, so the room speaks A2A 0.3 to it from now on.",
          },
        }),
      }),
  },
  {
    id: "agent-check-failed",
    title: "Settings, Agents: Check connection finds the token refused",
    route: () => ({ name: "settings", section: "agents" }),
    world: (w) =>
      w.a2aAgent({
        peer: (peer) => ({
          ...peer,
          connection: {
            status: "failed",
            at: Date.now() - 40_000,
            by: { memberId: w.me["memberId"], name: myName(w), kind: "person" },
            summary: "Icarus's gateway refused the room's token (HTTP 401). Replace the token.",
          },
        }),
      }),
  },
  { id: "setup-welcome", title: "Setup: welcome", setup: "welcome", permissions: "live" },
  {
    id: "setup-devices",
    title: "Setup: microphone, speaker and camera (sample devices)",
    setup: "devices",
    permissions: "live",
  },
  {
    id: "setup-permissions",
    title: "Setup: permissions (this Mac's real states)",
    setup: "permissions",
    permissions: "live",
  },
  {
    id: "setup-permissions-not-asked",
    title: "Setup: permissions, not asked yet",
    setup: "permissions",
    permissions: NOT_ASKED,
  },
  {
    id: "setup-permissions-denied",
    title: "Setup: permissions, denied",
    setup: "permissions",
    permissions: DENIED,
  },
  {
    id: "setup-permissions-granted",
    title: "Setup: permissions, all allowed",
    setup: "permissions",
    permissions: GRANTED,
  },
  { id: "setup-pair", title: "Setup: link this computer", setup: "pair", permissions: GRANTED },
  {
    id: "setup-pair-unknown",
    title: "Setup: this computer's link couldn't be checked",
    setup: "pair",
    permissions: GRANTED,
    linkError: "EACCES: permission denied, open bridge.json",
  },
  {
    id: "setup-pair-linked",
    title: "Setup: this computer is already linked, uplink-bridge on PATH",
    setup: "pair",
    permissions: GRANTED,
    linkedAs: "Rosa's Mac",
    cli: "ours",
  },
  {
    id: "setup-pair-error",
    title: "Setup: linking fails",
    setup: "pair",
    permissions: GRANTED,
    pairFails: true,
  },
  { id: "setup-done", title: "Setup: done", setup: "done", permissions: NOT_ASKED },
];

/** Your own name in the sample team (teams:mine holds the team's). */
function myName(w: World): string {
  return w.members.find((m) => m.memberId === w.me["memberId"])?.name ?? "Rosa Vega";
}

/** The run Icarus's gateway didn't take: neither version's send was found (ADR 0018), as the room words it. */
function refusedRun(
  agent: Record<string, unknown>,
  me: Record<string, unknown>,
): Record<string, unknown>[] {
  const at = Date.now() - 6 * 60_000;
  const reason =
    "Icarus doesn't answer SendMessage, the A2A 1.0 method its Agent Card promises, or message/send from A2A 0.3. It said: “method not found”. Check that the address on its Agent Card is its A2A endpoint.";
  const driver = { memberId: me["memberId"], name: me["name"], kind: "person" };
  return [
    {
      runId: "gym-run-icarus",
      harness: "a2a",
      title: "Testing",
      state: "failed",
      failReason: reason,
      private: false,
      driver,
      startedAt: at,
      stateChangedAt: at + 2_000,
      endedAt: at + 2_000,
      a2a: {
        agent: { agentId: agent["agentId"], memberId: agent["memberId"], name: agent["name"] },
        connected: true,
        canCancel: "unknown",
        following: false,
        delivery: "failed",
        artifacts: [],
        lastError: reason,
        lastContactAt: at,
        messages: [
          { kind: "start", text: "Testing", at, status: "failed", error: reason, by: driver },
        ],
      },
    },
  ];
}

export function simulatedState(
  statuses: GymState["permissions"] & object,
  packaged = true,
): PermissionsState {
  return { platform: "darwin", packaged, appName: "Uplink Room", statuses: { ...statuses } };
}

// Inventory variants use the same routes and query fixtures as the normal gym.
STATES.push(...inventoryScenes(STATES));

// The recorded Inbox has only Working rows. This state makes Allow and Settle
// reachable by keyboard without asking a backend to create work.
STATES.push({
  id: "inventory-inbox-shortcuts",
  title: "Inventory Inbox: approval and finished work",
  route: () => ({ name: "inbox" }),
  world: (world) => {
    type Row = Record<string, unknown>;
    const inbox = world.get<{ working: Row[] }>("inbox:get", { view: "mine" });
    const base = inbox.working[0]!;
    const run = (base["runs"] as Row[])[0]!;
    const task = world.get<Row>("tasks:get", { taskId: base["taskId"] });
    const now = Date.now();
    const approvalId = `${base["taskId"]}-shortcut-approval`;
    const doneId = `${base["taskId"]}-shortcut-done`;
    const approvalRun = {
      ...run,
      runId: `${run["runId"]}-shortcut-approval`,
      taskId: approvalId,
      state: "waiting",
      stateChangedAt: now,
      prompt: {
        kind: "approval",
        promptId: "gym-shortcut-approval",
        text: "Read the sample report",
        action: "Read the sample report",
      },
    };
    const doneRun = {
      ...run,
      runId: `${run["runId"]}-shortcut-done`,
      taskId: doneId,
      state: "done",
      stateChangedAt: now,
      endedAt: now,
    };
    const approval = {
      ...base,
      taskId: approvalId,
      title: "Approve the sample report",
      state: "waiting",
      changedAt: now,
      runs: [approvalRun],
    };
    const done = {
      ...base,
      taskId: doneId,
      title: "Settle the finished sample",
      state: "done",
      changedAt: now,
      runs: [doneRun],
    };
    const value = { needsYou: [approval], working: [base], done: [done] };
    world.each("inbox:get", () => value);
    world.set("inbox:get", { view: "team" }, value);
    world.set("tasks:get", { taskId: approvalId }, { ...task, ...approval });
    world.set("tasks:get", { taskId: doneId }, { ...task, ...done });
  },
});
