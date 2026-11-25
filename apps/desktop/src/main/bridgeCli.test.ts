import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import {
  installAppCommands,
  installBridgeCli,
  linkScript,
  linksScript,
  readAppCommands,
  loginShellPath,
  readBridgeCli,
  READ_PATHS_SCRIPT,
  runOsascript,
  runPowerShell,
  windowsStatus,
  WRITE_PATH_SCRIPT,
  type BridgeCliDeps,
} from "./bridgeCli";
import { launcherDirEntries, windowsKey, withLauncherFirst } from "./bridgeCliSpec";

/** Links, modes and shells behave as on macOS and Linux; Windows runs only its own tests. */
const unix = test.runIf(process.platform !== "win32");

/**
 * `uplink-bridge` on PATH, against temporary folders: a fake /usr/local/bin, a scripted login
 * shell and a mocked administrator prompt. Nothing here touches this computer's own PATH.
 */
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(join(root, "usr", "local"), 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

async function runnable(path: string, body = "#!/bin/sh\nexit 0\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, { mode: 0o755 });
}

/** A Mac in a temporary folder: the app in Applications, /usr/local/bin, and Homebrew's bin first on PATH. */
async function mac(extra: Partial<BridgeCliDeps> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "uplink cli ")));
  roots.push(root);
  const launcher = join(root, "Applications", "Uplink Room.app", "Contents", "Resources", "bin", "uplink-bridge");
  await runnable(launcher);
  const linkDir = join(root, "usr", "local", "bin");
  const brew = join(root, "opt", "homebrew", "bin");
  const osascript = vi.fn<BridgeCliDeps["osascript"]>(async () => {});
  const deps: BridgeCliDeps = {
    platform: "darwin",
    launcher,
    command: (onPath) => (onPath ? "uplink-bridge" : `'${launcher}'`),
    env: {},
    shellPath: async () => [brew, linkDir, "/usr/bin", "/bin"],
    defaultPath: async () => [linkDir, "/usr/bin", "/bin"],
    linkDir,
    osascript,
    powershell: async () => {
      throw new Error("not on Windows");
    },
    envKey: "Environment",
    exists: async () => false,
    appImage: false,
    ...extra,
  };
  return { root, launcher, linkDir, brew, link: join(linkDir, "uplink-bridge"), osascript, deps };
}

unix("macOS: with nothing on PATH, Add to PATH links /usr/local/bin/uplink-bridge without a prompt when the folder is writable", async () => {
  const m = await mac();
  await mkdir(m.linkDir, { recursive: true });
  const before = await readBridgeCli(m.deps);
  expect(before).toMatchObject({ state: "missing", command: `'${m.launcher}'`, install: { kind: "link", at: m.link, admin: false } });
  expect(before.install).not.toHaveProperty("replaces");

  const after = await installBridgeCli(m.deps);
  expect(after).toEqual({ platform: "darwin", launcher: m.launcher, state: "ours", found: m.link, runs: true, command: "uplink-bridge" });
  expect(await readlink(m.link)).toBe(m.launcher);
  expect(m.osascript).not.toHaveBeenCalled();
});

unix("macOS: a folder it can't write goes through the administrator prompt, which only makes the link where nothing is", async () => {
  const m = await mac();
  // /usr/local is root's: /usr/local/bin can't be made without an administrator.
  await mkdir(join(m.root, "usr", "local"), { recursive: true });
  await chmod(join(m.root, "usr", "local"), 0o555);
  expect((await readBridgeCli(m.deps)).install).toEqual({ kind: "link", at: m.link, admin: true });

  m.osascript.mockImplementationOnce(async (script, args) => {
    expect(script).toContain("with administrator privileges");
    expect(script).toContain("quoted form of item 1 of argv");
    expect(script).toContain("/bin/ln -s ");
    expect(script).not.toContain("ln -sf");
    expect(script).not.toContain(m.root);
    expect(args).toEqual([m.launcher, m.linkDir, m.link]);
    // What the prompt's root shell does.
    await chmod(join(m.root, "usr", "local"), 0o755);
    await mkdir(m.linkDir, { recursive: true });
    await symlink(m.launcher, m.link);
  });
  expect(await installBridgeCli(m.deps)).toMatchObject({ state: "ours", command: "uplink-bridge" });

  // Cancelling the prompt changes nothing and says so; so does a file that appeared while it was open.
  const n = await mac();
  await mkdir(join(n.root, "usr", "local"), { recursive: true });
  await chmod(join(n.root, "usr", "local"), 0o555);
  n.osascript.mockRejectedValueOnce(new Error("0:180: execution error: User canceled. (-128)"));
  await expect(installBridgeCli(n.deps)).rejects.toThrow("Nothing changed: the administrator prompt was cancelled.");
  n.osascript.mockRejectedValueOnce(new Error("7:98: execution error: The command exited with a non-zero status. (17)"));
  await expect(installBridgeCli(n.deps)).rejects.toThrow(`Something appeared at ${n.link} meanwhile, so the app left it alone. Nothing changed.`);
  expect((await readBridgeCli(n.deps)).state).toBe("missing");
});

