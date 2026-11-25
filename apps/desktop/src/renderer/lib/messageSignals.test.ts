import { expect, test } from "vitest";
import { messageNotices, type Addressed, type MessageWatch } from "./messageSignals";

/** An alert with its delivery seq; `at` defaults to the seq, as if each arrived a moment apart. */
const alert = (messageId: string, channelId: string, reason: Addressed["reason"], seq: number, at = seq): Addressed => ({
  messageId,
  channelId,
  channel: channelId === "dm" ? { kind: "direct", label: "Ana" } : { kind: "channel", label: "#general" },
  author: { name: "Ana" },
  reason,
  preview: `message ${messageId}`,
  at,
  seq,
});

const away: MessageWatch = { openChannelId: null, focused: false, banners: true, sounds: true };

test("what was there when the app opened shows nothing; each new message shows once", () => {
  const first = messageNotices([alert("m1", "dm", "direct", 1)], away, null);
  expect(first).toEqual({ banners: [], cue: false, boundary: 1 });
  const next = messageNotices([alert("m3", "general", "mention", 3), alert("m2", "dm", "direct", 2), alert("m1", "dm", "direct", 1)], away, first.boundary);
  expect(next).toMatchObject({ cue: true, boundary: 3 });
  // In the order they reached you, so the newest banner lands on top.
  expect(next.banners).toEqual([
    { kind: "message", id: "message:m2", who: "Ana", where: "Ana", direct: true, reason: "direct", text: "message m2", channelId: "dm", messageId: "m2" },
    { kind: "message", id: "message:m3", who: "Ana", where: "#general", direct: false, reason: "mention", text: "message m3", channelId: "general", messageId: "m3" },
  ]);
  // The same list again shows nothing more.
  expect(messageNotices([alert("m3", "general", "mention", 3), alert("m2", "dm", "direct", 2)], away, next.boundary)).toMatchObject({ banners: [], cue: false });
});

test("after a restart, an older alert that comes into the list when a newer one is deleted gets no banner", () => {
  // The app opens to the 20 newest alerts (seqs 2 to 21); the one with seq 1 is the 21st.
  const twenty = Array.from({ length: 20 }, (_, i) => alert(`m${i + 2}`, "general", "mention", i + 2)).reverse();
  const opened = messageNotices(twenty, away, null);
  expect(opened).toMatchObject({ banners: [], boundary: 21 });
  // m21 is deleted, so the list now reaches back to m1.
  const shifted = [...twenty.slice(1), alert("m1", "general", "mention", 1)];
  expect(messageNotices(shifted, away, opened.boundary)).toMatchObject({ banners: [], cue: false, boundary: 21 });
  // A really new one still shows.
  const fresh = messageNotices([alert("m22", "general", "mention", 22), ...shifted], away, opened.boundary);
  expect(fresh.banners.map((b) => b.id)).toEqual(["message:m22"]);
});

test("an @everyone that a later fan-out step delivers gets its banner, after a direct message that reached you first", () => {
  // The direct message reached you first (seq 5) and its banner showed.
  const dm = messageNotices([alert("dm1", "dm", "direct", 5, 2_000)], away, 4);
  expect(dm.banners.map((b) => b.id)).toEqual(["message:dm1"]);
  // The @everyone was posted before it, but its fan-out step reached you after: seq 6.
  const later = messageNotices([alert("all1", "general", "everyone", 6, 1_000), alert("dm1", "dm", "direct", 5, 2_000)], away, dm.boundary);
  expect(later).toMatchObject({ cue: true, boundary: 6, banners: [{ id: "message:all1", reason: "everyone" }] });
});

test("nothing interrupts for the channel you're looking at, but it does once the window is in the back", () => {
  const list = [alert("m1", "general", "all", 1)];
  const looking = { ...away, openChannelId: "general", focused: true };
  expect(messageNotices(list, looking, 0)).toMatchObject({ banners: [], cue: false, boundary: 1 });
  expect(messageNotices(list, { ...looking, focused: false }, 0).banners).toHaveLength(1);
  // Another channel still gets a banner and the cue while you're in the app.
  expect(messageNotices([alert("m2", "dm", "direct", 2)], looking, 0)).toMatchObject({ cue: true, banners: [{ channelId: "dm" }] });
});

test("the Banners and Sounds switches each silence their part", () => {
  const list = [alert("m1", "general", "everyone", 1)];
  expect(messageNotices(list, { ...away, banners: false }, 0)).toMatchObject({ banners: [], cue: true });
  const quiet = messageNotices(list, { ...away, sounds: false }, 0);
  expect(quiet.cue).toBe(false);
  expect(quiet.banners).toMatchObject([{ reason: "everyone" }]);
  expect(messageNotices(list, { ...away, banners: false, sounds: false }, 0)).toMatchObject({ banners: [], cue: false });
});

test("a banner for a run's message names the run, not its driver", () => {
  const fromRun: Addressed = { ...alert("m2", "general", "mention", 2), author: { name: "Julio" }, asRun: { label: "Claude Code (Julio)" } };
  const { banners } = messageNotices([fromRun], away, 1);
  expect(banners).toMatchObject([{ who: "Claude Code (Julio)" }]);
});
