import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { runPaths } from "../types.ts";
import type { Inventory, Measurement, Finding } from "../types.ts";

export const miniInventory: Inventory = {
  version: 1,
  nonVisual: [],
  components: [
    {
      id: "icon-button",
      name: "Icon button",
      kind: "primitive",
      selector: ".btn.icon",
      sources: [],
      zoom: true,
      states: ["default", "hover", "focus-visible"].map((id) => ({ id, gymState: "buttons" })),
    },
    {
      id: "text-button",
      name: "Text button",
      kind: "primitive",
      selector: ".btn",
      sources: [],
      zoom: true,
      states: ["default", "pressed", "focus-visible"].map((id) => ({ id, gymState: "buttons" })),
    },
    {
      id: "menu",
      name: "Menu",
      kind: "component",
      selector: ".menu",
      sources: [],
      zoom: true,
      role: "menu",
      states: ["default", "selected", "overflow"].map((id) => ({ id, gymState: "menu" })),
    },
  ],
};
async function save(path: string, value: string | Buffer) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}
export async function makeRun(run: string) {
  if (process.platform !== "linux") throw new Error("Generate fixtures on the Linux instabox.");
  const start = performance.now(),
    paths = runPaths(resolve(run));
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  try {
    for (const component of miniInventory.components)
      for (const state of component.states)
        for (const theme of ["dark", "light"] as const) {
          let crop1: Buffer | undefined;
          for (const scale of [1, 2] as const) {
            const context = await browser.newContext({
              viewport: { width: 1300, height: 500 },
              deviceScaleFactor: scale,
            });
            try {
              const page = await context.newPage(),
                dark = theme === "dark";
              const icon =
                '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v12M2 8h12"/></svg>';
              await page.setContent(
                `<style>body{margin:16px;background:${dark ? "#151619" : "#f7f8fa"};color:${dark ? "#ebecee" : "#15171a"};font:13px system-ui}.target{box-sizing:border-box;background:${dark ? "#1d1f23" : "#fff"};border:1px solid ${dark ? "#2b2e33" : "#dfe2e7"};border-radius:7px}.btn{height:28px;display:flex;align-items:center;justify-content:center;gap:6px;padding:0 9px;color:inherit;font:inherit}.icon{width:28px;padding:0}.menu{width:${state.id === "overflow" ? 1180 : 240}px;padding:8px}.row{padding:8px;border-radius:4px}.active,.btn:hover{background:${dark ? "#23262a" : "#eef0f3"}}.btn:focus-visible{outline:2px solid currentColor;outline-offset:2px}.pressed{background:${dark ? "#23262a" : "#eef0f3"}}</style>${component.id === "menu" ? `<div class="target menu"><div class="row ${state.id === "selected" ? "active" : ""}">${icon} Open channel</div><div class="row">${state.id === "overflow" ? "A long channel name used to inspect horizontal tiles and preserved pixels ".repeat(3) : "Mute notifications"}</div><div class="row">Channel settings</div></div>` : `<button type="button" aria-label="Add channel" class="target btn ${component.id === "icon-button" ? "icon" : ""} ${state.id === "pressed" ? "pressed" : ""}">${icon}${component.id === "text-button" ? "<span>Add channel</span>" : ""}</button>`}`,
              );
              if (state.id === "focus-visible") await page.keyboard.press("Tab");
              if (state.id === "hover") await page.locator(".target").hover();
              const box = (await page.locator(".target").boundingBox())!;
              const clip = {
                x: box.x - 6,
                y: box.y - 6,
                width: box.width + 12,
                height: box.height + 12,
              };
              const crop = await page.screenshot({ clip });
              if (scale === 1) crop1 = crop;
              await save(paths.capture(component.id, state.id, theme, `${scale}x.png`), crop);
              const m = (await page.evaluate(
                ({ componentId, stateId, theme, scale, clip }) => {
                  const target = document.querySelector(".target")!;
                  const element = (el: Element) => {
                    const r = el.getBoundingClientRect(),
                      s = getComputedStyle(el);
                    return {
                      selector: el.tagName.toLowerCase(),
                      tag: el.tagName,
                      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
                      styles: {
                        fontFamily: s.fontFamily,
                        fontSize: s.fontSize,
                        fontWeight: s.fontWeight,
                      },
                      background: { r: 29, g: 31, b: 35, a: 1 },
                    };
                  };
                  return {
                    component: componentId,
                    state: stateId,
                    theme,
                    scale,
                    gymState: componentId === "menu" ? "menu" : "buttons",
                    viewport: { width: 1300, height: 500 },
                    devicePixelRatio: scale,
                    crop: { ...clip, margin: 6 },
                    target: element(target),
                    icons: [...target.querySelectorAll("svg")].map((el) => ({
                      ...element(el),
                      viewBox: "0 0 16 16",
                      attrWidth: "14",
                      attrHeight: "14",
                      strokeWidths: [1.5],
                      bbox: { x: 2, y: 2, width: 12, height: 12 },
                      iconName: "plus",
                    })),
                    texts: [...target.querySelectorAll("span,.row")].map((el) => ({
                      ...element(el),
                      text: el.textContent!,
                      inkRect: element(el).rect,
                      baseline: element(el).rect.y + 16,
                      clipped: false,
                    })),
                    rowPeers: [],
                    columnPeers: [],
                    hits: [],
                    tokens: {},
                    files: { crop: "" },
                  };
                },
                { componentId: component.id, stateId: state.id, theme, scale, clip },
              )) as Measurement;
              m.files.crop = `captures/${component.id}/${state.id}/${theme}/${scale}x.png`;
              await save(
                paths.capture(component.id, state.id, theme, `measure-${scale}x.json`),
                JSON.stringify(m),
              );
              if (scale === 2)
                for (const zoom of [4, 8, 0]) {
                  const png = await page.evaluate(
                    async ({ data, zoom }) => {
                      const img = new Image();
                      img.src = data;
                      await img.decode();
                      const canvas = document.createElement("canvas");
                      canvas.width = img.width * (zoom || 1);
                      canvas.height = img.height * (zoom || 1);
                      const ctx = canvas.getContext("2d")!;
                      ctx.imageSmoothingEnabled = false;
                      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                      ctx.strokeStyle = zoom ? "rgba(128,128,128,.55)" : "#ff4f85";
                      ctx.lineWidth = 1;
                      if (zoom) {
                        for (let x = 0; x < canvas.width; x += zoom) {
                          ctx.beginPath();
                          ctx.moveTo(x + 0.5, 0);
                          ctx.lineTo(x + 0.5, canvas.height);
                          ctx.stroke();
                        }
                        for (let y = 0; y < canvas.height; y += zoom) {
                          ctx.beginPath();
                          ctx.moveTo(0, y + 0.5);
                          ctx.lineTo(canvas.width, y + 0.5);
                          ctx.stroke();
                        }
                      } else {
                        ctx.strokeRect(12.5, 12.5, canvas.width - 25, canvas.height - 25);
                        ctx.beginPath();
                        ctx.moveTo(canvas.width / 2 + 0.5, 0);
                        ctx.lineTo(canvas.width / 2 + 0.5, canvas.height);
                        ctx.stroke();
                      }
                      return canvas.toDataURL().split(",")[1]!;
                    },
                    {
                      data: `data:image/png;base64,${(zoom ? crop1! : crop).toString("base64")}`,
                      zoom,
                    },
                  );
                  await save(
                    paths.capture(
                      component.id,
                      state.id,
                      theme,
                      zoom ? `zoom-${zoom * 100}.png` : "overlay.png",
                    ),
                    Buffer.from(png, "base64"),
                  );
                }
            } finally {
              await context.close();
            }
          }
          if (state.id === "default")
            for (const reduced of [false, true])
              for (const percent of [0, 25, 50, 75, 100]) {
                await save(
                  paths.motion(
                    component.id,
                    "reveal",
                    theme,
                    `${reduced ? "reduced/" : ""}f${String(percent).padStart(3, "0")}.png`,
                  ),
                  crop1!,
                );
              }
          if (state.id === "overflow")
            await save(paths.overflow("menu", "long-name", theme), crop1!);
        }
    for (const gym of ["buttons", "menu"])
      for (const theme of ["dark", "light"] as const)
        await save(
          paths.keyboard(gym, theme, "order.json"),
          JSON.stringify({ order: ["Add channel", "Channel settings"], reachedBy: "Tab" }),
        );
    const finding: Finding = {
      id: "fixture-focus",
      component: "icon-button",
      state: "focus-visible",
      theme: "dark",
      scale: 2,
      gymState: "buttons",
      check: "contrast",
      selector: ".btn.icon",
      measured: 2.8,
      expected: ">= 3",
      message: "Synthetic finding for checking report display.",
    };
    await save(
      paths.report("json"),
      JSON.stringify(
        {
          summary: { open: 2, waived: 1, fixture: true },
          open: [
            finding,
            {
              ...finding,
              id: "fixture-menu",
              component: "menu",
              state: "overflow",
              check: "overflow",
            },
          ],
          waived: [
            {
              ...finding,
              id: "fixture-waiver",
              component: "text-button",
              reason: "Synthetic waiver for checking reason display.",
            },
          ],
        },
        null,
        2,
      ),
    );
    await save(join(run, "inventory.json"), JSON.stringify(miniInventory, null, 2));
  } finally {
    await browser.close();
  }
  console.log(
    JSON.stringify({ fixture: resolve(run), milliseconds: Math.round(performance.now() - start) }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2])
    throw new Error("Usage: node scripts/upclose/fixtures/make-run.ts <run-folder>");
  await makeRun(process.argv[2]);
}