unix("macOS: anything at /usr/local/bin/uplink-bridge that isn't a copy of Uplink Room is reported, and never replaced", async () => {
  const m = await mac();
  await mkdir(m.linkDir, { recursive: true });
  const occupied = { kind: "none", why: "occupied" };

  // A file that isn't executable: no terminal runs it, but it is there.
  await writeFile(m.link, "notes\n", { mode: 0o644 });
  expect(await readBridgeCli(m.deps)).toMatchObject({ state: "other", found: m.link, runs: false, install: occupied });
  await expect(installBridgeCli(m.deps)).rejects.toThrow(/can't put/);
  expect(await readFile(m.link, "utf8")).toBe("notes\n");
  await rm(m.link);

  // A folder, and a link to something that isn't Uplink Room's and isn't there.
  await mkdir(m.link);
  expect(await readBridgeCli(m.deps)).toMatchObject({ state: "other", runs: false, install: occupied });
  await rm(m.link, { recursive: true });
  await symlink("/opt/someone-else/uplink-bridge", m.link);
  expect(await readBridgeCli(m.deps)).toMatchObject({ state: "other", target: "/opt/someone-else/uplink-bridge", runs: false, install: occupied });
  await rm(m.link);

  // A bridge installed with npm, linked into /usr/local/bin by npm itself.
  const npm = join(m.root, "usr", "local", "lib", "node_modules", "@uplink-room", "bridge", "dist", "uplink-bridge.mjs");
  await runnable(npm);
  await symlink(npm, m.link);
  expect(await readBridgeCli(m.deps)).toMatchObject({ state: "other", found: m.link, target: npm, runs: true, install: occupied });
  await expect(installBridgeCli(m.deps)).rejects.toThrow(/can't put/);
  expect(await readlink(m.link)).toBe(npm);

  // The same bridge under Homebrew's prefix comes first on PATH: a link in /usr/local/bin wouldn't win.
  await runnable(join(m.brew, "uplink-bridge"));
  expect(await readBridgeCli(m.deps)).toMatchObject({ state: "other", found: join(m.brew, "uplink-bridge"), install: { kind: "none", why: "shadowed" } });

  // A shell whose PATH leaves /usr/local/bin out, and one that couldn't be read (the default PATH then).
  const n = await mac({ shellPath: async () => ["/usr/bin", "/bin"] });
  expect((await readBridgeCli(n.deps)).install).toEqual({ kind: "none", why: "folder-not-on-path" });
  const o = await mac({ shellPath: async () => null });
  expect(await readBridgeCli(o.deps)).toMatchObject({ state: "missing", install: { kind: "link" } });
});

unix("macOS: a link to another copy of Uplink Room is replaced through Use this app's, only while it still reads the same", async () => {
  const m = await mac();
  await mkdir(m.linkDir, { recursive: true });
  const gone = join(m.root, "Volumes", "Uplink Room", "Uplink Room.app", "Contents", "Resources", "bin", "uplink-bridge");
  await symlink(gone, m.link);
  expect(await readBridgeCli(m.deps)).toMatchObject({
    state: "stale",
    found: m.link,
    target: gone,
    runs: false,
    install: { kind: "link", admin: false, replaces: gone },
  });
  expect(await installBridgeCli(m.deps)).toMatchObject({ state: "ours" });

  // The link changes between the install's own check and the replacement: it's left as it now is.
  // `command` runs inside that check, after the entry was read, so the change lands in between.
  const n = await mac();
  await mkdir(n.linkDir, { recursive: true });
  await symlink(join(n.root, "Old", "Uplink Room.app", "Contents", "Resources", "bin", "uplink-bridge"), n.link);
  let moved = false;
  const racing: BridgeCliDeps = {
    ...n.deps,
    command: (onPath) => {
      if (!moved) {
        moved = true;
        rmSync(n.link);
        symlinkSync("/opt/someone-else/uplink-bridge", n.link);
      }
      return n.deps.command(onPath);
    },
  };
  await expect(installBridgeCli(racing)).rejects.toThrow(`${n.link} changed meanwhile, so the app left it alone. Nothing changed.`);
  expect(await readlink(n.link)).toBe("/opt/someone-else/uplink-bridge");
});

unix("macOS: Add to PATH never replaces a file that appeared after the check", async () => {
  const m = await mac();
  await mkdir(m.linkDir, { recursive: true });
  let appeared = false;
  const racing: BridgeCliDeps = {
    ...m.deps,
    command: (onPath) => {
      if (!appeared) {
        appeared = true;
        writeFileSync(m.link, "mine\n");
      }
      return m.deps.command(onPath);
    },
  };
  await expect(installBridgeCli(racing)).rejects.toThrow(`Something appeared at ${m.link} meanwhile, so the app left it alone. Nothing changed.`);
  expect(await readFile(m.link, "utf8")).toBe("mine\n");
});

unix("an empty or relative folder first on PATH makes the plain command depend on the terminal's folder, so the full path stays", async () => {
  for (const first of ["", "bin", "./tools"]) {
    let linkDir = "";
    const m = await mac({ shellPath: async () => [first, linkDir, "/usr/bin"] });
    linkDir = m.linkDir;
    await mkdir(m.linkDir, { recursive: true });
    await symlink(m.launcher, m.link);
    expect(await readBridgeCli(m.deps), JSON.stringify(first)).toEqual({
      platform: "darwin",
      launcher: m.launcher,
      state: "ours",
      found: m.link,
      runs: true,
      relativeFirst: true,
      command: `'${m.launcher}'`,
    });
  }
  // After the link, a relative folder changes nothing.
  let linkDir = "";
  const m = await mac({ shellPath: async () => [linkDir, "", "/usr/bin"] });
  linkDir = m.linkDir;
  await mkdir(m.linkDir, { recursive: true });
  await symlink(m.launcher, m.link);
  const status = await readBridgeCli(m.deps);
  expect(status).toMatchObject({ state: "ours", command: "uplink-bridge" });
  expect(status).not.toHaveProperty("relativeFirst");
});

test.runIf(process.platform === "darwin")("the link scripts run in osascript: create stops at anything there, replace only while the link reads the same", async () => {
  const m = await mac();
  const dir = join(m.root, "it's a \"bin\" folder");
  const link = join(dir, "uplink-bridge");
  await runOsascript(linkScript("create", false), [m.launcher, dir, link]);
  expect(await readlink(link)).toBe(m.launcher);
  // Something there already: exit 17, and it stays.
  const taken = join(dir, "taken");
  await writeFile(taken, "mine\n");
  await expect(runOsascript(linkScript("create", false), [m.launcher, dir, taken])).rejects.toThrow("(17)");
  expect(await readFile(taken, "utf8")).toBe("mine\n");
  // Replace: only while the link reads what the app saw.
  const other = join(dir, "other copy");
  await symlink("/Old/Uplink Room.app/Contents/Resources/bin/uplink-bridge", other);
  await expect(runOsascript(linkScript("replace", false), [m.launcher, other, "/somewhere else"])).rejects.toThrow("(18)");
  expect(await readlink(other)).toBe("/Old/Uplink Room.app/Contents/Resources/bin/uplink-bridge");
  await runOsascript(linkScript("replace", false), [m.launcher, other, "/Old/Uplink Room.app/Contents/Resources/bin/uplink-bridge"]);
  expect(await readlink(other)).toBe(m.launcher);
});

test.runIf(process.platform !== "win32")("the login shell's PATH is read past what its startup files print, empty entries kept, and a shell that hangs gives up", async () => {
  const m = await mac();
  const shell = join(m.root, "fake-shell");
  // Arguments: -l -i -c <command>, as a login, interactive shell gets them.
  await runnable(shell, '#!/bin/sh\necho "Last login: today"\nPATH="/x/bin:/opt/y bin:"\nexport PATH\neval "$4"\necho "bye"\n');
  expect(await loginShellPath({ SHELL: shell })).toEqual(["/x/bin", "/opt/y bin", ""]);

  const slow = join(m.root, "slow-shell");
  await runnable(slow, "#!/bin/sh\nexec sleep 10\n");
  expect(await loginShellPath({ SHELL: slow }, 300)).toBeNull();
});

unix("Linux: the .deb's link is the app's; otherwise the app says how instead of changing it, and an AppImage can't at all", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "uplink cli ")));
  roots.push(root);
  const launcher = join(root, "opt", "Uplink Room", "resources", "bin", "uplink-bridge");
  await runnable(launcher);
  const usrBin = join(root, "usr", "bin");
  await mkdir(usrBin, { recursive: true });
  const deps: BridgeCliDeps = {
    platform: "linux",
    launcher,
    command: (onPath) => (onPath ? "uplink-bridge" : `'${launcher}'`),
    env: {},
    shellPath: async () => [join(root, "usr", "local", "bin"), usrBin],
    defaultPath: async () => [],
    linkDir: usrBin,
    osascript: async () => {},
    powershell: async () => "",
    envKey: "Environment",
    exists: async () => false,
    appImage: false,
  };
  // Without -f: ln stops if something is already there.
  expect(await readBridgeCli(deps)).toMatchObject({
    state: "missing",
    install: { kind: "none", why: "package", manual: `sudo ln -s '${launcher}' /usr/local/bin/uplink-bridge` },
  });
  await expect(installBridgeCli(deps)).rejects.toThrow(/can't put/);
  // What the package's post-install makes.
  await symlink(launcher, join(usrBin, "uplink-bridge"));
  expect(await readBridgeCli(deps)).toMatchObject({ state: "ours", command: "uplink-bridge" });
  await rm(join(usrBin, "uplink-bridge"));
  expect((await readBridgeCli({ ...deps, appImage: true })).install).toEqual({ kind: "none", why: "appimage" });
});

