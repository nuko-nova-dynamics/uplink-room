import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { repairAppImageDesktopEntries } from "./appImageDesktop";
import { execArgument } from "./loginItemSpec";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "uplink-desktop-"));
  roots.push(root);
  const data = join(root, "data");
  mkdirSync(join(data, "applications"), { recursive: true });
  const file = join(data, "applications", "uplink-room.desktop");
  const image = join(root, "Apps with spaces", "Uplink-Room-0.2.14-linux-x86_64.AppImage");
  return { root, data, file, image };
}

test("repairs a stale menu entry after the old AppImage has been removed, retaining deep links and metadata", () => {
  const { data, file, image } = fixture();
  const old = image.replace("0.2.14", "0.2.7");
  writeFileSync(
    file,
    `[Desktop Entry]\nName=Uplink Room\nExec=${execArgument(old)} %U\nIcon=custom-icon\nX-AppImage-Version=0.2.7\n`,
  );
  repairAppImageDesktopEntries(image, "0.2.14", data);
  expect(readFileSync(file, "utf8")).toBe(
    `[Desktop Entry]\nName=Uplink Room\nExec=${execArgument(image)} %U\nIcon=custom-icon\nX-AppImage-Version=0.2.14\n`,
  );
});

test("leaves custom launchers, other installations and test-channel entries alone", () => {
  const { data, file, image } = fixture();
  for (const executable of [
    "/home/a/.local/bin/uplink-room",
    image.replace("Apps with spaces", "other"),
    image.replace("0.2.14", "0.2.14-test.1"),
  ]) {
    const text = `[Desktop Entry]\nExec=${execArgument(executable)} %U\nX-AppImage-Version=custom\n`;
    writeFileSync(file, text);
    repairAppImageDesktopEntries(image, "0.2.14", data);
    expect(readFileSync(file, "utf8")).toBe(text);
  }
});

test("does not create a menu entry when none was installed", () => {
  const { data, image } = fixture();
  expect(() => repairAppImageDesktopEntries(image, "0.2.14", data)).not.toThrow();
});
