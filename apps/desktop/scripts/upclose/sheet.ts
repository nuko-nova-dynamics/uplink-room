import { readFile, readdir, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, relative, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { availableParallelism } from "node:os";
import { decode, zoom } from "./image.ts";
import type { Rect } from "./types.ts";
import { runPaths } from "./types.ts";
import type { Inventory, Measurement, Finding } from "./types.ts";

export const FRAME_WIDTH = 1000;
const CONTENT_WIDTH = 952;
const TILE_HEIGHT = 920;
export type Picture = {
  source: string;
  component: string;
  state: string;
  theme: string;
  scale: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fullWidth: number;
  fullHeight: number;
  sourceRegion?: Rect;
  sourceCrop?: string;
  wideTile?: boolean;
};
export type Item = { picture: Picture; label: string } | { text: string };
export type Frame = {
  path: string;
  label: string;
  items: Item[];
  height: number;
  budgetExempt?: boolean;
  note?: string;
};
export type ComponentPage = {
  id: string;
  name: string;
  frames: Frame[];
  notes: string[];
  links: string[];
  open: number;
  waived: number;
  dropped?: { label: string; images: string[] }[];
};
export type SheetPlan = { version: 1; summary: unknown; components: ComponentPage[] };
type Report = {
  summary?: unknown;
  open?: Finding[];
  findings?: Finding[];
  waived?: (Finding & { reason?: string; waiver?: { reason: string }; finding?: Finding })[];
};
const themes = ["dark", "light"] as const;
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const url = (s: string) => s.split(/[\\/]/).map(encodeURIComponent).join("/");
export function pictureLabel(p: Picture): string {
  const region = p.sourceRegion;
  const original = region
    ? ` | source pixels ${region.x},${region.y} to ${region.x + region.width},${region.y + region.height} of ${p.sourceCrop}`
    : "";
  return `${p.component} | ${p.state} | ${p.theme} | ${p.scale} | pixels ${p.x},${p.y} to ${p.x + p.width},${p.y + p.height} of ${p.fullWidth}×${p.fullHeight}${original}`;
}
export function tilePicture(p: Picture): Picture[] {
  const tiles: Picture[] = [];
  for (let y = 0; y < p.height; y += TILE_HEIGHT) {
    for (let x = 0; x < p.width; x += CONTENT_WIDTH) {
      tiles.push({
        ...p,
        wideTile: p.width > CONTENT_WIDTH,
        x: p.x + x,
        y: p.y + y,
        width: Math.min(CONTENT_WIDTH, p.width - x),
        height: Math.min(TILE_HEIGHT, p.height - y),
      });
    }
  }
  return tiles;
}
export function addFrames(page: ComponentPage, label: string, pictures: Picture[]): void {
  let items: Item[] = [],
    used = 0,
    rowWidth = 0,
    rowHeight = 0;
  const flush = () => {
    if (!items.length) return;
    page.frames.push({
      label,
      path: `pages/${page.id}/${String(page.frames.length + 1).padStart(2, "0")}-${label}.png`,
      items,
      height: 100 + used + rowHeight,
      budgetExempt: items.every((item) => "picture" in item && item.picture.wideTile),
    });
    items = [];
    used = 0;
    rowWidth = 0;
    rowHeight = 0;
  };
  for (const picture of pictures.flatMap(tilePicture)) {
    const w = Math.max(220, picture.width),
      h = picture.height + 110;
    if (rowWidth && rowWidth + w + 16 > CONTENT_WIDTH) {
      used += rowHeight + 16;
      rowWidth = 0;
      rowHeight = 0;
    }
    if (used + Math.max(rowHeight, h) > 1000) flush();
    items.push({ picture, label: pictureLabel(picture) });
    rowWidth += w + (rowWidth ? 16 : 0);
    rowHeight = Math.max(rowHeight, h);
  }
  flush();
}
function addText(page: ComponentPage, label: string, text: string): void {
  const lines = text.split("\n").flatMap((line) => line.match(/.{1,100}/gu) ?? [""]);
  for (let i = 0; i < lines.length; i += 42) {
    const chunk = lines.slice(i, i + 42).join("\n");
    page.frames.push({
      label,
      path: `pages/${page.id}/${String(page.frames.length + 1).padStart(2, "0")}-${label}.png`,
      items: [{ text: chunk }],
      height: 90 + Math.min(42, lines.length - i) * 22,
    });
  }
}
async function optionalJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
async function names(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
async function picture(
  path: string,
  component: string,
  state: string,
  theme: string,
  scale: string,
): Promise<Picture | undefined> {
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  if (data.length < 24 || data.toString("hex", 0, 8) !== "89504e470d0a1a0a")
    throw new Error(`Invalid PNG: ${path}`);
  const width = data.readUInt32BE(16),
    height = data.readUInt32BE(20);
  return {
    source: path,
    component,
    state,
    theme,
    scale,
    x: 0,
    y: 0,
    width,
    height,
    fullWidth: width,
    fullHeight: height,
  };
}
function region(
  p: Picture,
  m: Measurement,
  rect: Measurement["target"]["rect"],
  factor: number,
): Picture | undefined {
  const x = Math.max(0, Math.floor((rect.x - m.crop.x) * factor));
  const y = Math.max(0, Math.floor((rect.y - m.crop.y) * factor));
  const width = Math.min(p.fullWidth - x, Math.ceil((rect.x + rect.width - m.crop.x) * factor) - x);
  const height = Math.min(
    p.fullHeight - y,
    Math.ceil((rect.y + rect.height - m.crop.y) * factor) - y,
  );
  return width > 0 && height > 0 ? { ...p, x, y, width, height } : undefined;
}
function newPage(id: string, name: string): ComponentPage {
  return { id, name, frames: [], notes: [], links: [], open: 0, waived: 0 };
}

export async function planSheet(run: string, inventory: Inventory): Promise<SheetPlan> {
  run = resolve(run);
  const paths = runPaths(run),
    report = await optionalJson<Report>(paths.report("json"));
  const system = newPage("_system", "Across components");
  const systemPictures: Record<string, Picture[]> = {
    icons: [],
    controls: [],
    focus: [],
    type: [],
  };
  const pages: ComponentPage[] = [];
  const open = report?.open ?? report?.findings ?? [];
  const waived = report?.waived ?? [];
  for (const component of inventory.components) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(component.id))
      throw new Error(`Invalid component id: ${component.id}`);
    const page = newPage(component.id, component.name);
    const groups: Record<string, Picture[]> = {
      overview: [],
      summaryIcons: [],
      "states-2x-dark": [],
      "states-2x-light": [],
      "zoom-400": [],
      "zoom-800": [],
      overlays: [],
      focus: [],
      motion: [],
      overflow: [],
    };
    async function collect(
      path: string,
      state: string,
      theme: string,
      scale: string,
      group: string,
    ) {
      const p = await picture(path, component.id, state, theme, scale);
      if (p) groups[group]!.push(p);
      else page.notes.push(`Missing: ${state} | ${theme} | ${scale}`);
      return p;
    }
    for (const theme of themes)
      for (const state of component.states) {
        const p1 = await collect(
          paths.capture(component.id, state.id, theme, "1x.png"),
          state.id,
          theme,
          "1×",
          "overview",
        );
        const p2 = await collect(
          paths.capture(component.id, state.id, theme, "2x.png"),
          state.id,
          theme,
          "2×",
          `states-2x-${theme}`,
        );
        const m1 = await optionalJson<Measurement>(
          paths.capture(component.id, state.id, theme, "measure-1x.json"),
        );
        if (!m1) page.notes.push(`Missing: measurements | ${state.id} | ${theme} | 1×`);
        if (p1 && m1 && component.zoom) {
          const raster = decode(await readFile(p1.source));
          const regions: { label: string; rect: Rect; icon?: boolean }[] = m1.icons.map((icon) => ({
            label: `icon ${icon.iconName ?? icon.selector}`,
            rect: {
              x: icon.rect.x - 2,
              y: icon.rect.y - 2,
              width: icon.rect.width + 4,
              height: icon.rect.height + 4,
            },
            icon: true,
          }));
          const corners = (rect: Rect, label: string, margin = 0) => {
            regions.push(
              {
                label: `${label} top-left`,
                rect: { x: rect.x - margin, y: rect.y - margin, width: 24, height: 24 },
              },
              {
                label: `${label} side edge`,
                rect: {
                  x: rect.x + rect.width - 12,
                  y: rect.y + rect.height / 2 - 12,
                  width: 24,
                  height: 24,
                },
              },
            );
          };
          corners(m1.target.rect, "component");
          if (state.id === "focus-visible") {
            const focus = m1.focus;
            const ring = focus?.ringWidth ?? 4;
            corners(focus?.element.rect ?? m1.target.rect, "focus ring", ring + 2);
          }
          if (p1.width <= 120 && p1.height <= 60)
            regions.push({ label: "whole small control", rect: m1.crop });
          for (const entry of regions) {
            const crop = region(p1, m1, entry.rect, 1);
            if (!crop) continue;
            const data = new Uint8Array(crop.width * crop.height * 4);
            for (let y = 0; y < crop.height; y++) {
              const start = ((crop.y + y) * raster.width + crop.x) * 4;
              data.set(raster.data.subarray(start, start + crop.width * 4), y * crop.width * 4);
            }
            for (const factor of crop.width > 60 || crop.height > 40
              ? ([8, 4] as const)
              : ([8] as const)) {
              const bytes = zoom({ width: crop.width, height: crop.height, data }, factor);
              const width = crop.width * (factor + 1) - 1,
                height = crop.height * (factor + 1) - 1;
              const pic: Picture = {
                ...p1,
                source: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
                state: `${state.id} | ${entry.label}`,
                scale: `${factor * 100}% with 1 px grid`,
                x: 0,
                y: 0,
                width,
                height,
                fullWidth: width,
                fullHeight: height,
                sourceRegion: { x: crop.x, y: crop.y, width: crop.width, height: crop.height },
                sourceCrop: `1× crop ${p1.fullWidth}×${p1.fullHeight}`,
              };
              groups[`zoom-${factor * 100}`]!.push(pic);
              if (entry.icon && factor === 8) {
                groups.summaryIcons!.push(pic);
                systemPictures.icons!.push(pic);
              }
            }
          }
        }
        await collect(
          paths.capture(component.id, state.id, theme, "overlay.png"),
          state.id,
          theme,
          "2× measurement overlay",
          "overlays",
        );
        const m = await optionalJson<Measurement>(
          paths.capture(component.id, state.id, theme, "measure-2x.json"),
        );
        if (!m) page.notes.push(`Missing: measurements | ${state.id} | ${theme} | 2×`);
        if (p2 && (state.id === "focus-visible" || m?.focus)) {
          groups.focus!.push(p2);
          systemPictures.focus!.push(p2);
        }
        if (
          p2 &&
          (m?.target.tag.toLowerCase() === "button" ||
            /(^|[\s,.])\.btn\b|button/i.test(component.selector))
        )
          systemPictures.controls!.push(p2);
        if (m && p2)
          for (const text of m.texts) {
            const r = region(p2, m, text.inkRect, 2);
            if (r)
              systemPictures.type!.push({
                ...r,
                state: `${state.id} | ${text.styles.fontFamily ?? ""} ${text.styles.fontSize ?? ""} ${text.styles.fontWeight ?? ""}`,
              });
          }
      }
    for (const animation of await names(join(run, "motion", component.id)))
      for (const theme of themes) {
        for (const reduced of [false, true])
          for (const percent of [0, 25, 50, 75, 100]) {
            await collect(
              paths.motion(
                component.id,
                animation,
                theme,
                `${reduced ? "reduced/" : ""}f${String(percent).padStart(3, "0")}.png`,
              ),
              `${animation} ${percent}%${reduced ? " reduced motion" : ""}`,
              theme,
              "native motion frame",
              "motion",
            );
          }
        const video = paths.motion(component.id, animation, theme, "live.webm");
        if (await exists(video)) page.links.push(relative(paths.sheet, video));
      }
    if (!groups.motion!.length) page.notes.push("Missing: motion pass");
    for (const gymState of new Set(component.states.map((s) => s.gymState))) {
      for (const variant of await names(join(run, "overflow", gymState)))
        for (const theme of themes) {
          await collect(
            paths.overflow(gymState, variant, theme),
            `${gymState} ${variant}`,
            theme,
            "native overflow capture",
            "overflow",
          );
        }
      for (const theme of themes) {
        const order = await optionalJson<unknown>(paths.keyboard(gymState, theme, "order.json"));
        if (order)
          addText(
            page,
            "keyboard-order",
            `${component.id} | ${gymState} | ${theme}\n${JSON.stringify(order, null, 2)}`,
          );
        else page.notes.push(`Missing: keyboard order | ${gymState} | ${theme}`);
        const video = paths.keyboard(gymState, theme, "tab.webm");
        if (await exists(video)) page.links.push(relative(paths.sheet, video));
      }
    }
    if (!groups.focus!.length) page.notes.push("Missing: keyboard focus captures");
    if (!groups.overflow!.length) page.notes.push("Missing: overflow pass");
    // Keep visual evidence before keyboard lists and report text.
    const keyboard = page.frames;
    page.frames = [];
    addFrames(page, "summary", [...groups.overview!, ...groups.summaryIcons!]);
    if (!page.frames.length) addText(page, "summary", `${component.id} | No captures available`);
    for (const frame of page.frames)
      frame.note = `${component.id} | Open findings: ${open.filter((f) => f.component === component.id).length}`;
    for (const [label, pictures] of Object.entries(groups))
      if (label !== "overview" && label !== "summaryIcons") addFrames(page, label, pictures);
    for (const frame of keyboard)
      addText(page, frame.label, (frame.items[0] as { text: string }).text);
    if (!report) page.notes.push("Missing: report.json");
    const findings = open.filter((f) => f.component === component.id);
    const waivers = waived.filter((w) => (w.finding ?? w).component === component.id);
    page.open = findings.length;
    page.waived = waivers.length;
    if (report)
      addText(
        page,
        "report",
        // Only this component's part: the run summary is on the sheet's index page once.
        `${component.id} | deterministic report\nOpen: ${findings.length}; waived: ${waivers.length}`,
      );
    for (const f of findings) addText(page, "open-finding", findingText(f));
    for (const w of waivers)
      addText(
        page,
        "waived-finding",
        `${findingText(w.finding ?? w)}\nWaiver: ${w.reason ?? w.waiver?.reason ?? "Reason missing from report"}`,
      );
    applyBudget(page, component.kind === "view" ? 16 : 10);
    pages.push(page);
  }
  for (const [label, pictures] of Object.entries(systemPictures)) {
    addFrames(system, label, pictures);
    if (!pictures.length) system.notes.push(`Missing: ${label} comparison inputs`);
  }
  return { version: 1, summary: report?.summary ?? null, components: [...pages, system] };
}
export function applyBudget(page: ComponentPage, limit: number): void {
  const priority = (frame: Frame) => {
    if (frame.label === "summary") return 0;
    if (frame.label === "open-finding") return 1;
    if (frame.label.startsWith("states-2x")) return 4;
    if (frame.label === "report") return 2;
    if (frame.label === "focus") return 5;
    if (frame.label === "zoom-800")
      return frame === page.frames.find((f) => f.label === "zoom-800") ? 3 : 6;
    if (frame.label === "zoom-400") return 7;
    return 8;
  };
  const selected = new Set<Frame>();
  let used = 0;
  // The budget trims text only: a judge must see every crop, zoom, overlay and focus capture,
  // since a state the sheet leaves out caps the component's grade.
  const visual = (frame: Frame) => frame.items.some((item) => "picture" in item);
  for (const frame of [...page.frames].sort((a, b) => priority(a) - priority(b))) {
    if (frame.label === "open-finding" || visual(frame) || used < limit) {
      selected.add(frame);
      used++;
    }
  }
  page.dropped = page.frames
    .filter((frame) => !selected.has(frame))
    .map((frame) => ({
      label: frame.label,
      images: frame.items.map((item) => ("picture" in item ? item.label : item.text)),
    }));
  page.frames = page.frames.filter((frame) => selected.has(frame));
  page.frames.forEach((frame, index) => {
    frame.path = `pages/${page.id}/${String(index + 1).padStart(2, "0")}-${frame.label}.png`;
  });
  const last = page.frames.at(-1);
  if (last && page.dropped.length) {
    const labels = [...new Set(page.dropped.map((frame) => frame.label))].join(", ");
    last.note = `${last.note ? `${last.note}. ` : ""}Budget omitted ${page.dropped.length} frames: ${labels}. Full list in index.json.`;
    page.notes.push(last.note);
  }
  if (used > limit)
    page.notes.push(
      `Open findings require ${used - limit} frames above the budget; no finding was dropped.`,
    );
}
function findingText(f: Finding): string {
  return `${f.component} | ${f.state} | ${f.theme} | ${f.scale ? `${f.scale}×` : "all scales"}\n${f.id} | ${f.check} | ${f.selector}\n${f.message}\nMeasured: ${JSON.stringify(f.measured)}\nExpected: ${JSON.stringify(f.expected)}${f.artifact ? `\nArtifact: ${f.artifact}` : ""}`;
}
export function sheetIndex(plan: SheetPlan) {
  return {
    ...plan,
    components: plan.components.map((p) => ({
      ...p,
      frames: p.frames.map(({ items: _items, ...frame }) => frame),
    })),
  };
}
export function frameHtml(frame: Frame, sourceUrl: (path: string) => string): string {
  return `<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:24px;width:1000px;background:#888;color:#111;font:14px/22px system-ui,sans-serif}h1{font-size:17px;line-height:24px;margin:0 0 28px}.items{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}figure{margin:0;flex:none}figcaption{font-size:12px;line-height:16px;height:110px;overflow-wrap:anywhere;max-width:100%;padding:0 0 10px}.crop{position:relative;overflow:hidden}img{position:absolute;max-width:none;image-rendering:pixelated}pre{margin:0;font:14px/22px system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>${esc(frame.path)}</h1><div class="items">${frame.items.map((item) => ("text" in item ? `<pre>${esc(item.text)}</pre>` : `<figure style="width:${Math.max(220, item.picture.width)}px"><figcaption>${esc(item.label)}</figcaption><div class="crop" style="width:${item.picture.width}px;height:${item.picture.height}px"><img src="${esc(sourceUrl(item.picture.source))}" style="width:${item.picture.fullWidth}px;height:${item.picture.fullHeight}px;left:-${item.picture.x}px;top:-${item.picture.y}px"></div></figure>`)).join("")}</div>${frame.note ? `<p>${esc(frame.note)}</p>` : ""}`;
}
export async function buildSheet(run: string, inventory: Inventory): Promise<SheetPlan> {
  if (process.platform !== "linux")
    throw new Error("Render the sheet on the Linux instabox, not on this Mac.");
  const start = performance.now();
  const plan = await planSheet(run, inventory),
    out = runPaths(resolve(run)).sheet;
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  try {
    await rm(join(out, "pages"), { recursive: true, force: true });
    // Frames are independent files, so several pages render them at once from one shared queue.
    const frames = plan.components.flatMap((c) => c.frames);
    const workers = Math.max(
      1,
      Math.min(frames.length, Number(process.env["SHEET_PAGES"]) || availableParallelism()),
    );
    let next = 0;
    const render = async () => {
      const page = await browser.newPage({
        viewport: { width: FRAME_WIDTH, height: 1250 },
        deviceScaleFactor: 1,
      });
      for (let i = next++; i < frames.length; i = next++) {
        const frame = frames[i]!;
        const sources = new Map<string, string>();
        for (const item of frame.items)
          if ("picture" in item && !sources.has(item.picture.source))
            sources.set(
              item.picture.source,
              item.picture.source.startsWith("data:")
                ? item.picture.source
                : `data:image/png;base64,${(await readFile(item.picture.source)).toString("base64")}`,
            );
        await page.setContent(frameHtml(frame, (path) => sources.get(path)!));
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all([...document.images].map((i) => i.decode()));
        });
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        // The viewport is 1250 high; measure content independently for compact frames.
        const contentHeight = await page
          .locator("body")
          .evaluate((el) => Math.ceil(el.getBoundingClientRect().height));
        if (contentHeight > 1250)
          throw new Error(`Frame exceeds 1250 pixels: ${frame.path} (${height})`);
        frame.height = contentHeight;
        const target = join(out, frame.path);
        await mkdir(dirname(target), { recursive: true });
        await page.screenshot({
          path: target,
          clip: { x: 0, y: 0, width: FRAME_WIDTH, height: contentHeight },
        });
      }
      await page.close();
    };
    await Promise.all(Array.from({ length: workers }, render));
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "index.json"), JSON.stringify(sheetIndex(plan), null, 2) + "\n");
    await writeFile(
      join(out, "index.html"),
      `<!doctype html><meta charset="utf-8"><title>Component sheet</title><style>body{background:#888;color:#111;font:14px/1.6 system-ui,sans-serif;margin:24px}a{color:#111}pre{white-space:pre-wrap}</style><h1>Component sheet</h1><pre>${esc(JSON.stringify(plan.summary, null, 2))}</pre><nav>${plan.components.map((c) => `<a href="#${c.id}">${esc(c.name)}</a>`).join(" | ")}</nav>${plan.components.map((c) => `<section id="${c.id}"><h2>${esc(c.name)}</h2><p>Open: ${c.open}; waived: ${c.waived}</p><ol>${c.frames.map((f) => `<li><a href="${url(f.path)}">${esc(f.path)}</a></li>`).join("")}</ol>${c.notes.map((n) => `<p>${esc(n)}</p>`).join("")}${c.links.map((l) => `<p><a href="${url(l)}">${esc(l)}</a></p>`).join("")}</section>`).join("")}`,
    );
  } finally {
    await browser.close();
  }
  console.log(
    JSON.stringify({
      frames: plan.components.reduce((n, c) => n + c.frames.length, 0),
      milliseconds: Math.round(performance.now() - start),
      output: out,
    }),
  );
  return plan;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2),
    run = args[0];
  if (!run || (args.length > 1 && (args[1] !== "--inventory" || !args[2] || args.length !== 3)))
    throw new Error("Usage: node scripts/upclose/sheet.ts <run-folder> [--inventory <path>]");
  const inventoryPath =
    args[2] ?? resolve(import.meta.dirname, "../../src/renderer/gym/inventory.json");
  const inventory = await optionalJson<Inventory>(inventoryPath);
  if (!inventory)
    throw new Error(`Inventory not found: ${inventoryPath}. Pass --inventory <path>.`);
  await buildSheet(run, inventory);
}