const WIN_LAUNCHER = "C:\\Users\\Ana\\AppData\\Local\\Programs\\Uplink Room\\resources\\bin\\uplink-bridge.cmd";
const WIN_DIR = win32.dirname(WIN_LAUNCHER);
const WIN_ENV = {
  USERPROFILE: "C:\\Users\\Ana",
  APPDATA: "C:\\Users\\Ana\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\Ana\\AppData\\Local",
  TOOL_DIRS: "C:\\Tools;D:\\Tools",
};

test("Windows: cleanup drops only literal entries that are exactly a dead copy of Uplink Room's folder; a %VAR% entry always stays", () => {
  const gone = "D:\\Gone\\Uplink Room\\resources\\bin";
  const live = "D:\\Live\\Uplink Room\\resources\\bin";
  const raw = [
    "%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps",
    "",
    `${gone}\\`,
    live,
    "%TOOL_DIRS%",
    "%LOCALAPPDATA%\\Programs\\Uplink Room\\resources\\bin",
    WIN_DIR,
    "C:\\%TOOLS%\\bin",
  ].join(";");
  expect(withLauncherFirst(raw, WIN_DIR, new Set([windowsKey(gone)]))).toBe(
    [
      WIN_DIR,
      "%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps",
      live,
      "%TOOL_DIRS%",
      "%LOCALAPPDATA%\\Programs\\Uplink Room\\resources\\bin",
      "C:\\%TOOLS%\\bin",
    ].join(";"),
  );
  expect(launcherDirEntries(raw)).toEqual([`${gone}\\`, live, WIN_DIR]);
  expect(withLauncherFirst(null, WIN_DIR, new Set())).toBe(WIN_DIR);
});

