import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  CHECK_EVERY_MS,
  autoRestartDue,
  FEED_BASE,
  canCheckNow,
  canRestart,
  channelOf,
  checkDue,
  errorCode,
  initialState,
  isOffline,
  onChannel,
  reduce,
  updatesOff,
  type UpdateEvent,
  type UpdateState,
} from "./updateSpec.ts";

const installed = { isPackaged: true, platform: "darwin", version: "0.2.0", env: {} };
const run = (state: UpdateState, ...events: UpdateEvent[]) => events.reduce(reduce, state);
const HOUR = 60 * 60 * 1000;

test("a version's prerelease tag picks its channel, and other prereleases belong to none", () => {
  expect(channelOf("0.2.0")).toBe("latest");
  expect(channelOf("0.1.1-test.2")).toBe("test");
  expect(channelOf("0.2.0-beta.1")).toBeNull();
  expect(channelOf("not a version")).toBeNull();
});

test("only an update on the app's own channel is taken", () => {
  const latest = initialState(installed);
  expect(onChannel(latest, "0.2.1")).toBe(true);
  // A test build put into the latest feed, and the other way round.
  expect(onChannel(latest, "0.2.1-test.1")).toBe(false);
  const test = initialState({ ...installed, version: "0.2.1-test.1" });
  expect(onChannel(test, "0.2.1-test.2")).toBe(true);
  expect(onChannel(test, "0.2.2")).toBe(false);
  expect(onChannel(latest, "0.3.0-beta.1")).toBe(false);
});

test("development builds, the opt-out, Linux packages other than the AppImage, and unknown channels never update", () => {
  expect(updatesOff(installed)).toBeNull();
  expect(updatesOff({ ...installed, isPackaged: false })).toBe("development");
  expect(updatesOff({ ...installed, env: { UPLINK_NO_UPDATES: "1" } })).toBe("turned-off");
  expect(updatesOff({ ...installed, platform: "linux" })).toBe("linux-package");
  expect(
    updatesOff({ ...installed, platform: "linux", env: { APPIMAGE: "/home/a/Uplink.AppImage" } }),
  ).toBeNull();
  expect(updatesOff({ ...installed, version: "0.2.0-beta.1" })).toBe("unknown-channel");
  const off = initialState({ ...installed, isPackaged: false });
  expect(off.phase).toBe("off");
  expect(checkDue(off, 0)).toBe(false);
  expect(canCheckNow(off)).toBe(false);
});

test("it checks at launch, then four hours after the last check, whether that one failed or not", () => {
  const launch = initialState(installed);
  expect(checkDue(launch, 1_000)).toBe(true);
  const checked = run(launch, { type: "check", at: 1_000 }, { type: "not-available" });
  expect(checkDue(checked, 1_000 + 3 * HOUR)).toBe(false);
  expect(checkDue(checked, 1_000 + CHECK_EVERY_MS)).toBe(true);
  const failed = run(launch, { type: "check", at: 1_000 }, { type: "failed" });
  expect(failed.phase).toBe("failed");
  expect(checkDue(failed, 1_000 + HOUR)).toBe(false);
  expect(checkDue(failed, 1_000 + CHECK_EVERY_MS)).toBe(true);
  expect(canCheckNow(failed)).toBe(true);
});

test("no check starts while one runs, while an update downloads, or once one is ready", () => {
  const later = 10 * CHECK_EVERY_MS;
  const checking = run(initialState(installed), { type: "check", at: 0 });
  expect(checkDue(checking, later)).toBe(false);
  expect(canCheckNow(checking)).toBe(false);
  const downloading = run(
    checking,
    { type: "available", version: "0.2.1" },
    { type: "progress", percent: 41.6 },
  );
  expect(downloading).toMatchObject({ phase: "downloading", next: "0.2.1", percent: 42 });
  expect(checkDue(downloading, later)).toBe(false);
  const ready = run(downloading, { type: "downloaded", version: "0.2.1" }, { type: "prepared" });
  expect(ready.phase).toBe("ready");
  expect(checkDue(ready, later)).toBe(false);
  expect(canCheckNow(ready)).toBe(false);
});

test("a downloaded update offers the restart, but not during a call, and comes back when the call ends", () => {
  const ready = run(
    initialState(installed),
    { type: "check", at: 0 },
    { type: "available", version: "0.2.1" },
    { type: "downloaded", version: "0.2.1" },
    { type: "prepared" },
  );
  expect(ready).toMatchObject({ phase: "ready", next: "0.2.1" });
  expect(canRestart(ready)).toBe(true);
  const inCall = reduce(ready, { type: "call", inCall: true });
  expect(canRestart(inCall)).toBe(false);
  expect(canRestart(reduce(inCall, { type: "call", inCall: false }))).toBe(true);
  // Joining a call while the download runs: the offer waits for the call to end.
  const downloadingInCall = run(
    initialState(installed),
    { type: "call", inCall: true },
    { type: "check", at: 0 },
    { type: "available", version: "0.2.1" },
    { type: "downloaded", version: "0.2.1" },
    { type: "prepared" },
  );
  expect(canRestart(downloadingInCall)).toBe(false);
  expect(canRestart(reduce(downloadingInCall, { type: "call", inCall: false }))).toBe(true);
  // Nothing to install: nothing to offer.
  expect(
    canRestart(run(initialState(installed), { type: "check", at: 0 }, { type: "not-available" })),
  ).toBe(false);
});

