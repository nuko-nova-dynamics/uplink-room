import { expect, test } from "vitest";
import { channelFrom, downloadsFor, parseFeed } from "./feed";
import { platformOf } from "./platform";

const MAC = `version: 0.2.0
files:
  - url: Uplink-Room-0.2.0-mac-arm64.zip
    sha512: abc
    size: 120000000
  - url: Uplink-Room-0.2.0-mac-x64.zip
    sha512: def
    size: 125000000
  - url: Uplink-Room-0.2.0-mac-arm64.dmg
    sha512: ghi
    size: 118000000
  - url: Uplink-Room-0.2.0-mac-x64.dmg
    sha512: jkl
    size: 123000000
path: Uplink-Room-0.2.0-mac-arm64.zip
sha512: abc
releaseDate: '2026-11-10T18:00:00.000Z'
`;

test("the download page offers each platform's installers, not the files only updates use", () => {
  const feed = parseFeed(MAC)!;
  expect(feed.version).toBe("0.2.0");
  expect(downloadsFor("mac", feed, "latest")).toEqual([
    {
      label: "Apple silicon",
      file: "Uplink-Room-0.2.0-mac-arm64.dmg",
      href: "/updates/latest/Uplink-Room-0.2.0-mac-arm64.dmg",
      size: 118000000,
    },
    {
      label: "Intel",
      file: "Uplink-Room-0.2.0-mac-x64.dmg",
      href: "/updates/latest/Uplink-Room-0.2.0-mac-x64.dmg",
      size: 123000000,
    },
  ]);
  const win = parseFeed(
    "version: 0.2.0\nfiles:\n  - url: Uplink-Room-Setup-0.2.0-arm64.exe\n  - url: Uplink-Room-Setup-0.2.0-x64.exe\n",
  )!;
  expect(downloadsFor("windows", win, "latest").map((d) => d.label)).toEqual(["x64", "Arm"]);
  const linux = parseFeed(
    "version: 0.2.0\nfiles:\n  - url: Uplink-Room-0.2.0-linux-amd64.deb\n  - url: Uplink-Room-0.2.0-linux-x86_64.AppImage\n",
  )!;
  expect(downloadsFor("linux", linux, "test").map((d) => d.href)).toEqual([
    "/updates/test/Uplink-Room-0.2.0-linux-x86_64.AppImage",
    "/updates/test/Uplink-Room-0.2.0-linux-amd64.deb",
  ]);
});

test("a feed that isn't one, or a file name that could leave the folder, is dropped", () => {
  expect(parseFeed("<html>Not found</html>")).toBeNull();
  expect(parseFeed("version: [unclosed")).toBeNull();
  expect(parseFeed("version: 0.2.0\nfiles:\n  - url: ../secret.dmg\n")!.files).toEqual([]);
  expect(channelFrom("test")).toBe("test");
  expect(channelFrom("beta")).toBe("latest");
  expect(channelFrom(undefined)).toBe("latest");
});

test("the visitor's platform comes from the browser's platform hint, else its user agent", () => {
  expect(platformOf("", "macOS")).toBe("mac");
  expect(platformOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe(
    "mac",
  );
  expect(platformOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
  expect(platformOf("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  expect(platformOf("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBeNull();
  expect(platformOf("Mozilla/5.0 (Linux; Android 15; Pixel 9)")).toBeNull();
  expect(platformOf("", "Chrome OS")).toBeNull();
});
