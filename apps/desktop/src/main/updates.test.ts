import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { net } from "electron";
import electronUpdater, { type UpdateInfo } from "electron-updater";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { sha512OfFile, signatureFile, signUpdate } from "./updateSignature.ts";
import { Updates } from "./updates.ts";

/**
 * updates.ts against a stand-in for electron-updater 6.8.10 that does what its download paths do
 * (out/AppUpdater.js executeDownload, out/BaseUpdater.js): "update-downloaded" for a fresh download
 * and for a cached file alike, then the install-on-quit handler, added only while
 * `autoInstallOnAppQuit` is on and read again at quit. The update key here is a throwaway one.
 */

const key = await vi.hoisted(async () => {
  const { createHash, generateKeyPairSync } = await import("node:crypto");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x!;
  return {
    secret: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    id: createHash("sha256").update(Buffer.from(x, "base64url")).digest("hex").slice(0, 16),
    x,
  };
});

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: { isPackaged: true, getVersion: () => "0.2.0" },
    autoUpdater: Object.assign(new EventEmitter(), { checkForUpdates: () => undefined }),
    BrowserWindow: { getAllWindows: () => [] },
    net: { fetch: vi.fn() },
  };
});
vi.mock("electron-updater", () => ({ default: { autoUpdater: null } }));
vi.mock("./telemetry", () => ({ reportError: vi.fn() }));
vi.mock("./log", () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./updateSignature.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./updateSignature.ts")>();
  return {
    ...real,
    verifyDownloadedUpdate: (options: Parameters<typeof real.verifyDownloadedUpdate>[0]) =>
      real.verifyDownloadedUpdate({ ...options, keys: { [key.id]: key.x } }),
  };
});

const FEED = "https://uplinkroom.com/updates";

/** electron-updater's autoUpdater, as far as updates.ts uses it. */
class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  disableWebInstaller = false;
  isUpdateSupported: (info: UpdateInfo) => boolean | Promise<boolean> = () => true;
  /** Whether checkForUpdates asks isUpdateSupported, as 6.8.10 does. */
  asksSupported = true;
  /** What the feed offers. */
  feed!: UpdateInfo;
  /** What downloadUpdate() does. */
  download: () => Promise<unknown> = () => new Promise(() => {});
  /** BaseUpdater: the file install() runs, and whether its quit handler is in. */
  installerPath: string | null = null;
  quitHandlerAdded = false;
  checkForUpdates = vi.fn(async () => {
    const info = this.feed;
    const supported = this.asksSupported ? await this.isUpdateSupported(info) : true;
    return { isUpdateAvailable: info.version !== "0.2.0" && supported, updateInfo: info };
  });
  downloadUpdate = vi.fn(() => this.download());
  quitAndInstall = vi.fn();
  /** NsisUpdater's: null (passes) without a publisherName. The cached path never calls it. */
  async verifySignature(_file: string): Promise<string | null> {
    return null;
  }
  addQuitHandler() {
    if (this.quitHandlerAdded || !this.autoInstallOnAppQuit) return;
    this.quitHandlerAdded = true;
  }
  /** Whether quitting now would run the installer. */
  get installsOnQuit() {
    return this.quitHandlerAdded && this.autoInstallOnAppQuit;
  }
  /** BaseUpdater.executeDownload's done(): fresh or cached, the same two steps. */
  downloaded(file: string, info: UpdateInfo = this.feed) {
    this.installerPath = file;
    this.emit("update-downloaded", { ...info, downloadedFile: file });
    this.addQuitHandler();
  }
}

