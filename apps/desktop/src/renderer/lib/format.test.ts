import { expect, test } from "vitest";
import { span } from "./format";

test("a length reads exactly: whole days, else whole hours, else minutes (Codex review)", () => {
  expect(span(7 * 86_400_000)).toBe("7 days");
  expect(span(86_400_000)).toBe("1 day");
  expect(span(3 * 3_600_000)).toBe("3 hours");
  // A ten-minute limit isn't "1 hour", and ninety minutes isn't "2 hours".
  expect(span(600_000)).toBe("10 minutes");
  expect(span(90 * 60_000)).toBe("90 minutes");
  // Nor is a minute and a half "2 minutes".
  expect(span(90_000)).toBe("90 seconds");
});
