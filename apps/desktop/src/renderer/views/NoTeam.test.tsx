// @vitest-environment happy-dom
/**
 * The home of someone in no team: the app menu's Settings… (and Command-comma) opens their
 * Settings, on Command line, as it opens a team's Settings in the Shell.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ menu: [] as (() => void)[], pending: false }));

vi.mock("convex/react", () => ({ useQuery: () => undefined }));
vi.mock("@clerk/electron/react", () => ({ UserButton: () => null }));
vi.mock("../lib/desktop", () => ({
  desktop: {
    onOpenSettings: (listener: () => void) => {
      mocks.menu.push(listener);
      return () => mocks.menu.splice(mocks.menu.indexOf(listener), 1);
    },
    takeOpenSettings: async () => mocks.pending,
  },
}));
vi.mock("../components/TeamForms", () => ({ TeamForms: () => null }));
vi.mock("../components/UpdateReady", () => ({ UpdateReady: () => null }));
vi.mock("./Pairs", () => ({
  usePairs: () => ({ pairs: [], more: undefined }),
  PairsNav: () => null,
  PairsLanding: () => <p className="stub-home">Pairs and teams</p>,
  PairConversation: () => null,
  PairStart: () => null,
}));
vi.mock("./Settings", () => ({
  ACCOUNT_SECTIONS: ["commandLine", "appearance"],
  SettingsView: ({ section }: { section: string }) => <p className="stub-settings">{section}</p>,
}));

const { NoTeamHome } = await import("./NoTeam");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  mocks.menu.length = 0;
  mocks.pending = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const prefs = { theme: "dark" } as never;

test("Settings… in the app menu opens Command line for someone in no team", async () => {
  await act(async () => root.render(<NoTeamHome prefs={prefs} onJoined={() => {}} account={<span />} />));
  expect(document.querySelector(".stub-home")).not.toBeNull();
  expect(mocks.menu).toHaveLength(1);
  await act(async () => mocks.menu[0]!());
  expect(document.querySelector(".stub-settings")?.textContent).toBe("commandLine");
});

test("Settings… chosen with no window open opens Command line once this window is up", async () => {
  mocks.pending = true;
  await act(async () => root.render(<NoTeamHome prefs={prefs} onJoined={() => {}} account={<span />} />));
  expect(document.querySelector(".stub-settings")?.textContent).toBe("commandLine");
});
