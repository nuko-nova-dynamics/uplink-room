import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import { attempt, listenerGuard } from "./updateGuards.ts";

test("a download that throws before it returns a promise rejects instead of throwing", async () => {
  // electron-updater's downloadUpdate() throws ERR_UPDATER_NO_CHECKSUM synchronously for a feed
  // file without a sha512; a bare `.catch` would never attach.
  const throwsAtOnce = () => {
    throw Object.assign(new Error("Cannot find checksum"), { code: "ERR_UPDATER_NO_CHECKSUM" });
  };
  let result: unknown;
  expect(() => {
    result = attempt(throwsAtOnce);
  }).not.toThrow();
  await expect(result).rejects.toMatchObject({ code: "ERR_UPDATER_NO_CHECKSUM" });
  await expect(attempt(() => Promise.reject(new Error("later")))).rejects.toThrow("later");
  await expect(attempt(() => Promise.resolve(["file.zip"]))).resolves.toEqual(["file.zip"]);
});

test("listeners added after the guard (MacUpdater's quit-on-staged) are pruned; the app's own stay", () => {
  const native = new EventEmitter();
  const markStaged = () => {};
  const prepared = () => {};
  native.on("update-downloaded", markStaged);
  native.on("update-downloaded", prepared);
  const guard = listenerGuard(native, "update-downloaded");
  let quit = 0;
  // What MacUpdater.quitAndInstall() registers when Squirrel.Mac hasn't staged the update yet.
  native.on("update-downloaded", () => (quit += 1));
  expect(guard.prune()).toBe(1);
  native.emit("update-downloaded");
  expect(quit).toBe(0);
  expect(native.listeners("update-downloaded")).toEqual([markStaged, prepared]);
  expect(guard.prune()).toBe(0);
});
