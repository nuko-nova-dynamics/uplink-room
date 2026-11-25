// @vitest-environment happy-dom
/**
 * Settling from the task panel: one press sends one settle, and once the room has it the panel
 * shows the task as settled instead of offering Settle again. The panel is a modal side panel
 * (UI SDK's Dialog, inline) that Escape closes. Its owner can keep a task's only
 * run, which closes it. Giving a task to a roster agent
 * (ADR 0044): Start a run lists every agent in the roster and sends runs.start via "agent".
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { afterEach, expect, test, vi } from "vitest";
import { settle } from "@ui-sdk/core/testing";
import type { Id, MyTeam } from "../lib/api";
import { SessionProvider, ToastProvider } from "../lib/session";
import { FakeConvex } from "../gym/fakeConvex";
import type { Nav } from "../Shell";
import { StartRunDialog, TaskPanel } from "./TaskPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

const team = { teamId: "team1", memberId: "m1", role: "admin", name: "Nuko Nova" } as unknown as MyTeam;
const julio = { memberId: "m1", name: "Julio", kind: "person" as const, role: "admin" };
const axel = { memberId: "m2", name: "Axel", kind: "person" as const, role: "member" };
const dayAgo = Date.now() - 86_400_000;

function run(runId: string, state: "done" | "failed") {
  return {
    runId,
    harness: "claude-code",
    state,
    private: false,
    driver: axel,
    startedAt: dayAgo,
    stateChangedAt: dayAgo,
    endedAt: dayAgo,
    canReply: false,
    settled: false,
    ...(state === "failed" ? { failReason: "Agent error" } : {}),
  };
}

/** "Fix Agent error", owned by Axel: 3 runs, 1 failed a day ago and 2 done. */
function task(settled: boolean) {
  return {
    taskId: "task1",
    title: "Fix Agent error",
    private: false,
    owner: axel,
    createdBy: julio,
    createdAt: dayAgo,
    state: "failed",
    settled,
    column: settled ? "done" : "needs_someone",
    waitingOn: [],
    runs: [run("r1", "failed"), run("r2", "done"), run("r3", "done")],
  };
}

function mount() {
  let settled = false;
  const listeners = new Set<() => void>();
  const settles: { args: Record<string, unknown>; resolve: () => void }[] = [];
  const convex = new FakeConvex(
    (udfPath) =>
      ({ "teams:members": [julio, axel], "tasks:get": task(settled), "projects:list": [], "machines:list": [] })[udfPath],
    (udfPath, args) => {
      if (udfPath !== "inbox:settle") return Promise.resolve(null);
      return new Promise((resolve) =>
        settles.push({
          args,
          // The room stores it and the subscription updates before the mutation answers, as Convex does.
          resolve: () => {
            settled = true;
            for (const listener of listeners) listener();
            resolve(null);
          },
        }),
      );
    },
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      <ConvexProvider client={convex as unknown as ConvexReactClient}>
        <ToastProvider>
          <SessionProvider team={team}>
            <TaskPanel taskId={"task1" as Id<"tasks">} nav={{} as Nav} onClose={() => {}} />
          </SessionProvider>
        </ToastProvider>
      </ConvexProvider>,
    ),
  );
  const settleButton = () =>
    [...host.querySelectorAll<HTMLButtonElement>(".drawer-head button")].find((b) => b.textContent?.trim() === "Settle");
  const toasts = () => [...document.querySelectorAll(".toast")].map((t) => t.textContent?.trim());
  return { host, settles, settleButton, toasts };
}

test("Settle sends once however often it's pressed, then the panel shows the task settled", async () => {
  const { host, settles, settleButton, toasts } = mount();
  expect(host.querySelector(".task-summary")?.textContent).toBe("3 runs: 1 failed, 2 done");
  const button = settleButton()!;
  expect(button).toBeDefined();

  act(() => {
    for (let i = 0; i < 7; i++) button.click();
  });
  expect(settles).toHaveLength(1);
  expect(settles[0]!.args).toMatchObject({ taskId: "task1" });
  // Pending on UI SDK's Button: busy and ignoring presses, not natively disabled.
  expect(settleButton()?.getAttribute("aria-busy")).toBe("true");

  await act(async () => settles[0]!.resolve());

  expect(settleButton()).toBeUndefined();
  expect(host.querySelector(".task-settled")?.textContent?.trim()).toBe("Settled");
  expect(toasts()).toEqual(["Settled"]);
});

