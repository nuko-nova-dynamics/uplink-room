import { afterEach, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import type { Locator } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon } from "../../src/renderer/components/Icon.tsx";
import { measure } from "./measure.ts";
import { measurement } from "./fixtures.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setupWindow() {
  const window = new Window();
  for (const key of [
    "document",
    "location",
    "CSS",
    "NodeFilter",
    "HTMLElement",
    "Element",
    "HTMLCanvasElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLSelectElement",
    "DOMRect",
    "DOMPoint",
    "DOMMatrix",
    "innerWidth",
    "innerHeight",
    "devicePixelRatio",
  ] as const)
    vi.stubGlobal(key, window[key]);
  vi.stubGlobal("getComputedStyle", (el: Parameters<typeof window.getComputedStyle>[0]) => {
    const style = window.getComputedStyle(el);
    return new Proxy(style, {
      get(target, key) {
        if (key === Symbol.iterator)
          return function* () {
            for (let i = 0; i < style.length; i++) yield style.item(i);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  return window;
}

it("records nearest DOM owners and library ancestry even when an ID shortens the selector", async () => {
  const window = setupWindow();
  document.body.innerHTML =
    '<style>* { opacity: 1; visibility: visible; }</style><main class="view"><button class="btn icon" id="own">' +
    renderToStaticMarkup(createElement(Icon, { name: "more" })) +
    '</button><div class="xterm"><button id="library"></button></div></main>';
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(10, 20, 28, 28),
  );
  vi.spyOn(window.SVGElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new window.DOMRect(10, 20, 14, 14),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect() {},
    fillRect() {},
    getImageData: () => ({ data: new Uint8ClampedArray([20, 20, 20, 255]) }),
  } as unknown as CanvasRenderingContext2D);
  const root = document.querySelector("main")!;
  const target = {
    evaluate: async (fn: (el: Element, info: unknown) => unknown, info: unknown) => fn(root, info),
  } as unknown as Locator;
  const m = measurement();
  const result = await measure(target, {
    component: "view",
    state: "default",
    gymState: "test",
    theme: "dark",
    scale: 1,
    crop: m.crop,
    files: m.files,
    inventory: [
      { id: "view", selector: ".view" },
      { id: "button", selector: ".btn" },
      { id: "icon-button", selector: ".btn.icon" },
    ],
  });
  expect(result.icons[0]?.iconName).toBe("more");
  expect(result.icons[0]?.selector).toBeTruthy();
  expect(result.owners?.["#own"]?.component).toBe("icon-button");
  expect(result.owners?.["#library"]?.component).toBe("view");
  expect(result.scopeMatches?.["#library"]).toEqual(["third-party-dom"]);
});

it("captures font heights and grid-cell rows without hidden native labels", async () => {
  setupWindow();
  document.body.innerHTML =
    "<style>*{opacity:1;visibility:visible}main{display:grid}" +
    "input{font-family:Atkinson Hyperlegible Next;font-size:13px}</style>" +
    '<main><input id="first" value="Save"><input id="second" value="Forget">' +
    '<input class="sr-only" value="Hidden"><input style="opacity:0" value="Transparent"></main>';
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(10, 20, 100, 28),
  );
  const measured: string[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect() {},
    fillRect() {},
    getImageData: () => ({ data: new Uint8ClampedArray([20, 20, 20, 255]) }),
    measureText(value: string) {
      measured.push(value);
      return {
        width: 30,
        fontBoundingBoxAscent: 12,
        fontBoundingBoxDescent: 3,
        actualBoundingBoxAscent: value === "H" ? 9 : 7,
      };
    },
  } as unknown as CanvasRenderingContext2D);
  const target = {
    evaluate: async (fn: (el: Element, info: unknown) => unknown, info: unknown) =>
      fn(document.querySelector("main")!, info),
  } as unknown as Locator;
  const result = await measure(target, {
    component: "test",
    state: "default",
    gymState: "test",
    theme: "dark",
    scale: 1,
    crop: measurement().crop,
    files: measurement().files,
  });
  expect(result.texts).toHaveLength(2);
  expect(result.texts.map((t) => [t.capHeight, t.xHeight])).toEqual([
    [9, 7],
    [9, 7],
  ]);
  expect(result.textRows).toEqual([["#first::value"], ["#second::value"]]);
  expect(measured.filter((t) => t === "H")).toHaveLength(1);
});

it("captures a direct flex label and the complete in-flow group", async () => {
  const window = setupWindow();
  document.body.innerHTML =
    "<style>*{opacity:1;visibility:visible}button{display:flex}</style>" +
    '<main><button><svg data-icon="test"></svg>Save<span class="sr-only">Hidden</span></button></main>';
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(10, 20, 80, 28),
  );
  vi.spyOn(window.SVGElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new window.DOMRect(20, 27, 14, 14),
  );
  vi.spyOn(window.Range.prototype, "getBoundingClientRect").mockImplementation(
    () => new window.DOMRect(40, 27, 26, 14),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect() {},
    fillRect() {},
    getImageData: () => ({ data: new Uint8ClampedArray([20, 20, 20, 255]) }),
    measureText: () => ({
      width: 26,
      fontBoundingBoxAscent: 11,
      fontBoundingBoxDescent: 3,
      actualBoundingBoxAscent: 8,
    }),
  } as unknown as CanvasRenderingContext2D);
  const target = {
    evaluate: async (fn: (el: Element, info: unknown) => unknown, info: unknown) =>
      fn(document.querySelector("main")!, info),
  } as unknown as Locator;
  const result = await measure(target, {
    component: "test",
    state: "default",
    gymState: "test",
    theme: "dark",
    scale: 1,
    crop: measurement().crop,
    files: measurement().files,
  });
  const context = result.iconContexts![result.icons[0]!.selector]!;
  expect(result.texts.map((t) => t.text)).toEqual(["Save"]);
  expect(context.labelSelector).toBe(result.texts[0]!.selector);
  expect(context.contentGroup).toEqual({ x: 20, y: 27, width: 46, height: 14 });
});

