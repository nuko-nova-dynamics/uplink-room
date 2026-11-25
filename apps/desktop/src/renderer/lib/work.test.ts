import { expect, test } from "vitest";
import {
  answerState,
  DELIVERY_MS,
  previewTerminal,
  runClock,
  currentStep,
  dropTrailingPrompts,
  failText,
  failedNote,
  groupInput,
  waitingNames,
  offlineMachines,
  outputTail,
  rowRun,
  showRun,
  showReply,
  showTyped,
  stepLine,
  stateSummary,
  stateLabel,
  t3PairingText,
} from "./work";

test("a run card's preview shows the last lines as plain text, without colors or blank lines", () => {
  const chunks = [
    "$ ./migrate --dry-run\r\n",
    "\x1b[2mChecking 4,112 workspaces…\x1b[0m\r\n\r\n",
    "\x1b[31merror\x1b[0m: workspace ws_88 references a deleted field\r\n",
  ];
  expect(outputTail(chunks, 2)).toEqual([
    "Checking 4,112 workspaces…",
    "error: workspace ws_88 references a deleted field",
  ]);
});

test("a carriage return keeps what came after it, as a progress line ends up on screen", () => {
  expect(outputTail(["Building 10%\rBuilding 60%\rBuilding done\r\n", "\x1b]0;title\x07ready"])).toEqual([
    "Building done",
    "ready",
  ]);
});

const who = (memberId: string) => ({ memberId, name: memberId });

test("who typed what joins one person's keystrokes into one line and splits at Enter", () => {
  const typed = [
    { at: 1000, by: who("ana"), data: "e" },
    { at: 1100, by: who("ana"), data: "cho hi" },
    { at: 1200, by: who("ana"), data: "\r" },
    { at: 1300, by: who("ana"), data: "ls" },
  ].reverse();
  expect(groupInput(typed).map((e) => e.data)).toEqual(["ls", "echo hi\r"]);
});

test("another person, a long pause or a sent suggestion starts a new line", () => {
  const typed = [
    { at: 1000, by: who("ana"), data: "a" },
    { at: 1100, by: who("ben"), data: "b" },
    { at: 9000, by: who("ben"), data: "c" },
    { at: 9100, by: who("ben"), data: "pnpm test\r", suggestedBy: who("hermes") },
  ].reverse();
  expect(groupInput(typed).map((e) => `${e.by.name}:${e.data}`)).toEqual([
    "ben:pnpm test\r",
    "ben:c",
    "ben:b",
    "ana:a",
  ]);
});

test("typed control keys show as symbols: Backspace, Ctrl-C, Enter, Tab, Escape and the arrows", () => {
  expect(showTyped("ls\u007f\u0003\r\u001b")).toBe("ls⌫^C↵⎋");
  expect(showTyped("git st\tsh\u001b[A\u001bOB\u001b[C\u001b[D\n")).toBe("git st⇥sh↑↓→←↵");
});

test("pasted text shows without bracketed paste's markers", () => {
  expect(showTyped("\u001b[200~pnpm build\u001b[201~\r")).toBe("pnpm build↵");
});

test("input from before replies were marked shows without the replies mixed into it", () => {
  // Julio's rail before the fix: focus out, device attributes and focus in, typed together with Enter.
  expect(showTyped("\u001b[O\u001b[?1;2c\u001b[I\r", { legacy: true })).toBe("↵");
  expect(showTyped("\u001b[O", { legacy: true })).toBe("");
});

test("Shift+F3 and Ctrl+F3, shaped like cursor position reports, show as typed", () => {
  expect(showTyped("\u001b[1;2R")).toBe("⎋[1;2R");
  expect(showTyped("\u001b[1;5R")).toBe("⎋[1;5R");
});

test("a screen's replies get lines of their own, never joined with typing", () => {
  const typed = [
    { at: 1000, by: who("ana"), data: "echo review-", kind: "typed" as const },
    { at: 1100, by: who("ana"), data: "\u001b[?1;2c", kind: "reply" as const },
    { at: 60_000, by: who("ana"), data: "\u001b[I", kind: "reply" as const },
    { at: 60_100, by: who("ana"), data: "\u007f\r", kind: "typed" as const },
  ].reverse();
  expect(groupInput(typed).map((e) => `${e.kind}:${e.data}`).reverse()).toEqual([
    "typed:echo review-",
    "reply:\u001b[?1;2c\u001b[I",
    "typed:\u007f\r",
  ]);
  expect(showReply("\u001b[?1;2c\u001b[I")).toBe("⎋[?1;2c⎋[I");
});

