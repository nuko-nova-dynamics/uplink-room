// @vitest-environment happy-dom
/**
 * Settings, Command line (ADR 0030): each signed-in computer with when it signed in, was last used
 * and works until, and Revoke, which asks once more because it ends that computer's joined runs.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const NOW = Date.UTC(2026, 10, 5, 12);
const mocks = vi.hoisted(() => ({ sent: [] as { name: string; args: unknown }[], toasts: [] as string[], signIns: [] as unknown[] }));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (ref: never) => (getFunctionName(ref) === "people:signIns" ? mocks.signIns : undefined),
    useMutation: (ref: never) => async (args: unknown) => {
      mocks.sent.push({ name: getFunctionName(ref), args });
      return null;
    },
  };
});
vi.mock("../../lib/session", () => ({ useToast: () => ({ show: (text: string) => mocks.toasts.push(text) }) }));
vi.mock("../../components/useNow", () => ({ useNow: () => NOW }));

const { CommandLine } = await import("./CommandLine");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  mocks.sent.length = 0;
  mocks.toasts.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const click = async (label: string) => {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
  await act(async () => found.click());
};

test("each signed-in computer says where, when it signed in and was last used, and until when it works", async () => {
  mocks.signIns = [
    { signInId: "s1", name: "rosa-mbp", prefix: "urs_3f9a", createdAt: NOW - 3 * 86_400_000, lastUsedAt: NOW - 2 * 3_600_000, expiresAt: Date.UTC(2026, 11, 2, 12), current: false },
    { signInId: "s2", name: "build-box", prefix: "urs_77c1", createdAt: NOW - 3_600_000, expiresAt: Date.UTC(2026, 11, 5, 12), current: false },
  ];
  await act(async () => root.render(<CommandLine />));
  const rows = [...document.querySelectorAll(".cli-signin")].map((r) => r.textContent);
  expect(rows[0]).toContain("rosa-mbp");
  expect(rows[0]).toContain("Signed in 3d ago. Last used 2h ago. Works until Dec 2.");
  expect(rows[0]).toContain("urs_3f9a");
  expect(rows[1]).toContain("Not used yet.");
});

test("Revoke asks once more, then signs that computer out", async () => {
  mocks.signIns = [{ signInId: "s1", name: "rosa-mbp", prefix: "urs_3f9a", createdAt: NOW - 86_400_000, expiresAt: Date.UTC(2026, 11, 4, 12), current: false }];
  await act(async () => root.render(<CommandLine />));
  await click("Revoke");
  expect(mocks.sent).toEqual([]);
  expect(document.querySelector(".cli-confirm")?.textContent).toContain("the runs its sessions joined with uplink join end");
  await click("Revoke");
  expect(mocks.sent).toEqual([{ name: "people:revokeSignIn", args: { signInId: "s1" } }]);
  expect(mocks.toasts).toEqual(["Signed out rosa-mbp"]);
});

test("with no computer signed in, it says how to sign one in", async () => {
  mocks.signIns = [];
  await act(async () => root.render(<CommandLine />));
  expect(document.querySelector(".empty-state")?.textContent).toContain("Run uplink login in a terminal");
});
