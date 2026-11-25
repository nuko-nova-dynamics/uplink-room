import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClerkBridge } from "@clerk/electron";
import { storage } from "@clerk/electron/storage";
import { app, BrowserWindow, clipboard, ipcMain, Menu, net, powerMonitor, protocol, safeStorage, session, shell } from "electron";
import { appMenuTemplate, SettingsRequest, TRAFFIC_LIGHTS } from "./menuSpec";
import { opensOutside, startPathAllowed } from "./startPath";
import { pairRefusal, parsePairRequest } from "./pairGuard";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { registerPermissions } from "./permissions";
import { appCsp } from "./csp";
import { log, logLifecycle, logsDir, logWindow, recentLines, registerRendererLog, startLogging } from "./log";
import { FRAME_HOST, FRAME_SCHEME, frameResponse, isViewerPath, viewerHeaders } from "./frame";
import { BROWSER_FRAME_HOST, browserFrameResponse } from "./browserFrame";
import {
  bridgeBusyTerminals,
  addMcpServerFromApp,
  agentSetupStatus,
  bridgeCliStatus,
  installAgentSkillFromApp,
  bridgeCommand,
  currentPairing,
  installBridgeCliOnPath,
  pairThisComputer,
  readT3Threads,
  shareT3Threads,
  startBridge,
  stopBridge,
} from "./bridge";
import { parseT3ShareRequest } from "./t3ThreadsSpec";
import { guardedStorage, protectsTokens } from "./tokenStorage";
import { firstReachable, forwardSpaceView, letAppFrame, type Forward } from "./spaceForward";
import { dismiss, endSession, notify, quiet, reconcile } from "./notifications";
import { parseLiveKeys, parseNotifyRequest, parseSession } from "./notifySpec";
import { fakeMedia, registerMedia } from "./media";
import { MainAnalytics, parseIdentity } from "./analytics";
import { POSTHOG_ASSETS_HOST, POSTHOG_HOST } from "./analyticsSpec";
import { startTelemetry } from "./telemetry";
import { Updates } from "./updates";
import { AUTO_RESTART_IDLE_SECONDS, channelOf } from "./updateSpec";
import { LoginItem } from "./loginItem";
import { registerClipboard } from "./clipboard";
import { DeepLinkQueue, deepLinkFromArgv, parseDeepLink } from "./deepLink";

/** electron-builder.yml `appId`, which the Windows installer's shortcut carries as its AppUserModelID. */
const APP_ID = "com.nukonovadynamics.uplinkroom";

/**
 * Two custom schemes:
 *  - `uplink-room://app/` serves the built renderer, so it has a real origin
 *    (storage, fetch) instead of `file://`. It is also the scheme Clerk's
 *    OAuth sign-in returns to, so the packaged app registers it with the
 *    operating system. Clerk only accepts it because it is in the Clerk
 *    instance's `allowed_origins`.
 *  - `uplink-frame://sandbox/` is the separate origin for posted HTML pages (see frame.ts),
 *    and `uplink-frame://browser/` the one for shared browsers (see browserFrame.ts).
 */
const APP_SCHEME = "uplink-room";
const APP_HOST = "app";
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * Clerk's Electron bridge: token storage (encrypted with safeStorage, which on
 * macOS needs the signed app's Keychain identity) and, in the packaged app,
 * OAuth through the system browser and a deep link back. Development and the
 * tests run unpackaged: no deep-link handler, no single-instance lock, and the
 * token may be kept unencrypted if the OS store refuses an unsigned Electron.
 *
 * On Linux without a supported keyring, safeStorage falls back to `basic_text`
 * (a hard-coded key) while still reporting encryption available, so there the
 * session is kept in memory only and the person signs in again next launch
 * (see tokenStorage.ts). The backend is known only once the app is ready.
 */
// Development and test runs keep their own data (and Clerk session) apart
// from the installed app's, unless a script passes --user-data-dir.
// A LiveKit dev server bound to 127.0.0.1 (docs/calls.md): Chromium's WebRTC skips loopback
// candidates unless told otherwise. Local runs only; packaged builds never set it.
if (!app.isPackaged && (fakeMedia || process.env["UPLINK_LOCAL_LIVEKIT"] === "1"))
  app.commandLine.appendSwitch("allow-loopback-in-peer-connection");

if (!app.isPackaged && !app.commandLine.hasSwitch("user-data-dir"))
  app.setPath("userData", join(app.getPath("appData"), "Uplink Room (development)"));
