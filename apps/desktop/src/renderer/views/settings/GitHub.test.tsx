// @vitest-environment happy-dom
/**
 * Settings, GitHub (ADR 0020): a sync whose action died stays "syncing" in the backend. Once it is
 * past its stale time, Settings says it didn't finish and Sync now starts it again; before that, Sync now
 * waits for it. And each viewer sees the groups and the buttons the backend allows them.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ synced: [] as unknown[], disconnect: vi.fn(), toast: vi.fn() }));
vi.mock("convex/react", () => ({ useMutation: () => mocks.disconnect }));
vi.mock("../../lib/session", () => ({
  useSession: () => ({ teamId: "team" }),
  useToast: () => ({ show: mocks.toast }),
  useAct: () => async (args: unknown) => {
    mocks.synced.push(args);
    return null;
  },
  useRoomQuery: () => undefined,
}));

const { GitHubView, GitHubAvatar } = await import("./GitHub");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  mocks.synced.length = 0;
  mocks.disconnect.mockReset();
  mocks.toast.mockReset();
});

const MINUTE = 60_000;
function account(syncStaleAt: number) {
  return {
    accountId: "acct1",
    login: "nuko",
    type: "Organization" as const,
    repositorySelection: "all" as const,
    repoCount: 4,
    suspended: false,
    syncState: "syncing" as const,
    syncStaleAt,
    connectedAt: Date.now() - 60 * MINUTE,
    connectedBy: "Julio",
    connectedById: "julio",
    mine: false,
    canSync: true,
    canChangeRepos: true,
    canDisconnect: true,
    settingsUrl: "https://github.com/organizations/nuko/settings/installations/1",
  };
}

function render(syncStaleAt: number) {
  const data = {
    configured: true,
    canConnect: true,
    canConnectOrganizations: true,
    accounts: [account(syncStaleAt)],
  };
  return show(data);
}

function show(data: unknown, connects: unknown[] = []) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      <GitHubView
        data={data as never}
        connects={connects as never}
        waiting={false}
        onConnect={() => {}}
      />,
    ),
  );
  return host;
}

const syncButton = (host: HTMLElement) =>
  [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Sync now" || b.textContent === "Syncing…",
  )!;

test("a sync past its stale time says it didn't finish, and Sync now starts it again", async () => {
  const stalled = render(Date.now() - 4 * MINUTE);
  expect(stalled.textContent).toContain("Sync didn't finish. Sync now starts it again.");
  expect(syncButton(stalled).disabled).toBe(false);
  await act(async () => syncButton(stalled).click());
  expect(mocks.synced).toEqual([{ accountId: "acct1" }]);

  const running = render(Date.now() + 9 * MINUTE);
  expect(running.textContent).toContain("syncing now");
  expect(running.textContent).not.toContain("didn't finish");
  expect(syncButton(running).disabled).toBe(true);
});

/** A personal account, as github.accounts gives it to the viewer. */
function personal(
  login: string,
  by: string,
  flags: { mine: boolean; canSync: boolean; canChangeRepos: boolean; canDisconnect: boolean },
) {
  return {
    ...account(Date.now() + 9 * MINUTE),
    accountId: `acct-${login}`,
    login,
    type: "User" as const,
    syncState: "synced" as const,
    syncStaleAt: undefined,
    lastSyncedAt: Date.now() - 5 * MINUTE,
    connectedBy: by,
    ...flags,
    ...(flags.canChangeRepos
      ? { settingsUrl: "https://github.com/settings/installations/2" }
      : { settingsUrl: undefined }),
  };
}

const groups = (host: HTMLElement) =>
  [...host.querySelectorAll("section.gh-group")].map((g) => ({
    label: g.querySelector("h3")!.textContent,
    rows: [...g.querySelectorAll(".gh-account:not(.gh-finish)")].map((row) => ({
      login: row.querySelector(".gh-name b")!.textContent,
      buttons: [...row.querySelectorAll("button")].map((b) => b.textContent),
    })),
  }));

