// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { typingText } from "./Typing";

test("the typing line names who is writing, says an agent is writing, and stops naming at four", () => {
  const ana = { name: "Ana", kind: "person" as const };
  const theo = { name: "Theo", kind: "person" as const };
  const mia = { name: "Mia", kind: "person" as const };
  const hermes = { name: "Hermes", kind: "agent" as const };
  expect(typingText([])).toBe("");
  expect(typingText([ana])).toBe("Ana is typing");
  expect(typingText([hermes])).toBe("Hermes is writing");
  expect(typingText([ana, theo])).toBe("Ana and Theo are typing");
  expect(typingText([ana, theo, hermes])).toBe("Ana, Theo and Hermes are typing");
  expect(typingText([ana, theo, mia, hermes])).toBe("Several people are typing");
});

test("a typing row that was already old when it arrived never shows; a fresh one shows for a few seconds after its last keystroke (Codex review)", async () => {
  const { noteTyping, typistsNow, TYPING_SHOWN_MS } = await import("./Typing");
  const now = 1_800_000_000_000;
  const seen = new Map<string, { at: number; seenAt: number }>();
  const ana = { member: { memberId: "ana", name: "Ana", kind: "person" as const }, at: now - 2 * 86_400_000 };
  const theo = { member: { memberId: "theo", name: "Theo", kind: "person" as const }, at: now - 1_000 };
  const mia = { member: { memberId: "mia", name: "Mia", kind: "person" as const }, at: now - 500, replyTo: "thread1" };
  // Opening the channel days after Ana abandoned a draft: only Theo is typing here, Mia in her thread.
  noteTyping(seen, [ana, theo, mia], now);
  expect(typistsNow(seen, [ana, theo, mia], undefined, now).map((t) => t.name)).toEqual(["Theo"]);
  expect(typistsNow(seen, [ana, theo, mia], "thread1", now).map((t) => t.name)).toEqual(["Mia"]);
  // Theo stops: gone a few seconds later. Typing again brings him back.
  expect(typistsNow(seen, [theo], undefined, now + TYPING_SHOWN_MS + 1)).toEqual([]);
  const again = { ...theo, at: now + 7_000 };
  noteTyping(seen, [again], now + 7_000);
  expect(typistsNow(seen, [again], undefined, now + 8_000).map((t) => t.name)).toEqual(["Theo"]);
});
