import { afterEach, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import type { Page } from "@playwright/test";
import {
  elements,
  emptyClick,
  scopeTabTraversal,
  arrowDescendants,
  steps,
  mapped,
  resetFixtureStorage,
  type Context,
} from "./common.ts";
import {
  sceneComponents,
  nearestComponent,
  tooltipPresent,
  relatedElements,
  arrowMoved,
  hitMismatch,
  cursorExpected,
  cycleLength,
  escapeProgress,
  interactive,
  tabBudget,
  layeredTogether,
  overlappingRegions,
} from "./rules.ts";
import { focusPixels } from "./focus.ts";
import { World } from "../../../src/renderer/gym/world.ts";
import { STATES } from "../../../src/renderer/gym/states.ts";
import { encode } from "../image.ts";
import { buildReport } from "../report.ts";
import type { InventoryComponent, Finding } from "../types.ts";

const component = (id: string, selector: string, scene = "test"): InventoryComponent => ({
  id,
  selector,
  kind: "component",
  name: id,
  sources: [],
  zoom: false,
  states: [{ id: "default", gymState: scene }],
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("uses scene aliases, specificity and deterministic names for one owner", () => {
  const candidates = sceneComponents(
    [
      component("wrong", ".pane", "other"),
      component("right", ".pane"),
      component("button", ".btn"),
      component("icon", ".btn.icon"),
      component("inactive", ".elsewhere", "other"),
    ],
    "test",
  );
  expect(nearestComponent([[".pane"]], candidates)).toBe("right");
  expect(nearestComponent([[".btn", ".btn.icon"], [".pane"]], candidates)).toBe("icon");
  const fields = sceneComponents(
    [
      { ...component("field", ".field"), kind: "primitive" },
      component("notifications", ".seg", "notifications"),
    ],
    "run-dialog",
  );
  expect(nearestComponent([[".seg"], [".field"]], fields)).toBe("field");
});

it("accepts a native title with an accessible name", () => {
  expect(tooltipPresent("Settings", "Settings", false)).toBe(true);
  expect(tooltipPresent("", "", true)).toBe(false);
  expect(tooltipPresent("Settings", null, false)).toBe(false);
});

it("accepts expanded corner hits and subpixel edges while retaining missed centers", () => {
  const rect = { x: 0, y: 0, width: 28, height: 28 },
    r = Array.from({ length: 4 }, () => [7, 7]);
  expect(hitMismatch({ dx: 2, dy: 2, hit: true }, rect, r)).toBe(false);
  expect(hitMismatch({ dx: 14, dy: 14, hit: false }, rect, r)).toBe(true);
  expect(hitMismatch({ dx: -2, dy: 14, hit: true }, rect, r)).toBe(true);
  expect(
    hitMismatch(
      { dx: 29.171875, dy: 20, hit: false },
      { ...rect, width: 31.171875, height: 22 },
      Array.from({ length: 4 }, () => [6, 6]),
    ),
  ).toBe(false);
});

it("compares cursor conventions within semantic control classes", () => {
  expect(
    cursorExpected({ role: "input", disabled: false, cursor: "text", control: true }),
  ).toContain("text");
  expect(
    cursorExpected({ role: "button", disabled: true, cursor: "not-allowed", control: true }),
  ).toContain("not-allowed");
  expect(
    cursorExpected({ role: "button", disabled: false, cursor: "crosshair", control: true }),
  ).not.toContain("crosshair");
  expect(
    cursorExpected({ role: "select", disabled: false, cursor: "default", control: true }),
  ).toContain("default");
  expect(
    cursorExpected({ role: "combobox", disabled: false, cursor: "text", control: true }),
  ).toContain("text");
  expect(cycleLength(["box", "box"])).toBeNull();
  expect(
    cursorExpected({
      role: "button",
      disabled: false,
      cursor: "zoom-in",
      control: true,
      zoomAction: true,
    }),
  ).toContain("zoom-in");
  expect(
    cursorExpected({
      role: "option",
      disabled: false,
      cursor: "auto",
      control: true,
      composite: "listbox",
    }),
  ).toContain("auto");
});

it("does not turn a programmatic dialog focus target into a clickable control", () => {
  const window = new Window();
  const dialog = window.document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.tabIndex = -1;
  expect(dialog.matches(interactive)).toBe(false);
  dialog.setAttribute("role", "button");
  expect(dialog.matches(interactive)).toBe(true);
});

it("allows two complete focus cycles in large inventories", () => {
  const cycle = Array.from({ length: 130 }, (_, i) => String(i));
  expect(cycleLength([...cycle, ...cycle].slice(0, 200))).toBeNull();
  expect(tabBudget(cycle.length)).toBeGreaterThan(260);
  expect(cycleLength([...cycle, ...cycle])).toBe(130);
});

it("waits for asynchronously rendered targets before continuing an input sequence", async () => {
  const ready = new Set<string>();
  const inputs: string[] = [];
  const page = {
    locator: (selector: string) => {
      const locator = {
        first: () => locator,
        waitFor: async () => {
          await Promise.resolve();
          ready.add(selector);
        },
        count: async () => Number(ready.has(selector)),
        evaluateAll: async () => ready.has(selector),
        boundingBox: async () =>
          ready.has(selector) ? { x: 0, y: 0, width: 20, height: 20 } : null,
        evaluate: async () => ({ name: "", href: null, handlers: "clipboard", editable: true }),
      };
      return locator;
    },
    keyboard: {
      press: async (key: string) => {
        expect(ready.has(".pin")).toBe(true);
        inputs.push(key);
      },
      type: async (text: string) => inputs.push("type:" + text),
    },
    mouse: { move: async () => inputs.push("hover"), click: async () => inputs.push("click") },
    evaluate: async () => ({ w: 100, h: 100 }),
  } as unknown as Page;
  await steps({ page } as Context, [
    { do: "tab", to: ".pin" },
    { do: "hover", target: ".detail" },
    { do: "type", target: ".composer", text: "hello" },
  ]);
  expect(inputs).toEqual(["Tab", "hover", "click", "type:hello"]);
  expect(ready.has(".detail")).toBe(true);
});

it("reads ID-shortened library ancestry and clips paint before the scrollbar gutter", async () => {
  const window = new Window();
  for (const key of [
    "document",
    "CSS",
    "HTMLElement",
    "HTMLInputElement",
    "DOMRect",
    "innerWidth",
    "innerHeight",
  ] as const)
    vi.stubGlobal(key, window[key]);
  vi.stubGlobal("getComputedStyle", window.getComputedStyle.bind(window));
  document.body.innerHTML =
    '<style>* { opacity: 1; visibility: visible; }</style><div class="app"><main class="pane"><div class="xterm"><button id="library">Library private text</button></div><div style="opacity:0"><button id="hidden">h</button></div><div id="scroll" style="overflow-x:hidden;overflow-y:hidden"><button id="clipped">c</button></div><button id="own" class="btn icon" title="Settings"></button><div id="context" class="elsewhere">Shown text</div></main><aside class="detached">Owned outside the main view</aside></div>';
  Object.defineProperties(document.getElementById("scroll"), {
    clientWidth: { value: 18 },
    clientHeight: { value: 20 },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.id === "scroll" ? new DOMRect(0, 0, 20, 20) : new DOMRect(10, 10, 30, 30);
  });
  document.elementFromPoint = () => document.getElementById("own");
  const page = {
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
  } as unknown as Page;
  const context = {
    page,
    state: "test",
    inventory: {
      version: 1,
      nonVisual: [],
      components: [
        { ...component("pane", ".pane"), kind: "view" },
        { ...component("inactive-shell", ".app", "other"), kind: "view" },
        component("icon", ".btn.icon"),
        component("inactive", ".elsewhere", "other"),
        component("detached", ".detached", "other"),
      ],
    },
  } as unknown as Context;
  const result = await elements(context);
  expect(mapped(context)).toBe("pane");
  expect(result.find((e) => e.selector === "#library")).toBeUndefined();
  expect(result.find((e) => e.selector === "#hidden")).toBeUndefined();
  expect(result.find((e) => e.selector === "#clipped")?.paint).toEqual({
    x: 10,
    y: 10,
    width: 8,
    height: 10,
  });
  expect(result.find((e) => e.selector === "#own")?.owner).toBe("icon");
  expect(result.find((e) => e.selector === "#context")?.owner).toBe("pane");
  expect(result.find((e) => e.text === "Owned outside the main view")?.owner).toBe("detached");
  expect(result.find((e) => e.owner === "pane")?.text).not.toContain("Library private text");
  document.body.innerHTML =
    '<style>* { opacity: 1; visibility: visible; }</style><section class="standalone">A standalone component</section>';
  context.inventory.components = [component("standalone", ".standalone", "other")];
  await elements(context);
  expect(mapped(context)).toBe("standalone");
});

it("allows a sibling scrim to overlap its drawer but keeps overlaps within a layer", () => {
  const scrim = { layer: "scrim", dismissal: true, ancestors: [] };
  const drawer = { layer: "drawer", ancestors: [] };
  expect(layeredTogether(scrim, drawer)).toBe(true);
  expect(layeredTogether(drawer, { ...drawer })).toBe(false);
});

it("tests text ranges rather than unused space in a block heading", () => {
  const text = { x: 0, y: 0, width: 50, height: 18 };
  const close = { x: 80, y: 0, width: 20, height: 24 };
  expect(overlappingRegions([text], [close])).toBeUndefined();
  expect(overlappingRegions([{ ...text, width: 90 }], [close])).toBeDefined();
});

it("detects a real inset focus ring and rejects identical captures", () => {
  const bytes = new Uint8Array(40 * 40 * 4).fill(255),
    focused = bytes.slice();
  for (let x = 5; x < 35; x++)
    for (const y of [5, 34]) for (let c = 0; c < 3; c++) focused[(y * 40 + x) * 4 + c] = 0;
  expect(
    focusPixels(
      encode({ width: 40, height: 40, data: focused }),
      encode({ width: 40, height: 40, data: bytes }),
    ),
  ).toBe(60);
  expect(
    focusPixels(
      encode({ width: 40, height: 40, data: bytes }),
      encode({ width: 40, height: 40, data: bytes }),
    ),
  ).toBe(0);
});

it("groups pass observations across positions and themes while retaining different values", () => {
  const f: Finding = {
    id: "a",
    check: "overflow",
    component: "button",
    state: "default",
    theme: "dark",
    gymState: "test",
    selector: "button:nth-of-type(1)",
    measured: {
      rule: "overlap",
      value: { other: "span:nth-of-type(1)", a: { x: 1, y: 2, width: 28, height: 28 } },
    },
    expected: "Disjoint",
    message: "overlap",
  };
  const b = {
    ...f,
    id: "b",
    theme: "light" as const,
    selector: "button:nth-of-type(2)",
    measured: {
      rule: "overlap",
      value: { other: "span:nth-of-type(2)", a: { x: 30, y: 40, width: 28, height: 28 } },
    },
  };
  const report = buildReport([f, b], []);
  expect(report.groups.open).toHaveLength(1);
  expect(report.groups.open[0]?.instanceCount).toBe(2);
  const focusA = {
    ...f,
    check: "keyboard" as const,
    measured: "body",
    expected: "#root > button:nth-of-type(1)",
  };
  const focusB = { ...focusA, id: "b", expected: "#root > button:nth-of-type(2)" };
  expect(buildReport([focusA, focusB], []).groups.open).toHaveLength(1);
  const outsideA = {
    ...f,
    message: "outside-window",
    measured: { x: -10, y: 0, width: 28, height: 28 },
  };
  const outsideB = { ...outsideA, id: "b", measured: { x: -20, y: 0, width: 28, height: 28 } };
  expect(buildReport([outsideA, outsideB], []).groups.open).toHaveLength(2);
  const shift = {
    ...f,
    check: "motion" as const,
    message: "layout-shift",
    measured: {
      rule: "layout-shift",
      value: {
        before: { x: 0, y: 0, width: 28, height: 28 },
        after: { x: 0, y: 13, width: 28, height: 28 },
        percent: 0,
      },
    },
  };
  const nextFrame = {
    ...shift,
    id: "next",
    measured: { ...shift.measured, value: { ...shift.measured.value, percent: 25 } },
  };
  expect(buildReport([shift, nextFrame], []).groups.open).toHaveLength(1);
});

it("keeps a route identity while rendering the empty terminal fixture", () => {
  const world = new World();
  STATES.find((s) => s.id === "inventory-terminal-empty")!.world!(world);
  expect(STATES.find((s) => s.id === "inventory-terminal-empty")!.route!(world)).toMatchObject({
    name: "terminal",
    terminalId: expect.any(String),
  });
});

it("returns a version from the gym file save instead of null", () => {
  vi.stubGlobal("localStorage", new Window().localStorage);
  const world = new World();
  STATES.find((s) => s.id === "inventory-files")!.world!(world);
  expect(world.saveFile({ fileId: "inventory-file-0", content: "Edited" })).toEqual({ version: 2 });
  expect(world.get("files:get", { fileId: "inventory-file-0" })).toMatchObject({
    content: "Edited",
    version: 2,
  });
});

it("clears pending interaction state only in the isolated gym document", () => {
  const clear = vi.fn();
  vi.stubGlobal("location", { protocol: "https:", pathname: "/" });
  vi.stubGlobal("localStorage", { clear });
  vi.stubGlobal("sessionStorage", { clear });
  resetFixtureStorage();
  expect(clear).not.toHaveBeenCalled();
  vi.stubGlobal("location", { protocol: "uplink-room:", pathname: "/gym.html" });
  resetFixtureStorage();
  expect(clear).toHaveBeenCalledTimes(2);
});

it("does not treat an ID-shortened child as an overlapping sibling", () => {
  const parent = { selector: "#root > main > button", ancestors: ["#root > main", "#root"] };
  const child = { selector: "#child", ancestors: [parent.selector, "#root > main", "#root"] };
  expect(relatedElements(parent, child)).toBe(true);
  expect(relatedElements(parent, { selector: "#peer", ancestors: ["#root > main", "#root"] })).toBe(
    false,
  );
});

it("accepts arrow wrapping in a one-item menu but requires movement among several", () => {
  expect(arrowMoved("only", "only", 1)).toBe(true);
  expect(arrowMoved("first", "first", 2)).toBe(false);
  expect(arrowMoved("first", "second", 2)).toBe(true);
  expect(arrowMoved(undefined, undefined, 0)).toBe(true);
  expect(arrowMoved(undefined, undefined, 1)).toBe(false);
});

it("keeps the private-channel route available in its empty fixture", () => {
  const world = new World();
  const state = STATES.find((s) => s.id === "inventory-private-empty")!;
  state.world!(world);
  expect(state.route!(world)).toMatchObject({ name: "channel", channelId: expect.any(String) });
});

it("keeps open overlay controls present when starting keyboard traversal", async () => {
  const window = new Window();
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("getComputedStyle", window.getComputedStyle.bind(window));
  vi.stubGlobal("innerWidth", 100);
  vi.stubGlobal("innerHeight", 100);
  vi.spyOn(window.HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new window.DOMRect(0, 0, 100, 100),
  );
  document.body.innerHTML =
    '<div class="overlay"><div role="dialog"><button>Cancel</button></div></div>';
  document.elementFromPoint = () => document.querySelector(".overlay");
  const click = vi.fn();
  const page = {
    evaluate: async (fn: (arg: string) => unknown, arg: string) => fn(arg),
    mouse: { click },
  } as unknown as Page;
  await emptyClick({ page } as Context);
  expect(click).not.toHaveBeenCalled();
  document.body.innerHTML = "<main>Empty space</main>";
  document.elementFromPoint = () => document.querySelector("main");
  await emptyClick({ page } as Context);
  expect(click).toHaveBeenCalledOnce();
});

it("removes only library descendants from Tab traversal and restores their state", async () => {
  const window = new Window();
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("CSS", window.CSS);
  document.body.innerHTML =
    '<button id="app">App</button><div class="xterm"><textarea></textarea></div><div class="excalidraw" inert="kept"></div>';
  const page = {
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
  } as unknown as Page;
  const restore = await scopeTabTraversal({ page } as Context);
  expect(document.querySelector(".xterm")?.hasAttribute("inert")).toBe(true);
  expect(document.getElementById("app")?.hasAttribute("inert")).toBe(false);
  await restore();
  expect(document.querySelector(".xterm")?.hasAttribute("inert")).toBe(false);
  expect(document.querySelector(".excalidraw")?.getAttribute("inert")).toBe("kept");
});

it("credits only options reached through the composite's active descendant", async () => {
  const window = new Window();
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("CSS", window.CSS);
  document.body.innerHTML =
    '<input id="search" aria-controls="choices" aria-activedescendant="a"><ul id="choices"><li role="option" id="a"></li><li role="option" id="b"></li><li role="option" id="unreachable"></li></ul>';
  const control = document.getElementById("search")!;
  const page = {
    locator: () => ({
      focus: async () => (control as HTMLInputElement).focus(),
      evaluate: async (fn: (el: Element) => unknown) => fn(control),
    }),
    keyboard: {
      press: async () =>
        control.setAttribute(
          "aria-activedescendant",
          control.getAttribute("aria-activedescendant") === "a" ? "b" : "a",
        ),
    },
  } as unknown as Page;
  expect(await arrowDescendants(page, "#search")).toEqual(["#a", "#b"]);
});

it("lets Escape clear a query or close a nested layer before checking its parent", () => {
  expect(escapeProgress({ layers: 1, value: "query" }, { layers: 1, value: "" })).toBe(true);
  expect(escapeProgress({ layers: 1, value: "" }, { layers: 0, value: "" })).toBe(true);
  expect(escapeProgress({ layers: 1, value: "query" }, { layers: 1, value: "query" })).toBe(false);
});
