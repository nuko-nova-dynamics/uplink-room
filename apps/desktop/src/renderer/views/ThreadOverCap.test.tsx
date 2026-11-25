// @vitest-environment happy-dom
/**
 * A thread the room stopped because T3 Code took no mode within its machine's cap (ADR 0043) keeps
 * the amber mode chip that says why in its header after it stops; another stopped thread shows none.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { afterEach, expect, test } from "vitest";
import type { MyTeam } from "../lib/api";
import { SessionProvider, ToastProvider } from "../lib/session";
import { FakeConvex } from "../gym/fakeConvex";
import { ThreadView } from "./ThreadView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

const team = { teamId: "team1", memberId: "m1", role: "member", name: "Harbor Labs" } as unknown as MyTeam;
const julio = { memberId: "m1", name: "Julio", kind: "person" as const, role: "member" };
const machine = { machineId: "mac", name: "julio-mbp", online: true, belongsTo: { kind: "person", member: julio }, mostPermissiveMode: "approval-required" };
const run = { runId: "run-1", harness: "codex", title: "Fix invoice totals", state: "stopped", stateChangedAt: 0, machine: { machineId: "mac", name: "julio-mbp" } };
const thread = (overCap: boolean) => ({
  runId: "run-1",
  open: false,
  access: "drive",
  runtimeMode: "full-access",
  runtimeModeOverCap: overCap,
  startedBy: { memberId: "m1", name: "Julio" },
  driver: { memberId: "m1", name: "Julio" },
  watching: [],
  machine: { machineId: "mac", name: "julio-mbp", mostOpenAccess: "open", mostPermissiveMode: "approval-required", passesWheel: true },
});
const nav = { go() {}, openTask() {}, openTerminal() {}, openSpace() {}, openThread() {} };

function mount(overCap: boolean) {
  const convex = new FakeConvex((udfPath) => {
    if (udfPath === "teams:members") return [julio];
    if (udfPath === "runs:get") return run;
    if (udfPath === "threads:get") return thread(overCap);
    if (udfPath === "machines:list") return [machine];
    if (udfPath === "threads:wheelRequests" || udfPath === "threads:suggestions") return [];
    return undefined;
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      <ConvexProvider client={convex as unknown as ConvexReactClient}>
        <ToastProvider>
          <SessionProvider team={team}>
            <ThreadView runId={"run-1" as never} nav={nav as never} />
          </SessionProvider>
        </ToastProvider>
      </ConvexProvider>,
    ),
  );
  return host;
}

test("a thread the room stopped over its machine's cap keeps the amber mode chip that says why", () => {
  const chip = mount(true).querySelector<HTMLElement>(".main-head .mode-chip");
  expect(chip?.classList.contains("amber")).toBe(true);
  expect(chip?.textContent).toBe("Full access");
  expect(chip?.title).toContain("T3 Code didn't take a lower mode, so the room stopped this thread.");
});

test("another stopped thread shows no mode chip", () => {
  expect(mount(false).querySelector(".main-head .mode-chip")).toBeNull();
});