// Test-channel builds (0.2.1-test.1, docs/releases.md) keep theirs apart from the released app's too.
else if (app.isPackaged && channelOf(app.getVersion()) === "test" && !app.commandLine.hasSwitch("user-data-dir"))
  app.setPath("userData", join(app.getPath("appData"), "Uplink Room (test)"));

// The diagnostic log (log.ts): the OS's logs folder for the installed app, the data folder's own
// `logs` for development, test-channel builds and --user-data-dir runs. Before anything else logs.
startLogging({
  separateData:
    !app.isPackaged || channelOf(app.getVersion()) === "test" || app.commandLine.hasSwitch("user-data-dir"),
});
logLifecycle();

// Error reports, in release builds only (telemetry.ts). After userData is set, since the SDK keeps
// unsent events there, and before Clerk and the app register their schemes.
startTelemetry();

/**
 * Product analytics (analytics.ts, docs/analytics.md). Only release builds carry a project key
 * (`.env.release`), so development, tests and screenshot runs send nothing.
 */
const analytics = new MainAnalytics({
  key: import.meta.env["VITE_POSTHOG_KEY"] as string | undefined,
  file: join(app.getPath("userData"), "analytics.json"),
});

/**
 * The app's own updates (updates.ts): installed builds only. A ready update also installs on its
 * own once nobody is at the computer and the bridge has no terminal a restart would end.
 */
/** "Open at login" (loginItem.ts): installed builds only. */
const loginItem = new LoginItem();

const updates = new Updates(process.platform, {
  quiet: async () => ({
    idle: powerMonitor.getSystemIdleState(AUTO_RESTART_IDLE_SECONDS),
    terminals: await bridgeBusyTerminals(),
  }),
  onAppImageMoved: (path) => loginItem.followAppImage(path),
});

/**
 * Join links and the welcome email's links (deepLink.ts). They wait until the window takes them;
 * each arrival focuses the window and tells it to. A cold start on Windows or Linux carries its
 * link in argv; macOS sends `open-url`, which can come before the app is ready, so it's listened
 * for here, at startup. Clerk's own `uplink-room://app/` callback is left to Clerk.
 */
const deepLinks = new DeepLinkQueue(() => {
  const [window] = BrowserWindow.getAllWindows();
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.focus();
  window.webContents.send("uplink:deep-link");
});
app.on("open-url", (event, url) => {
  const link = parseDeepLink(url);
  if (!link) return;
  event.preventDefault();
  deepLinks.push(link);
});
const launchLink = deepLinkFromArgv(process.argv);
if (launchLink) deepLinks.push(launchLink);

let tokensProtected: boolean | undefined;
function persistTokens(): boolean | undefined {
  if (tokensProtected === undefined && app.isReady()) {
    tokensProtected = protectsTokens(
      process.platform,
      process.platform === "linux" ? safeStorage.getSelectedStorageBackend() : undefined,
    );
    if (!tokensProtected)
      console.warn("Uplink Room: no system keyring, so the sign-in is kept in memory only until the app quits.");
  }
  return tokensProtected;
}

const clerk = createClerkBridge({
  storage: guardedStorage(storage({ unencryptedFallback: !app.isPackaged }), persistTokens),
  ...(app.isPackaged ? { renderer: { scheme: APP_SCHEME, host: APP_HOST } } : {}),
  userAgent: `Uplink Room/${app.getVersion()}`,
});

