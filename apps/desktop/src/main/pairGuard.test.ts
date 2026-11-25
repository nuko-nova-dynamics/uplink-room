import { expect, test } from "vitest";
import { ALREADY_LINKED, CANT_CHECK, pairRefusal, parsePairRequest, readPairing } from "./pairGuard";

const fail = (code: string) => () => {
  throw Object.assign(new Error(`${code}: open bridge.json`), { code });
};

test("only a missing bridge.json or one with no token reads as unpaired; a failed read is unknown", () => {
  expect(readPairing(fail("ENOENT"))).toEqual({ status: "unpaired" });
  expect(readPairing(() => JSON.stringify({ limits: {} }))).toEqual({ status: "unpaired" });
  expect(readPairing(() => JSON.stringify({ token: "t", machineId: "m1" }))).toEqual({ status: "paired", machineId: "m1" });
  expect(readPairing(fail("EACCES"))).toEqual({ status: "unknown", error: "EACCES: open bridge.json" });
  expect(readPairing(() => "{ half a file")).toMatchObject({ status: "unknown" });
  expect(readPairing(() => "null")).toMatchObject({ status: "unknown" });
});

test("a pairing that exists or can't be read is replaced only with an explicit replace: true", () => {
  const paired = { status: "paired", machineId: "m1" } as const;
  const unknown = { status: "unknown", error: "EACCES" } as const;
  const ask = (value: unknown) => parsePairRequest(value)!;
  expect(pairRefusal(ask({ code: "abcd-1234" }), paired)).toBe(ALREADY_LINKED);
  expect(pairRefusal(ask({ code: "abcd-1234", replace: false }), paired)).toBe(ALREADY_LINKED);
  expect(pairRefusal(ask({ code: "abcd-1234", replace: "true" }), paired)).toBe(ALREADY_LINKED);
  expect(pairRefusal(ask({ code: "abcd-1234" }), unknown)).toBe(CANT_CHECK);
  expect(pairRefusal(ask({ code: "abcd-1234", replace: true }), paired)).toBeNull();
  expect(pairRefusal(ask({ code: "abcd-1234", replace: true }), unknown)).toBeNull();
  expect(pairRefusal(ask({ code: "abcd-1234" }), { status: "unpaired" })).toBeNull();
});

test("anything but { code } is not a pair request", () => {
  expect(parsePairRequest("abcd-1234")).toBeNull();
  expect(parsePairRequest(null)).toBeNull();
  expect(parsePairRequest({ replace: true })).toBeNull();
});
