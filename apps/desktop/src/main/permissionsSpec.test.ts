import { expect, test } from "vitest";
import { actionFor, openPane, SETTINGS_PANE, setupSteps } from "./permissionsSpec.ts";

test("Screen Recording's pane opens even when listing the screens is refused", async () => {
  const opened: string[] = [];
  await openPane("screen", {
    listScreens: () => Promise.reject(new Error("screen access denied")),
    open: async (url) => void opened.push(url),
  });
  expect(opened).toEqual([SETTINGS_PANE.screen]);
});

test("each permission gets the one action its state allows", () => {
  expect(actionFor("microphone", "not-determined")).toBe("ask");
  expect(actionFor("camera", "denied")).toBe("switch-on");
  expect(actionFor("camera", "restricted")).toBe("none");
  expect(actionFor("screen", "not-determined")).toBe("list");
  expect(actionFor("screen", "denied")).toBe("list");
  expect(actionFor("notifications", "unknown")).toBe("test");
  expect(actionFor("microphone", "granted")).toBe("none");
});

test("the permissions step is macOS only, and the devices step comes when asked for", () => {
  expect(setupSteps("darwin", false)).toEqual(["welcome", "permissions", "pair", "done"]);
  expect(setupSteps("win32", true)).toEqual(["welcome", "devices", "pair", "done"]);
});