// Electron keeps only the last call, so both schemes are registered here,
// after Clerk's, with the privileges Clerk asks for its renderer scheme.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
  // CORS-enabled so the shared-browser frame and the PDF viewer can load their module scripts
  // into their pages (see browserFrame.ts and frame.ts).
  { scheme: FRAME_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const here = fileURLToPath(new URL(".", import.meta.url));
const rendererDir = join(here, "../renderer");

/** Which bundled page to open. Tests use `/harness.html`; everything else opens the app. */
const startPath = process.env["UPLINK_START_PATH"] ?? "/index.html";

/** The UI gym's sample team (startPath.ts): it runs in the background and opens nothing outside. */
const inGym = startPath.startsWith("/gym.html");
// No Dock icon, and the app never becomes the active one, so a gym run doesn't take the person's focus.
if (inGym && process.platform === "darwin") app.setActivationPolicy("accessory");

/** A link out of the app, in the system browser; in the gym it's only logged (startPath.ts). */
function openOutside(url: string): void {
  if (opensOutside(url, startPath)) void shell.openExternal(url);
  else if (/^https?:\/\//.test(url)) console.info(`Uplink Room: the gym didn't open ${url}`);
}
const devServer = process.env["ELECTRON_RENDERER_URL"];
const convexUrl = import.meta.env["VITE_CONVEX_URL"] as string | undefined;

/** The Clerk Frontend API host, which the publishable key encodes (`pk_test_<base64 host$>`). */
function clerkHost(): string | undefined {
  const key = import.meta.env["VITE_CLERK_PUBLISHABLE_KEY"] as string | undefined;
  const encoded = key?.split("_")[2];
  if (!encoded) return undefined;
  const host = Buffer.from(encoded, "base64").toString("utf8").replace(/\$$/, "");
  return /^[a-z0-9.-]+$/i.test(host) ? host : undefined;
}

/** What the built renderer may load (csp.ts). */
const APP_CSP = appCsp(clerkHost());

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json",
};

/** `new URL(...).origin` is "null" for some custom schemes, so compare scheme and host. */
const originOf = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
};

function registerProtocols(): void {
  protocol.handle(FRAME_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname === BROWSER_FRAME_HOST)
      return browserFrameResponse(url.pathname, url.search, rendererDir, devServer);
    if (url.hostname !== FRAME_HOST) return new Response("Not found", { status: 404 });
    if (url.pathname === "/frame.html" || url.pathname === "/frame.js" || url.pathname === "/") {
      return frameResponse(url.pathname);
    }
    return await viewerResponse(url);
  });

  /**
   * The PDF viewer's files, under the frame origin (see frame.ts). In development they
   * come from the dev server, which also serves its own module paths; built, only
   * `pdf-frame.html` and `/assets/` are served, from the renderer's folder.
   */
  async function viewerResponse(url: URL): Promise<Response> {
    let response: Response;
    if (devServer) {
      response = await net.fetch(new URL(url.pathname + url.search, devServer).toString());
    } else {
      if (!isViewerPath(url.pathname)) return new Response("Not found", { status: 404 });
      const file = normalize(join(rendererDir, decodeURIComponent(url.pathname)));
      if (!file.startsWith(rendererDir + sep) || !existsSync(file)) return new Response("Not found", { status: 404 });
      response = await net.fetch(pathToFileURL(file).toString());
    }
    const type = MIME[url.pathname.slice(url.pathname.lastIndexOf("."))] ?? response.headers.get("content-type") ?? undefined;
    return new Response(response.body, { status: response.status, headers: viewerHeaders(type) });
  }

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== APP_HOST) return new Response("Not found", { status: 404 });
    let relative: string;
    try {
      relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    const file = normalize(join(rendererDir, relative));
    // Stay inside the renderer's folder.
    if (!file.startsWith(rendererDir + sep) || !existsSync(file))
      return new Response("Not found", { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString());
    const type = MIME[file.slice(file.lastIndexOf("."))];
    const headers = new Headers(response.headers);
    if (type) headers.set("content-type", type);
    headers.set("content-security-policy", APP_CSP);
    return new Response(response.body, { status: response.status, headers });
  });
}

/** The app's own origin: the dev server's, or `uplink-room://app`. */
const appOrigin = devServer ? originOf(devServer) : APP_ORIGIN;

/** True for the app window's main frame on the app's own origin (never a posted page). */
function isAppFrame(contents: Electron.WebContents, url: string, isMainFrame: boolean): boolean {
  if (!isMainFrame || contents.getType() !== "window") return false;
  try {
    return originOf(url) === appOrigin;
  } catch {
    return false;
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    // Linux capture boxes opt in to showing the gym inside Xvfb so frame callbacks run.
    // Other gym runs stay hidden and never take focus on the host desktop.
    ...(inGym ? { show: process.platform === "linux" && process.env["UPLINK_GYM_XVFB"] === "1", paintWhenInitiallyHidden: true } : {}),
    width: 1320,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#121212",
    title: "Uplink Room",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: TRAFFIC_LIGHTS }
      : {}),
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // The sound cues must play when a run starts waiting, even before anyone clicks in the window.
      autoplayPolicy: "no-user-gesture-required",
      // A call keeps its heartbeat and media timers on time while the window is hidden, minimized
      // or behind other windows: Chromium otherwise slows a background page's timers, down to one
      // wake-up a minute after five minutes hidden, which is the call's whole presence window.
      backgroundThrottling: false,
    },
  });
  logWindow(window);
  // Checks and screenshot runs stay silent on the machine they run on.
  if (quiet) window.webContents.setAudioMuted(true);

  // Links open in the system browser; the app never opens a second window.
  // The window never leaves the app's origin, because a page from elsewhere
  // would inherit the preload and with it Clerk's token cache.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (originOf(url) === appOrigin) return;
    event.preventDefault();
    openOutside(url);
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (event.isMainFrame && originOf(url) !== appOrigin) event.preventDefault();
  });

  if (devServer) void window.loadURL(new URL(startPath, devServer).toString());
  else void window.loadURL(`${APP_ORIGIN}${startPath}`);
  return window;
}