function windows(files: string[], powershell: BridgeCliDeps["powershell"] = async () => "") {
  const present = new Set(files.map((f) => f.toLowerCase()));
  const deps: BridgeCliDeps = {
    platform: "win32",
    launcher: WIN_LAUNCHER,
    command: (onPath) => (onPath ? "uplink-bridge" : `& '${WIN_LAUNCHER}'`),
    env: WIN_ENV,
    shellPath: async () => null,
    defaultPath: async () => [],
    linkDir: "",
    osascript: async () => {},
    powershell,
    envKey: "Environment",
    exists: async (path) => present.has(path.toLowerCase()),
    appImage: false,
  };
  return deps;
}

test("Windows: a new terminal runs the first uplink-bridge in the system's PATH, then the user's", async () => {
  const npm = "C:\\Users\\Ana\\AppData\\Roaming\\npm\\uplink-bridge.cmd";
  const old = "D:\\Old\\Uplink Room\\resources\\bin\\uplink-bridge.cmd";
  const deps = windows([WIN_LAUNCHER, npm, old]);
  const system = "C:\\Windows\\system32;C:\\Windows";
  const user = (value: string | null) => ({ machine: system, machineKind: "ExpandString", user: value, userKind: "ExpandString" });
  expect(await windowsStatus(deps, user(`%LOCALAPPDATA%\\Programs\\Uplink Room\\resources\\bin\\;%APPDATA%\\npm`))).toMatchObject({
    state: "ours",
    command: "uplink-bridge",
  });
  expect(await windowsStatus(deps, user(`%APPDATA%\\npm;${WIN_DIR}`))).toMatchObject({
    state: "other",
    found: npm,
    install: { kind: "user-path", at: WIN_DIR },
  });
  expect(await windowsStatus(deps, { ...user(WIN_DIR), machine: `${system};D:\\Old\\Uplink Room\\resources\\bin` })).toMatchObject({
    state: "stale",
    found: old,
    install: { kind: "none", why: "shadowed" },
  });
  expect(await windowsStatus(deps, user(null))).toMatchObject({ state: "missing", command: `& '${WIN_LAUNCHER}'` });
});

