import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { Page } from "@playwright/test";
import {
  findingId,
  runPaths,
  type Finding,
  type Inventory,
  type Theme,
  type Step,
} from "../types.ts";
import type { Gym } from "../launch.ts";
import { resize, showState } from "../launch.ts";
import {
  forbidden,
  interactive,
  nearestComponent,
  sceneComponents,
  fallbackComponents,
} from "./rules.ts";
import { cropRect } from "../plan.ts";
import { scopeRules } from "../scope.ts";
export type Context = {
  gym: Gym;
  page: Page;
  run: string;
  state: string;
  theme: Theme;
  inventory: Inventory;
  findings: Finding[];
  paths: ReturnType<typeof runPaths>;
  viewOwner?: string;
};
export async function save(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}
export async function inventory(): Promise<Inventory> {
  const data: Inventory = JSON.parse(
    await readFile(new URL("../../../src/renderer/gym/inventory.json", import.meta.url), "utf8"),
  );
  return data;
}
export async function arrowDescendants(page: Page, selector: string): Promise<string[]> {
  const control = page.locator(selector);
  await control.focus();
  const count = await control.evaluate((el) =>
    (el.getAttribute("aria-controls") || "")
      .split(/\s+/)
      .reduce(
        (n, id) => n + (document.getElementById(id)?.querySelectorAll("[role=option]").length || 0),
        0,
      ),
  );
  const reached = new Set<string>();
  for (let i = 0; i <= Math.min(count, 200); i++) {
    const target = await control.evaluate((el) => {
      const item = document.getElementById(el.getAttribute("aria-activedescendant") || "");
      const owned = (el.getAttribute("aria-controls") || "")
        .split(/\s+/)
        .some((id) => document.getElementById(id)?.contains(item || null));
      return owned && item?.matches("[role=option]") ? "#" + CSS.escape(item.id) : null;
    });
    if (target) reached.add(target);
    if (i < count) await page.keyboard.press("ArrowDown");
  }
  return [...reached];
}
// Serialized into the page. Keep all DOM helpers inside this function.
export async function elements(
  c: Context,
  includeOffscreen = false,
  onlyActive = false,
  target?: string,
) {
  const result = await c.page.evaluate(
    ({
      candidates,
      fallbacks,
      querySelectors,
      query,
      includeOffscreen,
      onlyActive,
      libraries,
      target,
    }) => {
      const selectors = candidates.map((c) => c.selector);
      const matches = (el: Element, sel: string) => {
        const texts: { text: string; exact: boolean }[] = [];
        const css = sel.replace(
          /:(has-text|text-is)\(("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\)/g,
          (_all, kind: string, quoted: string) => {
            texts.push({ text: quoted.slice(1, -1), exact: kind === "text-is" });
            return "";
          },
        );
        try {
          return (
            el.matches(css) &&
            texts.every((t) =>
              t.exact
                ? [el, ...el.querySelectorAll("*")].some(
                    (n) => (n.textContent || "").replace(/\s+/g, " ").trim() === t.text,
                  )
                : (el.textContent || "").toLowerCase().includes(t.text.toLowerCase()),
            )
          );
        } catch {
          return false;
        }
      };
      const selector = (el: Element): string => {
        if (el.id) return "#" + CSS.escape(el.id);
        const parts: string[] = [];
        for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
          if (e.id) {
            parts.unshift("#" + CSS.escape(e.id));
            return parts.join(" > ");
          }
          const tag = e.tagName.toLowerCase();
          const siblings = e.parentElement
            ? [...e.parentElement.children].filter((x) => x.tagName === e!.tagName)
            : [];
          parts.unshift(
            tag + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(e) + 1})` : ""),
          );
        }
        return "body > " + parts.join(" > ");
      };
      return (
        target
          ? [...document.querySelectorAll(target)]
          : onlyActive
            ? document.activeElement && document.activeElement !== document.body
              ? [document.activeElement]
              : []
            : [
                ...document.querySelectorAll(
                  query +
                    "," +
                    [
                      ...new Set(
                        querySelectors.map((s) =>
                          s.replace(
                            /:(?:has-text|text-is)\(("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\)/g,
                            "",
                          ),
                        ),
                      ),
                    ]
                      .filter((sel) => {
                        try {
                          document.querySelector(sel);
                          return true;
                        } catch {
                          return false;
                        }
                      })
                      .join(",") +
                    ", [role=tooltip], .tooltip, [role=dialog], [role=menu], [role=listbox], .drawer, .popover, .menu, p, span, label, h1, h2, h3",
                ),
              ]
      ).flatMap((el) => {
        const r = el.getBoundingClientRect(),
          s = getComputedStyle(el);
        if (
          !r.width ||
          !r.height ||
          el.closest("[inert]") ||
          s.visibility === "hidden" ||
          s.display === "none" ||
          Number(s.opacity) === 0 ||
          (!includeOffscreen &&
            (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth))
        )
          return [];
        const ancestry: string[][] = [];
        let owner: string | undefined;
        let opacity = 1;
        let excluded = false;
        let paint = {
          x: Math.max(0, r.x),
          y: Math.max(0, r.y),
          right: Math.min(innerWidth, r.right),
          bottom: Math.min(innerHeight, r.bottom),
        };
        let layer = "";
        let sticky = false;
        for (let e: Element | null = el; e; e = e.parentElement) {
          ancestry.push(selectors.filter((sel) => matches(e!, sel)));
          owner ??= candidates.find((c) => matches(e!, c.selector))?.id;
          if (libraries.some((name) => e!.classList.contains(name))) excluded = true;
          const style = getComputedStyle(e);
          opacity *= Number(style.opacity || 1);
          if (style.visibility === "hidden" || style.display === "none") opacity = 0;
          if (
            !layer &&
            matches(
              e,
              ".overlay,.drawer,.drawer-scrim,.scrim,.popover,.pop,.menu,.emoji-picker,[role=dialog],[role=menu],[role=tooltip],[role=listbox]",
            )
          )
            layer = selector(e);
          if (style.position === "sticky" || style.position === "fixed") sticky = true;
          if (e !== el) {
            const box = e.getBoundingClientRect();
            const left = box.left + e.clientLeft,
              top = box.top + e.clientTop;
            if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
              paint.x = Math.max(paint.x, left);
              paint.right = Math.min(paint.right, left + e.clientWidth);
            }
            if (/hidden|clip|auto|scroll/.test(style.overflowY)) {
              paint.y = Math.max(paint.y, top);
              paint.bottom = Math.min(paint.bottom, top + e.clientHeight);
            }
          }
        }
        if (
          opacity === 0 ||
          excluded ||
          (!includeOffscreen && (paint.right <= paint.x || paint.bottom <= paint.y))
        )
          return [];
        if (!owner)
          for (let parent: Element | null = el; parent; parent = parent.parentElement) {
            owner = fallbacks.find((c) => matches(parent!, c.selector))?.id;
            if (owner) break;
          }
        const textNodes = document.createTreeWalker(el, 5, {
          acceptNode(node) {
            if (node.nodeType !== 1) return 1;
            const element = node as Element;
            return element.matches("style,script") ||
              libraries.some((name) => element.classList.contains(name))
              ? 2
              : 3;
          },
        });
        let text = "";
        const textRects: { x: number; y: number; width: number; height: number }[] = [];
        while (textNodes.nextNode()) {
          text += textNodes.currentNode.textContent || "";
          if (!textNodes.currentNode.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(textNodes.currentNode);
          for (const rect of range.getClientRects?.() || []) {
            const x = Math.max(paint.x, rect.x),
              y = Math.max(paint.y, rect.y);
            const right = Math.min(paint.right, rect.right),
              bottom = Math.min(paint.bottom, rect.bottom);
            if (right > x && bottom > y)
              textRects.push({ x, y, width: right - x, height: bottom - y });
          }
        }
        let scrollContainer = false;
        for (let e = el.parentElement; e; e = e.parentElement)
          if (
            /auto|scroll/.test(
              getComputedStyle(e).overflow +
                getComputedStyle(e).overflowX +
                getComputedStyle(e).overflowY,
            )
          )
            scrollContainer = true;
        const props = Object.keys(el).find((k) => k.startsWith("__reactProps"));
        const handlers = props
          ? Object.values((el as unknown as Record<string, Record<string, unknown>>)[props]!)
              .filter((x) => typeof x === "function")
              .map(String)
              .join(" ")
          : "";
        const label =
          el.getAttribute("aria-label") ||
          (el.getAttribute("aria-labelledby") || "")
            .split(" ")
            .map((id) => document.getElementById(id)?.textContent || "")
            .join(" ")
            .trim() ||
          text.trim() ||
          el.getAttribute("title") ||
          "";
        return [
          {
            selector: selector(el),
            ancestry,
            ancestors: (() => {
              const paths: string[] = [];
              for (let parent = el.parentElement; parent; parent = parent.parentElement)
                paths.push(selector(parent));
              return paths;
            })(),
            rect: { x: r.x, y: r.y, width: r.width, height: r.height },
            inputType: el instanceof HTMLInputElement ? el.type : null,
            zoomAction: el.matches(".attachment-image,.lightbox-stage img"),
            activeDescendant: el.getAttribute("aria-activedescendant"),
            owner,
            paint: {
              x: paint.x,
              y: paint.y,
              width: Math.max(0, paint.right - paint.x),
              height: Math.max(0, paint.bottom - paint.y),
            },
            layer,
            sticky,
            role:
              el.getAttribute("role") ||
              (el.matches(".drawer,.dialog,.overlay")
                ? "dialog"
                : el.matches(".menu,.pop,.popover,.access-pop")
                  ? "menu"
                  : el.tagName.toLowerCase()),
            modal: el.getAttribute("aria-modal") === "true",
            name: label.slice(0, 180),
            text: text.trim(),
            textRects,
            cursor: s.cursor,
            disabled: el.matches(":disabled,[aria-disabled=true]"),
            dismissal: el.matches(".scrim,.drawer-scrim"),
            control:
              el.matches(query) ||
              !!(
                props &&
                (el as unknown as Record<string, Record<string, unknown>>)[props]?.["onClick"] &&
                !handlers.includes(".closest(")
              ),
            icon: !!el.querySelector("svg") && !(el.textContent || "").trim(),
            title: el.getAttribute("title"),
            handlers,
            href: el.getAttribute("href"),
            scrollContainer,
            overflow: s.overflowX,
            scroll: el.scrollWidth,
            width: el.clientWidth,
            ellipsis: s.textOverflow,
            intended: !!el.closest(".avatar-stack, .face-stack, .avatars, .faces"),
            decorations: !!el.closest(".face, .char-host, .state-ring"),
            composite: el.matches(".inbox-row")
              ? "inbox"
              : el.closest("[role=listbox],[role=menu],[role=tablist]")?.getAttribute("role"),
            focusVisible: el.matches(":focus-visible"),
            tabIndex: (el as HTMLElement).tabIndex,
            pointerEvents: s.pointerEvents,
            occluder: (() => {
              const x = (paint.x + paint.right) / 2,
                y = (paint.y + paint.bottom) / 2;
              const hit = document.elementFromPoint(x, y);
              return hit && hit !== el && !el.contains(hit)
                ? {
                    selector: selector(hit),
                    layer: (() => {
                      const l = hit.closest(
                        ".overlay,.drawer,.drawer-scrim,.scrim,.popover,.pop,.menu,.emoji-picker,[role=dialog],[role=menu],[role=tooltip],[role=listbox]",
                      );
                      return l ? selector(l) : "";
                    })(),
                  }
                : null;
            })(),
            parent: el.parentElement ? selector(el.parentElement) : "",
            outline: s.outline,
            shadow: s.boxShadow,
          },
        ];
      });
    },
    {
      candidates: sceneComponents(c.inventory.components, c.state),
      fallbacks: fallbackComponents(c.inventory.components).map(({ id, selector }) => ({
        id,
        selector,
      })),
      querySelectors: c.inventory.components.flatMap((component) => [
        component.selector,
        ...component.states.flatMap((state) => (state.target ? [state.target] : [])),
      ]),
      libraries: scopeRules.find((r) => r.id === "third-party-dom")?.classes || [],
      query: interactive,
      includeOffscreen,
      onlyActive,
      target,
    },
  );
  if (!onlyActive && !target) {
    const views = new Set(
      c.inventory.components.filter((component) => component.kind === "view").map((v) => v.id),
    );
    const roots = result.filter((e) => e.owner && views.has(e.owner));
    roots.sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
    const root =
      roots[0] ||
      result
        .filter((e) => e.owner)
        .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0];
    c.viewOwner = root?.owner;
  }
  return result;
}
export type ElementInfo = Awaited<ReturnType<typeof elements>>[number];
export function mapped(c: Context, e?: ElementInfo) {
  return (
    e?.owner ||
    (e
      ? nearestComponent(e.ancestry, sceneComponents(c.inventory.components, c.state))
      : c.viewOwner || "unmapped")
  );
}

export function finding(
  c: Context,
  check: Finding["check"],
  e: ElementInfo | undefined,
  rule: string,
  measured: unknown,
  expected: unknown,
  artifact: string,
) {
  const f = {
    check,
    component: mapped(c, e),
    state: c.state,
    gymState: c.state,
    theme: c.theme,
    selector: e?.selector || "body",
    measured: { rule, value: measured },
    expected,
    message: rule,
    artifact: relative(c.run, artifact),
  };
  c.findings.push({ ...f, id: findingId(f) });
}
export async function shot(c: Context, file: string, e?: ElementInfo) {
  await mkdir(dirname(file), { recursive: true });
  const size = await c.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const r = e?.rect;
  const visible =
    r && r.x < size.width && r.y < size.height && r.x + r.width > 0 && r.y + r.height > 0;
  const rect = visible
    ? cropRect(r, size, 1, 6)
    : { x: 0, y: 0, width: size.width, height: size.height };
  const png = await mainValue<string>(
    `process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows()[0].webContents.capturePage(${JSON.stringify(rect)}).then(image=>image.toPNG().toString('base64'))`,
  );
  await writeFile(file, Buffer.from(png, "base64"));
}
export async function move(c: Context, e: ElementInfo) {
  await c.page.mouse.move(e.rect.x + e.rect.width / 2, e.rect.y + e.rect.height / 2);
}
export function safe(e: ElementInfo) {
  return !e.disabled && !e.href && !forbidden.test(e.name + " " + e.handlers);
}
export async function click(c: Context, e: ElementInfo) {
  if (!safe(e)) return false;
  await move(c, e);
  await c.page.mouse.click(e.rect.x + e.rect.width / 2, e.rect.y + e.rect.height / 2);
  return true;
}
export async function steps(c: Context, list: Step[]) {
  for (const step of list) {
    if (step.do === "resize") {
      await sizeWindow(c.page, step.width, step.height);
      continue;
    }
    if (step.do === "key") {
      if (/^(Escape|Arrow\w+|Tab|Shift\+Tab|Enter|Space|[aAsSzZhH])$/.test(step.key)) {
        if (step.key === "Enter" || step.key === "Space") {
          const active = (await elements(c, false, true))[0];
          if (!active || !safe(active))
            throw new Error("Skipped unsafe keyboard activation: " + step.key);
        }
        await c.page.keyboard.press(step.key);
      } else throw new Error("Unsafe inventory key: " + step.key);
      continue;
    }
    if (step.do === "wait") {
      await c.page.locator(step.for).first().waitFor({ timeout: 1500 });
      continue;
    }
    if (step.do === "tab" || step.do === "shift-tab") {
      const target = c.page.locator(step.to);
      await target.first().waitFor({ state: "visible", timeout: 3000 });
      if (!(await target.count())) throw new Error("Missing inventory tab target: " + step.to);
      let reached = false;
      for (let n = 0; n < (step.max || 60); n++) {
        await c.page.keyboard.press(step.do === "tab" ? "Tab" : "Shift+Tab");
        if (await target.evaluateAll((els) => els.some((el) => el === document.activeElement))) {
          reached = true;
          break;
        }
      }
      if (!reached) throw new Error("Inventory tab target was not reached: " + step.to);
      continue;
    }
    const loc = c.page.locator(step.target).first();
    await loc.waitFor({ state: "visible", timeout: 3000 });
    let box = await loc.boundingBox();
    for (let attempt = 0; box && attempt < 6; attempt++) {
      const viewport = await c.page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
      if (
        box.y >= 0 &&
        box.y + box.height <= viewport.h &&
        box.x >= 0 &&
        box.x + box.width <= viewport.w
      )
        break;
      await c.page.mouse.move(
        Math.min(viewport.w - 10, Math.max(10, box.x + box.width / 2)),
        viewport.h / 2,
      );
      await c.page.mouse.wheel(
        box.x < 0 ? box.x : Math.max(0, box.x + box.width - viewport.w),
        box.y - viewport.h / 2,
      );
      await c.page.waitForTimeout(60);
      box = await loc.boundingBox();
    }
    if (!box) throw new Error("Missing inventory step: " + step.target);
    if (step.do !== "hover") {
      const action = await loc.evaluate((el) => {
        const props = Object.keys(el).find((k) => k.startsWith("__reactProps"));
        return {
          name: el.getAttribute("aria-label") || el.textContent || "",
          href: el.getAttribute("href"),
          editable: el.matches("input,textarea,[contenteditable=true]"),
          handlers: props
            ? Object.values((el as unknown as Record<string, Record<string, unknown>>)[props]!)
                .filter((v) => typeof v === "function")
                .map(String)
                .join(" ")
            : "",
        };
      });
      if (
        (step.do !== "type" || !action.editable) &&
        (action.href || forbidden.test(action.name + " " + action.handlers))
      )
        throw new Error("Skipped external or clipboard action: " + step.target);
    }
    if (step.do === "hover") await c.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    else if (step.do === "press") {
      await c.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await c.page.mouse.down();
    } else if (step.do === "click" || step.do === "type") {
      await c.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      if (step.do === "type") await c.page.keyboard.type(step.text);
    }
  }
}
export async function video(file: string): Promise<() => Promise<void>> {
  await mkdir(dirname(file), { recursive: true });
  const child: ChildProcess = spawn(
    "ffmpeg",
    [
      "-nostdin",
      "-y",
      "-loglevel",
      "error",
      "-f",
      "x11grab",
      "-framerate",
      "60",
      "-video_size",
      "1320x840",
      "-i",
      process.env["DISPLAY"] || ":0",
      "-c:v",
      "libvpx-vp9",
      "-threads",
      "1",
      "-deadline",
      "realtime",
      "-cpu-used",
      "8",
      file,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let error = "";
  let spawnFailure: Error | undefined;
  child.stderr?.on("data", (v) => {
    error += String(v);
  });
  child.on("error", (e) => {
    spawnFailure = e;
    error += String(e);
  });
  const stop = async () => {
    child.kill("SIGINT");
    if (child.exitCode === null)
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5000).unref();
      });
    if (error.trim()) await writeFile(file + ".log", error);
  };
  try {
    const deadline = Date.now() + 5000;
    while (
      !(await stat(file).then(
        () => true,
        () => false,
      ))
    ) {
      if (
        spawnFailure ||
        child.exitCode !== null ||
        child.signalCode !== null ||
        Date.now() >= deadline
      )
        throw new Error("Recorder did not start: " + (error.trim() || file));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } catch (failure) {
    await stop();
    throw failure;
  }
  return stop;
}
export async function emptyClick(c: Context) {
  const point = await c.page.evaluate((query) => {
    // Clicking an open layer's backdrop dismisses the very controls being audited.
    if (
      [
        ...document.querySelectorAll(
          ".overlay,.drawer,.drawer-scrim,.scrim,.pop,.popover,.menu,[role=dialog],[role=menu],[role=listbox]",
        ),
      ].some((el) => {
        const r = el.getBoundingClientRect(),
          style = getComputedStyle(el);
        return (
          r.width > 0 && r.height > 0 && style.display !== "none" && style.visibility !== "hidden"
        );
      })
    )
      return null;
    for (let y = innerHeight - 10; y > 0; y -= 25)
      for (let x = innerWidth - 10; x > 0; x -= 25) {
        const e = document.elementFromPoint(x, y);
        if (e && !e.closest(query) && !e.closest(".scrim,[role=dialog]")) return { x, y };
      }
    return null;
  }, interactive);
  if (point) await c.page.mouse.click(point.x, point.y);
}

// The shared loader predates the isolated inventory root. Keep its real-input
// preparation while recognizing that root; do not change the shared launcher.
/** Every interaction starts from the same isolated gym storage, including the undo queue. */
export function resetFixtureStorage() {
  if (location.protocol !== "uplink-room:" || location.pathname !== "/gym.html") return;
  localStorage.clear();
  sessionStorage.clear();
}

export async function loadState(
  page: Page,
  state: string,
  theme: Theme,
  options: { reducedMotion?: boolean } = {},
) {
  await page.evaluate(resetFixtureStorage);
  const compatible = new Proxy(page, {
    get(target, property) {
      if (property === "locator")
        return (selector: string, options?: Parameters<Page["locator"]>[1]) =>
          target.locator(
            selector === ".app, .setup"
              ? ".app, .setup, .inventory-page, main.main, .browser-panel, [role=dialog]"
              : selector,
            options,
          );
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return showState(compatible, state, theme, options);
}
let inspectorPort = 0;
export async function enableWindowSizing() {
  const { freePort } = await import("../../lib.ts");
  inspectorPort = await freePort();
  process.env["UPLINK_GYM_ELECTRON_ARGS"] =
    (process.env["UPLINK_GYM_ELECTRON_ARGS"] || "") + ` --inspect=127.0.0.1:${inspectorPort}`;
}
async function mainValue<T>(expression: string): Promise<T> {
  const targets = (await (await fetch(`http://127.0.0.1:${inspectorPort}/json/list`)).json()) as {
    webSocketDebuggerUrl: string;
  }[];
  return new Promise<T>((resolve, reject) => {
    const socket = new WebSocket(targets[0]!.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Main-process request timed out"));
    }, 15000);
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    socket.onmessage = (event) => {
      const data = JSON.parse(String(event.data));
      if (data.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (data.error || data.result?.exceptionDetails) reject(new Error(JSON.stringify(data)));
      else resolve(data.result.result.value as T);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error("Main-process inspector connection failed"));
    };
  });
}
export async function sizeWindow(page: Page, width: number, height: number) {
  await mainValue(
    `(()=>{const w=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows()[0];w.setMenuBarVisibility(false);w.setPosition(0,0);w.setContentSize(${width},${height});w.focus();})()`,
  );
  const dims = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  if (dims.width !== width || dims.height !== height) await resize(page, width, height);
}

/** Keep excluded library key handlers out of the app's Tab traversal without changing layout. */
export async function scopeTabTraversal(c: Context) {
  await c.page.evaluate(
    (classes) => {
      const records = [
        ...document.querySelectorAll(classes.map((name) => "." + CSS.escape(name)).join(",")),
      ].map((element) => ({ element, inert: element.getAttribute("inert") }));
      (window as unknown as { __upcloseInert?: typeof records }).__upcloseInert = records;
      for (const { element } of records) element.setAttribute("inert", "");
    },
    scopeRules.find((r) => r.id === "third-party-dom")?.classes || [],
  );
  return async () => {
    await c.page.evaluate(() => {
      const w = window as unknown as {
        __upcloseInert?: { element: Element; inert: string | null }[];
      };
      for (const { element, inert } of w.__upcloseInert || []) {
        if (inert === null) element.removeAttribute("inert");
        else element.setAttribute("inert", inert);
      }
      delete w.__upcloseInert;
    });
  };
}
