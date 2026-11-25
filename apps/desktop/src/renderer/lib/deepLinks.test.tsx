// @vitest-environment happy-dom
/**
 * Links into the app (lib/deepLinks.ts): a welcome email's open link waits through Clerk's
 * sign-in reload, and a link that names nothing the person can see, such as a made-up channel id,
 * goes nowhere and says so instead of blanking the app.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const session = vi.hoisted(() => ({
  channels: undefined as { channelId: string }[] | undefined,
  toast: vi.fn<(text: string) => void>(),
}));
vi.mock("./session", () => ({
  useRoomQuery: () => session.channels,
  useToast: () => ({ show: session.toast }),
}));
vi.mock("./desktop", () => ({ desktop: {} }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TEAM = "k57team";
const GENERAL = "jn7general";

async function load() {
  vi.resetModules();
  return await import("./deepLinks");
}

beforeEach(() => {
  sessionStorage.clear();
  session.channels = [{ channelId: GENERAL }];
  session.toast.mockReset();
});

afterEach(() => {
  document.body.innerHTML = "";
});

/** Mounts the Shell's part: useOpenLink for TEAM, with a nav that records where it went. */
async function mountShell(links: Awaited<ReturnType<typeof load>>) {
  const go = vi.fn();
  function Shell() {
    links.useOpenLink({ go } as never, TEAM);
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = () => act(async () => root.render(<Shell />));
  await render();
  return { go, root, render };
}

test("an open link waits through the sign-in reload in sessionStorage, and goes once it's used", async () => {
  let links = await load();
  links.receive({ kind: "open", path: ["team", TEAM, "settings", "machines"] });
  expect(JSON.parse(sessionStorage.getItem("uplink.pendingOpen")!)).toEqual({ teamId: TEAM, path: ["settings", "machines"] });

  // Clerk reloads the page as it signs someone in: the module starts again from storage.
  links = await load();
  expect(links.pendingLinks().open).toEqual({ teamId: TEAM, path: ["settings", "machines"] });

  const { go, root } = await mountShell(links);
  expect(go).toHaveBeenCalledWith({ name: "settings", section: "machines" });
  expect(sessionStorage.getItem("uplink.pendingOpen")).toBeNull();
  act(() => root.unmount());
});

test("a made-up channel id goes nowhere: the app stays put and says the link opens nothing", async () => {
  const links = await load();
  links.receive({ kind: "open", path: ["team", TEAM, "channel", "not-a-convex-id"] });
  const { go, root } = await mountShell(links);
  expect(go).not.toHaveBeenCalled();
  expect(session.toast).toHaveBeenCalledWith(links.NOTHING_TO_OPEN);
  expect(links.pendingLinks().open).toBeNull();
  expect(sessionStorage.getItem("uplink.pendingOpen")).toBeNull();
  act(() => root.unmount());
});

test("a channel link waits for the channel list, then opens a channel this person can see", async () => {
  const links = await load();
  session.channels = undefined;
  links.receive({ kind: "open", path: ["team", TEAM, "channel", GENERAL] });
  const { go, root, render } = await mountShell(links);
  expect(go).not.toHaveBeenCalled();
  expect(links.pendingLinks().open).not.toBeNull();

  session.channels = [{ channelId: GENERAL }];
  await render();
  expect(go).toHaveBeenCalledWith({ name: "channel", channelId: GENERAL });
  act(() => root.unmount());
});

test("only places in the team resolve: its Inbox, a known channel, a settings section", async () => {
  const { resolveOpen } = await load();
  const channels = [{ channelId: GENERAL }];
  expect(resolveOpen([], channels)).toEqual({ name: "inbox" });
  expect(resolveOpen(["settings", "agents"], channels)).toEqual({ name: "settings", section: "agents" });
  // The GitHub connect page's Return to Uplink Room link.
  expect(resolveOpen(["settings", "github"], channels)).toEqual({ name: "settings", section: "github" });
  for (const path of [["settings", "secrets"], ["channel", "jn7other"], ["channel"], ["run", "x"], ["channel", GENERAL, "extra"]]) {
    expect(resolveOpen(path, channels)).toBeNull();
  }
  expect(resolveOpen(["channel", GENERAL], undefined)).toBeUndefined();
  // A message link opens the channel at the message; any other tail is refused.
  expect(resolveOpen(["channel", GENERAL, "message", "k97abcdef"], channels)).toEqual({
    name: "channel",
    channelId: GENERAL,
    messageId: "k97abcdef",
  });
  expect(resolveOpen(["channel", GENERAL, "thread", "k97abcdef"], channels)).toBeNull();
  expect(resolveOpen(["channel", "jn7other", "message", "k97abcdef"], channels)).toBeNull();
});

test("a message link points at the site's open page with the team, channel and message", async () => {
  const { messageLink, SITE_ORIGIN } = await load();
  expect(messageLink(TEAM, GENERAL, "k97abcdef")).toBe(`${SITE_ORIGIN}/open#team/${TEAM}/channel/${GENERAL}/message/k97abcdef`);
});

test("a stored link that isn't one is ignored after the reload", async () => {
  sessionStorage.setItem("uplink.pendingOpen", JSON.stringify({ teamId: "../x", path: ["settings"] }));
  sessionStorage.setItem("uplink.pendingInvite", "<script>");
  const links = await load();
  expect(links.pendingLinks()).toEqual({ invite: null, open: null });
});

test("a link for the current team closes the team picker so the team can open it; other teams switch or are refused", async () => {
  const { openLinkTeamStep } = await load();
  const teams = [{ teamId: TEAM }, { teamId: "k57other" }];
  expect(openLinkTeamStep(TEAM, TEAM, teams, true)).toBe("show-team");
  expect(openLinkTeamStep(TEAM, TEAM, teams, false)).toBe("none");
  expect(openLinkTeamStep("k57other", TEAM, teams, false)).toBe("switch");
  expect(openLinkTeamStep("k57other", undefined, teams, true)).toBe("switch");
  expect(openLinkTeamStep("k57notmine", TEAM, teams, false)).toBe("refuse");
  expect(openLinkTeamStep(undefined, TEAM, teams, true)).toBe("none");
});
