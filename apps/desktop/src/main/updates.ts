import { unlink } from "node:fs/promises";
import { app, autoUpdater as nativeUpdater, BrowserWindow, net } from "electron";
import electronUpdater, {
  type AppUpdater,
  type UpdateDownloadedEvent,
  type UpdateInfo,
} from "electron-updater";
import { reportError } from "./telemetry";
import { log } from "./log";
import { attempt, listenerGuard } from "./updateGuards";
import { sha512OfFile, verifyDownloadedUpdate } from "./updateSignature";
import {
  AUTO_RESTART_TICK_MS,
  TICK_MS,
  autoRestartDue,
  canCheckNow,
  canRestart,
  channelOf,
  checkDue,
  errorCode,
  feedUrl,
  initialState,
  isOffline,
  onChannel,
  reduce,
  type Quiet,
  type UpdateEvent,
  type UpdateRefusal,
  type UpdateState,
} from "./updateSpec";

/** An update the app refused: its signature didn't check out, or it was for another channel. */
class UpdateRefusedError extends Error {
  readonly code: "ERR_UPLINK_UPDATE_SIGNATURE" | "ERR_UPLINK_UPDATE_CHANNEL" | "ERR_UPLINK_UPDATE_MISMATCH";
  constructor(message: string, code: UpdateRefusedError["code"]) {
    super(message);
    this.code = code;
  }
}

/**
 * BaseUpdater's protected members (electron-updater 6.8.10, out/BaseUpdater.js), which the NSIS and
 * AppImage updaters inherit: the file `install()` runs, and the call that adds the install-on-quit
 * handler. See installOnQuit.
 */
type BaseUpdaterInternals = { readonly installerPath: string | null; addQuitHandler(): void };

/** One downloaded update being checked: the attempt it belongs to, its version and its file. */
type Ticket = { generation: number; version: string; file: string };

export type UpdatesOptions = {
  /** How quiet the computer is right now (updateSpec.ts, Quiet). Without it the app never restarts itself. */
  quiet?: () => Promise<Quiet>;
  /** Linux: an update installed at quit moved the AppImage to a new file name (electron-updater's "appimage-filename-updated"). */
  onAppImageMoved?: (path: string) => void;
};

/**
 * The app's own updates, with electron-updater on the rules in updateSpec.ts. The feed is
 * electron-builder's `publish` setting (electron-builder.yml), which it writes into the installed
 * app as `app-update.yml`: `https://uplinkroom.com/updates/<channel>/`, served from Vercel Blob
 * through the site's rewrites (apps/site). A failure is reported (telemetry.ts) and shown in
 * Settings; it never stops the app.
 *
 * What stands between the feed and an install (electron-updater 6.8.10):
 *  - The channel: a version for another channel is refused when the check finds it, through
 *    electron-updater's `isUpdateSupported`, so it's never downloaded or taken from the cache.
 *  - The signature (updateSignature.ts), checked on every platform when electron-updater emits
 *    "update-downloaded". It emits that for a fresh download and for an installer it already had
 *    in its cache, which it accepts by its sha512 alone (AppUpdater.executeDownload calls
 *    `done(false)` without NsisUpdater.verifySignature), so the check covers both. It's checked
 *    against the version and channel the feed offers, so a cached 0.2.1 advertised as 9.9.9 fails.
 *  - Nothing installs until then: `autoInstallOnAppQuit` stays off, so electron-updater adds no
 *    install-on-quit handler and MacUpdater doesn't hand the zip to Squirrel.Mac. After the check,
 *    the app adds the handler itself on Windows and Linux, and asks Squirrel.Mac to stage on macOS.
 *  - Each check starts an attempt, and a failure ends it. A step that finishes after its attempt
 *    ended (a download that failed after "update-downloaded", then a retry) changes nothing.
 */
