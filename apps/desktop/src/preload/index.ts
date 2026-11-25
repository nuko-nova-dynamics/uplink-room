import { exposeClerkBridge } from "@clerk/electron/preload";
import type { PairingOnDisk } from "../main/pairGuard";
import type { BridgeCli } from "../main/bridgeCliSpec";
import type { AgentSetup, McpAdded, McpHarness, SkillTarget } from "../main/agentSetupSpec";
// Sentry's IPC bridge (window.__SENTRY_IPC__), which the renderer's SDK sends errors through. The SDK
// can't inject its own preload into a bundled app (main/telemetry.ts), so it's bundled in here.
import "@sentry/electron/preload";
import { contextBridge, ipcRenderer } from "electron";
import { telemetryDisabled, telemetryTest } from "@uplink-room/bridge/scrub";
import type { NotifyChoice, NotifyRequest } from "../main/notifySpec";
import type { UpdateState } from "../main/updateSpec";
import type { LoginItemState } from "../main/loginItemSpec";
import type { PermissionKind, PermissionsState } from "../main/permissionsSpec";
import type { T3ShareRequest, T3ThreadsView } from "../main/t3ThreadsSpec";

type NotifyAnswer = { choice: NotifyChoice; request: NotifyRequest; session: string };

// Clerk's token storage and OAuth transport (see main/index.ts).
exposeClerkBridge();

/**
 * What else the renderer gets from the main process: the platform, the
 * command that runs the bridge bundled with the app, pairing this computer
 * with a code, loopback forwards for Space views, system notifications
 * (main/notifications.ts), the screen picker for calls, the usage data setting, and the app's
 * updates (main/updates.ts). The main process answers only the app's main frame.
 */
/** invoke prefixes main's message with "Error invoking remote method '<channel>': Error: "; this takes it off. */
function plainError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
}

