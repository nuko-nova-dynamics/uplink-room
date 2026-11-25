// @vitest-environment happy-dom
/**
 * The call bar (DESIGN.md, Calls): one pill under a channel's title with who's in the call, Join or
 * your controls, and no tiles for voice. The session and the call are stood in for.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { settle } from "@ui-sdk/core/testing";

const calls: [string, unknown][] = [];
const state = vi.hoisted(() => ({ call: {} as Record<string, unknown> }));

vi.mock("../lib/session", () => ({
  useSession: () => ({
    isAdmin: true,
    team: { name: "Harbor Labs" },
    me: { memberId: "mrosa", name: "Rosa Vega", role: "admin" },
    members: [
      { memberId: "mscout", name: "Scout", kind: "agent" },
      { memberId: "mnotes", name: "Notetaker", kind: "agent" },
    ],
  }),
  useAct: (ref: never) => async (args: unknown) => {
    calls.push([getFunctionName(ref), args]);
    return true;
  },
  useRoomQuery: (ref: never) =>
    getFunctionName(ref) === "channels:list"
      ? [
          {
            channelId: "cgeneral",
            kind: "channel",
            name: "general",
            callQuality: "standard",
            callQualityChosen: "standard",
          },
        ]
      : undefined,
}));

vi.mock("../lib/call", () => ({
  useCall: () => state.call,
  useLiveCalls: () => [],
}));

vi.mock("../lib/desktop", () => ({ fakeMedia: true, desktop: { platform: "darwin" } }));

const { CallBar, CallStage } = await import("./Call");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const person = (memberId: string, name: string) => ({
  memberId,
  name,
  kind: "person",
  takesNotes: false,
  muted: false,
  camera: false,
  screen: false,
  joinedAt: 0,
});
const live = {
  callId: "call1",
  channelId: "cgeneral",
  startedAt: Date.now() - 65_000,
  participants: [
    person("mrosa", "Rosa Vega"),
    person("mana", "Ana Ruiz"),
    person("mben", "Ben Okafor"),
    person("mchloe", "Chloe Martin"),
    { ...person("mnotes", "Notetaker"), kind: "agent", takesNotes: true },
  ],
};

const roots: Root[] = [];
beforeEach(() => {
  calls.length = 0;
  state.call = {
    callId: null,
    channelId: null,
    status: "idle",
    speaking: new Set(),
    tiles: [],
    join: vi.fn(),
  };
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

async function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(node));
  return host;
}
const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label,
  );
const faces = (host: HTMLElement) =>
  [...host.querySelectorAll(".call-face-stack .call-face")].map((f) => f.getAttribute("title"));
/** A menu item (UI SDK Menu): popups render in the top layer, in the body beside the host. */
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (i) => i.textContent?.trim() === label,
  );
async function click(el: HTMLElement | undefined) {
  await act(async () => el!.click());
  await act(() => settle());
}
async function key(el: Element, name: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
  await act(() => settle());
}

test("outside the call: three faces and +N, the time, who's taking notes, and Join; voice takes no tiles", async () => {
  const host = await mount(
    <>
      <CallBar call={live as never} channelId={"cgeneral" as never} />
      <CallStage call={live as never} />
    </>,
  );
  expect(button(host, "5 in the call")?.textContent).toContain("+2");
  expect(faces(host)).toEqual(["Rosa Vega", "Ana Ruiz", "Ben Okafor"]);
  expect(host.querySelector(".call-time")?.textContent).toBe("01:05");
  expect(host.querySelector(".call-notes")?.getAttribute("title")).toBe(
    "Notetaker is taking notes",
  );
  // The notice never sits in a strip a narrow column can drop (spec #5, story 22).
  expect(host.querySelector('.call-notes[role="img"]')?.getAttribute("aria-label")).toBe(
    "Notetaker is taking notes",
  );
  expect(host.querySelector(".call-notes")?.closest(".call-drop")).toBeNull();
  expect(host.querySelector(".call-stage")).toBeNull();
  expect(button(host, "Mute")).toBeUndefined();

  await click(button(host, "Join call"));
  expect(state.call["join"]).toHaveBeenCalledWith("cgeneral");

  await click(button(host, "5 in the call"));
  expect(
    [...document.querySelectorAll(".call-people .call-member .truncate")].map((n) => n.textContent),
  ).toEqual(["Rosa Vega", "Ana Ruiz", "Ben Okafor", "Chloe Martin", "Notetaker"]);
});

test("in the call: whoever talks comes first, and the menu holds the camera, devices, voice quality and agents", async () => {
  state.call = {
    ...state.call,
    callId: "call1",
    channelId: "cgeneral",
    status: "connected",
    speaking: new Set(["mchloe"]),
    muted: false,
    camera: false,
    screen: false,
  };
  const host = await mount(<CallBar call={live as never} channelId={"cgeneral" as never} />);
  expect(faces(host)[0]).toBe("Chloe Martin");
  expect(host.querySelector(".call-face-stack .call-face.speaking")?.getAttribute("title")).toBe(
    "Chloe Martin",
  );
  expect(button(host, "Join call")).toBeUndefined();
  for (const label of ["Mute", "Share a screen", "More call controls", "Leave the call"])
    expect(button(host, label), label).toBeDefined();

  await click(button(host, "More call controls"));
  const items = [...document.querySelectorAll('.call-menu [role="menuitem"]')].map(
    (i) => i.textContent,
  );
  expect(items).toEqual([
    "Turn camera on",
    "Microphone, speaker and camera",
    "Voice qualityStandard",
    "Scout",
  ]);

  await click(menuItem("Scout"));
  expect(calls).toEqual([["calls:invite", { callId: "call1", memberId: "mscout" }]]);
  expect(document.querySelector(".call-menu")).toBeNull();

  // Voice quality is a submenu: the arrow key opens it on its first choice. Escape closes the
  // choices, and Escape (once more, if the menu is still open) returns to the menu's button.
  await click(button(host, "More call controls"));
  const voice = menuItem("Voice qualityStandard")!;
  await act(async () => voice.focus());
  await key(voice, "ArrowRight");
  expect(document.querySelectorAll('.quality-choices [role="menuitemradio"]')).toHaveLength(3);
  const choice = document.querySelector<HTMLElement>('[role="menuitemradio"]')!;
  expect(document.activeElement).toBe(choice);
  await key(choice, "Escape");
  expect(document.querySelector('[role="menuitemradio"]')).toBeNull();
  if (document.querySelector(".call-menu")) await key(document.activeElement!, "Escape");
  expect(document.querySelector(".call-menu")).toBeNull();
  expect(document.activeElement).toBe(button(host, "More call controls"));
});

test("while joining, the bar says so in place of the time", async () => {
  state.call = {
    ...state.call,
    callId: "call1",
    channelId: "cgeneral",
    status: "joining",
    speaking: new Set(),
  };
  const host = await mount(<CallBar call={live as never} channelId={"cgeneral" as never} />);
  expect(host.querySelector('.call-status[role="status"]')?.textContent).toBe("Joining");
  expect(button(host, "Mute")?.disabled).toBe(true);
});
