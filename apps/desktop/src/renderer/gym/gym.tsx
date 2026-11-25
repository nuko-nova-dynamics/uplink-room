import { useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { ConvexError } from "convex/values";
import "@xterm/xterm/css/xterm.css";
import "../styles.css";
import "../components/ui-sdk.css";
import { ShellView } from "../Shell";
import { CallContext, callErrorText, type CallContextValue } from "../lib/call";
import { SessionProvider, ToastProvider, useSession, useToast } from "../lib/session";
import { usePreferences } from "../lib/theme";
import { desktopPermissions, type PermissionsApi } from "../lib/permissions";
import type { MyTeam } from "../lib/api";
import { Face } from "../components/Faces";
import type { PairApi } from "../views/Setup";
import { BridgeCliContext, type BridgeCliApi } from "../lib/bridgeCli";
import type { BridgeCli, ToolCli } from "../../main/bridgeCliSpec";
import { AgentSetupContext, type AgentSetupApi } from "../lib/agentSetup";
import type { AgentSetup, SkillState } from "../../main/agentSetupSpec";
import type { PermissionKind, PermissionsState } from "../../main/permissionsSpec";
import { redirectCopies } from "../lib/clipboard";
import { FakeConvex } from "./fakeConvex";
import { World } from "./world";
import { ChatWorld } from "./chat";
import { GitHubWorld } from "./github";
import { simulatedState, STATES, type GymState } from "./states";
import { PairsWorld } from "./pairs";
import { NoTeamHome } from "../views/NoTeam";
import { InventorySpace } from "./InventorySpace";
import { InventoryInvite } from "./InventoryInvite";
import { InventoryBrowser } from "./InventoryBrowser";
import { InventoryCloud } from "./InventoryCloud";
import { InventoryPage } from "./InventoryPage";
import { joinOutcome } from "../lib/pairs";
import { T3ThreadsContext } from "../lib/t3Threads";
import { gymT3Threads } from "./t3threads";
import "../look.css";

// Copies stay in the gym: its crawl clicks every Copy button, and the system clipboard belongs to
// the person running it. The last copy is kept on window for a script to read.
redirectCopies(async (text) => {
  (window as unknown as { gymCopied?: string }).gymCopied = text;
});
try {
  Object.defineProperty(navigator.clipboard, "writeText", {
    configurable: true,
    value: async (text: string) => {
      (window as unknown as { gymCopied?: string }).gymCopied = text;
    },
  });
} catch {
  // No clipboard object to replace: nothing could be copied through it either.
}

/**
 * The UI gym (gym.html?state=<id>&theme=dark|light): the real shell and views with the sample team
 * from fixtures.json, no sign-in and no backend. scripts/gym.ts drives it. Clerk's avatar menu is
 * replaced by the same face, LiveKit by a call that only changes state, and the permissions by a
 * simulation, except in the "live" states, which read this computer's real states and ask nothing.
 */
const params = new URLSearchParams(location.search);
const state: GymState = STATES.find((s) => s.id === params.get("state")) ?? STATES[0]!;
try {
  localStorage.setItem("uplink.theme", params.get("theme") === "light" ? "light" : "dark");
  // The gym never shows a banner or plays a cue on the computer it runs on.
  localStorage.setItem("uplink.notifications", state.notificationsOn ? "on" : "off");
  localStorage.setItem("uplink.sounds", state.notificationsOn ? "on" : "off");
  localStorage.setItem("uplink.onboarded", "yes");
} catch {
  // Storage can be unavailable; the defaults apply.
}
document.title = `Uplink Room gym: ${state.title}`;
// scripts/gym.ts reads the list from here.
(window as unknown as { gymStates: unknown }).gymStates = STATES.map(({ id, title, flows }) => ({
  id,
  title,
  ...(flows ? { flows } : {}),
}));

// The gym's window counts as in front, as a person's is while they use it: read marks and presence
// follow what's on screen even when the capture runs behind another window.
document.hasFocus = () => true;
const world = new World();
state.world?.(world);
// Extra delivery outcomes for the Members component captures, without changing product behavior.
const inviteDelivery = params.get("inviteDelivery");
if (inviteDelivery === "sent" || inviteDelivery === "failed") {
  world.each("invites:list", (value) => {
    const rows = value as Record<string, unknown>[];
    return [
      ...rows,
      {
        ...rows[0],
        inviteId: "gym-invite-new",
        email: "new-member@example.test",
        emailState: {
          status: inviteDelivery,
          kind: "invite",
          at: Date.now(),
          ...(inviteDelivery === "failed" ? { error: "The address bounced." } : {}),
        },
      },
    ];
  });
}
// The agents sheet needs actual agent members in its many state, rather than only more people.
// Keep this sample data in the gym; the production Agents view always uses the team's members.
if (state.id === "inventory-settings-agents-many") {
  world.each("teams:members", (members) => {
    const rows = members as Record<string, unknown>[];
    const agent = rows.find((member) => member["kind"] === "agent");
    return agent
      ? [
          ...rows,
          ...Array.from({ length: 24 }, (_, i) => ({
            ...agent,
            memberId: `gym-agent-${i}`,
            agentId: `gym-agent-${i}`,
            name: `Harbor assistant ${i + 1}`,
          })),
        ]
      : rows;
  });
}
if (state.id === "settings-agents" || state.id.startsWith("inventory-settings-agents-")) {
  const task = world.get<{ runs: Record<string, unknown>[] }>("tasks:get", {
    taskId: world.taskId,
  });
  world.set(
    "runs:live",
    {},
    task.runs.filter((run) => run["state"] === "working"),
  );
}

const chat = state.chat
  ? new ChatWorld(world, params.get("theme") !== "light", state.agent, state.runs, state.hosted)
  : null;
const github = new GitHubWorld(state.github ?? "accounts", {
  me: String(world.me["memberId"]),
  ana: String(world.members.find((m) => m.name === "Ana Ruiz")?.memberId ?? "gym-ana"),
});
const meName = String(
  world.members.find((m) => m.memberId === world.me["memberId"])?.name ?? "Rosa Vega",
);
const pairs = new PairsWorld(state.pairs ?? "some", meName);
// scripts/gym.ts's chat flows post as teammates through this.
(window as unknown as { gymChat: unknown }).gymChat = chat;
const missing = new Set<string>();
const EMPTY_PAGE = { page: [], isDone: true, continueCursor: "" };
const gone = state.gone?.(world);
/** Where a file attached in the gym uploads: answered here with a storage id, as the room's storage answers. */
const GYM_UPLOAD = "https://gym.invalid/upload";
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) =>
  String(input) === GYM_UPLOAD
    ? Promise.resolve(
        new Response(JSON.stringify({ storageId: "gym-storage" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    : realFetch(input, init);
// Requests made by real gym input, for interaction checks; never used by the app.
const gymMutations: { path: string; args: Record<string, unknown> }[] = [];
(window as unknown as { gymMutations: typeof gymMutations }).gymMutations = gymMutations;
const worldListeners = new Set<() => void>();
const convex = new FakeConvex(
  (udfPath, args) => {
    if (state.loading && udfPath !== "teams:members" && udfPath !== "teams:mine") return undefined;
    // A channel you were removed from answers not_found, as the backend does (ADR 0016).
    if (state.gone && args["channelId"] === gone)
      throw new ConvexError({ code: "not_found", message: "Not found in this team" });
    // Sample data: the bridge release another machine installs from (machines.bridgeRelease).
    if (udfPath === "machines:bridgeRelease") return state.noRelease ? null : SAMPLE_RELEASE;
    const said = chat?.answer(udfPath, args);
    if (said !== undefined) return said;
    const paired = pairs.answer(udfPath, args);
    if (paired !== undefined) return paired;
    const fromGitHub = github.answer(udfPath, args);
    if (fromGitHub !== undefined) return fromGitHub;
    const value = world.get(udfPath, args);
    if (value !== undefined) return value;
    // A page nobody recorded (a channel the state added) is an empty page; anything else stays loading.
    // One object for it, as Convex keeps a result's identity until it changes: a new one on every
    // render would loop a component whose effect depends on the result (React error 301).
    if ("paginationOpts" in args) return EMPTY_PAGE;
    if (!missing.has(udfPath)) {
      missing.add(udfPath);
      console.info(`gym: no fixture for ${udfPath} ${JSON.stringify(args)}`);
    }
    return undefined;
  },
  // Mutations go to the chat stand-in; the invite ones whose result a dialog shows answer as the
  // backend would, and so does a pairing code for Link a machine.
  async (udfPath, args) => {
    gymMutations.push({ path: udfPath, args });
    if (udfPath === "invites:create" || udfPath === "invites:revoke") {
      if (state.inviteOutcome === "loading") await new Promise(() => {});
      if (state.inviteOutcome === "error") throw new Error("The invite request failed. Try again.");
    }
    if (udfPath === "teams:setInviteReminders") {
      world.each("teams:settings", (value) => ({
        ...(value as object),
        inviteReminders: args.inviteReminders,
      }));
      worldListeners.forEach((listener) => listener());
      return null;
    }
    if (udfPath === "members:setEmailNotifications") {
      world.each("members:emailNotifications", (value) => ({
        ...(value as object),
        joined: args.joined,
      }));
      worldListeners.forEach((listener) => listener());
      return null;
    }
    // The doc autosave queue expects the same version receipt as files.edit.
    if (udfPath === "files:edit") return world.saveFile(args);
    if (udfPath === "github:disconnect" && state.github === "disconnect-busy")
      return new Promise(() => {});
    if (udfPath === "github:disconnect" && state.github === "disconnect-error") {
      throw new Error("GitHub couldn't disconnect this account. Try again.");
    }
    if (
      udfPath === "invites:regenerate" ||
      udfPath === "invites:resend" ||
      udfPath === "invites:create"
    ) {
      const token = "gym-7Qx2-kP9v-Rt4m";
      return {
        inviteId: args["inviteId"] ?? "gym-invite-new",
        token,
        url: `https://uplinkroom.com/invite#${token}`,
        expiresAt: Date.now() + 7 * 86_400_000,
        emailed: true,
      };
    }
    // Hold the real Link this computer handler while the pending mutation is captured.
    if (udfPath === "machines:createPairingCode" && state.id === "link-machine-this-busy")
      return new Promise(() => {});
    if (udfPath === "machines:createPairingCode")
      return { code: "JQJG-9PUM", expiresAt: Date.now() + 10 * 60 * 1000 };
    // A file attached in a box uploads to the gym's stand-in address (below), as to the room's storage.
    if (udfPath === "messages:attachUrl" || udfPath === "pairs:attachUrl")
      return { uploadUrl: GYM_UPLOAD, uploadId: "gym-upload" };
    const paired = pairs.mutate(udfPath, args);
    if (paired !== undefined) return paired;
    return (await chat?.mutate(udfPath, args)) ?? null;
  },
  (listener) => {
    worldListeners.add(listener);
    const off = [
      () => worldListeners.delete(listener),
      pairs.subscribe(listener),
      ...(chat ? [chat.subscribe(listener)] : []),
    ];
    return () => off.forEach((stop) => stop());
  },
);
const team = world.me as unknown as MyTeam;

const SAMPLE_RELEASE = {
  url: "https://sample.public.blob.vercel-storage.com/bridge/uplink-room-bridge-0.2.5-57b537f.tgz",
  sha256: "3f9a1c0e7b52d4a86c1e9f0b2d7a4e6c8b3f5a1d9e2c7b4a6f0d8e1c3b5a7f92",
  version: "0.2.5",
};

/**
 * `uplink-bridge` on PATH as the installed app on a Mac would see it, from the state's `cli`.
 * Add to PATH succeeds after a moment and changes nothing on this computer.
 */
const LAUNCHER = "/Applications/Uplink Room.app/Contents/Resources/bin/uplink-bridge";
const LINK = "/usr/local/bin/uplink-bridge";
/** `uplink` and `uplink-mcp` beside the bridge: on PATH with it, or missing, with a link to add. */
function gymTools(ours: boolean): ToolCli[] {
  return (["uplink", "uplink-mcp"] as const).map((name) => {
    const launcher = LAUNCHER.replace(/uplink-bridge$/, name);
    const at = `/usr/local/bin/${name}`;
    return ours
      ? { name, launcher, state: "ours", found: at, runs: true }
      : { name, launcher, state: "missing", install: { kind: "link", at, admin: true } };
  });
}
function gymCli(
  kind: Exclude<NonNullable<GymState["cli"]>, "error">,
  tools: "missing" | undefined = state.tools,
): BridgeCli {
  return { ...gymBridge(kind), tools: gymTools(kind === "ours" && tools !== "missing") };
}
function gymBridge(kind: Exclude<NonNullable<GymState["cli"]>, "error">): BridgeCli {
  const base = { platform: "darwin" as const, launcher: LAUNCHER, command: `'${LAUNCHER}'` };
  const link = { kind: "link" as const, at: LINK, admin: true };
  switch (kind) {
    case "ours":
      return { ...base, state: "ours", found: LINK, runs: true, command: "uplink-bridge" };
    case "relative":
      return { ...base, state: "ours", found: LINK, runs: true, relativeFirst: true };
    case "missing":
      return { ...base, state: "missing", install: link };
    case "stale": {
      const gone = "/Volumes/Uplink Room/Uplink Room.app/Contents/Resources/bin/uplink-bridge";
      return {
        ...base,
        state: "stale",
        found: LINK,
        target: gone,
        runs: false,
        install: { ...link, replaces: gone },
      };
    }
    case "occupied":
      return {
        ...base,
        state: "other",
        found: LINK,
        target: "/usr/local/lib/node_modules/@uplink-room/bridge/dist/uplink-bridge.mjs",
        runs: true,
        install: { kind: "none", why: "occupied" },
      };
    case "other":
      return {
        ...base,
        state: "other",
        found: "/opt/homebrew/bin/uplink-bridge",
        target: "/opt/homebrew/lib/node_modules/@uplink-room/bridge/dist/uplink-bridge.mjs",
        runs: true,
        install: { kind: "none", why: "shadowed" },
      };
  }
}
// Sample threads, never this computer's bridge: other states show no T3 Code threads at all.
const t3Threads = state.t3Threads ? gymT3Threads(state.t3Threads, String(world.get<{ machineId: string }[]>("machines:list")[0]?.machineId)) : null;
let cliNow = state.cli === "error" ? null : gymCli(state.cli ?? "missing");
const bridgeCli: BridgeCliApi = {
  bundled: async () => `'${LAUNCHER}'`,
  // "error": the probe fails, as when PowerShell is blocked; the app still carries its bridge.
  read: async () => {
    if (!cliNow) throw new Error("PowerShell exited with 1");
    return cliNow;
  },
  install: async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    cliNow = gymCli("ours", undefined);
    return cliNow;
  },
};

/**
 * The uplink skill and uplink-mcp for agents, from the state's `skills`. Installing and adding
 * succeed after a moment and change nothing on this computer.
 */
const skillState = (target: "claude" | "codex"): SkillState =>
  state.skills === "current"
    ? "current"
    : state.skills === "outdated"
      ? target === "codex"
        ? "outdated"
        : "current"
      : "missing";
let agentsNow: AgentSetup = {
  platform: "darwin",
  skills: {
    claude: { state: skillState("claude"), path: "~/.claude/skills/uplink" },
    codex: { state: skillState("codex"), path: "~/.agents/skills/uplink" },
  },
};
const agentSetup: AgentSetupApi = {
  read: async () => agentsNow,
  installSkill: async (target) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    agentsNow = {
      ...agentsNow,
      skills: { ...agentsNow.skills, [target]: { ...agentsNow.skills[target], state: "current" } },
    };
    return agentsNow;
  },
  addMcp: async (harness) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    const server = "'/Applications/Uplink Room.app/Contents/Resources/bin/uplink-mcp'";
    const command =
      harness === "claude"
        ? `claude mcp add --scope user uplink -- ${server}`
        : harness === "codex"
          ? `codex mcp add uplink -- ${server}`
          : `hermes mcp add uplink --command ${server}`;
    return { harness, command };
  },
};

/** A call without LiveKit: joining, muting and sharing only change state, so the controls can be driven. */
function GymCall({ children }: { children: ReactNode }) {
  const session = useSession();
  const inCall = state.call === "connected" || state.call === "many";
  const [call, setCall] = useState(() =>
    inCall ? world.liveCall(state.call === "many" ? world.members.slice(2) : []) : null,
  );
  const [media, setMedia] = useState({ muted: false, camera: false, screen: false });
  const toast = useToast();
  const report = (media: { muted: boolean; camera: boolean; screen: boolean }) => {
    world.setMyMedia(session.me.memberId as string, media);
    return media;
  };
  const value = useMemo<CallContextValue>(
    () => ({
      callId: (call?.callId ?? null) as never,
      channelId: (call?.channelId ?? null) as never,
      status: call ? "connected" : "idle",
      ...media,
      speaking: new Set(call && !media.muted ? [session.me.memberId as string] : []),
      tiles: call
        ? [{ identity: session.me.memberId, join: `${session.me.memberId}.gym`, isLocal: true }]
        : [],
      join: async () => {
        if (state.call === "join-fails") {
          // The backend's own words when calls aren't configured (calls.join), as the app words them.
          toast.show(callErrorText("Calls aren't set up on this deployment"));
          return;
        }
        setCall(world.liveCall());
      },
      leave: async () => setCall(null),
      toggleMute: async () => setMedia((m) => report({ ...m, muted: !m.muted })),
      toggleCamera: async () => setMedia((m) => report({ ...m, camera: !m.camera })),
      shareScreen: async () => setMedia((m) => ({ ...m, screen: true })),
      stopScreen: async () => setMedia((m) => ({ ...m, screen: false })),
      shareQuality: null,
      changeShareQuality: async () => {},
      voice: "standard",
      screenView: new Map(),
      setScreenView: () => {},
      cameraQuality: "720p" as never,
      setCameraQuality: async () => {},
      micTrack: null,
      selfCamera: null,
      krisp: { state: "off", why: "the gym has no microphone" },
    }),
    [call, media, session.me.memberId, toast],
  );
  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

/** Simulated permissions: Allow grants, Open Settings opens nothing, and the drag tile shows. */
function simulatedPermissions(start: PermissionsState): PermissionsApi {
  let current = start;
  const set = (kind: PermissionKind) => {
    current = { ...current, statuses: { ...current.statuses, [kind]: "granted" } };
    return current;
  };
  return {
    read: async () => current,
    ask: async (kind) => set(kind),
    open: async () => {},
    drag: () => {},
    testNotification: async () => {},
  };
}

/** This computer's real states, read only: asking, opening and dragging do nothing here. */
const livePermissions: PermissionsApi = {
  read: desktopPermissions.read,
  ask: async () => desktopPermissions.read(),
  open: async () => {},
  drag: () => {},
  testNotification: async () => {},
};

const pair: PairApi = {
  available: true,
  current: state.linkError
    ? { status: "unknown", error: state.linkError }
    : state.linkedAs
      ? { status: "paired", name: state.linkedAs }
      : { status: "unpaired" },
  pair: async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (state.pairFails) throw new Error("the bridge couldn't reach your team");
  },
};

function Gym() {
  const prefs = usePreferences();
  if (state.noTeam) {
    // Someone signed in who is in no team: their Pairs and making or joining a team (views/NoTeam.tsx).
    return (
      <NoTeamHome
        prefs={prefs}
        onJoined={() => {}}
        account={<Face who={{ name: meName, kind: "person" }} size={28} />}
      />
    );
  }
  return <TeamGym prefs={prefs} />;
}

function TeamGym({ prefs }: { prefs: ReturnType<typeof usePreferences> }) {
  const permissions = useMemo(
    () =>
      state.permissions === "live" || state.permissions === undefined
        ? livePermissions
        : simulatedPermissions(simulatedState(state.permissions)),
    [],
  );
  return (
    <SessionProvider team={team}>
      <BridgeCliContext.Provider value={bridgeCli}>
        <AgentSetupContext.Provider value={agentSetup}>
          <T3ThreadsContext.Provider value={t3Threads}>
            <GymCall>
              <GymShell prefs={prefs} permissions={permissions} />
            </GymCall>
          </T3ThreadsContext.Provider>
        </AgentSetupContext.Provider>
      </BridgeCliContext.Provider>
    </SessionProvider>
  );
}

function GymShell({
  prefs,
  permissions,
}: {
  prefs: ReturnType<typeof usePreferences>;
  permissions: PermissionsApi;
}) {
  const session = useSession();
  if (state.inventoryPage === "space")
    return <InventorySpace scene={state.inventoryVariant ?? "ready"} />;
  if (state.inventoryPage === "invite")
    return <InventoryInvite scene={state.inventoryVariant ?? "default"} />;
  if (state.inventoryPage === "browser")
    return <InventoryBrowser scene={state.inventoryVariant ?? "driver"} />;
  if (state.inventoryPage === "cloud")
    return <InventoryCloud scene={state.inventoryVariant ?? "default"} />;
  if (state.isolation) return <InventoryPage variant={state.isolation} specimen={state.specimen} />;
  return (
    <ShellView
      prefs={prefs}
      teams={[team]}
      onSwitch={() => {}}
      onPick={() => {}}
      account={<Face who={{ name: session.me.name, kind: "person" }} size={28} />}
      initialRoute={state.route?.(world) ?? { name: "inbox" }}
      initialTaskId={state.task?.(world) as never}
      {...(state.run ? { initialRunId: state.run as never } : {})}
      permissions={permissions}
      pair={pair}
      setupStep={state.setup ?? null}
      initialPairMissed={state.pairMissed}
      initialPairJoin={
        state.pairJoin
          ? (() => {
              // The room's refusal as the app words it (lib/pairs.ts), so the gym shows what a person sees.
              const outcome = joinOutcome({ refused: { code: "not_found", message: "" } });
              return {
                code: state.pairJoin,
                ...("error" in outcome ? { error: outcome.error } : {}),
              };
            })()
          : undefined
      }
    />
  );
}

const isMac =
  (window as unknown as { uplink?: { platform?: string } }).uplink?.platform === "darwin";
createRoot(document.getElementById("root")!).render(
  <ConvexProvider client={convex as unknown as ConvexReactClient}>
    <ToastProvider>
      <div
        className={isMac ? "" : "no-mac-inset"}
        style={{ height: "100%" }}
        data-gym-state={state.id}
      >
        <Gym />
      </div>
    </ToastProvider>
  </ConvexProvider>,
);