test("Windows: a folder not named in full before the launcher's makes the plain command depend on PowerShell's folder; empty entries don't", async () => {
  const deps = windows([WIN_LAUNCHER]);
  const user = (value: string) => ({ machine: "C:\\Windows\\system32;", machineKind: "ExpandString", user: value, userKind: "ExpandString" });
  for (const first of ["tools", ".\\tools", "C:tools", "\\tools", "   "]) {
    expect(await windowsStatus(deps, user(`${first};${WIN_DIR}`)), JSON.stringify(first)).toMatchObject({
      state: "ours",
      relativeFirst: true,
      command: `& '${WIN_LAUNCHER}'`,
    });
  }
  // In the system's PATH too, which comes first.
  expect(await windowsStatus(deps, { ...user(WIN_DIR), machine: "C:\\Windows;bin" })).toMatchObject({ relativeFirst: true });
  // PowerShell skips empty entries (a trailing ;), and a UNC folder is named in full.
  const plain = await windowsStatus(deps, user(`;;\\\\server\\share\\tools;${WIN_DIR};`));
  expect(plain).toMatchObject({ state: "ours", command: "uplink-bridge" });
  expect(plain).not.toHaveProperty("relativeFirst");
  // After the launcher's folder, one not named in full changes nothing.
  expect(await windowsStatus(deps, user(`${WIN_DIR};tools`))).not.toHaveProperty("relativeFirst");
});

test("Windows: an expandable PATH is expanded before it's split, so a variable holding two folders is searched as two; REG_SZ isn't expanded", async () => {
  const second = "D:\\Tools\\uplink-bridge.cmd";
  const deps = windows([second]);
  expect(await windowsStatus(deps, { machine: null, user: "%TOOL_DIRS%", userKind: "ExpandString" })).toMatchObject({ state: "other", found: second });
  expect(await windowsStatus(deps, { machine: null, user: "%TOOL_DIRS%", userKind: "String" })).toMatchObject({ state: "missing" });
  // The system's value the same way.
  expect(await windowsStatus(deps, { machine: "%TOOL_DIRS%", machineKind: "ExpandString", user: null })).toMatchObject({
    state: "other",
    install: { kind: "none", why: "shadowed" },
  });
});

/** A fake registry behind the PowerShell scripts: one user PATH value and its type. */
function registry(start: { user: string | null; userKind: string | null }) {
  const now = { ...start };
  const writes: Record<string, string>[] = [];
  const deps = windows([WIN_LAUNCHER], async (script, env) => {
    expect(env["UPLINK_ENV_KEY"]).toBe("Environment");
    if (script === READ_PATHS_SCRIPT) return JSON.stringify({ ...now, machine: "C:\\Windows\\system32", machineKind: "ExpandString" });
    expect(script).toBe(WRITE_PATH_SCRIPT);
    writes.push(env);
    now.user = env["UPLINK_PATH_AFTER"]!;
    now.userKind = env["UPLINK_PATH_KIND"]!;
    return "";
  });
  return { deps, writes };
}

