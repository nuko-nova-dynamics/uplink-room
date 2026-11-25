/**
 * Files saved for a terminal run (ADR 0043) stay in its workspace's `.uplink-room/files`: a symlink
 * the repository put where the bridge writes is refused, so nothing outside the workspace is written.
 *
 * A folder link is a junction on Windows, which needs no privilege (CI's runner has none to make a
 * symlink), so the folder checks run there too; elsewhere the type is ignored and it is a symlink.
 */
import { afterEach, expect, test, type TestContext } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { ROOM_FILES_KEPT_MS, RoomFilesIndex, removeRoomFiles, saveRoomFiles } from "../src/roomFiles.ts";
import { FileServer } from "./tools/fileServer.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A link to a folder: a junction on Windows. */
const linkFolder = (target: string, path: string) => symlink(target, path, "junction");

/**
 * A symlink to a file. Windows needs a privilege for one (Developer Mode or SeCreateSymbolicLink),
 * and refuses with EPERM without it: the test is skipped there then, not failed.
 */
async function linkFile(target: string, path: string, { skip }: TestContext): Promise<void> {
  try {
    await symlink(target, path, "file");
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") skip("Windows refused a file symlink without the privilege (EPERM).");
    throw error;
  }
}

/** A workspace, a folder outside it with a file the repository must not reach, and a file to save. */
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "uplink-room-files-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const workspace = join(dir, "repo");
  const outside = join(dir, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(outside, "precious"), "keep me\n");
  const files = await FileServer.start();
  cleanups.push(() => files.close());
  return { workspace, outside, file: files.add("notes.txt", "from the room", "text/plain") };
}

test("saves a message's files under .uplink-room/files and marks the folder git-ignored", async () => {
  const { workspace, file } = await setup();
  const saved = await saveRoomFiles(workspace, "d1", [file]);
  expect(saved.map((f) => f.path)).toEqual([join(workspace, ".uplink-room", "files", "d1", "notes.txt")]);
  expect(await readFile(saved[0]!.path, "utf8")).toBe("from the room");
  expect(await readFile(join(workspace, ".uplink-room", ".gitignore"), "utf8")).toBe("*\n");
  // Delivered again, the same paths are written again.
  expect((await saveRoomFiles(workspace, "d1", [file])).map((f) => f.path)).toEqual(saved.map((f) => f.path));
});

test("a relative workspace gets absolute paths, so the run in it doesn't resolve them twice", async () => {
  const { workspace, file } = await setup();
  // As runs.start passes a relative cwd on: relative to the bridge's own working directory.
  const saved = await saveRoomFiles(relative(process.cwd(), workspace), "d1", [file]);
  expect(saved.map((f) => isAbsolute(f.path))).toEqual([true]);
  expect(saved.map((f) => f.path)).toEqual([join(workspace, ".uplink-room", "files", "d1", "notes.txt")]);
  expect(await readFile(saved[0]!.path, "utf8")).toBe("from the room");
});

test("a symlinked .gitignore is not followed: its target outside the workspace keeps its contents", async (context) => {
  const { workspace, outside, file } = await setup();
  await mkdir(join(workspace, ".uplink-room"));
  await linkFile(join(outside, "precious"), join(workspace, ".uplink-room", ".gitignore"), context);
  expect(await saveRoomFiles(workspace, "d1", [file])).toEqual([]);
  expect(await readFile(join(outside, "precious"), "utf8")).toBe("keep me\n");
});

test("a symlinked .uplink-room or files folder is refused, and nothing is written where it points", async () => {
  for (const link of [".uplink-room", join(".uplink-room", "files"), join(".uplink-room", "files", "d1")]) {
    const { workspace, outside, file } = await setup();
    await mkdir(join(workspace, link, ".."), { recursive: true });
    await linkFolder(outside, join(workspace, link));
    expect(await saveRoomFiles(workspace, "d1", [file])).toEqual([]);
    expect(await readdir(outside)).toEqual(["precious"]);
  }
});