test("a thread's start failure reads as a sentence and keeps T3 Code's own detail", () => {
  expect(failText("t3_unavailable")).toBe("T3 Code isn't running on its machine.");
  expect(failText("launch_failed: spawn codex ENOENT")).toBe(
    "T3 Code couldn't start the thread. spawn codex ENOENT",
  );
  expect(failText("Lost contact with Hermes.")).toBe("Lost contact with Hermes.");
  expect(failText(undefined)).toBeUndefined();
});

test("a Working row shows its working run, and names the failed attempts beside it", () => {
  const runs = [{ state: "failed" }, { state: "working" }];
  expect(rowRun("working", runs)).toBe(runs[1]);
  expect(rowRun("done", runs)).toBeUndefined();
  expect(failedNote(runs)).toBe("1 of 2 runs failed");
  expect(failedNote([{ state: "working" }])).toBeUndefined();
});

test("a Working row's step is the terminal's last line, but not a bare prompt or the harness's own question", () => {
  expect(currentStep(["Running pnpm test"])).toBe("Running pnpm test");
  expect(currentStep(["~/atlas-web $ "])).toBeUndefined();
  expect(currentStep(["atlas-web %"])).toBeUndefined();
  // The instruction a harness was given, and its own approval question, aren't steps.
  expect(currentStep(["> Add three save slots to the title screen."])).toBeUndefined();
  expect(currentStep(["? Codex wants to run rotate-keys --all"])).toBeUndefined();
  expect(stepLine(["● Reading src/charts/Usage.tsx", "~/atlas-web $"])).toBe("Reading src/charts/Usage.tsx");
  expect(stepLine(["? Codex wants to run rotate-keys --all"])).toBeUndefined();
  expect(currentStep(undefined)).toBeUndefined();
});

test("a plain shell or Space run the room can't track reads Live; an A2A run's Unknown stays", () => {
  expect(stateLabel({ state: "unknown", harness: "shell", terminalId: "t1" })).toBe("Live");
  expect(stateLabel({ state: "unknown", harness: "space", spaceId: "s1" })).toBe("Live");
  // A session that joined by itself has no terminal, and is Live while it lasts (ADR 0032).
  expect(stateLabel({ state: "unknown", harness: "claude-code", joined: true })).toBe("Live");
  expect(stateLabel({ state: "unknown", harness: "claude-code" })).toBe("Status unknown");
  expect(stateLabel({ state: "unknown", harness: "a2a" })).toBe("Status unknown");
  expect(stateLabel({ state: "working", harness: "shell", terminalId: "t1" })).toBe("Working");
});

test("a finished run's preview leaves out the bare prompt its shell was left at", () => {
  expect(dropTrailingPrompts(["error: ws_88", "~/atlas-web $", "atlas-web $ "])).toEqual(["error: ws_88"]);
  expect(dropTrailingPrompts(["$ ls", "README.md"])).toEqual(["$ ls", "README.md"]);
});

const MIN = 60_000;
const run = (over: Record<string, unknown>) => ({
  state: "working",
  harness: "codex",
  terminalId: "t1",
  startedAt: 0,
  stateChangedAt: 40 * MIN,
  ...over,
});

test("a working run's clock counts from its start, so an answered approval doesn't reset it", () => {
  expect(showRun(run({}), 45 * MIN)).toEqual({ icon: "working", label: "Working", time: "45:00", ticking: true });
});

test("a run's timer switches to hours and minutes past an hour, so it never reads like a clock time", () => {
  expect(runClock(0, 59 * MIN + 59_000)).toBe("59:59");
  expect(runClock(0, 4 * 60 * MIN + 51 * MIN + 14_000)).toBe("4h 51m");
  expect(showRun(run({}), 2 * 60 * MIN).time).toBe("2h 0m");
});

test("every surface says the same words and times for the same run", () => {
  expect(showRun(run({ state: "waiting" }), 88 * MIN).time).toBe("48m");
  expect(showRun(run({ state: "done", endedAt: 40 * MIN }), 88 * MIN)).toEqual({
    icon: "done",
    label: "Done",
    time: "48m ago",
  });
  expect(showRun(run({ state: "unknown", harness: "shell" }), 3 * MIN)).toMatchObject({ label: "Live", time: "03:00", ticking: true });
  expect(showRun(run({}), 45 * MIN, true, 5 * MIN).time).toBe("40m");
});