test("Windows: Add to PATH writes back what it read with the launcher first, keeping the value's registry type", async () => {
  const expandable = registry({ user: "%APPDATA%\\npm", userKind: "ExpandString" });
  expect(await installBridgeCli(expandable.deps)).toMatchObject({ state: "ours" });
  expect(expandable.writes).toEqual([
    {
      UPLINK_ENV_KEY: "Environment",
      UPLINK_PATH_HAD: "1",
      UPLINK_PATH_BEFORE: "%APPDATA%\\npm",
      UPLINK_PATH_KIND: "ExpandString",
      UPLINK_PATH_AFTER: `${WIN_DIR};%APPDATA%\\npm`,
    },
  ]);
  // A REG_SZ PATH stays REG_SZ, % and all.
  const plain = registry({ user: "C:\\%TOOLS%\\bin", userKind: "String" });
  await installBridgeCli(plain.deps);
  expect(plain.writes[0]).toMatchObject({ UPLINK_PATH_KIND: "String", UPLINK_PATH_AFTER: `${WIN_DIR};C:\\%TOOLS%\\bin` });
  // A copy of Uplink Room whose launcher is gone leaves; one still there, and a variable, stay.
  const copies = registry({ user: "D:\\Gone\\Uplink Room\\resources\\bin;D:\\Live\\Uplink Room\\resources\\bin;%TOOL_DIRS%", userKind: "ExpandString" });
  const present = new Set([WIN_LAUNCHER, "D:\\Live\\Uplink Room\\resources\\bin\\uplink-bridge.cmd"].map((f) => f.toLowerCase()));
  await installBridgeCli({ ...copies.deps, exists: async (path) => present.has(path.toLowerCase()) });
  expect(copies.writes[0]!["UPLINK_PATH_AFTER"]).toBe(`${WIN_DIR};D:\\Live\\Uplink Room\\resources\\bin;%TOOL_DIRS%`);
  // No PATH yet: Windows' own type for one.
  const none = registry({ user: null, userKind: null });
  await installBridgeCli(none.deps);
  expect(none.writes[0]).toMatchObject({ UPLINK_PATH_HAD: "0", UPLINK_PATH_KIND: "ExpandString", UPLINK_PATH_AFTER: WIN_DIR });
});

test.runIf(process.platform === "win32")("Windows: the PowerShell scripts keep %VARS% and each value's type, and refuse a PATH that changed meanwhile", async () => {
  // A throwaway key under HKCU instead of Environment, so the runner's own PATH is never touched.
  const key = `Software\\UplinkRoomTest-${process.pid}-${Date.now()}`;
  const ps = (script: string, env: Record<string, string> = {}) => runPowerShell(script, { UPLINK_ENV_KEY: key, ...env });
  const set = (value: string, kind: string) =>
    ps(`$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($env:UPLINK_ENV_KEY); $k.SetValue('Path', '${value}', '${kind}'); $k.Close()`);
  const read = async () => JSON.parse(await ps(READ_PATHS_SCRIPT)) as { user: string; userKind: string };
  try {
    const deps: BridgeCliDeps = { ...windows([], (script, env) => ps(script, env)), envKey: key, exists: async () => false, env: process.env };
    await set("%SystemRoot%\\Temp;C:\\Tools", "ExpandString");
    expect(await readBridgeCli(deps)).toMatchObject({ state: "missing" });
    expect(await installBridgeCli(deps)).toMatchObject({ state: "ours" });
    expect(await read()).toMatchObject({ user: `${WIN_DIR};%SystemRoot%\\Temp;C:\\Tools`, userKind: "ExpandString" });

    await expect(
      ps(WRITE_PATH_SCRIPT, { UPLINK_PATH_HAD: "1", UPLINK_PATH_BEFORE: "C:\\Tools", UPLINK_PATH_KIND: "ExpandString", UPLINK_PATH_AFTER: "C:\\Elsewhere" }),
    ).rejects.toThrow("Your PATH changed while the app was reading it. Try again.");
    expect((await read()).user).toBe(`${WIN_DIR};%SystemRoot%\\Temp;C:\\Tools`);

    await set("C:\\%TOOLS%\\bin", "String");
    await installBridgeCli(deps);
    expect(await read()).toEqual({ user: `${WIN_DIR};C:\\%TOOLS%\\bin`, userKind: "String", machine: expect.any(String), machineKind: expect.any(String) });
  } finally {
    await ps(`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($env:UPLINK_ENV_KEY, $false)`).catch(() => {});
  }
}, 60_000);