test("a member sees her own account with its actions and the team's organization without any; an admin also sees other people's, with Disconnect only", () => {
  const org = {
    ...account(Date.now() + 9 * MINUTE),
    syncState: "synced" as const,
    lastSyncedAt: Date.now() - MINUTE,
  };
  const orgForMember = {
    ...org,
    canSync: false,
    canChangeRepos: false,
    canDisconnect: false,
    settingsUrl: undefined,
  };
  const own = { mine: true, canSync: true, canChangeRepos: true, canDisconnect: true };
  const someoneElses = (admin: boolean) => ({
    mine: false,
    canSync: false,
    canChangeRepos: false,
    canDisconnect: admin,
  });

  const member = show({
    configured: true,
    canConnect: true,
    canConnectOrganizations: false,
    accounts: [
      personal("ana", "Ana", own),
      personal("bo", "Bo", someoneElses(false)),
      orgForMember,
    ],
  });
  expect(groups(member)).toEqual([
    {
      label: "Your account",
      rows: [{ login: "ana", buttons: ["Change which repos", "Sync now", "Disconnect"] }],
    },
    { label: "Organizations", rows: [{ login: "nuko", buttons: [] }] },
  ]);
  expect(member.textContent).toContain("connected by Julio");
  expect(member.textContent).toContain(
    "If you leave the team, it's disconnected. The App stays installed on your GitHub account until you uninstall it there.",
  );
  expect(member.querySelector(".pane-title button")!.textContent).toContain(
    "Connect another GitHub account",
  );

  const admin = show({
    configured: true,
    canConnect: true,
    canConnectOrganizations: true,
    accounts: [personal("bo", "Bo", someoneElses(true)), org],
  });
  expect(groups(admin)).toEqual([
    { label: "Your account", rows: [] },
    {
      label: "Organizations",
      rows: [{ login: "nuko", buttons: ["Change which repos", "Sync now", "Disconnect"] }],
    },
    { label: "Other people's accounts", rows: [{ login: "bo", buttons: ["Disconnect"] }] },
  ]);
  expect(admin.textContent).toContain("You haven't connected your GitHub account.");
  expect(admin.textContent).toContain("connected by Bo");
});