test("a downloaded update is offered only once it's checked (and, on macOS, staged), on every platform", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const start = initialState({ ...installed, platform, env: { APPIMAGE: "/a/Uplink.AppImage" } });
    const preparing = run(
      start,
      { type: "check", at: 0 },
      { type: "available", version: "0.2.1" },
      { type: "downloaded", version: "0.2.1" },
    );
    expect(preparing).toMatchObject({ phase: "preparing", next: "0.2.1" });
    // Squirrel.Mac's own "update-downloaded" can't be mistaken for a restart offer before then.
    expect(canRestart(preparing)).toBe(false);
    expect(canCheckNow(preparing)).toBe(false);
    expect(checkDue(preparing, 10 * CHECK_EVERY_MS)).toBe(false);
    expect(canRestart(reduce(preparing, { type: "prepared" }))).toBe(true);
    // A staging or signature failure while preparing ends it; a later "prepared" offers nothing.
    const failed = reduce(preparing, { type: "failed", reason: "signature" });
    expect(failed).toMatchObject({ phase: "failed", failure: "signature" });
    expect(canRestart(reduce(failed, { type: "prepared" }))).toBe(false);
  }
});

test("a refused signature is remembered until the next check starts", () => {
  const refused = run(
    initialState(installed),
    { type: "check", at: 0 },
    { type: "failed", reason: "signature" },
  );
  expect(refused.failure).toBe("signature");
  expect(canCheckNow(refused)).toBe(true);
  expect(reduce(refused, { type: "check", at: 1 }).failure).toBeUndefined();
  expect(reduce(refused, { type: "failed" }).failure).toBeUndefined();
  const offChannel = run(initialState(installed), { type: "failed", reason: "channel" });
  expect(offChannel.failure).toBe("channel");
});

test("a download that fails, even before it starts, returns to a state that checks again later", () => {
  // updates.ts runs downloadUpdate() through attempt(), so a synchronous throw lands here too.
  const failed = run(
    initialState(installed),
    { type: "check", at: 1_000 },
    { type: "available", version: "0.2.1" },
    { type: "failed" },
  );
  expect(failed).toMatchObject({ phase: "failed" });
  expect(failed.next).toBeUndefined();
  expect(canCheckNow(failed)).toBe(true);
  expect(checkDue(failed, 1_000 + CHECK_EVERY_MS)).toBe(true);
});

test("the feed address the app checks signatures against is the one electron-builder bakes in", () => {
  const config = readFileSync(join(import.meta.dirname, "../../electron-builder.yml"), "utf8");
  expect(config).toContain(`url: ${FEED_BASE}/\${channel}`);
});

test("an install that fails after the download ends the offer and lets a check start again", () => {
  const ready = run(
    initialState(installed),
    { type: "check", at: 0 },
    { type: "downloaded", version: "0.2.1" },
    { type: "prepared" },
  );
  expect(ready.phase).toBe("ready");
  const failed = reduce(ready, { type: "failed" });
  expect(failed.phase).toBe("failed");
  expect(failed.next).toBeUndefined();
  expect(canRestart(failed)).toBe(false);
  expect(canCheckNow(failed)).toBe(true);
});

test("offline failures get no error report; a bad feed or a failed install does", () => {
  expect(errorCode(Object.assign(new Error("x"), { code: "ENOTFOUND" }))).toBe("ENOTFOUND");
  expect(errorCode(new Error("net::ERR_INTERNET_DISCONNECTED"))).toBe("ERR_INTERNET_DISCONNECTED");
  expect(errorCode(Object.assign(new Error("x"), { statusCode: 404 }))).toBe("HTTP_404");
  expect(errorCode("weird")).toBe("UNKNOWN");
  expect(isOffline("ENOTFOUND")).toBe(true);
  expect(isOffline("ERR_INTERNET_DISCONNECTED")).toBe(true);
  expect(isOffline("ERR_UPDATER_CHANNEL_FILE_NOT_FOUND")).toBe(false);
  expect(isOffline("HTTP_404")).toBe(false);
});

test("a ready update restarts on its own only when nobody is at the computer and nothing would be cut off", () => {
  const ready: UpdateState = { phase: "ready", version: "0.2.0", channel: "latest", off: null, next: "0.2.1", inCall: false };
  expect(autoRestartDue(ready, { idle: "idle", terminals: 0 })).toBe(true);
  expect(autoRestartDue(ready, { idle: "locked", terminals: 0 })).toBe(true);
  // Someone is using the computer, or it can't tell.
  expect(autoRestartDue(ready, { idle: "active", terminals: 0 })).toBe(false);
  expect(autoRestartDue(ready, { idle: "unknown", terminals: 0 })).toBe(false);
  // A restart would end a terminal, or the bridge didn't answer.
  expect(autoRestartDue(ready, { idle: "locked", terminals: 1 })).toBe(false);
  expect(autoRestartDue(ready, { idle: "locked", terminals: null })).toBe(false);
  // A call, or nothing ready.
  expect(autoRestartDue({ ...ready, inCall: true }, { idle: "locked", terminals: 0 })).toBe(false);
  expect(autoRestartDue({ ...ready, phase: "downloading" }, { idle: "locked", terminals: 0 })).toBe(false);
});