// ---------- uplink and uplink-mcp beside the bridge (ADR 0042) ----------

/** A Mac with all three launchers in the app. */
async function macWithTools(extra: Partial<BridgeCliDeps> = {}) {
  const m = await mac(extra);
  for (const name of ["uplink", "uplink-mcp"]) await runnable(join(dirname(m.launcher), name));
  const at = (name: string) => join(m.linkDir, name);
  const launcherOf = (name: string) => join(dirname(m.launcher), name);
  return { ...m, at, launcherOf };
}

unix("macOS: Add to PATH links uplink-bridge, uplink and uplink-mcp in one step", async () => {
  const m = await macWithTools();
  await mkdir(m.linkDir, { recursive: true });
  const before = await readAppCommands(m.deps);
  expect(before).toMatchObject({ state: "missing", install: { kind: "link", at: m.at("uplink-bridge"), admin: false } });
  expect(before.tools).toEqual([
    { name: "uplink", launcher: m.launcherOf("uplink"), state: "missing", install: { kind: "link", at: m.at("uplink"), admin: false } },
    { name: "uplink-mcp", launcher: m.launcherOf("uplink-mcp"), state: "missing", install: { kind: "link", at: m.at("uplink-mcp"), admin: false } },
  ]);

  const after = await installAppCommands(m.deps);
  expect(after).toMatchObject({ state: "ours", command: "uplink-bridge" });
  expect(after.tools?.map((t) => [t.name, t.state, t.found])).toEqual([
    ["uplink", "ours", m.at("uplink")],
    ["uplink-mcp", "ours", m.at("uplink-mcp")],
  ]);
  for (const name of ["uplink-bridge", "uplink", "uplink-mcp"]) expect(await readlink(m.at(name))).toBe(m.launcherOf(name));
  expect(m.osascript).not.toHaveBeenCalled();
  // Nothing left to do: a second click changes nothing.
  expect(await installAppCommands(m.deps)).toEqual(after);
});

unix("macOS: with the bridge on PATH from an earlier version, Add to PATH adds only uplink and uplink-mcp, through one administrator prompt", async () => {
  const m = await macWithTools();
  await mkdir(m.linkDir, { recursive: true });
  await symlink(m.launcher, m.at("uplink-bridge"));
  await chmod(m.linkDir, 0o555);
  onTestFinished(() => chmod(m.linkDir, 0o755).catch(() => {}));
  const before = await readAppCommands(m.deps);
  expect(before.state).toBe("ours");
  expect(before.tools?.map((t) => t.install)).toEqual([
    { kind: "link", at: m.at("uplink"), admin: true },
    { kind: "link", at: m.at("uplink-mcp"), admin: true },
  ]);
  m.osascript.mockImplementationOnce(async (script, args) => {
    expect(script).toBe(linksScript(["create", "create"]));
    expect(script).toContain("with administrator privileges");
    expect(script).not.toContain(m.root);
    expect(args).toEqual([m.linkDir, m.launcherOf("uplink"), m.at("uplink"), "", m.launcherOf("uplink-mcp"), m.at("uplink-mcp"), ""]);
    await chmod(m.linkDir, 0o755);
    await symlink(m.launcherOf("uplink"), m.at("uplink"));
    await symlink(m.launcherOf("uplink-mcp"), m.at("uplink-mcp"));
  });
  const after = await installAppCommands(m.deps);
  expect(m.osascript).toHaveBeenCalledTimes(1);
  expect(after.tools?.every((t) => t.state === "ours")).toBe(true);

  // Cancelling the one prompt changes nothing and says so.
  const n = await macWithTools();
  await mkdir(join(n.root, "usr", "local"), { recursive: true });
  await chmod(join(n.root, "usr", "local"), 0o555);
  n.osascript.mockRejectedValueOnce(new Error("0:180: execution error: User canceled. (-128)"));
  await expect(installAppCommands(n.deps)).rejects.toThrow("Nothing changed: the administrator prompt was cancelled.");
  expect(n.osascript.mock.calls[0]![0]).toBe(linksScript(["create", "create", "create"]));
});

