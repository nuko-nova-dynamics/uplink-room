import { expect, test } from "vitest";
import { opensOutside, startPathAllowed } from "./startPath.ts";

test("the gym runs only unpackaged, in a profile under the temp folder", () => {
  const tmp = "/var/folders/x/T";
  expect(startPathAllowed("/index.html", { packaged: true, userData: "/Users/a/Library/Application Support/Uplink Room", tmp })).toBe(true);
  expect(startPathAllowed("/gym.html?state=inbox", { packaged: false, userData: `${tmp}/uplink-gym-abc`, tmp })).toBe(true);
  expect(startPathAllowed("/gym.html", { packaged: true, userData: `${tmp}/uplink-gym-abc`, tmp })).toBe(false);
  expect(startPathAllowed("/gym.html", { packaged: false, userData: "/Users/a/Library/Application Support/Uplink Room (development)", tmp })).toBe(false);
  expect(startPathAllowed("/gym.html", { packaged: false, userData: tmp, tmp })).toBe(false);
});

test("links leave the app for the browser, except in the gym, which only logs them", () => {
  expect(opensOutside("https://github.com/organizations/harbor-labs/settings/installations/1", "/index.html")).toBe(true);
  expect(opensOutside("https://github.com/organizations/harbor-labs/settings/installations/1", "/gym.html")).toBe(false);
  expect(opensOutside("https://uplinkroom.com", "/gym.html?state=settings&theme=dark")).toBe(false);
  expect(opensOutside("file:///etc/passwd", "/index.html")).toBe(false);
});