export class Updates {
  private state: UpdateState;
  private readonly platform: string;
  private updater: AppUpdater | null = null;
  /** The current attempt. A check starts one and a failure ends it, each by adding one. */
  private generation = 0;
  /** What the current attempt's check found: the version and files the signature check compares against. */
  private pending: UpdateInfo | null = null;
  /** A version a check refused because it's for another channel, and the attempt that check started. */
  private offChannel: { generation: number; version: string } | null = null;
  /** macOS: the attempt Squirrel.Mac was last asked to stage. */
  private staging = -1;
  /** Removes native "update-downloaded" listeners MacUpdater added after start (see listenerGuard). */
  private pruneQuitListeners: () => void = () => {};
  /** Error codes already reported this launch, by stage. */
  private readonly reported = new Set<string>();
  private readonly options: UpdatesOptions;
  /** True while restartIfQuiet is asking how quiet the computer is. */
  private askingQuiet = false;

  constructor(platform: string = process.platform, options: UpdatesOptions = {}) {
    this.platform = platform;
    this.options = options;
    this.state = initialState({
      isPackaged: app.isPackaged,
      platform,
      version: app.getVersion(),
      env: process.env,
    });
  }

  get current(): UpdateState {
    return { ...this.state };
  }

  /** Starts the launch check and the four-hourly ones. Does nothing in a build that doesn't update. */
  start(): void {
    if (this.state.phase === "off") {
      log.info("updates", "off", { why: this.state.off });
      return;
    }
    try {
      // electron-updater is CommonJS; its docs read `autoUpdater` off the default export.
      const updater = electronUpdater.autoUpdater;
      // Downloads start here, after a check, so a failure lands in one place.
      updater.autoDownload = false;
      // Off until an update's signature checks out (installOnQuit). With it on, electron-updater
      // adds its install-on-quit handler as soon as a file downloads, and on macOS MacUpdater hands
      // the zip to Squirrel.Mac at once; a staged update installs on quit whatever the app decides.
      updater.autoInstallOnAppQuit = false;
      // The Windows installers are full NSIS installers, never web installers (electron-updater asks for this).
      updater.disableWebInstaller = true;
      // A version for another channel isn't an update for this app. electron-updater then treats
      // it as unavailable, so it keeps nothing to download; check() reports the refusal.
      const supported = updater.isUpdateSupported;
      updater.isUpdateSupported = (info) => {
        if (onChannel(this.state, info.version)) return supported(info);
        this.offChannel = { generation: this.generation, version: info.version };
        return false;
      };
      if (this.platform === "darwin") {
        // Squirrel.Mac finished staging: now, and only now, a restart can install it.
        nativeUpdater.on("update-downloaded", () => {
          if (this.staging === this.generation) this.apply({ type: "prepared" });
        });
        const guard = listenerGuard(nativeUpdater, "update-downloaded");
        this.pruneQuitListeners = () => void guard.prune();
      }
      updater.on("download-progress", (progress) =>
        this.apply({ type: "progress", percent: progress.percent }),
      );
      updater.on("update-downloaded", (event) => void this.prepare(updater, event));
      updater.on("appimage-filename-updated", (path) => this.options.onAppImageMoved?.(path));
      // Every failure arrives here, Squirrel.Mac's staging errors included, which no promise returns.
      updater.on("error", (error) => {
        this.report(error);
        if (this.state.phase === "preparing" || this.state.phase === "ready") this.fail();
      });
      this.updater = updater;
    } catch (error) {
      this.report(error, "setup");
      return;
    }
    const tick = () => {
      if (checkDue(this.state, Date.now())) void this.check();
    };
    setInterval(tick, TICK_MS).unref();
    tick();
    if (this.options.quiet) setInterval(() => void this.restartIfQuiet(), AUTO_RESTART_TICK_MS).unref();
  }

  /**
   * Restarts the app to install a ready update when nobody is using the computer and nothing would
   * be cut off (updateSpec.ts, autoRestartDue). Runs every minute while the app is open, and when
   * the screen locks. True when the restart is under way.
   */
  async restartIfQuiet(): Promise<boolean> {
    const quiet = this.options.quiet;
    if (!quiet || !this.updater || this.askingQuiet || !canRestart(this.state)) return false;
    this.askingQuiet = true;
    try {
      const now = await quiet();
      if (!autoRestartDue(this.state, now)) return false;
      log.info("updates", "restarting on its own", { version: this.state.next, idle: now.idle });
      return this.restart();
    } catch (error) {
      this.report(error, "install");
      return false;
    } finally {
      this.askingQuiet = false;
    }
  }

