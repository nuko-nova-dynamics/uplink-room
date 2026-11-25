// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { codeTimeLeft, joinOutcome, pairEndedLine, pairTitle, readCode, type PairView } from "./pairs";

const pair = (over: Partial<PairView> = {}): PairView =>
  ({
    pairId: "p1",
    createdAt: 0,
    seq: 0,
    unread: 0,
    people: [
      { id: "me", name: "Rosa Vega", you: true },
      { id: "pepe", name: "Pepe Ortiz" },
    ],
    runs: [],
    agents: [],
    ...over,
  }) as PairView;

describe("pairTitle", () => {
  test("names the other people, not you", () => {
    expect(pairTitle(pair())).toBe("Pepe Ortiz");
    expect(pairTitle(pair({ people: [{ id: "me", name: "Rosa", you: true }, { id: "a", name: "Ana" }, { id: "b", name: "Bo" }] as never }))).toBe("Ana and Bo");
    const many = [{ id: "me", name: "Rosa", you: true }, ...["Ana", "Bo", "Cy", "Di"].map((name) => ({ id: name, name }))];
    expect(pairTitle(pair({ people: many as never }))).toBe("Ana, Bo and 2 more");
  });
  test("a Pair with only you is waiting for someone", () => {
    expect(pairTitle(pair({ people: [{ id: "me", name: "Rosa", you: true }] as never }))).toBe("Waiting for someone to join");
  });
});

describe("pairEndedLine", () => {
  test("says who or what ended it", () => {
    expect(pairEndedLine(pair({ endedAt: 1, endReason: "ended" }))).toBe("This Pair has ended. You can still read it.");
    expect(pairEndedLine(pair({ endedAt: 1, endReason: "too_few_people" }))).toBe("This Pair ended when only one person was left in it. You can still read it.");
    expect(pairEndedLine(pair())).toBeUndefined();
  });
});

test("codeTimeLeft counts down minutes and seconds, then says it expired", () => {
  expect(codeTimeLeft(10 * 60_000, 0)).toBe("10:00");
  expect(codeTimeLeft(10 * 60_000, 18_500)).toBe("9:42");
  expect(codeTimeLeft(1000, 1000)).toBeNull();
});

test("readCode tidies what was typed or pasted into a code's shape", () => {
  expect(readCode("  river 4821 maple 0937 ")).toBe("RIVER-4821-MAPLE-0937");
  expect(readCode("River-4821-Maple-0937")).toBe("RIVER-4821-MAPLE-0937");
  expect(readCode("")).toBe("");
});

describe("joinOutcome", () => {
  test("a joined Pair opens", () => {
    expect(joinOutcome({ pairId: "p9" })).toEqual({ pairId: "p9" });
  });
  test("a wrong, used or expired code reads plainly, and so does the hour's limit", () => {
    expect(joinOutcome({ refused: { code: "not_found", message: "That pair code is wrong…" } })).toEqual({
      error: "That code didn't work. It may be mistyped, used already, or more than 10 minutes old. Ask for a new one.",
    });
    expect(joinOutcome({ refused: { code: "forbidden", message: "Too many wrong pair codes: no pair code works for you for 42 more minutes." } })).toEqual({
      error: "Too many wrong codes. No code works for you for 42 more minutes.",
    });
  });
});