let fake: FakeUpdater;
/** The `.sig` files on the feed, by URL; a gate holds a fetch until the test opens it. */
const published = new Map<string, string>();
const gates = new Map<string, Promise<void>>();
const dir = mkdtempSync(join(tmpdir(), "uplink-updates-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  fake = new FakeUpdater();
  (electronUpdater as unknown as { autoUpdater: FakeUpdater }).autoUpdater = fake;
  published.clear();
  gates.clear();
  vi.mocked(net.fetch).mockImplementation(async (input) => {
    const url = String(input);
    await gates.get(url);
    const text = published.get(url);
    return new Response(text ?? "", { status: text === undefined ? 404 : 200 });
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** An installer on disk, as electron-updater left it, and its sha512. */
async function installer(name: string, bytes: string) {
  const path = join(dir, `${Math.random().toString(36).slice(2)}-${name}`);
  writeFileSync(path, bytes);
  return { path, sha512: await sha512OfFile(path) };
}

/** Publishes `<file>.sig` in a channel's folder, signed for `signed` (by default, what it sits beside). */
function sign(
  folder: string,
  file: string,
  sha512: string,
  signed: { channel: string; version: string },
) {
  const signature = signUpdate(key.secret, { ...signed, file, sha512 });
  published.set(`${FEED}/${folder}/${file}.sig`, signatureFile([signature]));
}

function offer(version: string, files: { url: string; sha512: string }[]): UpdateInfo {
  return { version, files, path: files[0]!.url, sha512: files[0]!.sha512, releaseDate: "" };
}

function hold(url: string) {
  let open!: () => void;
  gates.set(url, new Promise<void>((resolve) => (open = resolve)));
  return () => open();
}

test("a cached Windows installer advertised under a higher version doesn't install", async () => {
  // 0.2.1, properly signed, is in electron-updater's cache from an earlier download. Someone with
  // the store's write token puts its sha512 in the feed as 9.9.9. electron-updater accepts the
  // cached file by its sha512 and calls done(false) without NsisUpdater.verifySignature.
  const cached = await installer("Uplink-Room-Setup-0.2.1-x64.exe", "the 0.2.1 installer");
  sign("latest", "Uplink-Room-Setup-0.2.1-x64.exe", cached.sha512, {
    channel: "latest",
    version: "0.2.1",
  });
  fake.feed = offer("9.9.9", [{ url: "Uplink-Room-Setup-0.2.1-x64.exe", sha512: cached.sha512 }]);
  let installsAtDownload: boolean | null = null;
  fake.download = async () => {
    fake.downloaded(cached.path);
    installsAtDownload = fake.installsOnQuit;
    return [cached.path];
  };
  const updates = new Updates("win32");
  updates.start();

  await vi.waitFor(() => expect(updates.current.phase).toBe("failed"));
  expect(updates.current.failure).toBe("signature");
  expect(installsAtDownload).toBe(false);
  expect(fake.installsOnQuit).toBe(false);
  expect(updates.restart()).toBe(false);
  expect(existsSync(cached.path)).toBe(false);
});

test("a signed Windows update installs on quit only once its signature has checked out", async () => {
  const file = await installer("Uplink-Room-Setup-0.2.1-x64.exe", "the 0.2.1 installer");
  sign("latest", "Uplink-Room-Setup-0.2.1-x64.exe", file.sha512, {
    channel: "latest",
    version: "0.2.1",
  });
  fake.feed = offer("0.2.1", [{ url: "Uplink-Room-Setup-0.2.1-x64.exe", sha512: file.sha512 }]);
  const open = hold(`${FEED}/latest/Uplink-Room-Setup-0.2.1-x64.exe.sig`);
  fake.download = async () => {
    fake.downloaded(file.path);
    return [file.path];
  };
  const updates = new Updates("win32");
  updates.start();

  await vi.waitFor(() => expect(updates.current.phase).toBe("preparing"));
  expect(fake.installsOnQuit).toBe(false);
  open();
  await vi.waitFor(() => expect(updates.current.phase).toBe("ready"));
  expect(updates.current.next).toBe("0.2.1");
  expect(fake.installsOnQuit).toBe(true);
});

test("a check left over from a failed attempt can't let a newer, unchecked AppImage install", async () => {
  vi.stubEnv("APPIMAGE", "/home/a/Uplink-Room.AppImage");
  // Attempt A: 0.2.1 downloads, "update-downloaded" fires, then copying the blockmap fails, so
  // the download rejects while A's signature check is still waiting on the network.
  const a = await installer("Uplink-Room-0.2.1-linux-x86_64.AppImage", "the 0.2.1 AppImage");
  sign("latest", "Uplink-Room-0.2.1-linux-x86_64.AppImage", a.sha512, {
    channel: "latest",
    version: "0.2.1",
  });
  fake.feed = offer("0.2.1", [
    { url: "Uplink-Room-0.2.1-linux-x86_64.AppImage", sha512: a.sha512 },
  ]);
  const openA = hold(`${FEED}/latest/Uplink-Room-0.2.1-linux-x86_64.AppImage.sig`);
  fake.download = async () => {
    fake.downloaded(a.path);
    const error = Object.assign(new Error("EACCES: copying current.blockmap"), { code: "EACCES" });
    fake.emit("error", error);
    throw error;
  };
  const updates = new Updates("linux");
  updates.start();
  await vi.waitFor(() => expect(updates.current.phase).toBe("failed"));

  // Attempt B: the retry finds 0.2.2, which is still downloading, unchecked.
  const b = await installer("Uplink-Room-0.2.2-linux-x86_64.AppImage", "the 0.2.2 AppImage");
  sign("latest", "Uplink-Room-0.2.2-linux-x86_64.AppImage", b.sha512, {
    channel: "latest",
    version: "0.2.2",
  });
  fake.feed = offer("0.2.2", [
    { url: "Uplink-Room-0.2.2-linux-x86_64.AppImage", sha512: b.sha512 },
  ]);
  let finishB!: () => void;
  fake.download = () =>
    new Promise((resolve) => {
      finishB = () => {
        fake.downloaded(b.path);
        resolve([b.path]);
      };
    });
  await updates.check();
  expect(updates.current).toMatchObject({ phase: "downloading", next: "0.2.2" });

  // A's check now passes. It belongs to an attempt that ended, so it changes nothing.
  openA();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(fake.installsOnQuit).toBe(false);
  expect(updates.current).toMatchObject({ phase: "downloading", next: "0.2.2" });

  // B, once downloaded and checked, installs as usual.
  finishB();
  await vi.waitFor(() => expect(updates.current.phase).toBe("ready"));
  expect(updates.current.next).toBe("0.2.2");
  expect(fake.installsOnQuit).toBe(true);
  expect(fake.installerPath).toBe(b.path);
});

test("a test build put into the latest feed is refused before it downloads", async () => {
  // Someone copies a signed test build and its signature into the latest folder.
  const file = await installer("Uplink-Room-0.2.1-test.1-mac-arm64.zip", "a test build");
  sign("latest", "Uplink-Room-0.2.1-test.1-mac-arm64.zip", file.sha512, {
    channel: "test",
    version: "0.2.1-test.1",
  });
  fake.feed = offer("0.2.1-test.1", [
    { url: "Uplink-Room-0.2.1-test.1-mac-arm64.zip", sha512: file.sha512 },
  ]);
  fake.download = async () => {
    fake.downloaded(file.path);
    return [file.path];
  };
  for (const asksSupported of [true, false]) {
    // Also when electron-updater takes it as available without asking isUpdateSupported.
    fake.asksSupported = asksSupported;
    const updates = new Updates("darwin");
    updates.start();
    await vi.waitFor(() => expect(updates.current.phase).toBe("failed"));
    expect(updates.current.failure).toBe("channel");
    expect(fake.downloadUpdate).not.toHaveBeenCalled();
    fake.removeAllListeners();
  }
});

test("a ready Windows update restarts the app on its own once the computer is quiet, and not while a terminal runs", async () => {
  const file = await installer("Uplink-Room-Setup-0.2.1-x64.exe", "the 0.2.1 installer");
  sign("latest", "Uplink-Room-Setup-0.2.1-x64.exe", file.sha512, { channel: "latest", version: "0.2.1" });
  fake.feed = offer("0.2.1", [{ url: "Uplink-Room-Setup-0.2.1-x64.exe", sha512: file.sha512 }]);
  fake.download = async () => {
    fake.downloaded(file.path);
    return [file.path];
  };
  let terminals = 1;
  const updates = new Updates("win32", { quiet: async () => ({ idle: "idle", terminals }) });
  updates.start();
  await vi.waitFor(() => expect(updates.current.phase).toBe("ready"));

  expect(await updates.restartIfQuiet()).toBe(false);
  await new Promise((resolve) => setImmediate(resolve));
  expect(fake.quitAndInstall).not.toHaveBeenCalled();

  terminals = 0;
  expect(await updates.restartIfQuiet()).toBe(true);
  await vi.waitFor(() => expect(fake.quitAndInstall).toHaveBeenCalledWith(true, true));
});
