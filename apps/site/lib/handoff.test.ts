import { expect, test } from "vitest";
import { appInviteLink, appOpenLink, inviteToken, openPath } from "./handoff";

const TOKEN = "uri_166e9f648a1eaac2b2cca0ea199de6072fc4c71999e801a7";

test("the invite page takes the token from the fragment and hands it to the app", () => {
  expect(inviteToken(`#${TOKEN}`)).toBe(TOKEN);
  expect(appInviteLink(TOKEN)).toBe(`uplink-room://invite/${TOKEN}`);
  for (const bad of ["", "#", "#short", `#${TOKEN}/x`, "#<img src=x>", `#${TOKEN}?a=b`]) {
    expect(inviteToken(bad)).toBeNull();
  }
});

test("the open page takes only a team path of plain ids", () => {
  expect(openPath("#team/k57abc/settings/machines")).toEqual(["team", "k57abc", "settings", "machines"]);
  expect(appOpenLink(["team", "k57abc", "channel", "k99def"])).toBe("uplink-room://open/team/k57abc/channel/k99def");
  for (const bad of ["#", "#settings/machines", "#team", "#team/../../x", "#team/k57abc/javascript:alert(1)"]) {
    expect(openPath(bad)).toBeNull();
  }
});
