// @vitest-environment happy-dom
/**
 * Call quality controls (issue #87): the share picker's quality, a channel's voice quality and the
 * team's limit on both, and how a viewer watches a shared screen. The session, the call and the
 * desktop bridge they read are stood in for.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { settle } from "@ui-sdk/core/testing";

const calls: [string, unknown][] = [];
const state = vi.hoisted(() => ({
  admin: true,
  limit: "none" as string,
  platform: "darwin",
  refreshRate: null as number | null,
  channels: [] as unknown[],
  call: {} as Record<string, unknown>,
}));

vi.mock("../lib/session", () => ({
  useSession: () => ({
    isAdmin: state.admin,
    team: { name: "Nuko Nova" },
    me: { memberId: "mana", name: "Ana", role: state.admin ? "admin" : "member" },
    members: [],
  }),
  useAct: (ref: never) => async (args: unknown) => {
    calls.push([getFunctionName(ref), args]);
    return true;
  },
  useRoomQuery: (ref: never) => {
    const name = getFunctionName(ref);
    if (name === "teams:settings") return { name: "Nuko Nova", linkPreviews: "on", callQualityLimit: state.limit };
    if (name === "channels:list") return state.channels;
    return undefined;
  },
}));

vi.mock("../lib/call", () => ({
  useCall: () => state.call,
  useLiveCalls: () => [],
}));

vi.mock("../lib/desktop", () => ({
  fakeMedia: true,
  desktop: {
    get platform() {
      return state.platform;
    },
    screenSources: async () => [
      { id: "screen:1", name: "Entire screen", kind: "screen", thumbnail: null, refreshRate: state.refreshRate },
      { id: "window:2", name: "Reef Runner (Godot)", kind: "window", thumbnail: null, refreshRate: state.refreshRate },
    ],
  },
}));

const { ScreenPicker } = await import("./Call");
const { ScreenTools, VoiceQuality } = await import("./CallQuality");
const { Calls } = await import("../views/settings/Calls");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
beforeEach(() => {
  calls.length = 0;
  state.admin = true;
  state.limit = "none";
  state.platform = "darwin";
  state.refreshRate = null;
  state.channels = [
    { channelId: "cgeneral", kind: "channel", name: "general", callQuality: "standard", callQualityChosen: "standard" },
    { channelId: "cdm", kind: "direct", name: "Ben", callQuality: "standard", callQualityChosen: "standard" },
  ];
  state.call = {
    screenView: new Map(),
    setScreenView: vi.fn(),
    shareQuality: null,
    changeShareQuality: vi.fn(),
    cameraQuality: "720p",
    setCameraQuality: vi.fn(),
  };
  localStorage.clear();
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
  // A dialog (UI SDK) renders into the body beside the host: this render's is the newest one.
  return ([...document.querySelectorAll<HTMLElement>('[data-slot="dialog-content"]')].at(-1) ?? host);
}

const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text || b.getAttribute("aria-label") === text)!;
// A segmented control (UI SDK) is a radio group, its chosen segment checked; the team limit saves
// when pressed, so it's a toggle group (PickOne), its choice pressed and its off choices aria-disabled.
const pressed = (host: HTMLElement, group: string) =>
  [...host.querySelectorAll(`[aria-labelledby="${group}"] button:is([aria-checked="true"], [aria-pressed="true"])`)].map((b) => b.textContent);
const disabled = (host: HTMLElement, group: string) =>
  [...host.querySelectorAll<HTMLButtonElement>(`[aria-labelledby="${group}"] button`)]
    .filter((b) => b.disabled || b.getAttribute("aria-disabled") === "true")
    .map((b) => b.textContent);
// Menus and select lists render in the top layer, in the body beside the host.
const choices = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
const unavailable = (el: Element) => el.getAttribute("aria-disabled") === "true";

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await act(() => settle());
}

test("the share picker starts at Balanced, shares at the quality picked, and remembers it", async () => {
  const onShare = vi.fn();
  const host = await mount(<ScreenPicker onClose={() => {}} onShare={onShare} />);
  expect(pressed(host, "share-quality-label")).toEqual(["Balanced"]);
  expect(host.textContent).toContain("1080p at 30 fps, for most sharing.");
  expect(disabled(host, "share-quality-label")).toEqual([]);

  expect(host.textContent).not.toContain("60 fps uses more bandwidth");

  await click(button(host, "Smooth HD"));
  expect(host.textContent).toContain("1080p at 60 fps, for video and games at full size. 60 fps uses more bandwidth and processor.");
  // Source has its own frame rate, 30 or 60.
  expect(host.querySelector('[aria-label="Source frame rate"]')).toBeNull();
  await click(button(host, "Source"));
  expect(host.querySelector('[aria-label="Source frame rate"] [aria-checked="true"]')!.textContent).toBe("30 fps");
  await click(button(host, "60 fps"));
  expect(host.textContent).toContain("Your screen's own size, up to 4K, at 60 fps.");
  await click(host.querySelector<HTMLButtonElement>('.source[role="radio"]')!);
  await click(button(host, "Share"));
  expect(onShare).toHaveBeenCalledWith(expect.objectContaining({ id: "screen:1" }), true, "source60");
  expect(localStorage.getItem("uplink.shareQuality")).toBe("source60");

  // The next picker opens at the remembered choice.
  const again = await mount(<ScreenPicker onClose={() => {}} onShare={() => {}} />);
  expect(pressed(again, "share-quality-label")).toEqual(["Source"]);
  expect(again.querySelector('[aria-label="Source frame rate"] [aria-checked="true"]')!.textContent).toBe("60 fps");
});

test("on Windows, a 60 fps choice says what a display above 60 Hz really gets", async () => {
  localStorage.setItem("uplink.shareQuality", "smooth");
  state.refreshRate = 144;
  const mac = await mount(<ScreenPicker onClose={() => {}} onShare={() => {}} />);
  expect(mac.textContent).not.toContain("Windows 11");

  state.platform = "win32";
  const host = await mount(<ScreenPicker onClose={() => {}} onShare={() => {}} />);
  expect(host.textContent).toContain("Your fastest display runs at 144 Hz, so on Windows 11 a 60 fps share runs at about 48 fps");
  await click(host.querySelector<HTMLButtonElement>('.source[role="radio"]')!);
  expect(host.textContent).toContain("This display runs at 144 Hz");
  // Not for 30 fps, and not where 60 holds (120 Hz: every second refresh is 60 fps).
  await click(button(host, "Balanced"));
  expect(host.textContent).not.toContain("Windows 11");
  state.refreshRate = 120;
  const fast = await mount(<ScreenPicker onClose={() => {}} onShare={() => {}} />);
  expect(fast.textContent).not.toContain("Windows 11");
});

test("the share picker keeps to the team's limit and says why the rest are unavailable", async () => {
  state.limit = "high";
  const host = await mount(<ScreenPicker onClose={() => {}} onShare={() => {}} />);
  expect(disabled(host, "share-quality-label")).toEqual(["Smooth HD", "Source"]);
  expect(host.textContent).toContain("Smooth HD and Source are above your team's limit (High). An admin can change it in Settings, Calls.");

  // A remembered choice above the limit starts at the closest one it allows.
  localStorage.setItem("uplink.shareQuality", "balanced");
  state.limit = "standard";
  const low = await mount(<ScreenPicker onClose={() => {}} onShare={() => {}} />);
  expect(pressed(low, "share-quality-label")).toEqual(["Sharp"]);
  expect(disabled(low, "share-quality-label")).toEqual(["Balanced", "Smooth", "Smooth HD", "Source"]);
  expect(low.textContent).toContain("Balanced, Smooth, Smooth HD and Source are above your team's limit (Standard).");
});

test("an admin chooses a team channel's voice quality; choices above the limit are unavailable", async () => {
  state.limit = "high";
  const host = await mount(<VoiceQuality channelId={"cgeneral" as never} />);
  await click(button(host, "Voice: Standard"));
  const rows = choices();
  expect(rows.map((r) => [r.querySelector(".quality-choice span")!.textContent, r.getAttribute("aria-checked"), unavailable(r)])).toEqual([
    ["Standard", "true", false],
    ["High", "false", false],
    ["Music", "false", true],
  ]);
  expect(document.body.textContent).toContain("48 kbps, mono");
  expect(document.body.textContent).toContain("Music is above your team's limit (High).");

  await click(rows[1]!);
  expect(calls).toEqual([["channels:setCallQuality", { channelId: "cgeneral", quality: "high" }]]);
  expect(document.querySelector(".quality-pop")).toBeNull();
});

test("in a team channel only admins choose; in a direct message anyone in it can", async () => {
  state.admin = false;
  const team = await mount(<VoiceQuality channelId={"cgeneral" as never} />);
  await click(button(team, "Voice: Standard"));
  expect(choices().every(unavailable)).toBe(true);
  expect(document.body.textContent).toContain("Only admins can change this in a team channel.");
  await click(choices()[1]!);
  expect(calls).toEqual([]);
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await act(() => settle());

  const dm = await mount(<VoiceQuality channelId={"cdm" as never} />);
  await click(button(dm, "Voice: Standard"));
  const music = choices()[2]!;
  expect(unavailable(music)).toBe(false);
  await click(music);
  expect(calls).toEqual([["channels:setCallQuality", { channelId: "cdm", quality: "music" }]]);
});

test("a channel set above a lowered limit shows what its calls use, and what was chosen", async () => {
  state.limit = "high";
  state.channels = [{ channelId: "cdm", kind: "direct", name: "Ben", callQuality: "high", callQualityChosen: "music" }];
  const host = await mount(<VoiceQuality channelId={"cdm" as never} />);
  await click(button(host, "Voice: High"));
  expect(document.body.textContent).toContain("Set to Music; your team's limit keeps calls at High.");
});

test("picking the quality a lowered limit holds a higher saved choice at saves it, so it stays when the limit goes up", async () => {
  state.limit = "high";
  state.channels = [{ channelId: "cdm", kind: "direct", name: "Ben", callQuality: "high", callQualityChosen: "music" }];
  const host = await mount(<VoiceQuality channelId={"cdm" as never} />);
  await click(button(host, "Voice: High"));
  // High is already checked, so picking it again is a press on the checked item.
  await click(choices()[1]!);
  expect(calls).toEqual([["channels:setCallQuality", { channelId: "cdm", quality: "high" }]]);
  expect(document.querySelector(".quality-pop")).toBeNull();
});

test("Settings, Calls: your camera quality, and the team's limit for admins only", async () => {
  state.admin = false;
  const member = await mount(<Calls />);
  expect(pressed(member, "limit-label")).toEqual(["No limit"]);
  expect(disabled(member, "limit-label")).toEqual(["Standard", "High", "No limit"]);
  expect(member.textContent).toContain("Only admins can change this.");
  await click(button(member, "1080p"));
  expect(state.call["setCameraQuality"]).toHaveBeenCalledWith("1080p");

  state.admin = true;
  const admin = await mount(<Calls />);
  await click(button(admin, "High"));
  expect(calls).toEqual([["teams:setCallQualityLimit", { limit: "high" }]]);

  // Under the Standard limit a 1080p camera is unavailable, and says why.
  state.limit = "standard";
  state.call["cameraQuality"] = "1080p";
  const capped = await mount(<Calls />);
  expect(pressed(capped, "camera-quality-label")).toEqual(["720p"]);
  expect(disabled(capped, "camera-quality-label")).toEqual(["1080p"]);
  expect(capped.textContent).toContain("1080p is above your team's limit (Standard).");
});

test("a viewer can force a shared screen's low layer; the sharer changes its quality from the tile", async () => {
  const expand = vi.fn();
  const viewer = await mount(<ScreenTools join="mben.p1" isLocal={false} expanded={false} onExpand={expand} />);
  expect(pressed(viewer, "view-mben.p1")).toEqual(["Auto"]);
  await click(button(viewer, "Low"));
  expect(state.call["setScreenView"]).toHaveBeenCalledWith("mben.p1", "low");
  await click(button(viewer, "Expand the screen"));
  expect(expand).toHaveBeenCalled();

  state.call["shareQuality"] = "balanced";
  state.limit = "high";
  const sharer = await mount(<ScreenTools join="mana.p2" isLocal expanded={false} onExpand={() => {}} />);
  // The quality is a Select (UI SDK): its trigger shows the choice and its list opens in the body.
  const select = sharer.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]')!;
  expect(select.textContent).toBe("Balanced, 1080p, 30 fps");
  expect(document.getElementById(select.getAttribute("aria-labelledby")?.split(" ")[0] ?? "")?.textContent).toBe("Quality");
  await click(select);
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(options.map((o) => [o.textContent, unavailable(o)])).toEqual([
    ["Sharp, 1080p, 15 fps", false],
    ["Balanced, 1080p, 30 fps", false],
    ["Smooth, 720p, 60 fps", false],
    ["Smooth HD, 1080p, 60 fps, above your team's limit", true],
    ["Source, its own size, 30 fps, above your team's limit", true],
    ["Source, its own size, 60 fps, above your team's limit", true],
  ]);
  await click(options[0]!);
  expect(state.call["changeShareQuality"]).toHaveBeenCalledWith("sharp");
});