contextBridge.exposeInMainWorld("uplink", {
  platform: process.platform,
  bridgeCommand: (): Promise<string | null> => ipcRenderer.invoke("uplink:bridge-command"),
  /** Whether a new terminal runs this app's bridge as `uplink-bridge`; null outside the installed app (main/bridgeCli.ts). */
  bridgeCli: (): Promise<BridgeCli | null> => ipcRenderer.invoke("uplink:bridge-cli"),
  /** Puts this app's `uplink-bridge` on PATH. macOS may show its administrator prompt. */
  installBridgeCli: (): Promise<BridgeCli> =>
    ipcRenderer.invoke("uplink:bridge-cli-install").catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
    }),
  /** Whether the uplink skill is in Claude Code's and Codex's skills folders; null outside the installed app (main/agentSetup.ts). */
  agentSetup: (): Promise<AgentSetup | null> => ipcRenderer.invoke("uplink:agent-setup"),
  /** Copies the app's uplink skill into a harness's skills folder. */
  installAgentSkill: (target: SkillTarget): Promise<AgentSetup> => ipcRenderer.invoke("uplink:agent-skill-install", target).catch(plainError),
  /** Adds the app's uplink-mcp to a harness with its own `mcp add`. */
  addMcpServer: (harness: McpHarness): Promise<McpAdded> => ipcRenderer.invoke("uplink:agent-mcp-add", harness).catch(plainError),
  /** Pairs this computer. Main refuses to replace an existing pairing unless `replace` is true (main/pairGuard.ts). */
  pairThisComputer: (code: string, options?: { replace?: boolean }): Promise<void> =>
    ipcRenderer.invoke("uplink:pair-this-computer", { code, replace: options?.replace === true }).catch((error: unknown) => {
      // invoke prefixes main's message with "Error invoking remote method '<channel>': Error: ".
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
    }),
  /** Copies text with Electron's clipboard (main/clipboard.ts): the window's own clipboard API is refused. */
  copyText: (text: string): Promise<void> => ipcRenderer.invoke("uplink:copy-text", text),
  /** Join and open links the app was opened with, not yet taken (main/deepLink.ts). */
  takeDeepLinks: (): Promise<unknown[]> => ipcRenderer.invoke("uplink:deep-links-take"),
  /** Main has new links to take. Returns a function that stops listening. */
  onDeepLink: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on("uplink:deep-link", handler);
    return () => ipcRenderer.removeListener("uplink:deep-link", handler);
  },
  /** Forwards a Space view (the first of its gateway URLs that answers) to a loopback port and returns its URL there (spec #6). */
  openSpaceView: (urls: string[]): Promise<string> => ipcRenderer.invoke("uplink:space-open", urls),
  closeSpaceView: (url: string): Promise<void> => ipcRenderer.invoke("uplink:space-close", url),
  notify: (request: unknown, session: string): Promise<void> =>
    ipcRenderer.invoke("uplink:notify", request, session),
  dismissNotification: (id: string): Promise<void> =>
    ipcRenderer.invoke("uplink:notify-dismiss", id),
  /** A session starts: main takes away every banner whose key isn't live any more. */
  reconcileNotifications: (session: string, live: string[]): Promise<void> =>
    ipcRenderer.invoke("uplink:notify-reconcile", session, live),
  /** A session ends (sign-out, another team): main takes away its banners. */
  endNotificationSession: (session: string): Promise<void> =>
    ipcRenderer.invoke("uplink:notify-end", session),
  /**
   * A banner was clicked, or one of its buttons, with the request that banner showed (so Allow
   * answers exactly that approval). Returns a function that stops listening.
   */
  onNotification: (listener: (answer: NotifyAnswer) => void) => {
    const handler = (_event: unknown, answer: NotifyAnswer) => listener(answer);
    ipcRenderer.on("uplink:notification", handler);
    return () => ipcRenderer.removeListener("uplink:notification", handler);
  },
  /** True when UPLINK_NO_TELEMETRY or DO_NOT_TRACK turned error reports off (main/telemetry.ts). */
  telemetryOff: telemetryDisabled(process.env),
  /** True when UPLINK_TELEMETRY_TEST=1 asks each process to send one test error. */
  telemetryTest: telemetryTest(process.env),
  /** Tests and screenshot scripts: synthetic call media, no devices, no call sound. */
  fakeMedia: process.env["UPLINK_FAKE_MEDIA"] === "1",
  /** The screens and windows to share, for the app's own picker. */
  screenSources: (): Promise<unknown> => ipcRenderer.invoke("uplink:screen-sources"),
  /** The source the next getDisplayMedia() call gets, and whether with its sound. */
  chooseScreenSource: (id: string, name: string, audio: boolean): Promise<void> =>
    ipcRenderer.invoke("uplink:choose-screen-source", id, name, audio),
  /** "Share usage data" and this install's anonymous ID (main/analytics.ts). */
  analyticsState: (): Promise<{ enabled: boolean; deviceId: string } | null> =>
    ipcRenderer.invoke("uplink:analytics-state"),
  setAnalyticsEnabled: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("uplink:analytics-set-enabled", enabled),
  /** The member and team now open (or null after sign-out) and the current anonymous ID, for main's own events. */
  analyticsIdentify: (identity: { memberId: string; teamId: string } | null, deviceId: string): Promise<void> =>
    ipcRenderer.invoke("uplink:analytics-identify", identity, deviceId),
  /** The running version and where its update stands (Settings, Updates; the restart prompt). */
  updateState: (): Promise<UpdateState | null> => ipcRenderer.invoke("uplink:update-state"),
  checkForUpdates: (): Promise<UpdateState | null> => ipcRenderer.invoke("uplink:update-check"),
  /** False when main refused: nothing is ready, or this person is in a call. */
  restartToUpdate: (): Promise<boolean> => ipcRenderer.invoke("uplink:update-restart"),
  /** Whether this person is in a call, which holds the restart prompt back. */
  setInCall: (inCall: boolean): Promise<void> => ipcRenderer.invoke("uplink:update-in-call", inCall),
  /** "Open at login" (main/loginItem.ts): read it, and Settings' switch. */
  openAtLogin: (): Promise<LoginItemState | null> => ipcRenderer.invoke("uplink:open-at-login"),
  setOpenAtLogin: (on: boolean): Promise<LoginItemState | null> => ipcRenderer.invoke("uplink:open-at-login-set", on),
  /** Onboarding's permissions step (main/permissions.ts): read, ask, open the pane, drag the app in, test a banner. */
  permissions: (): Promise<PermissionsState | null> => ipcRenderer.invoke("uplink:permissions"),
  askPermission: (kind: "microphone" | "camera"): Promise<PermissionsState | null> =>
    ipcRenderer.invoke("uplink:permission-ask", kind),
  openPermission: (kind: PermissionKind): Promise<void> => ipcRenderer.invoke("uplink:permission-open", kind),
  dragApp: (): void => ipcRenderer.send("uplink:permission-drag"),
  testNotification: (): Promise<void> => ipcRenderer.invoke("uplink:notify-test"),
  /** Settings… in the macOS app menu (Command-comma). Returns a function that stops listening. */
  /** This computer's current pairing, or null when it has none. */
  /** This computer's pairing: unpaired, paired, or unknown when bridge.json can't be read (main/pairGuard.ts). */
  bridgePairing: (): Promise<PairingOnDisk | null> => ipcRenderer.invoke("uplink:bridge-pairing"),
  /** This computer's T3 Code threads, from its own bridge, and which of them the room gets (main/t3ThreadsSpec.ts). */
  t3Threads: (): Promise<T3ThreadsView | null> => ipcRenderer.invoke("uplink:t3-threads"),
  /** Shares exactly these threads from this computer, from the list `revision` names. */
  shareT3Threads: (request: T3ShareRequest): Promise<T3ThreadsView> => ipcRenderer.invoke("uplink:t3-share", request).catch(plainError),
  /** True once if Settings… was chosen while no window was open (it opened this one). */
  takeOpenSettings: (): Promise<boolean> => ipcRenderer.invoke("uplink:take-open-settings"),
  onOpenSettings: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on("uplink:open-settings", handler);
    return () => ipcRenderer.removeListener("uplink:open-settings", handler);
  },
  /** One line for the diagnostic log (main/log.ts). Fire and forget. */
  log: (level: string, scope: string, message: string, fields: Record<string, unknown>): void =>
    ipcRenderer.send("uplink:log", level, scope, message, fields),
  /** The computer suspends, resumes, locks or unlocks (Electron's powerMonitor). Returns a function that stops listening. */
  onPower: (listener: (event: string) => void) => {
    const handler = (_event: unknown, name: string) => listener(name);
    ipcRenderer.on("uplink:power", handler);
    return () => ipcRenderer.removeListener("uplink:power", handler);
  },
  /** Settings, Diagnostics: opens the logs folder, and the main process's half of "Copy diagnostics". */
  openLogs: (): Promise<boolean> => ipcRenderer.invoke("uplink:logs-open"),
  diagnostics: (): Promise<unknown> => ipcRenderer.invoke("uplink:diagnostics"),
  onUpdateState: (listener: (state: UpdateState) => void) => {
    const handler = (_event: unknown, state: UpdateState) => listener(state);
    ipcRenderer.on("uplink:update-state", handler);
    return () => ipcRenderer.removeListener("uplink:update-state", handler);
  },
});