test("a connect GitHub sent back waits under Finish connecting: it names who signed in to GitHub, and Connect sends only the account chosen", async () => {
  const offered = (
    installationId: number,
    login: string,
    type: "Organization" | "User",
    more: Record<string, unknown>,
  ) => ({
    installationId,
    login,
    type,
    repositorySelection: "all" as const,
    suspended: false,
    claimed: false,
    connected: false,
    checking: false,
    canConnect: false,
    ...more,
  });
  const flow = {
    connectId: "flow1",
    teamName: "Nuko Nova",
    githubLogin: "ana",
    expiresAt: Date.now() + 24 * MINUTE,
    status: "waiting" as const,
    accounts: [
      offered(53, "ana", "User", { claimed: true, canConnect: true }),
      offered(51, "nuko", "Organization", {
        refusal: "admin",
        why: "Only an admin of Nuko Nova can connect an organization.",
      }),
      offered(54, "tide", "Organization", {
        canConnect: true,
        refused: "Only an owner of tide can connect it, and GitHub no longer lists ana as one.",
      }),
    ],
  };
  const host = show(
    { configured: true, canConnect: true, canConnectOrganizations: false, accounts: [] },
    [flow],
  );
  expect(groups(host)).toEqual([
    {
      label: "Finish connecting",
      rows: [
        { login: "ana", buttons: ["Connect"] },
        { login: "nuko", buttons: [] },
        { login: "tide", buttons: ["Connect"] },
      ],
    },
  ]);
  expect(host.textContent).toContain("GitHub signed in as ana.");
  expect(host.textContent).toContain("Expires in 24 minutes");
  expect(host.textContent).toContain("Team admins only");
  expect(host.textContent).toContain(
    "If ana isn't your GitHub account, someone else finished this on GitHub: choose Cancel.",
  );
  // Nothing else competes with it: no empty state while the first connect waits.
  expect(host.textContent).not.toContain("No GitHub accounts connected yet");
  // The account she installed the App on is the one primary Connect; the page's own Connect steps back.
  expect([...host.querySelectorAll("button.primary")].map((b) => b.textContent)).toEqual([
    "Connect",
  ]);
  await act(async () =>
    [...host.querySelectorAll(".gh-account")][1]!.querySelector("button")!.click(),
  );
  expect(mocks.synced).toEqual([{ connectId: "flow1", installationId: 53 }]);

  // While the room asks GitHub, every Connect waits; an expired connect isn't shown at all.
  const checking = show(
    { configured: true, canConnect: true, canConnectOrganizations: false, accounts: [] },
    [
      {
        ...flow,
        status: "checking",
        checkStaleAt: Date.now() + MINUTE,
        accounts: flow.accounts.map((a) => ({ ...a, checking: a.installationId === 53 })),
      },
    ],
  );
  const buttons = [
    ...checking.querySelectorAll(".gh-account:not(.gh-finish) button"),
  ] as HTMLButtonElement[];
  expect(buttons.map((b) => [b.textContent, b.disabled])).toEqual([
    ["Connecting…", true],
    ["Connect", true],
  ]);
  const expired = show(
    { configured: true, canConnect: true, canConnectOrganizations: false, accounts: [] },
    [{ ...flow, expiresAt: Date.now() - 1000 }],
  );
  expect(expired.textContent).not.toContain("Finish connecting");
});

test("an avatar keeps its initial until loaded, and recovers from a failed image when the URL changes", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<GitHubAvatar login="rosa" type="User" avatarUrl="first.png" />));
  expect(host.querySelector(".gh-avatar")?.textContent).toBe("R");
  act(() => host.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(host.querySelector(".gh-avatar")?.getAttribute("data-image-state")).toBe("fallback");
  expect(host.querySelector("img")).toBeNull();
  act(() => root.render(<GitHubAvatar login="rosa" type="User" avatarUrl="second.png" />));
  expect(host.querySelector(".gh-avatar")?.textContent).toBe("R");
  act(() => host.querySelector("img")!.dispatchEvent(new Event("load")));
  expect(host.querySelector(".gh-avatar")?.getAttribute("data-image-state")).toBe("loaded");
  expect(host.querySelector(".gh-avatar")?.textContent).toBe("");
});

test("disconnect prevents duplicate submissions, shows failure in the dialog, and permits a retry", async () => {
  let fail!: (error: Error) => void;
  mocks.disconnect.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  const host = render(Date.now());
  act(() =>
    [...host.querySelectorAll<HTMLButtonElement>(".gh-account button")]
      .find((b) => b.textContent === "Disconnect")!
      .click(),
  );
  const submit = () => document.querySelector<HTMLButtonElement>(".dialog-foot .primary")!;
  act(() => {
    submit().click();
    submit().click();
  });
  expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  // UI SDK's Button keeps focus while pending: busy and unavailable, not natively disabled.
  expect(submit().getAttribute("aria-busy")).toBe("true");
  expect(submit().getAttribute("aria-disabled")).toBe("true");
  expect(submit().textContent).toBe("Disconnecting…");
  await act(async () => fail(new Error("GitHub is unavailable")));
  expect(document.querySelector('.dialog [role="alert"]')?.textContent).toContain("GitHub is unavailable");
  expect(submit().getAttribute("aria-disabled")).toBeNull();
  mocks.disconnect.mockResolvedValueOnce(null);
  await act(async () => submit().click());
  expect(document.querySelector(".dialog")).toBeNull();
  expect(mocks.disconnect).toHaveBeenCalledTimes(2);
});