test("a run on a machine whose bridge is offline says so instead of ticking", () => {
  expect(showRun(run({}), 45 * MIN, true)).toEqual({
    icon: "unknown",
    glyph: "offline",
    label: "Working, machine offline",
    time: "5m",
  });
  // A waiting run nobody can answer waits quietly, not as amber "needs you".
  expect(showRun(run({ state: "waiting" }), 45 * MIN, true)).toMatchObject({
    icon: "unknown",
    label: "Waiting, machine offline",
    offline: true,
  });
  // A finished run says how it ended, whatever its machine is doing now.
  expect(showRun(run({ state: "done", endedAt: 0 }), 45 * MIN, true).label).toBe("Done");
  expect(
    offlineMachines([
      { machineId: "a", online: false },
      { machineId: "b", online: true },
      { machineId: "c", online: false, cloud: { state: "stopped" } },
    ]),
  ).toEqual(new Set(["a"]));
});

test("a running cloud machine whose bridge isn't connected is offline; a stopped one says so itself", () => {
  expect(
    offlineMachines([
      { machineId: "running", online: false, cloud: { state: "running" } },
      { machineId: "stopped", online: false, cloud: { state: "stopped" } },
      { machineId: "connected", online: true, cloud: { state: "running" } },
    ]),
  ).toEqual(new Set(["running"]));
});

test("a private run never previews its terminal, which is not_found for an outsider admin", () => {
  // What inbox.get returns to an admin who isn't in the run's conversation (ADR 0015): the run
  // keeps its terminalId, marked private.
  const outsiderAdminView = { private: true, terminalId: "t_hidden", state: "working" };
  expect(previewTerminal(outsiderAdminView)).toBeUndefined();
  expect(previewTerminal({ private: false, terminalId: "t_open" })).toBe("t_open");
  expect(previewTerminal(undefined)).toBeUndefined();
});

test("an answer hides Allow and Deny only while it's on its way; one that didn't land brings them back", () => {
  const waiting = { state: "waiting", stateChangedAt: 1_000, lastAnswer: { at: 2_000 } };
  expect(answerState({ ...waiting, lastAnswer: undefined }, 3_000)).toBe("none");
  expect(answerState(waiting, 2_000 + DELIVERY_MS - 1)).toBe("sending");
  // T3 refused runtime-request.respond: the approval is pending again, still the same prompt.
  expect(answerState(waiting, 2_000 + DELIVERY_MS)).toBe("failed");
  // A prompt that arrived after the answer is a new question.
  expect(answerState({ ...waiting, stateChangedAt: 2_500 }, 3_000)).toBe("none");
  expect(answerState({ ...waiting, state: "working" }, 3_000)).toBe("none");
});

test("a task with runs in different states counts them, most urgent first", () => {
  expect(stateSummary([run({}), run({ state: "failed" })])).toBe("2 runs: 1 failed, 1 working");
  expect(stateSummary([run({ state: "done" }), run({ state: "done" })])).toBe("2 runs done");
});

test("who a task waits on reads as a sentence, you first", () => {
  expect(waitingNames(["Hermes", "you"])).toBe("you and Hermes");
  expect(waitingNames(["Ben Ito", "Hermes", "you"])).toBe("you, Ben Ito and Hermes");
  expect(waitingNames(["Ben Ito"])).toBe("Ben Ito");
});

test("a step drops a harness's own prompt and a prompt with the command typed at it", () => {
  expect(stepLine(["codex> retrying with a smaller batch"])).toBe("retrying with a smaller batch");
  expect(stepLine(["~/website codex"])).toBeUndefined();
});

test("a T3 Code pairing that ended or was refused needs pairing again, one ending within a week warns, and a working one says nothing", () => {
  const now = Date.UTC(2026, 10, 4);
  const day = 24 * 60 * 60 * 1000;
  expect(t3PairingText({ state: "needs_pairing", reason: "expired", expiresAt: now - day }, now)).toMatchObject({
    chip: "T3 Code needs pairing again",
    pairAgain: true,
    needsYou: true,
  });
  expect(t3PairingText({ state: "needs_pairing", reason: "refused" }, now)?.why).toMatch(/revoked in T3 Code/);
  expect(t3PairingText({ state: "connected", expiresAt: now + 3 * day }, now)).toMatchObject({
    chip: "T3 Code pairing ends in 3 days",
    needsYou: false,
  });
  expect(t3PairingText({ state: "connected", expiresAt: now + 20 * day }, now)).toBeUndefined();
  expect(t3PairingText(undefined, now)).toBeUndefined();
});