/**
 * Settings… in the macOS app menu (Command-comma): the window opens the same Settings route as the
 * gear at the bottom of the sidebar. With no window open, it opens one, as clicking the Dock does.
 */
/** Settings asked for while no window was open: the new window's shell takes it once it's up. */
const settingsRequest = new SettingsRequest();

function openSettings(): void {
  const [window] = BrowserWindow.getAllWindows();
  if (settingsRequest.request(Boolean(window))) {
    createWindow();
    return;
  }
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  window.webContents.send("uplink:open-settings");
}

/** Only the app's own main frame may ask the main process for anything. */
function fromAppWindow(event: Electron.IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return Boolean(frame) && frame === event.sender.mainFrame && event.sender.getType() === "window";
}

/** Open Space view forwards, by their loopback origin. */
const spaceForwards = new Map<string, Forward>();

function registerIpc(): void {
  registerRendererLog((event) => fromAppWindow(event as unknown as Electron.IpcMainInvokeEvent));
  // Cua's viewer page refuses every frame (`frame-ancestors 'none'`); let the app's origin, and only
  // it, frame the pages its own Space forwards serve (spaceForward.ts).
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    let origin: string;
    try {
      origin = new URL(details.url).origin;
    } catch {
      return callback({});
    }
    if (details.resourceType !== "subFrame" || !spaceForwards.has(origin)) return callback({});
    callback({ responseHeaders: letAppFrame(details.responseHeaders ?? {}, appOrigin) });
  });
  // Takes the view's URL at each address of the bridge's gateway, and forwards the first that answers.
  ipcMain.handle("uplink:space-open", async (event, urls: unknown) => {
    if (!fromAppWindow(event) || !Array.isArray(urls) || !urls.every((u) => typeof u === "string")) {
      throw new Error("Not allowed");
    }
    const url = await firstReachable(urls);
    if (!url) {
      log.warn("space", "view unreachable", { addresses: urls.length });
      throw new Error("unreachable");
    }
    const forward = await forwardSpaceView(url);
    spaceForwards.set(new URL(forward.url).origin, forward);
    log.info("space", "view forwarded", { addresses: urls.length, open: spaceForwards.size });
    return forward.url;
  });
  ipcMain.handle("uplink:space-close", async (event, url: unknown) => {
    if (!fromAppWindow(event) || typeof url !== "string") throw new Error("Not allowed");
    const origin = new URL(url).origin;
    await spaceForwards.get(origin)?.close();
    spaceForwards.delete(origin);
    log.info("space", "view closed", { open: spaceForwards.size });
  });
  // Settings, Diagnostics: the logs folder, and a short summary for "Copy diagnostics" (no secrets:
  // the log's lines are scrubbed as they're written, and paths show the home folder as ~).
  ipcMain.handle("uplink:logs-open", async (event) => {
    if (!fromAppWindow(event)) return false;
    const failed = await shell.openPath(logsDir());
    if (failed) log.warn("diagnostics", "couldn't open the logs folder");
    return !failed;
  });
  ipcMain.handle("uplink:diagnostics", (event) => {
    if (!fromAppWindow(event)) return null;
    const home = homedir();
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      platform: process.platform,
      arch: process.arch,
      osVersion: process.getSystemVersion(),
      packaged: app.isPackaged,
      logsDir: logsDir().split(home).join("~"),
      uptimeSeconds: Math.round(process.uptime()),
      recent: recentLines(400).filter((line) => / (WARN|ERROR) /.test(line)).slice(-40),
    };
  });
  ipcMain.handle("uplink:bridge-command", (event) => (fromAppWindow(event) ? bridgeCommand() : null));
  // `uplink-bridge` on PATH (main/bridgeCli.ts): read it whenever asked; change it only on Add to PATH.
  ipcMain.handle("uplink:bridge-cli", (event) => (fromAppWindow(event) ? bridgeCliStatus() : null));
  ipcMain.handle("uplink:bridge-cli-install", (event) => {
    if (!fromAppWindow(event)) throw new Error("Not allowed");
    return installBridgeCliOnPath();
  });
  // Settings, Command line (main/agentSetup.ts): the uplink skill and uplink-mcp for agents on this computer.
  ipcMain.handle("uplink:agent-setup", (event) => (fromAppWindow(event) ? agentSetupStatus() : null));
  ipcMain.handle("uplink:agent-skill-install", (event, target: unknown) => {
    if (!fromAppWindow(event)) throw new Error("Not allowed");
    if (target !== "claude" && target !== "codex") throw new Error("Unknown harness");
    return installAgentSkillFromApp(target);
  });
  ipcMain.handle("uplink:agent-mcp-add", (event, harness: unknown) => {
    if (!fromAppWindow(event)) throw new Error("Not allowed");
    if (harness !== "claude" && harness !== "codex" && harness !== "hermes") throw new Error("Unknown harness");
    return addMcpServerFromApp(harness);
  });
  // Settings, Machines on this computer (t3ThreadsSpec.ts): its T3 Code threads, read from its own
  // bridge and shown only here, and the ones a click on Save shares. The T3 Code session stays in
  // the bridge; the renderer gets titles and states only.
  ipcMain.handle("uplink:t3-threads", (event) => (fromAppWindow(event) ? readT3Threads() : null));
  ipcMain.handle("uplink:t3-share", (event, value: unknown) => {
    const request = parseT3ShareRequest(value);
    if (!fromAppWindow(event) || !request) throw new Error("Not allowed");
    return shareT3Threads(request);
  });
  // Whether this computer is already linked, so the setup never replaces a pairing unasked.
  ipcMain.handle("uplink:bridge-pairing", (event) => (fromAppWindow(event) ? currentPairing() : null));
  // The shell asks once it's up whether Settings was asked for before the window existed.
  ipcMain.handle("uplink:take-open-settings", (event) => {
    return fromAppWindow(event) ? settingsRequest.take() : false;
  });
  // Copy buttons (clipboard.ts): Electron's clipboard, since the renderer's needs a permission it doesn't get.
  registerClipboard(ipcMain, clipboard, fromAppWindow);
  ipcMain.handle("uplink:deep-links-take", (event) => (fromAppWindow(event) ? deepLinks.take() : []));
  // System notifications for Needs you and The wheel is yours; a click or button comes back to the renderer.
  ipcMain.handle("uplink:notify", (event, value: unknown, sessionValue: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const request = parseNotifyRequest(value);
    const session = parseSession(sessionValue);
    if (!fromAppWindow(event) || !window || !request || !session) return;
    notify(window, request, session, (answer) => {
      if (window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      window.webContents.send("uplink:notification", answer);
    });
  });
  ipcMain.handle("uplink:notify-dismiss", (event, id: unknown) => {
    if (fromAppWindow(event) && typeof id === "string") dismiss(id);
  });
  // A renderer session starts with what is live, and ends (sign-out, another team) by name, so
  // banners it can no longer keep up to date don't outlive it.
  ipcMain.handle("uplink:notify-reconcile", (event, sessionValue: unknown, keys: unknown) => {
    const session = parseSession(sessionValue);
    const live = parseLiveKeys(keys);
    if (fromAppWindow(event) && session && live) reconcile(session, live);
  });
  ipcMain.handle("uplink:notify-end", (event, sessionValue: unknown) => {
    const session = parseSession(sessionValue);
    if (fromAppWindow(event) && session) endSession(session);
  });
  ipcMain.handle("uplink:pair-this-computer", async (event, value: unknown) => {
    const request = parsePairRequest(value);
    if (!fromAppWindow(event) || !request) throw new Error("Not allowed");
    if (!app.isPackaged || !convexUrl) throw new Error("Pairing from the app needs the installed app");
    // Replacing a pairing deletes the computer's terminals, profiles and threads: only setup's
    // confirmation sends replace (main/pairGuard.ts).
    const refusal = pairRefusal(request, currentPairing());
    if (refusal) throw new Error(refusal);
    try {
      await pairThisComputer(request.code, convexUrl);
    } catch (error) {
      void analytics.capture("machine_linked", { method: "this_computer", result: "failed" });
      throw error;
    }
    void analytics.capture("machine_linked", { method: "this_computer", result: "ok" });
  });
  // "Share usage data" (Settings, Privacy), which main keeps so both processes follow one setting.
  ipcMain.handle("uplink:analytics-state", (event) => (fromAppWindow(event) ? analytics.state : null));
  ipcMain.handle("uplink:analytics-set-enabled", (event, enabled: unknown) => {
    if (fromAppWindow(event) && typeof enabled === "boolean") analytics.setEnabled(enabled);
  });
  // The member and team the renderer opened, or null after sign-out: main's events use the same IDs.
  ipcMain.handle("uplink:analytics-identify", (event, value: unknown, deviceId: unknown) => {
    if (fromAppWindow(event)) analytics.identify(parseIdentity(value), typeof deviceId === "string" ? deviceId : undefined);
  });
  // Updates (updates.ts): the state for Settings and the prompt, "Check for updates", "Restart to
  // update", and whether this person is in a call, which holds the prompt and the restart back.
  ipcMain.handle("uplink:update-state", (event) => (fromAppWindow(event) ? updates.current : null));
  ipcMain.handle("uplink:update-check", (event) => (fromAppWindow(event) ? updates.check() : null));
  ipcMain.handle("uplink:update-restart", (event) => (fromAppWindow(event) ? updates.restart() : false));
  ipcMain.handle("uplink:update-in-call", (event, inCall: unknown) => {
    if (fromAppWindow(event) && typeof inCall === "boolean") updates.setInCall(inCall);
  });
  // "Open at login" (loginItem.ts), Settings, Updates.
  ipcMain.handle("uplink:open-at-login", (event) => (fromAppWindow(event) ? loginItem.state : null));
  ipcMain.handle("uplink:open-at-login-set", (event, on: unknown) => {
    if (!fromAppWindow(event) || typeof on !== "boolean") return null;
    return loginItem.set(on);
  });
  // While "Share usage data" is off, no request reaches PostHog from any page: this catches
  // anything posthog-js still had queued, its retries and beacons included.
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: [`${POSTHOG_HOST}/*`, `${POSTHOG_ASSETS_HOST}/*`] },
    (_details, callback) => callback({ cancel: !analytics.state.enabled }),
  );
}

