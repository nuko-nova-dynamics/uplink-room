// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

const call = vi.hoisted(() => ({
  channelId: null as string | null,
  status: "idle",
  speaking: new Set<string>(),
  callId: null,
  join: vi.fn(async () => {}),
}));
vi.mock("../lib/call", () => ({ useCall: () => call }));
vi.mock("../lib/log", () => ({ log: { info: () => {} } }));
vi.mock("./Call", () => ({ ChannelCallMembers: () => <ul className="call-members" /> }));
const { VoiceRooms } = await import("./VoiceRooms");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
  call.join.mockClear();
  call.channelId = null;
  call.status = "idle";
  localStorage.clear();
});

const rooms = ["general", "design", "ops", "random", "music", "games", "standup"].map((name) => ({
  channelId: name as never,
  name,
  kind: "team",
}));

async function render(
  liveCalls: { channelId: string; participants: { memberId: string; name: string }[] }[] = [],
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const open = vi.fn();
  await act(async () =>
    root.render(
      <VoiceRooms
        rooms={rooms}
        liveCalls={liveCalls as never}
        openChannelId={undefined}
        onOpen={open}
      />,
    ),
  );
  cleanup.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const room = (name: string) =>
    [...host.querySelectorAll<HTMLElement>('[role="option"]')].find((el) =>
      el.textContent?.includes(name),
    )!;
  return { host, open, room };
}

test("one click on an empty room joins it, which starts its call, and opens the channel", async () => {
  const { open, room } = await render();
  expect(room("design").getAttribute("aria-label")).toBe("#design, join voice");
  await act(async () => room("design").click());
  expect(call.join).toHaveBeenCalledWith("design");
  expect(open).toHaveBeenCalledWith("design");
});

test("a room with a call says who's there and joins it; the room you're in only opens", async () => {
  const live = [{ channelId: "ops", participants: [{ memberId: "a", name: "Ana" }] }];
  const first = await render(live);
  expect(first.room("ops").getAttribute("aria-label")).toBe("#ops, join the call with Ana");
  await act(async () => first.room("ops").click());
  expect(call.join).toHaveBeenCalledWith("ops");
  call.join.mockClear();
  call.channelId = "ops";
  call.status = "connected";
  const again = await render(live);
  expect(again.room("ops").getAttribute("aria-selected")).toBe("true");
  await act(async () => again.room("ops").click());
  expect(call.join).not.toHaveBeenCalled();
  expect(again.open).toHaveBeenCalledWith("ops");
});

test("five rooms show, a live one leading even when it is last, and the rest fold away", async () => {
  const { host, room } = await render([
    { channelId: "standup", participants: [{ memberId: "a", name: "Ana" }] },
  ]);
  expect(room("standup")).toBeTruthy();
  expect(host.querySelectorAll(`[role="option"]`).length).toBe(5);
  const more = host.querySelector<HTMLButtonElement>("button.fold-toggle")!;
  expect(more.textContent).toContain("All voice rooms (7)");
  await act(async () => more.click());
  expect(host.querySelectorAll('[role="option"]').length).toBe(7);
});
