import { expect, test } from "vitest";
import { notifySpec, parseNotifyRequest, shouldShow, type NotifyRequest } from "./notifySpec.ts";

const needs = (canAllow: boolean): NotifyRequest => ({
  kind: "needs",
  id: "run-1:p1",
  who: "Codex",
  task: "Ship 0.4.2",
  text: "Wants to run deploy 0.4.2",
  canAllow,
  runId: "run-1",
  promptId: "p1",
  taskId: "task-1",
});
const wheel: NotifyRequest = {
  kind: "wheel",
  id: "wheel:t1",
  terminal: "Tile map loader",
  terminalId: "t1",
};

test("a banner offers Allow only for an approval that can be undone; the rest show Open only", () => {
  expect(notifySpec(needs(true), "darwin").buttons.map((b) => b.choice)).toEqual(["allow", "open"]);
  expect(notifySpec(needs(false), "darwin").buttons.map((b) => b.choice)).toEqual(["open"]);
  const spec = notifySpec(wheel, "linux");
  expect(spec.title).toBe("You have control");
  expect(spec.buttons.map((b) => b.choice)).toEqual(["open"]);
});

test("the task goes in the subtitle on macOS and on the body's first line elsewhere", () => {
  const mac = notifySpec(needs(true), "darwin");
  expect(mac).toMatchObject({ title: "Codex needs you", subtitle: "Ship 0.4.2", body: "Wants to run deploy 0.4.2" });
  const win = notifySpec(needs(true), "win32");
  expect(win.subtitle).toBeUndefined();
  expect(win.body).toBe("Ship 0.4.2\nWants to run deploy 0.4.2");
});

test("requests from the renderer are checked before anything is shown", () => {
  expect(parseNotifyRequest(needs(true))).toEqual(needs(true));
  expect(parseNotifyRequest(wheel)).toEqual(wheel);
  expect(parseNotifyRequest({ ...needs(true), canAllow: "yes" })).toBeNull();
  // A needs-you banner names the run its Allow answers; the wheel names its terminal.
  expect(parseNotifyRequest({ ...needs(true), runId: undefined })).toBeNull();
  expect(parseNotifyRequest({ ...wheel, terminalId: "" })).toBeNull();
  expect(parseNotifyRequest({ kind: "deploy", id: "x" })).toBeNull();
  expect(parseNotifyRequest({ ...wheel, id: "" })).toBeNull();
});

test("a long command is clipped, not dropped: its approval still gets a banner", () => {
  // Claude Code forwards the whole command, and the reason line carries it, script and all.
  const script = `Wants to run bash -c '${"echo step && ".repeat(400)}true'`;
  const parsed = parseNotifyRequest({ ...needs(true), text: script, task: "T".repeat(900) });
  expect(parsed).not.toBeNull();
  if (parsed?.kind !== "needs") throw new Error("expected a needs-you request");
  expect(parsed.text.length).toBeLessThanOrEqual(500);
  expect(parsed.task.length).toBeLessThanOrEqual(500);
  expect(parsed.runId).toBe("run-1");
  expect(notifySpec(parsed, "darwin").body.startsWith("Wants to run bash -c")).toBe(true);
  // Ids are never clipped: one too long is still refused.
  expect(parseNotifyRequest({ ...needs(true), runId: "r".repeat(300) })).toBeNull();
});

const message = (reason: "direct" | "mention" | "reply" | "everyone" | "all"): Extract<NotifyRequest, { kind: "message" }> => ({
  kind: "message",
  id: "message:m1",
  who: "Ana",
  where: reason === "direct" ? "Ana" : "#general",
  direct: reason === "direct",
  reason,
  text: "Can you look at the deploy?",
  channelId: "c1",
  messageId: "m1",
});

test("a message banner says who wrote it, why it reached you, where, and a preview, with Open only", () => {
  expect(notifySpec(message("mention"), "darwin")).toEqual({
    title: "Ana mentioned you",
    subtitle: "#general",
    body: "Can you look at the deploy?",
    buttons: [{ text: "Open", choice: "open" }],
  });
  expect(notifySpec(message("direct"), "darwin")).toMatchObject({ title: "Ana", subtitle: "Direct message" });
  expect(notifySpec(message("reply"), "linux")).toMatchObject({ title: "Ana replied to you", body: "#general\nCan you look at the deploy?" });
  expect(notifySpec(message("everyone"), "darwin").title).toBe("Ana to @everyone");
  expect(notifySpec({ ...message("all"), text: "" }, "darwin").body).toBe("Sent an attachment");
  expect(parseNotifyRequest(message("mention"))).toEqual(message("mention"));
  expect(parseNotifyRequest({ ...message("mention"), reason: "shout" })).toBeNull();
  expect(parseNotifyRequest({ ...message("mention"), messageId: "" })).toBeNull();
});

test("a message banner shows while the window has focus, since it can be for another channel; the rest wait for another app", () => {
  expect(shouldShow(message("direct"), true)).toBe(true);
  expect(shouldShow(message("mention"), false)).toBe(true);
  expect(shouldShow(needs(true), true)).toBe(false);
  expect(shouldShow(wheel, true)).toBe(false);
  expect(shouldShow(wheel, false)).toBe(true);
});
