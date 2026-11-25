// @vitest-environment happy-dom
/** The new direct message popover (spec #63), with the session it reads stood in for. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../../lib/session", () => ({
  useSession: () => ({
    me: { memberId: "mjulio" },
    members: [
      { memberId: "mjulio", name: "Julio", kind: "person" },
      { memberId: "mana", name: "Ana", kind: "person" },
      { memberId: "mben", name: "Ben", kind: "person" },
    ],
  }),
  useAct: () => async (args: unknown) => {
    opened.push(args);
    return { channelId: "cnew", warnings: [] };
  },
  useRoomQuery: () => live,
}));

// runs.live: Ana's Claude Code run, and a run from a conversation Julio isn't in.
const allLive = [
  { runId: "rana000001", label: "Claude Code (Ana)", driver: { memberId: "mana", name: "Ana" }, task: { taskId: "t1", title: "Rig the crane" }, private: false, hearsYou: true, visibleToTeam: true },
  { runId: "rhidden001", label: "Codex (Ben)", driver: { memberId: "mben", name: "Ben" }, private: true, hearsYou: true },
];
let live = allLive;
const opened: unknown[] = [];

const { NewDirectMessage } = await import("./NewDirectMessage");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  live = allLive;
  opened.length = 0;
});

const plus = { top: 100, bottom: 120, right: 140, left: 120, width: 20, height: 20, x: 120, y: 100, toJSON: () => ({}) } as DOMRect;

test("the new direct message popover takes focus when it opens, and a shell update doesn't pull it back to the filter", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const firstClose = vi.fn();
  act(() => root.render(<NewDirectMessage anchor={plus} onClose={firstClose} onOpened={() => {}} />));
  const filter = document.querySelector("input")!;
  expect(document.activeElement).toBe(filter);

  // The person moves on to a teammate in the list; then a message arrives and the shell renders
  // again, with a new onClose.
  const ana = document.querySelector<HTMLButtonElement>(".pick-list button")!;
  act(() => ana.focus());
  const latestClose = vi.fn();
  act(() => root.render(<NewDirectMessage anchor={plus} onClose={latestClose} onOpened={() => {}} />));
  expect(document.activeElement).toBe(ana);

  // Escape still closes it, with the shell's latest handler.
  act(() => {
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(latestClose).toHaveBeenCalledTimes(1);
  expect(firstClose).not.toHaveBeenCalled();
});

test("a direct message can be started with a live run, listed by its name and task under the members", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const onOpened = vi.fn();
  act(() => root.render(<NewDirectMessage anchor={plus} onClose={() => {}} onOpened={onOpened} />));
  const runs = document.querySelector('[aria-label="Live runs"]')!;
  expect([...runs.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Claude Code (Ana)Rig the crane"]);
  act(() => runs.querySelector("button")!.click());
  await act(async () => document.querySelector<HTMLButtonElement>(".new-dm-foot .btn")!.click());
  expect(opened).toEqual([{ memberIds: [], runIds: ["rana000001"] }]);
  expect(onOpened).toHaveBeenCalledWith("cnew");
});

test("a picked run that stops while the picker is open drops out of the pick, so Open still works", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<NewDirectMessage anchor={plus} onClose={() => {}} onOpened={() => {}} />));
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Live runs"] button')!.click());
  const ben = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Members"] button')].find((b) => b.textContent?.includes("Ben"))!;
  act(() => ben.click());

  // Ana's run stops: runs.live no longer lists it.
  live = allLive.filter((r) => r.runId !== "rana000001");
  act(() => root.render(<NewDirectMessage anchor={plus} onClose={() => {}} onOpened={() => {}} />));
  await act(async () => document.querySelector<HTMLButtonElement>(".new-dm-foot .btn")!.click());
  expect(opened).toEqual([{ memberIds: ["mben"] }]);
});

test("picking a team run says, before the direct message opens, that the whole team sees its output (ADR 0039)", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<NewDirectMessage anchor={plus} onClose={() => {}} onOpened={() => {}} />));
  const foot = () => document.querySelector(".new-dm-foot")!.textContent;
  expect(foot()).toContain("Only the people in it can see it.");
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Live runs"] button')!.click());
  expect(document.querySelector(".new-dm-warn")!.textContent).toBe("Claude Code (Ana)'s output is visible to the whole team, so what you send it won't stay private.");
  expect(foot()).not.toContain("Only the people in it can see it.");
});
