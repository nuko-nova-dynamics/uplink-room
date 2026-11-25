import { expect, test } from "vitest";
import { callActionsPlace } from "./timeline";

const call = (over: Partial<Parameters<typeof callActionsPlace>[0]> = {}) => ({
  notesMessageId: undefined as string | undefined,
  proposals: [] as unknown[],
  hasTranscript: false,
  ...over,
});

test("a call's proposed tasks and transcript sit under its notes when the notes message is shown", () => {
  expect(callActionsPlace(call({ notesMessageId: "m1", hasTranscript: true }), new Set(["m1"]))).toBe("notes");
});

test("they move to the call's end event when the notes message has scrolled out of the loaded window", () => {
  expect(callActionsPlace(call({ notesMessageId: "m1", proposals: [{}] }), new Set(["m2"]))).toBe("end");
  expect(callActionsPlace(call({ notesMessageId: "m1", hasTranscript: true }), new Set())).toBe("end");
});

test("a call with no notes still shows its proposals or transcript at its end event, and nothing when it has neither", () => {
  expect(callActionsPlace(call({ proposals: [{}] }), new Set())).toBe("end");
  expect(callActionsPlace(call({ hasTranscript: true }), new Set())).toBe("end");
  expect(callActionsPlace(call(), new Set())).toBe("none");
});
