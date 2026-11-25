import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { UserButton } from "@clerk/electron/react";
import {
  Menu,
  MenuContent,
  MenuGroupLabel,
  MenuItem,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { Toggle } from "@ui-sdk/react/toggle";
import { Tip } from "./components/Tip";
import { api, type Id, type MyTeam } from "./lib/api";
import { useAct, useRoomQuery, useSession, useSoftRoomQuery, useToast } from "./lib/session";
import { markOnboarded, onboarded, type Preferences } from "./lib/theme";
import { harnessLabel } from "./lib/format";
import { STATE_META } from "./lib/states";
import { CHECKS_IN } from "./lib/chat";
import { Face, HarnessMark } from "./components/Faces";
import { Icon } from "./components/Icon";
import { SettingsOverlay } from "./components/SettingsOverlay";
import { Covered } from "./lib/covered";
import { Signals } from "./components/Signals";
import { LinkMascot } from "./characters/LinkMascot";
import { Setup, type PairApi } from "./views/Setup";
import type { LinkState } from "./views/setupSpec";
import { usePairing } from "./lib/pairing";
import { desktopPermissions, type PermissionsApi } from "./lib/permissions";
import { clerkAppearance } from "./lib/clerkAppearance";
import { Inbox } from "./views/Inbox";
import { Unfiled } from "./views/Unfiled";
import { ProjectView } from "./views/ProjectView";
import { ChannelView } from "./views/ChannelView";
import { ChannelBoundary } from "./components/chat/ChannelBoundary";
import { SearchView, type SearchSpec } from "./views/SearchView";
import { NewDirectMessage, placeNear } from "./components/chat/NewDirectMessage";
import { NewChannel } from "./components/chat/NewChannel";
import { useNow } from "./components/useNow";
import { presenceLabel, usePresence, useHeartbeat } from "./lib/presence";
import { MemberFace } from "./components/Faces";
import { TerminalView } from "./views/TerminalView";
import { ThreadView } from "./views/ThreadView";
import { SpaceView } from "./views/SpaceView";
import { SettingsView, type SettingsSection } from "./views/Settings";
import { StartRunDialog, TaskPanel } from "./views/TaskPanel";
import { TaskPicker } from "./components/TaskPicker";
import { RunPanel } from "./views/RunPanel";
import { NewProjectDialog, NewTaskDialog } from "./components/NewWork";
import { CallDock } from "./components/Call";
import { VoiceRooms } from "./components/VoiceRooms";
import { ViewBoundary } from "./components/ViewBoundary";
import { CallProvider, useLiveCalls } from "./lib/call";
import { UpdateReady } from "./components/UpdateReady";
import { track } from "./lib/analytics";
import { useOpenLink } from "./lib/deepLinks";
import { desktop } from "./lib/desktop";
import { useSettingsMenu } from "./lib/settingsMenu";
import { useStoredFlag } from "./lib/storedFlag";
import { PairConversation, PairsLanding, PairsNav, PairStart, usePairs } from "./views/Pairs";

export type Route =
  | { name: "inbox" }
  | { name: "unfiled" }
  | { name: "project"; projectId: Id<"projects"> }
  /** The board of tasks that belong to no project. */
  | { name: "noProject" }
  /**
   * A channel or direct message, opened at `messageId` when given. `search`: opened from a search
   * result, so that search's results show beside it (ChannelView's Search panel).
   */
  | {
      name: "channel";
      channelId: Id<"channels">;
      messageId?: Id<"messages"> | undefined;
      search?: SearchSpec | undefined;
    }
  | { name: "search"; query: string }
  | { name: "terminal"; terminalId: Id<"terminals"> }
  | { name: "thread"; runId: Id<"runs"> }
  | { name: "space"; spaceId: Id<"spaces"> }
  /** Your Pairs (ADR 0034): what a Pair is, and the ways to start or join one. */
  | { name: "pairs" }
  /** One Pair, outside every team. `code`: just made, so its first pair code shows. */
  | { name: "pair"; pairId: string; code?: boolean | undefined }
  | { name: "settings"; section: SettingsSection };

export type Nav = {
  go(route: Route): void;
  openTask(taskId: Id<"tasks">): void;
  openTerminal(terminalId: Id<"terminals">): void;
  openSpace(spaceId: Id<"spaces">): void;
  /** A T3 Code thread run's conversation (ADR 0022). */
  openThread(runId: Id<"runs">): void;
  openRun(run: {
    /** For a run with nothing else to open (an A2A run from a mention): opens the run itself. */
    runId?: Id<"runs"> | undefined;
    taskId?: Id<"tasks"> | undefined;
    terminalId?: Id<"terminals"> | undefined;
    spaceId?: Id<"spaces"> | undefined;
  }): void;
  /** Opens the first-run setup again (Settings, Setup). */
  runSetup?: () => void;
};

function sameRoute(a: Route, b: Route): boolean {
  if (a.name !== b.name) return false;
  // A channel is the same place whichever of its messages it was opened at.
  if (a.name === "channel" && b.name === "channel") return a.channelId === b.channelId;
  if (a.name === "pair" && b.name === "pair") return a.pairId === b.pairId;
  return JSON.stringify(a) === JSON.stringify(b);
}

type ShellProps = {
  prefs: Preferences;
  teams: MyTeam[];
  onSwitch: () => void;
  onPick: (team: MyTeam) => void;
  /** Your avatar and account menu in the sidebar's footer: Clerk's, unless the gym gives a stand-in. */
  account?: ReactNode;
  /** Where the gym opens, and the task it opens over it; the app opens to the Inbox. */
  initialRoute?: Route;
  initialTaskId?: Id<"tasks">;
  /** The run the gym opens its panel for (a live run's messages, ADR 0026). */
  initialRunId?: Id<"runs">;
  /** The gym's simulated permissions and pairing; the app talks to the main process. */
  permissions?: PermissionsApi;
  pair?: PairApi;
  /** The gym opens the setup at a step; the app shows it once on each computer. */
  setupStep?: "welcome" | "devices" | "permissions" | "pair" | "done" | null;
  /** The gym opens Start or join a Pair on its join form, with a code typed and the room's answer. */
  initialPairJoin?: { code: string; error?: string } | undefined;
  /** The gym opens a Pair as if its last message hadn't reached these runs. */
  initialPairMissed?: string[] | undefined;
};

/** Settings opens here, from the gear in the sidebar's footer and from Settings… (Command-comma). */
export const SETTINGS_ROUTE: Route = { name: "settings", section: "machines" };

/** The call you're in lives above every view, so it survives moving around the app. */
const ROSTER_ORDER = ["waiting", "failed", "working", "unknown", "done", "stopped", "idle"];

export function Shell(props: ShellProps) {
  return (
    <CallProvider>
      <ShellView {...props} />
    </CallProvider>
  );
}

/** The shell without its call: the gym (gym/) renders it inside a call state of its own. */
export function ShellView({
  prefs,
  teams,
  onSwitch,
  onPick,
  account,
  initialRoute,
  initialTaskId,
  initialRunId,
  permissions,
  pair,
  setupStep,
  initialPairJoin,
  initialPairMissed,
}: ShellProps) {
  const session = useSession();
  const liveCalls = useLiveCalls();
  const [route, setRoute] = useState<Route>(initialRoute ?? { name: "inbox" });
  const [taskId, setTaskId] = useState<Id<"tasks"> | null>(initialTaskId ?? null);
  const [runId, setRunId] = useState<Id<"runs"> | null>(initialRunId ?? null);
  const [groupByProject, setGroupByProject] = useState(false);
  const [projectFilter, setProjectFilter] = useState<Id<"projects"> | "all">("all");
  const [newProject, setNewProject] = useState(false);
  const [newTask, setNewTask] = useState(false);
  const [newDirect, setNewDirect] = useState<DOMRect | null>(null);
  const [newChannel, setNewChannel] = useState<DOMRect | null>(null);
  const [pairStart, setPairStart] = useState<DOMRect | null>(null);
  // A roster agent's "Give it a task" menu, then Give to an agent for the task picked there (ADR 0044).
  const [giveMenu, setGiveMenu] = useState<{ agentId: Id<"agents">; anchor: DOMRect } | null>(null);
  const [giving, setGiving] = useState<{
    agentId: Id<"agents">;
    taskId: Id<"tasks">;
    projectId: Id<"projects"> | undefined;
  } | null>(null);
  const { pairs, more: morePairs } = usePairs();
  const [welcome, setWelcome] = useState(() =>
    setupStep === undefined ? !onboarded() : setupStep !== null,
  );
  const desktopPair = useDesktopPair();

  const nav = useMemo<Nav>(
    () => ({
      go: (next) => {
        setRoute(next);
        setTaskId(null);
        setRunId(null);
      },
      openTask: (id) => {
        setRunId(null);
        setTaskId(id);
      },
      openTerminal: (terminalId) => {
        setRoute({ name: "terminal", terminalId });
        setTaskId(null);
        setRunId(null);
      },
      openSpace: (spaceId) => {
        setRoute({ name: "space", spaceId });
        setTaskId(null);
        setRunId(null);
      },
      openThread: (id) => {
        setRoute({ name: "thread", runId: id });
        setTaskId(null);
        setRunId(null);
      },
      runSetup: () => setWelcome(true),
      openRun: (run) => {
        if (run.taskId) {
          setRunId(null);
          setTaskId(run.taskId);
        } else if (run.terminalId) {
          setRoute({ name: "terminal", terminalId: run.terminalId });
          setTaskId(null);
        } else if (run.spaceId) {
          setRoute({ name: "space", spaceId: run.spaceId });
          setTaskId(null);
        } else if (run.runId) {
          setTaskId(null);
          setRunId(run.runId);
        }
      },
    }),
    [],
  );

  // A link from the welcome email opens its place here (lib/deepLinks.ts).
  useOpenLink(nav, session.teamId);

  // Soft: the shell sits outside every view's error boundary, so one of these failing (Convex timing
  // out a query, UPLINK-ROOM-DESKTOP-7) would take the whole window down. A failed one reads as not
  // loaded yet.
  const inbox = useSoftRoomQuery(api.inbox.get, {});
  const unfiled = useSoftRoomQuery(api.runs.unfiled, {});
  const roster = useSoftRoomQuery(api.teams.roster, {});
  const projects = useSoftRoomQuery(api.projects.list, {});
  const channels = useSoftRoomQuery(api.channels.list, {});
  // "No project" is a place once there's something to put there: a project to be outside of, or a task.
  const allTasks = useSoftRoomQuery(api.tasks.board, {});

  // Analytics: which of the app's main places people open.
  useEffect(() => {
    if (route.name === "inbox") track("inbox_opened");
    else if (route.name === "space") track("space_opened");
    else if (route.name === "terminal") track("terminal_opened");
  }, [route]);

  // Proposed tasks from calls need a yes or a no too (absent from a backend from before they did).
  const needs = (inbox?.needsYou.length ?? 0) + (inbox?.proposals?.length ?? 0);
  // A project archived while the Inbox shows only it: back to all projects, so nothing it held (a
  // proposal now asks where it goes) hides behind a filter the menu no longer lists.
  useEffect(() => {
    if (projectFilter !== "all" && projects && !projects.some((p) => p.projectId === projectFilter))
      setProjectFilter("all");
  }, [projectFilter, projects]);
  const projectChannelIds = new Set((projects ?? []).map((p) => p.channelId));
  const looseChannels = (channels ?? []).filter(
    (c) => c.kind !== "direct" && !c.projectId && !projectChannelIds.has(c.channelId),
  );
  const projectChannels = (channels ?? []).filter(
    (c) => c.kind !== "direct" && (c.projectId || projectChannelIds.has(c.channelId)),
  );
  const directMessages = (channels ?? []).filter((c) => c.kind === "direct");
  // Presence (lib/presence.ts): this app says you're here, and direct messages show who else is.
  useHeartbeat();
  const presenceOf = usePresence();
  const presenceNow = useNow(30_000);

  // Channels as last seen, so one you lose while it's open keeps its name in the title row.
  const seen = useRef(new Map<string, { name: string; kind: string }>());
  for (const c of channels ?? []) seen.current.set(c.channelId, { name: c.name, kind: c.kind });
  const is = (target: Route) => (sameRoute(route, target) ? ("page" as const) : undefined);
  // Conversations fold to what's live, so chat doesn't compete with the work: the one open, a
  // mention of you, or something unread in a conversation you hear from. Calls are in Voice.
  const [allConversations, setAllConversations] = useStoredFlag(
    "uplink.sidebar.allConversations",
    false,
  );
  const [projectsOpen, setProjectsOpen] = useStoredFlag("uplink.sidebar.projectsOpen", false);
  const showConversation = (c: {
    channelId: Id<"channels">;
    unread: number;
    mentions: number;
    notify?: string;
  }) =>
    allConversations ||
    is({ name: "channel", channelId: c.channelId }) !== undefined ||
    c.mentions > 0 ||
    (c.unread > 0 && c.notify !== "none");
  const conversationCount = (channels ?? []).length + (pairs ?? []).length;
  const shownConversations =
    (channels ?? []).filter(showConversation).length +
    (pairs ?? []).filter(
      (p) =>
        (p.unread > 0 && p.endedAt === undefined) ||
        (route.name === "pair" && route.pairId === p.pairId),
    ).length;
  // Until the sidebar's lists have loaded, it says so once instead of showing empty sections.
  const loadingSidebar = roster === undefined || projects === undefined || channels === undefined;
  // The gym's refused code: the popover opens on its own, under the sidebar's Pairs +, once it's there.
  const pairJoinShown = useRef(false);
  useEffect(() => {
    if (!initialPairJoin || pairJoinShown.current || loadingSidebar || pairs === undefined) return;
    const plus = document.querySelector<HTMLElement>('[aria-label="Start or join a Pair"]');
    if (!plus) return;
    pairJoinShown.current = true;
    setPairStart(plus.getBoundingClientRect());
  }, [initialPairJoin, loadingSidebar, pairs]);
  // The open place stays in view in the sidebar, so a short window never hides where you are.
  const sidebarList = useRef<HTMLElement>(null);
  useEffect(() => {
    sidebarList.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [route, loadingSidebar]);
  const openInbox = useCallback(() => nav.go({ name: "inbox" }), [nav]);
  const openSettings = useCallback(() => nav.go(SETTINGS_ROUTE), [nav]);
  // The view under Settings: the last place you were that isn't Settings (the Inbox at first).
  const behind = useRef<Route>({ name: "inbox" });
  if (route.name !== "settings") behind.current = route;
  const view: Route = route.name === "settings" ? behind.current : route;
  useSettingsMenu(openSettings);

  return (
    // On the Inbox its cards say what waits; the sidebar keeps only the dot (look.css).
    <div className={`app ${view.name === "inbox" ? "on-inbox" : ""}`}>
      <aside className="sidebar" aria-label="Sidebar">
        <div className="sidebar-top">
          <div style={{ minWidth: 0 }}>
            <Menu>
              <Tip label="Switch team">
                <MenuTrigger className="team-btn">
                  {/* Link's antenna glows while something needs you, and Link reacts to every sound cue. */}
                  <LinkMascot size={22} state={needs > 0 ? "waiting" : "idle"} />
                  <span className="truncate">{session.team.name}</span>
                  <Icon name="chevron-down" size={14} />
                </MenuTrigger>
              </Tip>
              <MenuContent
                className="pop team-menu"
                aria-label="Switch team"
                side="bottom"
                align="start"
                sideOffset={4}
              >
                <MenuRadioGroup
                  value={session.teamId}
                  onValueChange={(teamId) => {
                    const team = teams.find((t) => t.teamId === teamId);
                    if (team && team.teamId !== session.teamId) onPick(team);
                  }}
                >
                  <MenuGroupLabel className="pop-title">Teams</MenuGroupLabel>
                  {teams.map((team) => (
                    <MenuRadioItem
                      key={team.teamId}
                      value={team.teamId}
                      label={team.name}
                      closeOnSelect
                    >
                      <span className="grow truncate">{team.name}</span>
                      <MenuItemIndicator>
                        <Icon name="check" />
                      </MenuItemIndicator>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
                <MenuSeparator />
                <MenuItem onSelect={onSwitch}>Create or join a team</MenuItem>
              </MenuContent>
            </Menu>
          </div>
          {/* Search and a new task, as Grok Bot's sidebar keeps its search and + at the top. */}
          <span className="grow" />
          <Tip label="Search messages">
            <Toggle
              className="btn icon"
              aria-label="Search messages"
              pressed={route.name === "search"}
              onPressedChange={() => nav.go({ name: "search", query: "" })}
            >
              <Icon name="search" />
            </Toggle>
          </Tip>
          <Tip label="New task">
            <button
              className="btn icon"
              type="button"
              aria-label="New task"
              onClick={() => setNewTask(true)}
            >
              <Icon name="plus" />
            </button>
          </Tip>
        </div>

        <nav className="sidebar-scroll" ref={sidebarList}>
          <button
            className="nav-item"
            type="button"
            aria-current={is({ name: "inbox" })}
            onClick={openInbox}
          >
            <Icon name="inbox" />
            <span className="label-text">Inbox</span>
            {/* The count is "needs you" (DESIGN.md): working runs show in the Inbox, not as a count. */}
            {/* One small dot, as Grok Bot marks what needs you; how many is the Inbox's first line. */}
            {needs > 0 ? (
              <span
                className="attention-dot"
                aria-label={`${needs} need you`}
                title={`${needs} need you`}
              />
            ) : null}
          </button>

          {/* Unfiled: runs no task points at yet, shown only while there are some. */}
          {unfiled && unfiled.length > 0 ? (
            <button
              className="nav-item"
              type="button"
              aria-current={is({ name: "unfiled" })}
              onClick={() => nav.go({ name: "unfiled" })}
            >
              <Icon name="unfiled" />
              <span className="label-text">Unfiled</span>
              <span className="badge">{unfiled.length}</span>
            </button>
          ) : null}

          {loadingSidebar ? <div className="muted sidebar-note">Loading…</div> : null}
          {loadingSidebar ? null : (
            <>
              <div className="nav-heading">
                <span className="grow">Roster</span>
                <Tip label="Add an agent">
                  <button
                    className="icon-btn"
                    type="button"
                    aria-label="Add an agent"
                    onClick={() => nav.go({ name: "settings", section: "agents" })}
                  >
                    <Icon name="plus" />
                  </button>
                </Tip>
              </div>
              {roster === undefined ? null : roster.length === 0 ? (
                <button
                  className="nav-item roster-empty"
                  type="button"
                  onClick={() => nav.go({ name: "settings", section: "agents" })}
                >
                  <Icon name="plus" />
                  <span className="label-text">Add your first agent</span>
                </button>
              ) : (
                // A list of roomy rows, as Grok Bot lists its Bots: each character, its name, and what it's on.
                // Most urgent first: an agent waiting on someone leads, as Grok Bot's list does.
                <div className="roster-grid">
                  {[...roster]
                    .sort((a, b) => ROSTER_ORDER.indexOf(a.state) - ROSTER_ORDER.indexOf(b.state))
                    .map((entry) => {
                      const added =
                        entry.kind === "agent"
                          ? session.members.find((m) => m.memberId === entry.memberId)?.addedBy
                          : undefined;
                      const hover =
                        entry.kind === "agent"
                          ? `${entry.name}${added ? `, added by ${added.name}. It can do at most what ${added.name} can.` : ""}${
                              entry.reach === "checks_in"
                                ? " It reads and posts through its connector when it runs, so it sees messages when it next checks."
                                : ""
                            }`
                          : joinedOnly(entry)
                            ? `${harnessLabel(entry.name)}, joined by itself with uplink join: it has chat only, no terminal or thread`
                            : `${entry.name}, running now`;
                      // Its state and what it's on, also in the tooltip.
                      const doing =
                        entry.state === "idle"
                          ? ""
                          : `\n${STATE_META[entry.state].label}${entry.line ? `: ${entry.line}` : ""}`;
                      const body = (
                        <>
                          {entry.kind === "agent" ? (
                            <span className={`state-ring ring-${entry.state}`}>
                              <Face
                                who={{
                                  name: entry.name,
                                  kind: "agent",
                                  character: entry.character,
                                }}
                                state={entry.state}
                                size={40}
                              />
                            </span>
                          ) : (
                            // A harness shows its most urgent run's state on its character, as an agent does on its face.
                            <span className={`state-ring ring-${entry.state}`}>
                              <HarnessMark harness={entry.name} state={entry.state} size={36} />
                            </span>
                          )}
                          <div style={{ minWidth: 0 }}>
                            <b className="truncate">
                              {entry.kind === "harness" ? harnessLabel(entry.name) : entry.name}
                            </b>
                            {/* Its state, then what it's on (its most urgent run's title), as Grok Bot's list shows a bot's latest line. */}
                            {entry.state === "idle" &&
                            !entry.line &&
                            !(entry.kind === "agent" && entry.reach === "checks_in") ? null : (
                              <small className="roster-line">
                                {/* A joined run's Live isn't a state the room tracks: it keeps the text color rather than Unknown's grey. */}
                                <span
                                  className={
                                    joinedOnly(entry) && entry.state === "unknown"
                                      ? "roster-live"
                                      : `state-${entry.state}`
                                  }
                                >
                                  {entry.state === "idle"
                                    ? entry.kind === "agent" && entry.reach === "checks_in"
                                      ? CHECKS_IN
                                      : "Idle"
                                    : joinedOnly(entry) && entry.state === "unknown"
                                      ? "Live"
                                      : entry.state === "waiting"
                                        ? // The roster doesn't say whom it waits on: a teammate's run counts too.
                                          "Waiting:"
                                        : STATE_META[entry.state].label}
                                </span>
                                {entry.line ? (
                                  <span className="muted truncate">{entry.line}</span>
                                ) : entry.kind === "harness" && entry.joined ? (
                                  <span className="muted truncate">
                                    {entry.joined === entry.runs
                                      ? entry.runs > 1
                                        ? `${entry.runs} joined by themselves`
                                        : "Joined by itself"
                                      : `${entry.runs} runs, ${entry.joined} joined`}
                                  </span>
                                ) : entry.runs > 1 ? (
                                  <span className="muted">{entry.runs} runs</span>
                                ) : null}
                              </small>
                            )}
                          </div>
                        </>
                      );
                      // An agent's row opens "Give it a task" (ADR 0044); a harness's row only says what runs.
                      if (entry.kind === "agent" && entry.agentId) {
                        const agentId = entry.agentId;
                        const open = giveMenu?.agentId === agentId;
                        return (
                          <Tip key={entry.memberId} label={<TipLines text={hover + doing} />}>
                            <button
                              type="button"
                              className="roster-item"
                              aria-haspopup="menu"
                              aria-expanded={open}
                              // While it's open, the menu's click-outside close mustn't fire first and reopen it here.
                              onMouseDown={(event) => open && event.stopPropagation()}
                              onClick={(event) => {
                                const anchor = event.currentTarget.getBoundingClientRect();
                                setGiveMenu(open ? null : { agentId, anchor });
                              }}
                            >
                              {body}
                            </button>
                          </Tip>
                        );
                      }
                      return (
                        <div
                          key={entry.kind === "agent" ? entry.memberId : `h-${entry.name}`}
                          className="roster-item"
                          title={hover + doing}
                        >
                          {body}
                        </div>
                      );
                    })}
                </div>
              )}

              {/* Voice, as Discord lists its voice channels: every channel is a room, listed whether or not
                  anyone is there, and one click joins (or, with nobody there yet, starts) its call. */}
              <div className="nav-heading">
                <span className="grow">Voice</span>
              </div>
              <VoiceRooms
                rooms={[
                  ...[...looseChannels, ...projectChannels].map((c) => ({
                    channelId: c.channelId,
                    name: c.name,
                    kind: c.kind,
                  })),
                  // A direct message is a room while someone is talking in it.
                  ...directMessages
                    .filter((dm) => liveCalls?.some((call) => call.channelId === dm.channelId))
                    .map((dm) => ({ channelId: dm.channelId, name: dm.name, kind: dm.kind })),
                ]}
                liveCalls={liveCalls}
                openChannelId={route.name === "channel" ? route.channelId : undefined}
                onOpen={(channelId) => nav.go({ name: "channel", channelId })}
              />

              {/* People, channels and Pairs in one list (Grok Bot keeps one list of conversations). Folded,
                  it shows only what's live: the one open, a mention or something unread. */}
              <div className="nav-heading">
                <span className="grow">Conversations</span>
                <Tip label="New direct message">
                  <button
                    className="icon-btn"
                    type="button"
                    aria-label="New direct message"
                    aria-expanded={newDirect !== null}
                    // While it's open, the popover's click-outside close mustn't fire first and reopen it here.
                    onMouseDown={(event) => newDirect && event.stopPropagation()}
                    onClick={(event) => {
                      // Read now: React clears currentTarget once the handler returns, before a queued updater runs.
                      const rect = event.currentTarget.getBoundingClientRect();
                      setNewDirect((open) => (open ? null : rect));
                    }}
                  >
                    <Icon name="user" />
                  </button>
                </Tip>
                <Tip label="New channel">
                  <button
                    className="icon-btn"
                    type="button"
                    aria-label="New channel"
                    aria-expanded={newChannel !== null}
                    onMouseDown={(event) => newChannel && event.stopPropagation()}
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      setNewChannel((open) => (open ? null : rect));
                    }}
                  >
                    <Icon name="hash" />
                  </button>
                </Tip>
                <Tip label="Start or join a Pair">
                  <button
                    className="icon-btn"
                    type="button"
                    aria-label="Start or join a Pair"
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      setPairStart((open) => (open ? null : rect));
                    }}
                  >
                    <Icon name="link" />
                  </button>
                </Tip>
              </div>
              {directMessages.filter(showConversation).map((dm) => {
                const other = (dm.members ?? []).find((m) => m.memberId !== session.me.memberId);
                return (
                  <div key={dm.channelId}>
                    <button
                      type="button"
                      className={`nav-item dm-item ${dm.unread > 0 && dm.notify !== "none" ? "unread" : ""}`}
                      aria-current={is({ name: "channel", channelId: dm.channelId })}
                      onClick={() => nav.go({ name: "channel", channelId: dm.channelId })}
                    >
                      {dm.runs?.length ? (
                        // A direct message with a live run (ADR 0026) is named by the run first, and shows its mark.
                        <HarnessMark harness="run" size={32} title={dm.runs[0]!.label} />
                      ) : other ? (
                        <MemberFace
                          member={other}
                          members={session.members}
                          size={32}
                          presence={(() => {
                            const p = presenceOf(other.memberId);
                            return {
                              presence: p.presence,
                              label: presenceLabel(p.presence, p.lastSeenAt, presenceNow),
                            };
                          })()}
                        />
                      ) : (
                        <Icon name="user" />
                      )}
                      <span className="label-text">{dm.name}</span>
                      <UnreadBadges
                        unread={dm.notify === "none" ? 0 : dm.unread}
                        mentions={dm.mentions}
                      />
                    </button>
                  </div>
                );
              })}

              {[...looseChannels, ...projectChannels].filter(showConversation).map((channel) => {
                return (
                  <div key={channel.channelId}>
                    <button
                      type="button"
                      className={`nav-item ${channel.unread > 0 && channel.notify !== "none" ? "unread" : ""}`}
                      aria-current={is({ name: "channel", channelId: channel.channelId })}
                      onClick={() => nav.go({ name: "channel", channelId: channel.channelId })}
                    >
                      {/* A private channel (ADR 0016) shows a lock where a team channel shows #. */}
                      <Icon name={channel.kind === "private" ? "lock" : "hash"} />
                      <span className="label-text">{channel.name}</span>
                      {channel.kind === "private" ? (
                        <span className="sr-only">, private</span>
                      ) : null}
                      <UnreadBadges
                        unread={channel.notify === "none" ? 0 : channel.unread}
                        mentions={channel.mentions}
                      />
                    </button>
                  </div>
                );
              })}

              <PairsNav
                bare
                pairs={pairs?.filter(
                  (p) =>
                    allConversations ||
                    (p.unread > 0 && p.endedAt === undefined) ||
                    (route.name === "pair" && route.pairId === p.pairId),
                )}
                more={allConversations ? morePairs : undefined}
                currentPairId={route.name === "pair" ? route.pairId : undefined}
                onOpen={(pairId) => nav.go({ name: "pair", pairId })}
                onStart={(rect) => setPairStart((open) => (open ? null : rect))}
              />
              {/* More Pairs to load keeps it on offer, even when every loaded conversation shows. */}
              {conversationCount > shownConversations || allConversations || morePairs ? (
                <button
                  className="nav-item fold-toggle"
                  type="button"
                  aria-expanded={allConversations}
                  onClick={() => setAllConversations(!allConversations)}
                >
                  <Icon name={allConversations ? "chevron" : "chevron-down"} />
                  <span className="label-text">
                    {allConversations ? "Show less" : "All conversations"}
                  </span>
                </button>
              ) : null}

              {/* Projects are filters for the Inbox; their own pages fold away until wanted. */}
              <div className="nav-heading">
                <button
                  className="fold-heading grow"
                  type="button"
                  aria-expanded={projectsOpen}
                  onClick={() => setProjectsOpen(!projectsOpen)}
                >
                  Projects
                  <Icon name={projectsOpen ? "chevron-down" : "chevron"} size={12} />
                </button>
                <Tip label="New project">
                  <button
                    className="icon-btn"
                    type="button"
                    aria-label="New project"
                    onClick={() => setNewProject(true)}
                  >
                    <Icon name="plus" />
                  </button>
                </Tip>
                <Tip label="Group the Inbox by project">
                  <Toggle
                    className="icon-btn"
                    pressed={groupByProject}
                    aria-label="Group the Inbox by project"
                    onPressedChange={(on) => {
                      setGroupByProject(on);
                      nav.go({ name: "inbox" });
                    }}
                  >
                    <Icon name="layers" />
                  </Toggle>
                </Tip>
              </div>
              {/* Folded, it still shows the project you're in. */}
              {(projects ?? [])
                .filter(
                  (project) =>
                    projectsOpen ||
                    is({ name: "project", projectId: project.projectId }) !== undefined,
                )
                .map((project) => (
                  <div key={project.projectId} className="row-flex" style={{ gap: 0 }}>
                    <button
                      className="nav-item"
                      type="button"
                      aria-current={is({ name: "project", projectId: project.projectId })}
                      onClick={() => nav.go({ name: "project", projectId: project.projectId })}
                    >
                      <Icon name="folder" />
                      <span className="label-text">{project.name}</span>
                    </button>
                  </div>
                ))}
              {projectsOpen ? (
                <>
                  {projects && projects.length === 0 ? (
                    <div
                      className="muted"
                      style={{
                        padding: "var(--space-2) var(--space-8)",
                        fontSize: "var(--font-13)",
                      }}
                    >
                      Projects are optional groups of tasks. Add one with +.
                    </div>
                  ) : null}
                  {(projects ?? []).length > 0 || (allTasks ?? []).length > 0 ? (
                    <button
                      className="nav-item"
                      type="button"
                      aria-current={is({ name: "noProject" })}
                      onClick={() => nav.go({ name: "noProject" })}
                    >
                      <Icon name="board" />
                      <span className="label-text">No project</span>
                    </button>
                  ) : null}
                </>
              ) : null}
            </>
          )}
        </nav>

        <CallDock onOpenChannel={(channelId) => nav.go({ name: "channel", channelId })} />
        <UpdateReady placement="sidebar" />
        <div className="sidebar-bottom">
          {account ?? <UserButton appearance={clerkAppearance(prefs.theme)} />}
          <span className="grow truncate me-name">{session.me.name}</span>
          <Tip label="Settings">
            <Toggle
              className="btn icon"
              aria-label="Settings"
              pressed={route.name === "settings"}
              onPressedChange={openSettings}
            >
              <Icon name="gear" />
            </Toggle>
          </Tip>
        </div>
      </aside>

      <main className="main" style={{ position: "relative" }}>
        {/* A view that crashes shows an error in its place; the sidebar and the call dock stay. */}
        <Covered.Provider value={route.name === "settings"}>
          <ViewBoundary
            key={view.name === "channel" ? `channel:${view.channelId}` : JSON.stringify(view)}
            onLeave={openInbox}
          >
            {view.name === "inbox" ? (
              <Inbox
                nav={nav}
                groupByProject={groupByProject}
                setGroupByProject={setGroupByProject}
                projectFilter={projectFilter}
                setProjectFilter={setProjectFilter}
                frozen={taskId !== null}
              />
            ) : view.name === "unfiled" ? (
              <Unfiled nav={nav} />
            ) : view.name === "project" ? (
              <ProjectView key={view.projectId} projectId={view.projectId} nav={nav} />
            ) : view.name === "noProject" ? (
              <ProjectView key="no-project" projectId={undefined} nav={nav} />
            ) : view.name === "channel" ? (
              <ChannelBoundary
                key={view.channelId}
                onLeave={() => nav.go({ name: "inbox" })}
                inChannel={channels?.some((c) => c.channelId === view.channelId)}
                title={channelHeading(seen.current.get(view.channelId))}
              >
                <ChannelView
                  channelId={view.channelId}
                  focus={view.messageId}
                  search={view.search}
                  nav={nav}
                />
              </ChannelBoundary>
            ) : view.name === "search" ? (
              <SearchView initial={view.query} nav={nav} />
            ) : view.name === "thread" ? (
              <ThreadView key={view.runId} runId={view.runId} nav={nav} />
            ) : view.name === "terminal" ? (
              <TerminalView key={view.terminalId} terminalId={view.terminalId} nav={nav} />
            ) : view.name === "space" ? (
              <SpaceView key={view.spaceId} spaceId={view.spaceId} nav={nav} />
            ) : view.name === "pairs" ? (
              <PairsLanding
                pairs={pairs}
                more={morePairs}
                onOpen={(pairId) => nav.go({ name: "pair", pairId })}
                onStart={setPairStart}
              />
            ) : view.name === "pair" ? (
              <PairConversation
                key={view.pairId}
                pairId={view.pairId}
                showCode={view.code}
                initialMissed={initialPairMissed}
                onLeft={() => nav.go({ name: "pairs" })}
              />
            ) : (
              <SettingsView
                section={view.section}
                nav={nav}
                prefs={prefs}
                permissions={permissions ?? desktopPermissions}
              />
            )}
          </ViewBoundary>
        </Covered.Provider>
        {/* Settings opens over the view you were on, as Grok Bot's does; closing it puts you back there. */}
        {route.name === "settings" ? (
          <SettingsOverlay onClose={() => nav.go(behind.current)}>
            <SettingsView
              section={route.section}
              nav={nav}
              prefs={prefs}
              permissions={permissions ?? desktopPermissions}
            />
          </SettingsOverlay>
        ) : null}
        {taskId || runId ? (
          <div
            className="drawer-scrim"
            aria-hidden="true"
            onClick={() => (setTaskId(null), setRunId(null))}
          />
        ) : null}
        {taskId ? (
          <TaskPanel key={taskId} taskId={taskId} nav={nav} onClose={() => setTaskId(null)} />
        ) : runId ? (
          <RunPanel
            key={runId}
            runId={runId}
            onClose={() => setRunId(null)}
            nav={nav}
            onOpenRun={(next) => setRunId(next)}
            onOpenPlace={(place) => {
              setRunId(null);
              setRoute({
                name: "channel",
                channelId: place.channelId,
                ...(place.messageId ? { messageId: place.messageId } : {}),
              });
            }}
          />
        ) : null}
      </main>
      {newDirect ? (
        <NewDirectMessage
          anchor={newDirect}
          onClose={() => setNewDirect(null)}
          onOpened={(channelId) => {
            setNewDirect(null);
            nav.go({ name: "channel", channelId });
          }}
        />
      ) : null}
      {giveMenu ? (
        <TaskPicker
          className="give-task"
          title="Give it a task"
          empty="No open tasks"
          runs={false}
          focus
          style={placeNear(giveMenu.anchor, window.innerHeight)}
          onClose={() => setGiveMenu(null)}
          onPick={(_item, task) => {
            setGiveMenu(null);
            setGiving({
              agentId: giveMenu.agentId,
              taskId: task.taskId,
              projectId: task.projectId,
            });
          }}
        />
      ) : null}
      {giving ? (
        <StartRunDialog
          taskId={giving.taskId}
          projectId={giving.projectId}
          agentId={giving.agentId}
          onClose={() => setGiving(null)}
          nav={nav}
        />
      ) : null}
      {newChannel ? (
        <NewChannel
          anchor={newChannel}
          onClose={() => setNewChannel(null)}
          onCreated={(channelId) => {
            setNewChannel(null);
            nav.go({ name: "channel", channelId });
          }}
        />
      ) : null}
      {pairStart ? (
        <PairStart
          anchor={pairStart}
          initialJoin={initialPairJoin}
          onClose={() => setPairStart(null)}
          onOpened={(pairId, opts) => {
            setPairStart(null);
            nav.go({ name: "pair", pairId, code: opts.code });
          }}
        />
      ) : null}
      {newTask ? (
        <NewTaskDialog
          chooseProject
          onClose={() => setNewTask(false)}
          onCreated={(taskId) => {
            setNewTask(false);
            nav.openTask(taskId);
          }}
        />
      ) : null}
      {newProject ? (
        <NewProjectDialog
          onClose={() => setNewProject(false)}
          onCreated={(projectId) => {
            setNewProject(false);
            nav.go({ name: "project", projectId });
          }}
        />
      ) : null}
      {/* One session per team: switching teams ends this one and its banners with it. */}
      <Signals
        key={session.teamId}
        nav={nav}
        notifications={prefs.notifications}
        sounds={prefs.sounds}
        openChannelId={route.name === "channel" ? route.channelId : null}
      />
      {welcome ? (
        <Setup
          me={session.me.name}
          team={session.team.name}
          permissions={permissions ?? desktopPermissions}
          pair={pair ?? desktopPair}
          initialStep={setupStep ?? undefined}
          onDone={() => {
            markOnboarded();
            setWelcome(false);
            nav.go({ name: "inbox" });
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * A harness whose runs all joined by themselves (uplink join, ADR 0032): they report no state, so
 * they read Live, not Status unknown, and have chat only.
 */
function joinedOnly(entry: { kind: string; runs: number; joined?: number | undefined }): boolean {
  return entry.kind === "harness" && entry.runs > 0 && entry.joined === entry.runs;
}

/** A hint of several lines, as the browser's `title` showed them: one line for each newline. */
function TipLines({ text }: { text: string }) {
  return text.split("\n").map((line, i) => (
    <span key={i} style={{ display: "block" }}>
      {line}
    </span>
  ));
}

/** A channel's glyph and name for a title row: # for a team channel, the lock for a private one. */
function channelHeading(channel: { name: string; kind: string } | undefined): ReactNode {
  if (!channel) return undefined;
  if (channel.kind === "direct") return channel.name;
  return (
    <>
      <Icon className="head-glyph" name={channel.kind === "private" ? "lock" : "hash"} />
      {channel.name}
    </>
  );
}

/** Linking this computer from the setup: the installed app carries the bridge (main/bridge.ts). */
function useDesktopPair(): PairApi {
  const create = useAct(api.machines.createPairingCode);
  const machines = useRoomQuery(api.machines.list, {});
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    void desktop
      .bridgeCommand?.()
      .then((command) => setAvailable(Boolean(command && command !== "uplink-bridge")));
  }, []);
  const makeCode = useCallback(
    async (name: string) => ((await create({ name })) as { code: string } | undefined)?.code,
    [create],
  );
  const { pairing, refresh, pair } = usePairing({
    read: desktop.bridgePairing,
    makeCode,
    link: desktop.pairThisComputer,
  });
  const usable = available && Boolean(desktop.pairThisComputer);
  // An unlinked computer is linked as soon as the app opens: nobody should copy a pairing command
  // for the computer the app runs on. Once per app run; when it fails, setup and Settings,
  // Machines still offer Link this computer. A personal machine starts at Suggest, so teammates
  // can't start runs on it until its person raises that (ADR 0025).
  const session = useSession();
  const toast = useToast();
  const [autoLinking, setAutoLinking] = useState(false);
  const autoTried = useRef(false);
  useEffect(() => {
    if (!usable || pairing?.status !== "unpaired" || autoTried.current) return;
    autoTried.current = true;
    setAutoLinking(true);
    const name = `${session.me.name.split(/\s+/)[0] || session.me.name}'s ${desktop.platform === "darwin" ? "Mac" : "computer"}`;
    pair(name, { replace: false })
      .then(() => toast.show(`This computer is linked as ${name}. Its bridge is running.`, true))
      .catch((error: unknown) =>
        desktop.log?.("warn", "pairing", "linking this computer by itself failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => setAutoLinking(false));
  }, [usable, pairing, pair, session.me.name, toast]);
  // While it links by itself, setup shows "Checking" instead of offering to link it too.
  const current: LinkState | undefined = autoLinking
    ? undefined
    : pairing === undefined || pairing.status !== "paired"
      ? pairing
      : {
          status: "paired",
          name:
            machines?.find((m) => m.machineId === pairing.machineId)?.name ??
            "this computer's machine",
        };
  return useMemo(
    () => ({
      available: usable,
      current,
      pair,
      refresh,
    }),
    [available, current, pair, refresh],
  );
}

/**
 * A channel's counts in the sidebar: how many unread messages, and how many of them are addressed
 * to you (mentions, @everyone, replies). Amber stays for "needs you" (DESIGN.md), so a mention
 * count is the strong neutral badge, marked with @.
 */
function UnreadBadges({ unread, mentions }: { unread: number; mentions: number }) {
  if (mentions > 0) {
    return (
      <span
        className="badge mention"
        aria-label={`${mentions} mention${mentions === 1 ? "" : "s"}`}
      >
        @{mentions > 99 ? "99+" : mentions}
      </span>
    );
  }
  // Unread with nothing for you in it is worth a look sometime, not a count to clear.
  // Its name in the text color says so; no dot or number competes with what needs you.
  if (unread > 0) return <span className="sr-only">, {unread} unread</span>;
  return null;
}