  /** Checks now (at launch, on schedule, or from Settings) and downloads what it finds. Never rejects. */
  async check(): Promise<UpdateState> {
    const updater = this.updater;
    if (!updater || !canCheckNow(this.state)) return this.current;
    const generation = ++this.generation;
    this.pending = null;
    this.apply({ type: "check", at: Date.now() });
    let info: UpdateInfo;
    try {
      const result = await updater.checkForUpdates();
      if (generation !== this.generation) return this.current;
      const refused = this.offChannel?.generation === generation ? this.offChannel.version : null;
      if (refused !== null) {
        this.refuse("channel", refused, this.offChannelReason(refused));
        return this.current;
      }
      if (!result?.isUpdateAvailable) {
        this.apply({ type: "not-available" });
        return this.current;
      }
      info = result.updateInfo;
    } catch (error) {
      if (generation !== this.generation) return this.current;
      this.report(error, "check");
      this.fail();
      return this.current;
    }
    // isUpdateSupported already refused it; this holds even if electron-updater stops asking.
    if (!onChannel(this.state, info.version)) {
      this.refuse("channel", info.version, this.offChannelReason(info.version));
      return this.current;
    }
    this.pending = info;
    this.apply({ type: "available", version: info.version });
    this.startDownload(updater, generation);
    return this.current;
  }

  /** "Restart to update", clicked or (restartIfQuiet) on its own. Refused while they're in a call or nothing is ready. */
  restart(): boolean {
    const updater = this.updater;
    if (!updater || !canRestart(this.state)) return false;
    setImmediate(() => {
      // Asked again right before quitting: a call may have started since the click.
      if (!canRestart(this.state)) return;
      try {
        // Silent on Windows (no installer wizard), and the app opens again afterwards everywhere.
        // On macOS the update is staged by now, so MacUpdater quits at once and adds no listener.
        updater.quitAndInstall(true, true);
      } catch (error) {
        this.report(error, "install");
        this.fail();
      }
    });
    return true;
  }

  setInCall(inCall: boolean): void {
    if (inCall !== this.state.inCall) this.apply({ type: "call", inCall });
  }

  /**
   * `downloadUpdate()` can throw before it returns a promise (a feed file without a checksum), so it
   * runs through `attempt`: a throw and a rejection both end in the failed state, from which the
   * next check (or "Check for updates") starts over. A rejection for an attempt that already ended
   * changes nothing.
   */
  private startDownload(updater: AppUpdater, generation: number): void {
    void attempt(() => updater.downloadUpdate()).catch((error: unknown) => {
      if (generation !== this.generation) return;
      this.report(error, "download");
      this.fail(errorCode(error) === "ERR_UPDATER_INVALID_SIGNATURE" ? "signature" : undefined);
    });
  }

  /**
   * A file is downloaded, or found in electron-updater's cache: check that it's the update the
   * check found and that its signature vouches for it, then let it install. Each step goes on only
   * while its attempt is the current one.
   */
  private async prepare(updater: AppUpdater, event: UpdateDownloadedEvent): Promise<void> {
    const ticket: Ticket = {
      generation: this.generation,
      version: event.version,
      file: event.downloadedFile,
    };
    const info = this.pending;
    this.apply({ type: "downloaded", version: event.version });
    try {
      if (!info || info.version !== ticket.version)
        return this.mismatch(ticket, "it isn't the version the check found");
      if (!onChannel(this.state, ticket.version))
        return this.refuse("channel", ticket.version, this.offChannelReason(ticket.version));
      const verdict = await this.verify(ticket.file, info);
      if (ticket.generation !== this.generation) return;
      if (verdict.reason) {
        await unlink(ticket.file).catch(() => undefined);
        if (ticket.generation !== this.generation) return;
        return this.refuse("signature", ticket.version, verdict.reason);
      }
      // The file electron-updater will install must still be the one just checked.
      if (this.platform !== "darwin") {
        const installs = (updater as unknown as BaseUpdaterInternals).installerPath;
        if (installs !== ticket.file)
          return this.mismatch(ticket, "electron-updater would install another file");
      }
      const now = await sha512OfFile(ticket.file);
      if (ticket.generation !== this.generation) return;
      if (now !== verdict.sha512)
        return this.refuse("signature", ticket.version, "the file changed after its check");
      if (this.platform === "darwin") {
        // MacUpdater pointed the native updater at its local proxy for this zip; this is the call
        // it makes itself when autoInstallOnAppQuit is on. "update-downloaded" from it means staged.
        this.staging = ticket.generation;
        nativeUpdater.checkForUpdates();
        return;
      }
      this.installOnQuit(updater);
      this.apply({ type: "prepared" });
    } catch (error) {
      if (ticket.generation !== this.generation) return;
      this.report(error, "prepare");
      this.fail();
    }
  }