unix("macOS: an uplink that isn't the app's (npm link from a checkout) stays, and the other two are still linked", async () => {
  const m = await macWithTools();
  await mkdir(m.linkDir, { recursive: true });
  const checkout = join(m.root, "src", "uplink-room", "packages", "room-client", "src", "cli.ts");
  await runnable(checkout, "#!/usr/bin/env node\n");
  await symlink(checkout, m.at("uplink"));
  const before = await readAppCommands(m.deps);
  expect(before.tools?.[0]).toMatchObject({ name: "uplink", state: "other", target: checkout, runs: true, install: { kind: "none", why: "occupied" } });
  const after = await installAppCommands(m.deps);
  expect(await readlink(m.at("uplink"))).toBe(checkout);
  expect(after.state).toBe("ours");
  expect(after.tools?.map((t) => t.state)).toEqual(["other", "ours"]);
  // Only uplink is left, and the app can't place it: it says so.
  await expect(installAppCommands(m.deps)).rejects.toThrow("The app can't put uplink on PATH here.");
});

test.runIf(process.platform === "darwin")("macOS: the several-links script checks every link before it makes any (run by osascript, without the prompt)", async () => {
  const m = await macWithTools();
  await mkdir(m.linkDir, { recursive: true });
  const old = "/Volumes/Uplink Room/Uplink Room.app/Contents/Resources/bin/uplink";
  await symlink(old, m.at("uplink"));
  const args = [m.linkDir, m.launcherOf("uplink"), m.at("uplink"), old, m.launcherOf("uplink-mcp"), m.at("uplink-mcp"), ""];
  await runOsascript(linksScript(["replace", "create"], false), args);
  expect(await readlink(m.at("uplink"))).toBe(m.launcherOf("uplink"));
  expect(await readlink(m.at("uplink-mcp"))).toBe(m.launcherOf("uplink-mcp"));
  // The old link changed meanwhile: exit 18, and the link that was still free isn't made either.
  await rm(m.at("uplink-mcp"));
  await expect(runOsascript(linksScript(["replace", "create"], false), args)).rejects.toThrow("(18)");
  await expect(readlink(m.at("uplink-mcp"))).rejects.toThrow();
  // Something appeared where nothing was: exit 17.
  await writeFile(m.at("uplink-mcp"), "x");
  await expect(runOsascript(linksScript(["create"], false), [m.linkDir, m.launcherOf("uplink-mcp"), m.at("uplink-mcp"), ""])).rejects.toThrow("(17)");
});

unix("Linux: the .deb links all three; otherwise the app shows the command for each", async () => {
  const m = await macWithTools({ platform: "linux" });
  const status = await readAppCommands(m.deps);
  expect(status.tools?.map((t) => t.install)).toEqual([
    { kind: "none", why: "package", manual: `sudo ln -s '${m.launcherOf("uplink")}' /usr/local/bin/uplink` },
    { kind: "none", why: "package", manual: `sudo ln -s '${m.launcherOf("uplink-mcp")}' /usr/local/bin/uplink-mcp` },
  ]);
});

test("Windows: the bin folder on PATH runs all three; Add to PATH writes it once", async () => {
  const r = registry({ user: "%APPDATA%\\npm", userKind: "ExpandString" });
  const before = await readAppCommands(r.deps);
  expect(before.state).toBe("missing");
  expect(before.tools?.map((t) => [t.name, t.launcher, t.install])).toEqual([
    ["uplink", win32.join(WIN_DIR, "uplink.cmd"), { kind: "user-path", at: WIN_DIR }],
    ["uplink-mcp", win32.join(WIN_DIR, "uplink-mcp.cmd"), { kind: "user-path", at: WIN_DIR }],
  ]);
  const after = await installAppCommands(r.deps);
  expect(r.writes).toHaveLength(1);
  expect(after.tools?.map((t) => [t.state, t.found])).toEqual([
    ["ours", win32.join(WIN_DIR, "uplink.cmd")],
    ["ours", win32.join(WIN_DIR, "uplink-mcp.cmd")],
  ]);
});
