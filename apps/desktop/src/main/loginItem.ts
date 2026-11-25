import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { app } from "electron";
import { repairAppImageDesktopEntries } from "./appImageDesktop";
import { log } from "./log";
import {
  AUTOSTART_FILE,
  autostartEntry,
  autostartOn,
  defaultsOn,
  type LoginItemState,
} from "./loginItemSpec";
import { channelOf } from "./updateSpec";

/**
 * "Open at login", on the rules in loginItemSpec.ts. The one-time default is remembered in
 * `startup.json` in the app's data folder, so test-channel builds (which keep their own folder)
 * remember theirs apart.
 */
export class LoginItem {
  private readonly platform = process.platform;
  private readonly file = join(app.getPath("userData"), "startup.json");

  /** At launch: the one-time default, then (Linux) the autostart entry rewritten for this executable. */
  applyAtLaunch(): void {
    if (!this.supported()) return;
    if (this.platform === "linux" && process.env["APPIMAGE"])
      this.repairMenu(process.env["APPIMAGE"]);
    try {
      if (
        defaultsOn({
          isPackaged: app.isPackaged,
          channel: channelOf(app.getVersion()),
          defaulted: this.defaulted(),
        })
      ) {
        this.write(true);
        log.info("startup", "open at login turned on by default");
      } else if (this.platform === "linux" && this.read().on) {
        this.write(true);
      }
      this.markDefaulted();
    } catch (error) {
      log.warn("startup", "open at login not set", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Linux: an update installed at quit renamed the AppImage (0.2.9 to 0.2.10 in its name), and the
   * app may not open again before the next login, so the entry follows it now.
   */
  followAppImage(path: string): void {
    if (this.platform !== "linux" || !app.isPackaged) return;
    this.repairMenu(path);
    try {
      if (this.read().on) this.write(true, path);
    } catch (error) {
      log.warn("startup", "open at login not moved", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private repairMenu(image: string): void {
    try {
      repairAppImageDesktopEntries(image);
    } catch (error) {
      log.warn("startup", "menu launcher not moved", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  get state(): LoginItemState {
    if (!this.supported()) return { supported: false, on: false, needsApproval: false };
    try {
      return { supported: true, ...this.read() };
    } catch {
      return { supported: true, on: false, needsApproval: false };
    }
  }

  /** Settings' switch. The choice also counts as the one-time default, so it's never undone. */
  set(on: boolean): LoginItemState {
    if (!this.supported()) return this.state;
    this.write(on);
    this.markDefaulted();
    log.info("startup", on ? "open at login on" : "open at login off");
    return this.state;
  }

  private supported(): boolean {
    if (!app.isPackaged) return false;
    if (this.platform === "linux") return this.linuxExecutable() !== null;
    return this.platform === "darwin" || this.platform === "win32";
  }

  private read(): { on: boolean; needsApproval: boolean } {
    if (this.platform === "linux") {
      let text: string | null = null;
      try {
        text = readFileSync(this.autostartPath(), "utf8");
      } catch {
        text = null;
      }
      return { on: autostartOn(text), needsApproval: false };
    }
    const settings = app.getLoginItemSettings();
    if (this.platform === "darwin")
      return { on: settings.openAtLogin, needsApproval: settings.status === "requires-approval" };
    // Windows: false too when it's been turned off in Task Manager or Settings, Apps, Startup.
    return { on: settings.executableWillLaunchAtLogin, needsApproval: false };
  }

  private write(on: boolean, executable = this.linuxExecutable()): void {
    if (this.platform !== "linux") {
      app.setLoginItemSettings({ openAtLogin: on });
      return;
    }
    const path = this.autostartPath();
    if (!on) {
      rmSync(path, { force: true });
      return;
    }
    const entry = executable ? autostartEntry(executable) : null;
    if (!entry) throw new Error("the app's path can't go in an autostart entry");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entry);
  }

  /** The file a login runs: the AppImage itself (not its temporary mount), or the installed binary. */
  private linuxExecutable(): string | null {
    const appImage = process.env["APPIMAGE"];
    const executable = appImage || process.execPath;
    return autostartEntry(executable) ? executable : null;
  }

  private autostartPath(): string {
    const config = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
    return join(config, "autostart", AUTOSTART_FILE);
  }

  private defaulted(): boolean {
    try {
      return (
        (JSON.parse(readFileSync(this.file, "utf8")) as { openAtLoginDefaulted?: unknown })
          .openAtLoginDefaulted === true
      );
    } catch {
      return false;
    }
  }

  private markDefaulted(): void {
    if (this.defaulted()) return;
    writeFileSync(this.file, JSON.stringify({ openAtLoginDefaulted: true }) + "\n");
  }
}