  /**
   * Windows and Linux: lets the checked update install when the app quits. electron-updater adds
   * its install-on-quit handler only while `autoInstallOnAppQuit` is on, and reads the setting
   * again at quit (out/BaseUpdater.js, addQuitHandler), so the handler goes in now, and a failure
   * turns the setting off again (fail).
   */
  private installOnQuit(updater: AppUpdater): void {
    updater.autoInstallOnAppQuit = true;
    (updater as unknown as BaseUpdaterInternals).addQuitHandler();
  }

  /** The file's verdict against the update it belongs to: its sha512, and null or why it may not install. */
  private async verify(
    path: string,
    info: UpdateInfo,
  ): Promise<{ sha512: string | null; reason: string | null }> {
    const channel = this.state.channel;
    if (!channel) return { sha512: null, reason: "this app is on no channel" };
    return verifyDownloadedUpdate({
      path,
      channel,
      version: info.version,
      files: info.files,
      feed: feedUrl(channel),
      platform: this.platform,
      fetchText: async (url) => {
        const response = await net.fetch(url, { cache: "no-store" });
        if (response.status === 404) return null;
        if (!response.ok)
          throw Object.assign(new Error("Signature download failed"), {
            statusCode: response.status,
          });
        return response.text();
      },
    });
  }

  private offChannelReason(version: string): string {
    const theirs = channelOf(version);
    return theirs
      ? `it's for the ${theirs} channel, and this app is on ${this.state.channel ?? "none"}`
      : "it belongs to no release channel";
  }

  private refuse(kind: UpdateRefusal, version: string, reason: string): void {
    const code = kind === "channel" ? "ERR_UPLINK_UPDATE_CHANNEL" : "ERR_UPLINK_UPDATE_SIGNATURE";
    const error = new UpdateRefusedError(`Update ${version} refused: ${reason}`, code);
    console.warn(`Uplink Room: ${error.message}.`);
    this.report(error, kind);
    this.fail(kind);
  }

  private mismatch(ticket: Ticket, reason: string): void {
    const error = new UpdateRefusedError(
      `Update ${ticket.version} not installed: ${reason}`,
      "ERR_UPLINK_UPDATE_MISMATCH",
    );
    console.warn(`Uplink Room: ${error.message}.`);
    this.report(error, "prepare");
    this.fail();
  }

  /** Ends the current attempt: nothing it started can change the state or install any more. */
  private fail(reason?: UpdateRefusal): void {
    this.generation += 1;
    this.pending = null;
    if (this.updater) this.updater.autoInstallOnAppQuit = false;
    this.pruneQuitListeners();
    this.apply(reason ? { type: "failed", reason } : { type: "failed" });
  }

  private apply(event: UpdateEvent): void {
    const before = this.state.phase;
    this.state = reduce(this.state, event);
    const state = this.current;
    // Progress events repeat while a download runs; only a change of phase is a line.
    if (state.phase !== before) log.info("updates", state.phase, { version: state.next, why: state.failure });
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("uplink:update-state", state);
    }
  }

  private report(error: unknown, stage = this.stage()): void {
    const code = errorCode(error);
    log.warn("updates", "failed", { stage, code });
    if (isOffline(code)) return;
    const key = `${stage}:${code}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    reportError(error, {
      area: "updates",
      update_stage: stage,
      update_code: code,
      update_channel: this.state.channel ?? "none",
    });
  }

  private stage(): string {
    if (this.state.phase === "checking") return "check";
    if (this.state.phase === "downloading") return "download";
    if (this.state.phase === "preparing") return "prepare";
    if (this.state.phase === "ready") return "install";
    return "other";
  }
}