// Windows shows toasts only for an app whose AppUserModelID matches its Start menu shortcut.
// Unpackaged runs have no shortcut; Electron's docs use the executable's path there.
if (process.platform === "win32") app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);

if (clerk.isPrimaryInstance) {
  void app.whenReady().then(() => {
    registerProtocols();
    registerIpc();
    // Only the app's own frame gets the microphone, camera and screen, for calls (media.ts). No page
    // gets location or web notifications: system notifications come from the main process
    // (notifications.ts), for the two events that get a banner.
    registerMedia(isAppFrame, fromAppWindow);
    registerPermissions(fromAppWindow);
    if (process.platform === "darwin") {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate(
          appMenuTemplate({ openSettings, openWebsite: () => openOutside("https://uplinkroom.com") }),
        ),
      );
    }
    // The gym renders a sample team into its profile: never in an installed app or a real profile.
    const real = (path: string) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    };
    if (!startPathAllowed(startPath, { packaged: app.isPackaged, userData: real(app.getPath("userData")), tmp: real(tmpdir()) })) {
      console.error("Uplink Room: the UI gym runs only in a development build with a --user-data-dir under the temp folder.");
      app.quit();
      return;
    }
    createWindow();
    startBridge();
    updates.start();
    loginItem.applyAtLaunch();
    // A locked screen means nobody is at the computer: a ready update can install now.
    powerMonitor.on("lock-screen", () => void updates.restartIfQuiet());
    void analytics.capture("app_launched", {
      app_version: app.getVersion(),
      platform: (["darwin", "win32", "linux"] as const).find((p) => p === process.platform) ?? "other",
      arch: (["arm64", "x64"] as const).find((a) => a === process.arch) ?? "other",
    });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // A second launch (a deep link on Windows and Linux) focuses the open window, and hands it the
  // link when it's one of the app's (Clerk takes its own sign-in callback).
  app.on("second-instance", (_event, argv) => {
    const link = deepLinkFromArgv(argv);
    if (link) return deepLinks.push(link);
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  for (const forward of spaceForwards.values()) void forward.close();
  spaceForwards.clear();
  void stopBridge();
  void analytics.shutdown();
  clerk.cleanup();
});
