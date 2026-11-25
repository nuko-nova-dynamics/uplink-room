// @vitest-environment happy-dom
/**
 * The Join dialog for a join link (JoinInvite.tsx): an invite meant for another address never
 * offers Join. It says whom the invite is for and who is signed in, and offers Switch account.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preview: {} as Record<string, unknown>,
  accept: vi.fn(),
  signOut: vi.fn(async () => {}),
}));
vi.mock("convex/react", () => ({
  useQuery: () => mocks.preview,
  useMutation: () => mocks.accept,
}));
vi.mock("@clerk/electron/react", () => ({ useClerk: () => ({ signOut: mocks.signOut }) }));
vi.mock("../lib/session", () => ({ useToast: () => ({ show: () => {} }) }));
vi.mock("../lib/analytics", () => ({ track: () => {} }));

const { JoinInvite } = await import("./JoinInvite");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const base = {
  state: "valid",
  teamId: "k57team",
  teamName: "Nuko Nova",
  inviterName: "Julio Diaz",
  role: "admin",
  expiresAt: null,
  alreadyMember: false,
  inviteFor: "a…@company.com",
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  mocks.accept.mockReset();
  mocks.signOut.mockClear();
});

const buttons = () =>
  [...host.ownerDocument.querySelectorAll("button")].map((b) => b.textContent?.trim());

test("another account sees whom the invite is for and Switch account, never Join", async () => {
  mocks.preview = { ...base, account: "other", signedInAs: "b…@x.com", email: null };
  act(() =>
    root.render(<JoinInvite token="uri_0123456789abcdef" onJoined={() => {}} onClose={() => {}} />),
  );
  const text = document.body.textContent ?? "";
  expect(text).toContain("This invite is for another account");
  expect(text).toContain(
    "This invite to Nuko Nova is for a…@company.com. You're signed in as b…@x.com.",
  );
  expect(buttons()).toContain("Switch account");
  expect(buttons().some((b) => b?.startsWith("Join"))).toBe(false);

  const switcher = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "Switch account",
  )!;
  await act(async () => switcher.click());
  expect(mocks.signOut).toHaveBeenCalled();
  expect(mocks.accept).not.toHaveBeenCalled();
});

test("an unverified sign-in is told why it can't join, and can switch account", () => {
  mocks.preview = { ...base, account: "unverified", signedInAs: "a…@company.com", email: null };
  act(() =>
    root.render(<JoinInvite token="uri_0123456789abcdef" onJoined={() => {}} onClose={() => {}} />),
  );
  expect(document.body.textContent).toContain("doesn't show a verified email address");
  expect(buttons()).toContain("Switch account");
});

test("the invited account gets Join", () => {
  mocks.preview = {
    ...base,
    account: "match",
    signedInAs: "a…@company.com",
    email: "ana@company.com",
  };
  act(() =>
    root.render(<JoinInvite token="uri_0123456789abcdef" onJoined={() => {}} onClose={() => {}} />),
  );
  expect(document.body.textContent).toContain(
    "Julio Diaz invited ana@company.com to join Nuko Nova as an admin.",
  );
  expect(buttons()).toContain("Join team");
});

test("a failed join stays in the dialog and can be retried", async () => {
  mocks.preview = {
    ...base,
    account: "match",
    signedInAs: "a…@company.com",
    email: "ana@company.com",
  };
  mocks.accept.mockRejectedValueOnce(new Error("Couldn't reach the team."));
  let finish: (teamId: string) => void = () => {};
  mocks.accept.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const onJoined = vi.fn();
  act(() =>
    root.render(<JoinInvite token="uri_0123456789abcdef" onJoined={onJoined} onClose={() => {}} />),
  );
  const join = document.querySelector<HTMLButtonElement>(".dialog-foot .primary")!;

  await act(async () => join.click());
  const alert = document.querySelector('[role="dialog"] [role="alert"]');
  expect(alert?.textContent).toContain("Couldn't reach the team.");
  expect(alert?.textContent).toContain(
    "Try again. If joining still fails, ask Julio Diaz for a new invite.",
  );
  expect(join.textContent).toBe("Try again");
  expect(join.disabled).toBe(false);
  expect(onJoined).not.toHaveBeenCalled();

  await act(async () => join.click());
  expect(document.querySelector('[role="dialog"] [role="alert"]')).toBeNull();
  expect(join.textContent).toBe("Joining…");
  // UI SDK's Button is pending: busy and unavailable, while it keeps focus (no native disabled).
  expect(join.getAttribute("aria-busy")).toBe("true");
  expect(join.getAttribute("aria-disabled")).toBe("true");
  await act(async () => finish("k57team"));
  expect(mocks.accept).toHaveBeenCalledTimes(2);
  expect(onJoined).toHaveBeenCalledWith("k57team");
});

test("a failed account switch explains the failure and enables another attempt", async () => {
  mocks.preview = { ...base, account: "other", signedInAs: "b…@x.com", email: null };
  mocks.signOut.mockRejectedValueOnce(new Error("Couldn't sign out."));
  act(() =>
    root.render(<JoinInvite token="uri_0123456789abcdef" onJoined={() => {}} onClose={() => {}} />),
  );
  const switcher = document.querySelector<HTMLButtonElement>(".dialog-foot .primary")!;
  await act(async () => switcher.click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Couldn't sign out.Try switching accounts again.",
  );
  expect(switcher.disabled).toBe(false);
  await act(async () => switcher.click());
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(mocks.signOut).toHaveBeenCalledTimes(2);
});
