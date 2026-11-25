import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { LoginItem } from "./loginItem";

vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/unused", getVersion: () => "0.2.14" },
}));
vi.mock("./log", () => ({ log: { warn: vi.fn(), info: vi.fn() } }));
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true }));
});

// LoginItem deliberately ignores AppImage moves off Linux. The filesystem helper
// remains covered on every platform by appImageDesktop.test.ts.
test.skipIf(process.platform !== "linux")(
  "the updater move callback repairs the menu even when open at login is disabled",
  () => {
    const root = mkdtempSync(join(tmpdir(), "uplink-move-"));
    roots.push(root);
    vi.stubEnv("XDG_DATA_HOME", root);
    vi.stubEnv("XDG_CONFIG_HOME", root);
    mkdirSync(join(root, "applications"));
    const file = join(root, "applications", "uplink-room.desktop");
    writeFileSync(
      file,
      "[Desktop Entry]\nExec=/apps/Uplink-Room-0.2.7-linux-x86_64.AppImage %U\nX-AppImage-Version=0.2.7\n",
    );
    new LoginItem().followAppImage("/apps/Uplink-Room-0.2.15-linux-x86_64.AppImage");
    expect(readFileSync(file, "utf8")).toContain(
      "Exec=/apps/Uplink-Room-0.2.15-linux-x86_64.AppImage %U",
    );
    expect(readFileSync(file, "utf8")).toContain("X-AppImage-Version=0.2.15");
  },
);
