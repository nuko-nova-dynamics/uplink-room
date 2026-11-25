// @vitest-environment happy-dom
/** The new channel popover and a private channel's members popover (ADR 0016), with the session they read stood in for. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const calls: [string, unknown][] = [];
let detail: unknown;

vi.mock("../../lib/session", () => ({
  useSession: () => ({
    team: { name: "Nuko Nova" },
    me: { memberId: "mana", name: "Ana", role: "member" },
    members: [
      { memberId: "mjulio", name: "Julio", kind: "person" },
      { memberId: "mana", name: "Ana", kind: "person" },
      { memberId: "mben", name: "Ben", kind: "person" },
      { memberId: "mbot", name: "Deploy bot", kind: "agent" },
    ],
  }),
  useAct: (ref: never) => async (args: unknown) => {
    calls.push([getFunctionName(ref), args]);
    return getFunctionName(ref).endsWith("create") || getFunctionName(ref).endsWith("createPrivate") ? "cnew" : true;
  },
  useRoomQuery: (_ref: unknown, args: unknown) => (args === "skip" ? undefined : detail),
}));

const { NewChannel } = await import("./NewChannel");
const { ChannelMembers } = await import("./ChannelMembers");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
beforeEach(() => {
  calls.length = 0;
  detail = undefined;
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  // Popovers are portaled out of the host, so the whole page is what a test looks through.
  return document.body;
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text || b.getAttribute("aria-label") === text)!;

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
}

/** The names a pick list or member list shows, without the faces' initials. */
const names = (host: HTMLElement, selector: string) => [...host.querySelectorAll(`${selector} .grow`)].map((n) => n.textContent);
const pickButton = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>(".pick-list button")].find((b) => b.querySelector(".grow")?.textContent === name)!;

const plus = { top: 100, bottom: 120, right: 140, left: 120, width: 20, height: 20, x: 120, y: 100, toJSON: () => ({}) } as DOMRect;

test("a new channel is for everyone unless Private is chosen; a private one takes the people picked", async () => {
  const created = vi.fn();
  const host = mount(<NewChannel anchor={plus} onClose={() => {}} onCreated={created} />);
  const name = host.querySelector<HTMLInputElement>('input[aria-label="Channel name"]')!;
  expect(document.activeElement).toBe(name);
  expect(host.querySelector(".pick-list")).toBeNull();
  expect(host.textContent).toContain("Everyone in Nuko Nova can see it");
  expect(button(host, "Create").disabled).toBe(true);

  type(name, "#Launch");
  await click(button(host, "Private"));
  expect(host.textContent).toContain("Only the people you add can see it, admins included.");
  // You are in it already, so you aren't offered.
  expect(names(host, ".pick-list")).toEqual(["Julio", "Ben", "Deploy bot"]);
  await click(pickButton(host, "Ben"));
  expect(host.textContent).toContain("1 added, and you.");
  await click(button(host, "Create"));
  expect(calls).toEqual([["channels:createPrivate", { name: "Launch", memberIds: ["mben"] }]]);
  expect(created).toHaveBeenCalledWith("cnew");

  calls.length = 0;
  await click(button(host, "Everyone"));
  await click(button(host, "Create"));
  expect(calls).toEqual([["channels:create", { name: "Launch" }]]);
});

const members = [
  { memberId: "mjulio", name: "Julio", kind: "person" as const },
  { memberId: "mana", name: "Ana", kind: "person" as const },
];

test("the members button shows the count; only someone who can remove members gets remove buttons", async () => {
  detail = { kind: "private", creatorId: "mjulio", canRemove: false, members };
  const host = mount(<ChannelMembers channelId={"c1" as never} name="#launch" members={members as never} createdBy={"mjulio" as never} onLeft={() => {}} />);
  const open = host.querySelector<HTMLButtonElement>(".members-btn")!;
  expect(open.getAttribute("aria-label")).toBe("Members, 2");
  await click(open);
  expect(names(host, ".member-row")).toEqual(["Julio", "Ana"]);
  expect([...host.querySelectorAll(".member-row .muted")].map((n) => n.textContent)).toEqual(["Created it", "You"]);
  expect(host.querySelector('[aria-label^="Remove"]')).toBeNull();

  // As the channel's creator, Ana can remove members.
  act(() => roots.pop()!.unmount());
  detail = { kind: "private", creatorId: "mana", canRemove: true, members };
  const again = mount(<ChannelMembers channelId={"c1" as never} name="#launch" members={members as never} createdBy={"mana" as never} onLeft={() => {}} />);
  await click(again.querySelector<HTMLButtonElement>(".members-btn")!);
  // Never yourself: you leave instead.
  expect([...again.querySelectorAll('[aria-label^="Remove"]')].map((b) => b.getAttribute("aria-label"))).toEqual(["Remove Julio"]);
  await click(button(again, "Remove Julio"));
  expect(calls).toEqual([["channels:removeMember", { channelId: "c1", memberId: "mjulio" }]]);
});

