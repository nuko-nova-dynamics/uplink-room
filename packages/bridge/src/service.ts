/**
 * `uplink-bridge service`: runs the bridge as a systemd user service on Linux, for a server with no
 * display that someone reaches over SSH. `uplink-bridge run` in an SSH session ends when the session
 * does; the service starts at boot, restarts the bridge when it exits, and keeps running after logout
 * once the user lingers (`loginctl enable-linger`).
 *
 * A user service, not a system one: the bridge's terminals run as the person who paired it, with
 * their home, sign-ins and tools, and installing it needs no root.
 */
import { execFile } from "node:child_process";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

export const SERVICE_NAME = "uplink-bridge.service";

export type ServiceRunner = (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const runCommand: ServiceRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 127) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && code === 127 ? error.message : "")) });
    });
  });

/** One word of an ExecStart line or an Environment assignment, as systemd reads it (systemd.syntax(7)). */
function systemdWord(text: string): string {
  // `%` starts a specifier and `$` a variable in ExecStart, so both are doubled.
  return `"${text.replace(/[\\"]/g, (c) => `\\${c}`).replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

export interface UnitOptions {
  /** The program that runs the bridge: Node, or the desktop app's Electron acting as Node. */
  execPath: string;
  /** The bridge's script, such as ~/.uplink-room/npm/lib/node_modules/@uplink-room/bridge/dist/uplink-bridge.mjs. */
  script: string;
  /** The installing shell's PATH, so the bridge's terminals find claude, codex and the rest. */
  path: string;
  /** UPLINK_BRIDGE_HOME, when the bridge was paired with one. */
  bridgeHome?: string;
  /** Whether `execPath` is Electron, which runs a script only with ELECTRON_RUN_AS_NODE. */
  electron?: boolean;
}

export function unitFile(options: UnitOptions): string {
  const environment = [
    `PATH=${options.path}`,
    ...(options.bridgeHome ? [`UPLINK_BRIDGE_HOME=${options.bridgeHome}`] : []),
    ...(options.electron ? ["ELECTRON_RUN_AS_NODE=1"] : []),
  ];
  return [
    "# Written by `uplink-bridge service install`; `uplink-bridge service uninstall` removes it.",
    "[Unit]",
    "Description=Uplink Room bridge",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=${systemdWord(options.execPath)} ${systemdWord(options.script)} run`,
    ...environment.map((e) => `Environment=${systemdWord(e)}`),
    // The bridge exits with code 1 when it loses the room; it comes back on its own.
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function unitPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", SERVICE_NAME);
}

export interface ServiceContext {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: ServiceRunner;
  log?: (line: string) => void;
}

async function systemctl(run: ServiceRunner, ...args: string[]) {
  const result = await run("systemctl", ["--user", ...args]);
  if (result.code !== 0) {
    const said = (result.stderr || result.stdout).trim();
    throw new Error(
      `systemctl --user ${args.join(" ")} failed${said ? `: ${said}` : ""}. Run this in your own login session (ssh in as yourself, not sudo su), where systemd runs your user services.`,
    );
  }
  return result.stdout;
}

function requireLinux(platform: NodeJS.Platform) {
  if (platform !== "linux")
    throw new Error(
      "uplink-bridge service runs the bridge with systemd, on Linux. On macOS and Windows the desktop app keeps the bridge running; elsewhere keep uplink-bridge run going yourself.",
    );
}

/** Writes the unit, makes the user linger unless `linger` is false, then enables and starts the service. */
export async function installService(options: { linger: boolean; bridgeHome?: string }, context: ServiceContext = {}) {
  const env = context.env ?? process.env;
  const run = context.run ?? runCommand;
  const log = context.log ?? console.log;
  requireLinux(context.platform ?? process.platform);
  const script = await realpath(process.argv[1]!);
  const file = unitPath(env);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    unitFile({
      execPath: process.execPath,
      script,
      path: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      ...(options.bridgeHome ? { bridgeHome: options.bridgeHome } : {}),
      electron: Boolean(process.versions.electron),
    }),
  );
  log(`Wrote ${file}.`);
  await systemctl(run, "daemon-reload");
  await systemctl(run, "enable", SERVICE_NAME);
  // restart, not start, so installing again over a running service picks up the new unit.
  await systemctl(run, "restart", SERVICE_NAME);
  log("The bridge runs as a service now, and starts again whenever it stops or the machine boots.");

  if (options.linger) {
    const user = userInfo().username;
    const shown = await run("loginctl", ["show-user", user, "--property=Linger", "--value"]);
    if (shown.stdout.trim() !== "yes") {
      const enabled = await run("loginctl", ["enable-linger", user]);
      if (enabled.code !== 0) {
        log(
          `It still stops when you log out: systemd ends a user's services at logout unless the user lingers, and loginctl enable-linger was refused (${(enabled.stderr || enabled.stdout).trim() || `exit code ${enabled.code}`}). Run: sudo loginctl enable-linger ${user}`,
        );
      } else log(`Enabled lingering for ${user}, so the bridge keeps running after you log out.`);
    }
  }
  log("Logs: journalctl --user -u uplink-bridge -f. Status: uplink-bridge service status.");
}

/** Whether systemd runs the bridge's service now. */
export async function serviceActive(context: ServiceContext = {}): Promise<boolean> {
  if ((context.platform ?? process.platform) !== "linux") return false;
  const result = await (context.run ?? runCommand)("systemctl", ["--user", "is-active", "--quiet", SERVICE_NAME]);
  return result.code === 0;
}

export async function uninstallService(context: ServiceContext = {}) {
  const env = context.env ?? process.env;
  const run = context.run ?? runCommand;
  const log = context.log ?? console.log;
  requireLinux(context.platform ?? process.platform);
  // Already stopped or never installed: nothing to disable.
  await run("systemctl", ["--user", "disable", "--now", SERVICE_NAME]);
  await rm(unitPath(env), { force: true });
  await systemctl(run, "daemon-reload");
  log("Removed the bridge's service. The machine stays paired; uplink-bridge run starts the bridge by hand.");
}

export async function serviceStatus(context: ServiceContext = {}) {
  const run = context.run ?? runCommand;
  const log = context.log ?? console.log;
  requireLinux(context.platform ?? process.platform);
  // `status` exits 3 for a stopped service, which isn't a failure to report.
  const result = await run("systemctl", ["--user", "status", SERVICE_NAME, "--no-pager", "--lines=20"]);
  log((result.stdout || result.stderr).trimEnd() || `No ${SERVICE_NAME}. Install it with uplink-bridge service install.`);
}