test("a folder link where a saved file goes is never written through", async () => {
  const { workspace, outside, file } = await setup();
  await mkdir(join(workspace, ".uplink-room", "files", "d1"), { recursive: true });
  await linkFolder(outside, join(workspace, ".uplink-room", "files", "d1", "notes.txt"));
  // Replaced where the platform renames over a link (macOS, Linux), left out where it can't (Windows).
  for (const saved of await saveRoomFiles(workspace, "d1", [file])) {
    expect((await lstat(saved.path)).isSymbolicLink()).toBe(false);
    expect(await readFile(saved.path, "utf8")).toBe("from the room");
  }
  expect(await readdir(outside)).toEqual(["precious"]);
  expect(await readFile(join(outside, "precious"), "utf8")).toBe("keep me\n");
});

test("a symlink where a saved file goes is replaced, not written through", async (context) => {
  const { workspace, outside, file } = await setup();
  await mkdir(join(workspace, ".uplink-room", "files", "d1"), { recursive: true });
  await linkFile(join(outside, "precious"), join(workspace, ".uplink-room", "files", "d1", "notes.txt"), context);
  const saved = await saveRoomFiles(workspace, "d1", [file]);
  expect(saved).toHaveLength(1);
  expect((await lstat(saved[0]!.path)).isSymbolicLink()).toBe(false);
  expect(await readFile(saved[0]!.path, "utf8")).toBe("from the room");
  expect(await readFile(join(outside, "precious"), "utf8")).toBe("keep me\n");
});

test("removing a run's delivery folders follows no link: a link inside goes as a link, and a linked .uplink-room is left alone", async () => {
  const { workspace, outside, file } = await setup();
  await saveRoomFiles(workspace, "d1", [file]);
  const delivery = join(workspace, ".uplink-room", "files", "d1");
  await linkFolder(outside, join(delivery, "escape"));
  await removeRoomFiles(workspace, ["d1"]);
  await expect(lstat(delivery)).rejects.toThrow();
  expect(await readFile(join(outside, "precious"), "utf8")).toBe("keep me\n");

  const other = await setup();
  await mkdir(join(other.outside, "files", "d1"), { recursive: true });
  await writeFile(join(other.outside, "files", "d1", "notes.txt"), "not the bridge's");
  await linkFolder(other.outside, join(other.workspace, ".uplink-room"));
  await removeRoomFiles(other.workspace, ["d1"]);
  expect(await readFile(join(other.outside, "files", "d1", "notes.txt"), "utf8")).toBe("not the bridge's");
});

test("a bridge that starts again removes delivery folders older than 7 days from the workspaces it saved in, and forgets a workspace left empty", async () => {
  const { workspace, outside, file } = await setup();
  const index = join(workspace, "..", "room-files.json");
  const saving = new RoomFilesIndex(index);
  await saving.add(workspace);
  await saveRoomFiles(workspace, "old", [file]);
  await saveRoomFiles(workspace, "new", [file]);
  const files = join(workspace, ".uplink-room", "files");
  const now = Date.now();
  const old = new Date(now - ROOM_FILES_KEPT_MS - 60_000);
  await utimes(join(files, "old"), old, old);
  // A link the repository put there is no delivery of the bridge's: it and what it points at stay.
  await linkFolder(outside, join(files, "linked"));
  await utimes(outside, old, old);

  await new RoomFilesIndex(index).prune(ROOM_FILES_KEPT_MS, now);
  expect((await readdir(files)).sort()).toEqual(["linked", "new"]);
  expect(await readFile(join(outside, "precious"), "utf8")).toBe("keep me\n");
  expect(JSON.parse(await readFile(index, "utf8"))).toEqual({ v: 1, workspaces: [workspace] });

  // Once the last one is old too, the workspace is forgotten.
  await new RoomFilesIndex(index).prune(ROOM_FILES_KEPT_MS, now + ROOM_FILES_KEPT_MS + 120_000);
  expect((await readdir(files)).sort()).toEqual(["linked"]);
  expect(JSON.parse(await readFile(index, "utf8"))).toEqual({ v: 1, workspaces: [] });
});
