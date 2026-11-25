import { expect, test } from "vitest";
import { bannerAction, bannerRequest, changes, liveKeys, snapshot } from "./signals.ts";

const ME = "me";
const approval = (promptId: string, hardToUndo = false) => ({
  kind: "approval" as const,
  text: "Codex wants to run pnpm add tiled-map",
  action: "pnpm add tiled-map",
  promptId,
  hardToUndo,
});
const waitingRow = (runId: string, prompt = approval("p1"), driver = ME) => ({
  title: "Tile map loader",
  taskId: "task-1",
  runs: [
    {
      runId,
      terminalId: undefined as string | undefined,
      harness: "codex",
      state: "waiting",
      stateChangedAt: 1,
      driver: { memberId: driver, kind: "person", name: "Someone" },
      prompt,
    },
  ],
});
const inbox = (needsYou: ReturnType<typeof waitingRow>[] = [], done: unknown[] = []) => ({
  needsYou,
  done: done as never[],
});
const terminal = (driver: string) => ({ terminalId: "t1", title: "Tile map loader", driver: { memberId: driver } });

test("work already waiting when the app opens plays nothing; new work that needs you plays Needs you", () => {
  const first = snapshot(inbox([waitingRow("r1")]), [], ME);
  expect(changes(null, first, ME)).toEqual({ cues: [], banners: [], dismiss: [] });
  const next = snapshot(inbox([waitingRow("r1"), waitingRow("r2")]), [], ME);
  const found = changes(first, next, ME);
  expect(found.cues).toEqual(["needs"]);
  expect(found.banners).toHaveLength(1);
  expect(found.banners[0]).toMatchObject({ kind: "needs", runId: "r2", text: "Wants to run pnpm add tiled-map", canAllow: true });
});

test("a hard-to-undo approval gets a banner without Allow, and an answered one takes its banner away", () => {
  const before = snapshot(inbox(), [], ME);
  const deploy = snapshot(inbox([waitingRow("r1", approval("p9", true))]), [], ME);
  expect(changes(before, deploy, ME).banners[0]).toMatchObject({ canAllow: false });
  expect(changes(deploy, before, ME).dismiss).toEqual(["r1:p9"]);
});

test("the wheel is yours only when someone else drove the terminal before", () => {
  const theirs = snapshot(inbox(), [terminal("hermes")], ME);
  const mine = snapshot(inbox(), [terminal(ME)], ME);
  expect(changes(theirs, mine, ME).cues).toEqual(["wheel"]);
  // A terminal you start is yours from the first time it shows up.
  expect(changes(snapshot(inbox(), [], ME), mine, ME).cues).toEqual([]);
  expect(changes(mine, theirs, ME).dismiss).toEqual(["wheel:t1"]);
});

test("a wheel that comes back with an approval waiting gets one banner, the approval's", () => {
  const row = waitingRow("r1", approval("p1"), ME);
  row.runs[0]!.terminalId = "t1";
  const theirs = snapshot(inbox(), [terminal("hermes")], ME);
  const mine = snapshot(inbox([row]), [terminal(ME)], ME);
  const found = changes(theirs, mine, ME);
  expect(found.cues).toEqual(["needs", "wheel"]);
  expect(found.banners.map((b) => b.kind)).toEqual(["needs"]);
});

test("Inbox zero plays when the last thing that needed you or waited to be settled goes", () => {
  const busy = snapshot(inbox([], [{}]), [], ME);
  const zero = snapshot(inbox(), [], ME);
  expect(changes(busy, zero, ME).cues).toEqual(["zero"]);
  expect(changes(zero, zero, ME).cues).toEqual([]);
});

test("the live keys are the runs waiting on you and the terminals you drive", () => {
  const row = waitingRow("r1", approval("p1"), ME);
  const now = snapshot(inbox([row]), [terminal(ME), { ...terminal("hermes"), terminalId: "t2" }], ME);
  expect(liveKeys(now, ME)).toEqual(["r1:p1", "wheel:t1"]);
});

test("a banner whose approval is gone opens its run instead of answering it", () => {
  const row = waitingRow("r1", approval("p1"), ME);
  row.runs[0]!.terminalId = "t1";
  const live = snapshot(inbox([row]), [], ME);
  const [banner] = changes(snapshot(inbox(), [], ME), live, ME).banners;
  const request = bannerRequest(banner!);
  if (request.kind !== "needs") throw new Error("expected a needs-you banner");
  expect(bannerAction("allow", request, live, "s1", "s1")).toEqual({ kind: "answer", runId: "r1", promptId: "p1" });

  const open = { kind: "openRun", taskId: "task-1", terminalId: "t1" };
  // Answered on another computer, or the run moved on to a newer approval.
  expect(bannerAction("allow", request, snapshot(inbox(), [], ME), "s1", "s1")).toEqual(open);
  const newer = snapshot(inbox([waitingRow("r1", approval("p2"), ME)]), [], ME);
  expect(bannerAction("allow", request, newer, "s1", "s1")).toEqual(open);
  // Clicked before the app has loaded anything after a reload.
  expect(bannerAction("allow", request, null, "s1", "s1")).toEqual(open);
  // Open, or a banner that never offered Allow, only opens.
  expect(bannerAction("open", request, live, "s1", "s1")).toEqual(open);
  expect(bannerAction("allow", { ...request, canAllow: false }, live, "s1", "s1")).toEqual(open);
  const wheel = bannerRequest({ kind: "wheel", id: "wheel:t1", terminalId: "t1", terminal: "Tiles", machine: undefined });
  expect(bannerAction("allow", wheel, null, "s1", "s1")).toEqual({ kind: "openTerminal", terminalId: "t1" });
});

test("a banner from another session (another team, or before a sign-out) neither answers nor opens here", () => {
  const row = waitingRow("r1", approval("p1"), ME);
  row.runs[0]!.terminalId = "t1";
  const live = snapshot(inbox([row]), [], ME);
  const [banner] = changes(snapshot(inbox(), [], ME), live, ME).banners;
  const request = bannerRequest(banner!);
  // Team A's session asked for it; team B's session is the one listening now.
  expect(bannerAction("allow", request, live, "team-a", "team-b")).toEqual({ kind: "ignore" });
  expect(bannerAction("open", request, live, "team-a", "team-b")).toEqual({ kind: "ignore" });
  const wheel = bannerRequest({ kind: "wheel", id: "wheel:t1", terminalId: "t1", terminal: "Tiles", machine: undefined });
  expect(bannerAction("open", wheel, live, "team-a", "team-b")).toEqual({ kind: "ignore" });
  // The session that asked for it still acts on it.
  expect(bannerAction("allow", request, live, "team-a", "team-a")).toEqual({ kind: "answer", runId: "r1", promptId: "p1" });
});
