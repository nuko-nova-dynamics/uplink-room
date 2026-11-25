// @vitest-environment happy-dom
/**
 * Settings, Members: Resend email on a deployment that couldn't email the invite. The token is
 * replaced either way, so the new link must be shown for sending by hand rather than lost behind a
 * toast that says it was emailed.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toasts: [] as string[],
  mutate: vi.fn(),
  resend: { emailed: false } as Record<string, unknown>,
}));

const INVITE = {
  inviteId: "jx7invite",
  email: "ana@example.com",
  role: "member",
  invitedAt: Date.UTC(2026, 10, 4),
  invitedBy: { memberId: "k57julio", name: "Julio Diaz" },
  expiresAt: Date.UTC(2026, 10, 11),
  sendEmail: true,
  canCopyLink: false,
  remindedAt: null,
  emailState: null,
};

vi.mock("../../lib/session", () => ({
  useSession: () => ({
    isAdmin: true,
    teamId: "team-harbor",
    team: { name: "Nuko Nova" },
    me: { memberId: "k57julio", name: "Julio Diaz" },
    members: [],
  }),
  useToast: () => ({ show: (text: string) => mocks.toasts.push(text) }),
  useAct: (ref: never) => async () =>
    getFunctionName(ref) === "invites:resend" ? mocks.resend : null,
  useRoomQuery: (ref: never) => {
    const name = getFunctionName(ref);
    if (name === "invites:list") return [INVITE];
    if (name === "teams:settings") return { inviteReminders: "on" };
    return undefined;
  },
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: never) => (args: unknown) => mocks.mutate(getFunctionName(ref), args),
}));
vi.mock("../../lib/desktop", () => ({ desktop: {} }));

const { Members } = await import("./Members");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  mocks.toasts.length = 0;
  mocks.mutate.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const click = async (label: string) => {
  const button = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  )!;
  await act(async () => button.click());
};

test("a resend that emailed nothing shows the new link with a copy button instead of claiming it went", async () => {
  mocks.resend = {
    inviteId: "jx7invite",
    token: "uri_0123456789abcdef0123456789abcdef0123456789abcdef",
    url: "https://uplinkroom.com/invite#uri_0123456789abcdef0123456789abcdef0123456789abcdef",
    expiresAt: Date.UTC(2026, 10, 11),
    emailed: false,
  };
  act(() => root.render(<Members />));
  await click("Resend email");

  expect(mocks.toasts).toEqual([]);
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("The new link for ana@example.com wasn't emailed");
  expect(dialog.textContent).toContain(
    "The email didn't go out, so send ana@example.com this link",
  );
  expect(dialog.querySelector(".secret-box")?.textContent).toBe(mocks.resend.url);
  expect([...dialog.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toContain(
    "Copy link",
  );
});

test("a resend that emailed says so and opens nothing", async () => {
  mocks.resend = {
    inviteId: "jx7invite",
    token: "uri_x",
    url: "https://uplinkroom.com/invite#uri_x",
    expiresAt: 0,
    emailed: true,
  };
  act(() => root.render(<Members />));
  await click("Resend email");
  expect(mocks.toasts).toEqual([
    "Emailing ana@example.com a new link. The old one stopped working.",
  ]);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("an invalid invite email stays in the dialog and names the problem", async () => {
  act(() => root.render(<Members />));
  await click("Invite someone");
  const field = document.querySelector<HTMLInputElement>("#invite-email")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      field,
      "not-an-email",
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const form = document.querySelector("#invite-form")!;
  await act(async () =>
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(document.querySelector("[role=alert]")?.textContent).toContain(
    "Enter a valid email address",
  );
  expect(field.getAttribute("aria-invalid")).toBe("true");
  expect(field.getAttribute("aria-describedby")).toContain("invite-email-error");
  expect(document.querySelector(`label[for="${field.id}"]`)?.textContent).toBe("Email");
  expect(mocks.mutate).not.toHaveBeenCalled();
});

test("a failed revoke keeps the dialog open and can be retried", async () => {
  mocks.mutate
    .mockRejectedValueOnce(new Error("Connection interrupted"))
    .mockResolvedValueOnce(null);
  act(() => root.render(<Members />));
  await click("Revoke");
  await click("Revoke invite");
  expect(document.querySelector("[role=alert]")?.textContent).toContain("Connection interrupted");
  expect(document.querySelector<HTMLButtonElement>(".dialog .solid")?.disabled).toBe(false);
  await click("Revoke invite");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(mocks.mutate).toHaveBeenCalledTimes(2);
});

test("a pending revoke shows busy feedback and prevents duplicate submission", async () => {
  let finish!: () => void;
  mocks.mutate.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  act(() => root.render(<Members />));
  await click("Revoke");
  await click("Revoke invite");
  const button = document.querySelector<HTMLButtonElement>(".dialog .solid")!;
  expect(button.textContent).toContain("Revoking");
  // UI SDK's Button stays focusable while pending: busy and unavailable, not natively disabled.
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.getAttribute("aria-disabled")).toBe("true");
  await act(async () => button.click());
  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
