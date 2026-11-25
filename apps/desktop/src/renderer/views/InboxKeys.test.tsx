// @vitest-environment happy-dom
/**
 * The Inbox's row keys: Z opens Snooze by the focused row with its first item active, J and K move
 * through it as the arrows do, Enter picks, and Escape closes it so the row keys work again.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { settle } from "@ui-sdk/core/testing";
import { afterEach, expect, test, vi } from "vitest";
import type { MyTeam } from "../lib/api";
import { pendingActions } from "../lib/pendingActions";
import { SessionProvider, ToastProvider } from "../lib/session";
import { FakeConvex } from "../gym/fakeConvex";
import type { Nav } from "../Shell";
import { Inbox } from "./Inbox";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const id of pendingActions.ids()) pendingActions.cancel(id);
  document.body.innerHTML = "";
  localStorage.clear();
});

const team = {
  teamId: "team1",
  memberId: "m1",
  role: "admin",
  name: "Nuko Nova",
} as unknown as MyTeam;
const julio = { memberId: "m1", name: "Julio", kind: "person" as const, role: "admin" };
const ana = { memberId: "m2", name: "Ana", kind: "person" as const, role: "member" };

/** A finished task with one finished run, as inbox.get lists it under Done. */
const done = (n: number) => ({
  taskId: `task${n}`,
  title: `Finished task ${n}`,
  state: "done",
  changedAt: n,
  waitingOn: [],
  owner: julio,
  runs: [
    {
      runId: `run${n}`,
      harness: "claude-code",
      state: "done",
      startedAt: 1,
      stateChangedAt: 2,
      driver: julio,
    },
  ],
});

function mount() {
  // Done starts folded; open it, as a person does, so its rows take the keys.
  localStorage.setItem("uplink.inbox.doneOpen", "1");
  const calls: { path: string; args: Record<string, unknown> }[] = [];
  const convex = new FakeConvex(
    (udfPath) =>
      ({
        "teams:members": [julio, ana],
        "inbox:get": { needsYou: [], working: [], done: [done(1), done(2)] },
        "projects:list": [],
        "machines:list": [],
        "teams:roster": [],
        "channels:list": [],
        "members:link": null,
        "tasks:board": [],
      })[udfPath],
    (udfPath, args) => {
      calls.push({ path: udfPath, args });
      return Promise.resolve(null);
    },
    () => () => {},
  );
  const nav = { openTask: vi.fn(), openRun: vi.fn() } as unknown as Nav;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      <ConvexProvider client={convex as unknown as ConvexReactClient}>
        <ToastProvider>
          <SessionProvider team={team}>
            <Inbox
              nav={nav}
              groupByProject={false}
              setGroupByProject={() => {}}
              projectFilter="all"
              setProjectFilter={() => {}}
              frozen={false}
            />
          </SessionProvider>
        </ToastProvider>
      </ConvexProvider>,
    ),
  );
  return { host, nav, calls };
}

/** A key as a person presses it: on whatever has focus, bubbling to the window. */
async function press(key: string) {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await act(() => settle());
}

const snooze = () =>
  document.querySelector<HTMLElement>('[role="menu"][aria-label="Snooze until"]');
const active = () => document.activeElement?.textContent ?? "";

test("Z opens Snooze with its first item active, J and K move through it, and Enter snoozes the row", async () => {
  const { host } = mount();
  await act(() => settle());
  expect(host.querySelectorAll(".inbox-row")).toHaveLength(2);
  await press("z");
  expect(snooze()).not.toBeNull();
  expect(active()).toMatch(/^In 1 hour/);
  await press("j");
  expect(active()).toMatch(/^Tomorrow morning/);
  await press("k");
  await press("ArrowDown");
  expect(active()).toMatch(/^Tomorrow morning/);
  await press("Enter");
  // Snoozed rows wait a few seconds for Undo before they're sent; the row leaves at once.
  expect(snooze()).toBeNull();
  expect([...host.querySelectorAll(".inbox-row")].map((r) => r.getAttribute("aria-label"))).toEqual(
    ["Finished task 2"],
  );
  expect(pendingActions.ids().has("task1")).toBe(true);
});

test("the filter menu picks Team in one press and closes", async () => {
  const { host } = mount();
  await act(() => settle());
  const trigger = host.querySelector<HTMLButtonElement>(".inbox-filter .btn")!;
  expect(trigger.getAttribute("aria-label")).toBe("Showing Mine");
  act(() => trigger.click());
  await act(() => settle());
  const team = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
    (item) => item.textContent === "Team",
  )!;
  act(() => team.click());
  await act(() => settle());
  expect(document.querySelector('[role="menu"][aria-label="Show"]')).toBeNull();
  expect(trigger.getAttribute("aria-label")).toBe("Showing Team");
});

test("Escape closes the row menu and the row keys work again", async () => {
  const { host, nav } = mount();
  await act(() => settle());
  await press("z");
  expect(snooze()).not.toBeNull();
  await press("Escape");
  expect(snooze()).toBeNull();
  // J moves to the next row, and Enter opens it.
  await press("j");
  expect(host.querySelector('.inbox-row[data-focus="true"]')?.getAttribute("aria-label")).toBe(
    "Finished task 2",
  );
  await press("Enter");
  expect(nav.openTask).toHaveBeenCalledWith("task2");
});

test("keys in a popup over the Inbox stay in the popup: its letters and Enter don't act on a row", async () => {
  const { host, nav } = mount();
  await act(() => settle());
  // A UI SDK menu open over the Inbox, as Send to is, its item focused: its items aren't buttons.
  const menu = document.createElement("div");
  menu.setAttribute("data-slot", "menu-content");
  menu.setAttribute("data-open", "");
  menu.setAttribute("role", "menu");
  const item = document.createElement("div");
  item.setAttribute("role", "menuitemradio");
  item.tabIndex = 0;
  menu.append(item);
  document.body.append(menu);
  act(() => item.focus());
  // J would move the row focus, and Enter open the row.
  await press("j");
  await press("Enter");
  expect(nav.openTask).not.toHaveBeenCalled();
  expect(host.querySelector('.inbox-row[data-focus="true"]')?.getAttribute("aria-label")).toBe(
    "Finished task 1",
  );
  menu.remove();
});