test("adding people offers only those not in it; leaving asks once more, in place", async () => {
  detail = { kind: "private", creatorId: "mana", canRemove: true, members };
  const left = vi.fn();
  const host = mount(<ChannelMembers channelId={"c1" as never} name="#launch" members={members as never} createdBy={"mana" as never} onLeft={left} />);
  await click(host.querySelector<HTMLButtonElement>(".members-btn")!);
  await click(button(host, "Add people"));
  expect(names(host, ".pick-list")).toEqual(["Ben", "Deploy bot"]);
  expect(document.activeElement).toBe(host.querySelector('input[aria-label="Find a teammate or agent"]'));
  await click(pickButton(host, "Deploy bot"));
  await click(button(host, "Add"));
  expect(calls).toEqual([["channels:addMembers", { channelId: "c1", memberIds: ["mbot"] }]]);
  expect(host.querySelector(".member-row")).not.toBeNull();

  calls.length = 0;
  await click(button(host, "Leave #launch"));
  expect(host.textContent).toContain("Leave #launch? Someone in it has to add you back.");
  expect(calls).toEqual([]);
  await click(button(host, "Cancel"));
  expect(host.querySelector(".leave-confirm")).toBeNull();
  await click(button(host, "Leave #launch"));
  await click(button(host, "Leave"));
  expect(calls).toEqual([["channels:leave", { channelId: "c1" }]]);
  expect(left).toHaveBeenCalledTimes(1);
  // Once you've left, the popover closes.
  expect(host.querySelector(".members-pop")).toBeNull();
});

test("before channels.members answers, the creator already sees who created it and the remove buttons", async () => {
  detail = undefined;
  const host = mount(<ChannelMembers channelId={"c1" as never} name="#launch" members={members as never} createdBy={"mana" as never} onLeft={() => {}} />);
  await click(host.querySelector<HTMLButtonElement>(".members-btn")!);
  expect([...host.querySelectorAll(".member-row .muted")].map((n) => n.textContent)).toEqual(["Created it"]);
  expect([...host.querySelectorAll('[aria-label^="Remove"]')].map((b) => b.getAttribute("aria-label"))).toEqual(["Remove Julio"]);
});

test("Escape closes the members popover without changing anything", async () => {
  detail = { kind: "private", creatorId: "mana", canRemove: true, members };
  const host = mount(<ChannelMembers channelId={"c1" as never} name="#launch" members={members as never} createdBy={"mana" as never} onLeft={() => {}} />);
  await click(host.querySelector<HTMLButtonElement>(".members-btn")!);
  await click(button(host, "Leave #launch"));
  act(() => {
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(host.querySelector(".members-pop")).toBeNull();
  expect(calls).toEqual([]);
});

test("the keyboard stays in the popover's steps, and Escape returns it to the Members button (L1)", async () => {
  detail = { kind: "private", creatorId: "mana", canRemove: true, members };
  const host = mount(<ChannelMembers channelId={"c1" as never} name="#launch" members={members as never} createdBy={"mana" as never} onLeft={() => {}} />);
  const membersButton = host.querySelector<HTMLButtonElement>(".members-btn")!;
  await click(membersButton);
  await click(button(host, "Leave #launch"));
  expect(document.activeElement).toBe(button(host, "Cancel"));
  await click(button(host, "Cancel"));
  expect(document.activeElement).toBe(button(host, "Leave #launch"));
  await click(button(host, "Add people"));
  expect(document.activeElement).toBe(host.querySelector('input[aria-label="Find a teammate or agent"]'));
  await click(button(host, "Back"));
  expect(document.activeElement).toBe(button(host, "Add people"));
  act(() => {
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(document.activeElement).toBe(membersButton);
});
