import { expect, test, vi } from "vitest";
import { DeepLinkQueue, deepLinkFromArgv, parseDeepLink } from "./deepLink";

const TOKEN = "uri_166e9f648a1eaac2b2cca0ea199de6072fc4c71999e801a7";

test("join and open links parse, and Clerk's sign-in callback and anything malformed don't", () => {
  expect(parseDeepLink(`uplink-room://invite/${TOKEN}`)).toEqual({ kind: "invite", token: TOKEN });
  expect(parseDeepLink(`uplink-room://invite/${TOKEN}/`)).toEqual({ kind: "invite", token: TOKEN });
  expect(parseDeepLink("uplink-room://open/team/k57abc/settings/machines")).toEqual({
    kind: "open",
    path: ["team", "k57abc", "settings", "machines"],
  });
  for (const other of [
    "uplink-room://app/?__clerk_attempt=1",
    "uplink-room://invite/",
    "uplink-room://invite/short",
    `uplink-room://invite/${TOKEN}/extra`,
    "uplink-room://invite/<script>alert(1)</script>",
    "uplink-room://open/settings/machines",
    "uplink-room://open/team/k57abc/../../etc",
    `https://uplinkroom.com/invite#${TOKEN}`,
    "not a url",
    42,
  ]) {
    expect(parseDeepLink(other)).toBeNull();
  }
});

test("Windows and Linux pass the link among the launch arguments", () => {
  expect(deepLinkFromArgv(["/Applications/Uplink Room", "--flag", `uplink-room://invite/${TOKEN}`])).toEqual({
    kind: "invite",
    token: TOKEN,
  });
  expect(deepLinkFromArgv(["uplink-room", "uplink-room://app/"])).toBeNull();
});

test("links wait until the window takes them, and a repeated link counts once", () => {
  const arrived = vi.fn();
  const queue = new DeepLinkQueue(arrived);
  const link = { kind: "invite" as const, token: TOKEN };
  queue.push(link);
  queue.push(link);
  expect(arrived).toHaveBeenCalledTimes(1);
  expect(queue.take()).toEqual([link]);
  expect(queue.take()).toEqual([]);
});
