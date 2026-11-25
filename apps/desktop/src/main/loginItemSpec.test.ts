import { expect, test } from "vitest";
import { autostartEntry, autostartOn, defaultsOn, execArgument } from "./loginItemSpec.ts";

test("only an installed release build turns Open at login on by itself, and only once", () => {
  expect(defaultsOn({ isPackaged: true, channel: "latest", defaulted: false })).toBe(true);
  expect(defaultsOn({ isPackaged: true, channel: "latest", defaulted: true })).toBe(false);
  expect(defaultsOn({ isPackaged: true, channel: "test", defaulted: false })).toBe(false);
  expect(defaultsOn({ isPackaged: false, channel: "latest", defaulted: false })).toBe(false);
});

test("the autostart entry's Exec quotes a path as the Desktop Entry Specification asks", () => {
  expect(execArgument("/home/a/Uplink-Room-0.2.10-linux-x86_64.AppImage")).toBe(
    "/home/a/Uplink-Room-0.2.10-linux-x86_64.AppImage",
  );
  expect(execArgument("/opt/Uplink Room/uplink-room")).toBe('"/opt/Uplink Room/uplink-room"');
  // `$` is escaped inside the quotes, and that backslash is escaped again as a string value.
  expect(execArgument("/home/a $b/100%.AppImage")).toBe('"/home/a \\\\$b/100%%.AppImage"');
  expect(execArgument("/home/a\nb")).toBeNull();
  expect(autostartEntry("/opt/Uplink Room/uplink-room")).toContain('\nExec="/opt/Uplink Room/uplink-room"\n');
});

test("an autostart entry a desktop turned off in place counts as off", () => {
  const entry = autostartEntry("/opt/uplink-room")!;
  expect(autostartOn(entry)).toBe(true);
  expect(autostartOn(null)).toBe(false);
  expect(autostartOn(entry.replace("X-GNOME-Autostart-enabled=true", "X-GNOME-Autostart-enabled=false"))).toBe(false);
  expect(autostartOn(`${entry}Hidden=true\n`)).toBe(false);
});
