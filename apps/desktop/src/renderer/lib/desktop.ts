import type { UpdateState } from "../../main/updateSpec";
import type { LoginItemState } from "../../main/loginItemSpec";
import type { PairingOnDisk } from "../../main/pairGuard";
import type { BridgeCli } from "../../main/bridgeCliSpec";
import type { AgentSetup, McpAdded, McpHarness, SkillTarget } from "../../main/agentSetupSpec";
import type { PermissionKind, PermissionsState } from "../../main/permissionsSpec";
import type { T3ShareRequest, T3ThreadsView } from "../../main/t3ThreadsSpec";

/** What the preload exposes on `window.uplink` (src/preload/index.ts). */
export type ScreenSource = {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnail: string | null;
  /** Hz: the screen's display, or for a window the fastest display; null when unknown (main/media.ts). */
  refreshRate: number | null;
};

type DesktopBridge = {
  platform?: string;
  fakeMedia?: boolean;
  telemetryOff?: boolean;
  telemetryTest?: boolean;
  screenSources?: () => Promise<ScreenSource[]>;
  chooseScreenSource?: (id: string, name: string, audio: boolean) => Promise<void>;
  analyticsState?: () => Promise<{ enabled: boolean; deviceId: string } | null>;
  setAnalyticsEnabled?: (enabled: boolean) => Promise<void>;
  analyticsIdentify?: (identity: { memberId: string; teamId: string } | null, deviceId: string) => Promise<void>;
  updateState?: () => Promise<UpdateState | null>;
  checkForUpdates?: () => Promise<UpdateState | null>;
  restartToUpdate?: () => Promise<boolean>;
  setInCall?: (inCall: boolean) => Promise<void>;
  onUpdateState?: (listener: (state: UpdateState) => void) => () => void;
  openAtLogin?: () => Promise<LoginItemState | null>;
  setOpenAtLogin?: (on: boolean) => Promise<LoginItemState | null>;
  copyText?: (text: string) => Promise<void>;
  takeDeepLinks?: () => Promise<unknown[]>;
  onDeepLink?: (listener: () => void) => () => void;
  onOpenSettings?: (listener: () => void) => () => void;
  takeOpenSettings?: () => Promise<boolean>;
  bridgePairing?: () => Promise<PairingOnDisk | null>;
  t3Threads?: () => Promise<T3ThreadsView | null>;
  shareT3Threads?: (request: T3ShareRequest) => Promise<T3ThreadsView>;
  permissions?: () => Promise<PermissionsState | null>;
  askPermission?: (kind: "microphone" | "camera") => Promise<PermissionsState | null>;
  openPermission?: (kind: PermissionKind) => Promise<void>;
  dragApp?: () => void;
  testNotification?: () => Promise<void>;
  pairThisComputer?: (code: string, options?: { replace?: boolean }) => Promise<void>;
  bridgeCommand?: () => Promise<string | null>;
  bridgeCli?: () => Promise<BridgeCli | null>;
  installBridgeCli?: () => Promise<BridgeCli>;
  agentSetup?: () => Promise<AgentSetup | null>;
  installAgentSkill?: (target: SkillTarget) => Promise<AgentSetup>;
  addMcpServer?: (harness: McpHarness) => Promise<McpAdded>;
  log?: (level: string, scope: string, message: string, fields: Record<string, unknown>) => void;
  onPower?: (listener: (event: "suspend" | "resume" | "lock-screen" | "unlock-screen" | "shutdown") => void) => () => void;
  openLogs?: () => Promise<boolean>;
  diagnostics?: () => Promise<MainDiagnostics | null>;
};

/** The main process's half of "Copy diagnostics" (main/index.ts). Its lines are already scrubbed. */
export type MainDiagnostics = {
  version: string;
  electron: string;
  chrome: string;
  platform: string;
  arch: string;
  osVersion: string;
  packaged: boolean;
  logsDir: string;
  uptimeSeconds: number;
  recent: string[];
};

export const desktop: DesktopBridge = (window as unknown as { uplink?: DesktopBridge }).uplink ?? {};

/** Tests and screenshot scripts run with synthetic media: no devices are opened and no call sound plays. */
export const fakeMedia = desktop.fakeMedia === true;