it("uses DOM ascent for mixed font baselines and wrapped runs without changing the target", async () => {
  const window = setupWindow();
  document.body.innerHTML =
    "<style>*{opacity:1;visibility:visible;font-family:Arial;font-size:13px;line-height:18px}" +
    "main{display:flex}#count{font-size:11px;line-height:16px}</style>" +
    '<main><span id="label">Working</span><span id="count">2</span>' +
    '<span id="wrapped">AB</span><button id="direct">Save</button></main>';
  const root = document.querySelector("main")!;
  const original = document.body.innerHTML;
  const nodes = [...root.querySelectorAll("*")].map((el) => el.firstChild);
  let probes = 0;
  let failProbe = false;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.style.verticalAlign === "baseline") {
      expect(root.contains(this)).toBe(false);
      probes++;
      return new DOMRect(0, this.parentElement!.style.fontSize === "11px" ? 110 : 111, 0, 0);
    }
    return new DOMRect(10, 20, 100, 40);
  });
  vi.spyOn(window.Range.prototype, "getBoundingClientRect").mockImplementation(function (
    this: InstanceType<typeof window.Range>,
  ) {
    const parent = this.startContainer.parentElement!;
    if (parent.getAttribute("style")?.includes("position: fixed")) {
      if (failProbe) throw new Error("Probe failed");
      return new window.DOMRect(0, 100, 10, 15);
    }
    const y = parent.id === "count" ? 21 : parent.id === "wrapped" && this.startOffset ? 38 : 20;
    return new window.DOMRect(10, y, 10, 15);
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect() {},
    fillRect() {},
    getImageData: () => ({ data: new Uint8ClampedArray([20, 20, 20, 255]) }),
    measureText: () => ({
      width: 10,
      fontBoundingBoxAscent: 12,
      fontBoundingBoxDescent: 3,
      actualBoundingBoxAscent: 8,
    }),
  } as unknown as CanvasRenderingContext2D);
  const target = {
    evaluate: async (fn: (el: Element, info: unknown) => unknown, info: unknown) => fn(root, info),
  } as unknown as Locator;
  const capture = () =>
    measure(target, {
      component: "test",
      state: "default",
      gymState: "test",
      theme: "dark",
      scale: 1,
      crop: measurement().crop,
      files: measurement().files,
    });
  const result = await capture();
  expect(result.texts.map((t) => [t.text, t.baseline])).toEqual([
    ["Working", 31],
    ["2", 31],
    ["A", 31],
    ["B", 49],
    ["Save", 31],
  ]);
  expect(probes).toBe(2);
  expect(document.body.innerHTML).toBe(original);
  expect([...root.querySelectorAll("*")].map((el) => el.firstChild)).toEqual(nodes);
  failProbe = true;
  await expect(capture()).rejects.toThrow("Probe failed");
  expect(document.body.innerHTML).toBe(original);
  expect([...root.querySelectorAll("*")].map((el) => el.firstChild)).toEqual(nodes);
});