test("The panel is a modal side panel over the view: Escape and its close button close it, and only the scrim beside it stays usable", async () => {
  const convex = new FakeConvex(
    (udfPath) =>
      ({ "teams:members": [julio, axel], "tasks:get": task(false), "projects:list": [], "machines:list": [] })[udfPath],
    async () => null,
  );
  const sidebar = document.createElement("nav");
  const host = document.createElement("main");
  document.body.append(sidebar, host);
  const root = createRoot(host);
  roots.push(root);
  const closes = vi.fn();
  act(() =>
    root.render(
      <ConvexProvider client={convex as unknown as ConvexReactClient}>
        <ToastProvider>
          <SessionProvider team={team}>
            <div className="drawer-scrim" />
            <TaskPanel taskId={"task1" as Id<"tasks">} nav={{} as Nav} onClose={closes} />
          </SessionProvider>
        </ToastProvider>
      </ConvexProvider>,
    ),
  );
  await act(() => settle());
  const panel = host.querySelector<HTMLElement>("aside.drawer")!;
  expect(panel.getAttribute("role")).toBe("dialog");
  expect(panel.getAttribute("aria-modal")).toBe("true");
  expect(panel.getAttribute("aria-label")).toBe("Task");
  // Focus starts on the panel, so no control shows a ring before a key is pressed.
  expect(document.activeElement).toBe(panel);
  expect(sidebar.inert).toBe(true);
  expect(host.querySelector<HTMLElement>(".drawer-scrim")!.inert).toBe(false);

  act(() => {
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(closes).toHaveBeenCalledTimes(1);
  closes.mockClear();
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Close task"]')!.click());
  expect(closes).toHaveBeenCalledTimes(1);
});

test("The owner can keep a task's only run, which closes the task", async () => {
  const keeps: Record<string, unknown>[] = [];
  const only = { ...task(false), owner: julio, state: "done", runs: [run("r1", "done")] };
  const convex = new FakeConvex(
    (udfPath) =>
      ({ "teams:members": [julio, axel], "tasks:get": only, "projects:list": [], "machines:list": [] })[udfPath],
    async (udfPath, args) => {
      if (udfPath === "tasks:keepRun") keeps.push(args);
      return null;
    },
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      <ConvexProvider client={convex as unknown as ConvexReactClient}>
        <ToastProvider>
          <SessionProvider team={team}>
            <TaskPanel taskId={"task1" as Id<"tasks">} nav={{} as Nav} onClose={() => {}} />
          </SessionProvider>
        </ToastProvider>
      </ConvexProvider>,
    ),
  );
  const keep = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === "Keep this run",
  );
  expect(keep).toBeDefined();

  await act(async () => keep!.click());

  expect(keeps).toEqual([{ teamId: "team1", taskId: "task1", runId: "r1" }]);
});

/** The roster: Icarus over A2A, Grok Bot at its routine webhook, Duet checking in, and a harness that isn't an agent. */
const roster = [
  {
    kind: "agent",
    memberId: "m3",
    agentId: "a-icarus",
    name: "Icarus",
    state: "idle",
    runs: 0,
    reach: "a2a",
  },
  {
    kind: "agent",
    memberId: "m4",
    agentId: "a-grok",
    name: "Grok Bot",
    state: "idle",
    runs: 0,
    reach: "webhook",
  },
  {
    kind: "agent",
    memberId: "m5",
    agentId: "a-duet",
    name: "Duet",
    state: "working",
    runs: 1,
    reach: "checks_in",
  },
  { kind: "harness", name: "claude-code", state: "working", runs: 1, joined: 0 },
];

function mountStart(props: { agentId?: Id<"agents"> } = {}) {
  const starts: Record<string, unknown>[] = [];
  const answers: Record<string, unknown> = {
    "teams:members": [julio, axel],
    "teams:roster": roster,
    "a2a:list": [
      {
        agentId: "a-icarus",
        agent: { name: "Icarus" },
        status: "ready",
        cardUrl: "https://icarus.example.com",
        cancel: "unsupported",
      },
    ],
    "machines:list": [],
    "projects:list": [],
    "profiles:mine": [],
  };
  const convex = new FakeConvex(
    (udfPath) => answers[udfPath],
    async (udfPath, args) => {
      if (udfPath === "runs:start") starts.push(args);
      return { runId: "r9", terminalId: undefined };
    },
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  let closed = false;
  act(() =>
    root.render(
      <ConvexProvider client={convex as unknown as ConvexReactClient}>
        <ToastProvider>
          <SessionProvider team={team}>
            <StartRunDialog
              taskId={"task1" as Id<"tasks">}
              projectId={undefined}
              onClose={() => (closed = true)}
              nav={{} as Nav}
              {...props}
            />
          </SessionProvider>
        </ToastProvider>
      </ConvexProvider>,
    ),
  );
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>(".dialog button")];
  const button = (text: string) => buttons().find((b) => b.textContent?.trim() === text);
  return { starts, buttons, button, closed: () => closed };
}

test("Start a run gives the task to any agent in the roster, said by how the room reaches it", async () => {
  const { starts, buttons, button, closed } = mountStart();
  act(() => button("An agent from the roster")!.click());
  const options = buttons().filter((b) => b.classList.contains("machine-option"));
  // Every roster agent, and no harness.
  expect(options.map((o) => o.querySelector(":scope > .face + span")?.textContent)).toEqual([
    "Icarus",
    "Grok Bot",
    "Duet",
  ]);
  expect(options.map((o) => o.querySelector(".sub")?.textContent)).toEqual([
    "It runs on its own gateway. The room follows its task and shows what it reports. Its gateway can't be asked to stop.",
    "Its routine gets the task. It reports back here.",
    "It sees the task when it checks the room.",
  ]);
  expect(button("Give to an agent")?.disabled).toBe(true);

  act(() => options[2]!.click());
  await act(async () => button("Give to Duet")!.click());
  expect(starts).toEqual([{ teamId: "team1", taskId: "task1", via: "agent", agentId: "a-duet" }]);
  expect(closed()).toBe(true);
});

test("Start a run opened for an agent has it picked, and sends what to tell it", async () => {
  const { starts, button } = mountStart({ agentId: "a-grok" as Id<"agents"> });
  expect(
    document.querySelector(".dialog [aria-checked=true].machine-option")?.textContent,
  ).toContain("Grok Bot");
  const box = document.querySelector<HTMLTextAreaElement>("#a2a-prompt")!;
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    set.call(box, "Only the CSV export, please.");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Give to Grok Bot")!.click());
  expect(starts).toEqual([
    {
      teamId: "team1",
      taskId: "task1",
      via: "agent",
      agentId: "a-grok",
      prompt: "Only the CSV export, please.",
    },
  ]);
});
