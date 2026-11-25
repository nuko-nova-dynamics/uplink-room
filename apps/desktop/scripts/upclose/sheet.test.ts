import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  tilePicture,
  pictureLabel,
  addFrames,
  planSheet,
  sheetIndex,
  frameHtml,
  applyBudget,
} from "./sheet.ts";
import type { Picture, ComponentPage, Item } from "./sheet.ts";
import { decode, encode } from "./image.ts";
import type { Inventory } from "./types.ts";
const p: Picture = {
  source: "/crop.png",
  component: "button",
  state: "hover",
  theme: "dark",
  scale: "2×",
  x: 0,
  y: 0,
  width: 2000,
  height: 1200,
  fullWidth: 2000,
  fullHeight: 1200,
};
describe("sheet planning", () => {
  it("tiles wide and tall crops without losing or scaling pixels", () => {
    const tiles = tilePicture(p);
    expect(tiles).toHaveLength(6);
    expect(tiles.reduce((sum, t) => sum + t.width * t.height, 0)).toBe(p.width * p.height);
    expect(tiles.every((t) => t.width <= 952 && t.height <= 1050 && t.fullWidth === 2000)).toBe(
      true,
    );
    const html = frameHtml(
      {
        path: "frame.png",
        label: "test",
        height: 1200,
        items: [{ picture: tiles[1]!, label: pictureLabel(tiles[1]!) }],
      },
      () => "/crop.png",
    );
    expect(html).toContain("width:2000px;height:1200px;left:-952px");
    expect(html).toContain("image-rendering:pixelated");
  });
  it("labels every image with citation fields and source coordinates", () => {
    expect(pictureLabel(p)).toBe(
      "button | hover | dark | 2× | pixels 0,0 to 2000,1200 of 2000×1200",
    );
  });
  it("packs small states beside each other and skips empty groups", () => {
    const page: ComponentPage = {
      id: "button",
      name: "Button",
      frames: [],
      notes: [],
      links: [],
      open: 0,
      waived: 0,
    };
    addFrames(page, "empty", []);
    addFrames(
      page,
      "overview",
      [p, p].map((p) => ({ ...p, width: 60, height: 40, fullWidth: 60, fullHeight: 40 })),
    );
    expect(page.frames).toHaveLength(1);
    expect(page.frames[0]!.items).toHaveLength(2);
    expect(page.frames[0]!.path).toBe("pages/button/01-overview.png");
  });
  it("indexes missing passes, findings, waiver reasons and the unchanged run summary", async () => {
    const run = await mkdtemp(join(tmpdir(), "sheet-test-"));
    try {
      const inventory: Inventory = {
        version: 1,
        nonVisual: [],
        components: [
          {
            id: "button",
            name: "Button",
            kind: "primitive",
            sources: [],
            selector: ".btn",
            zoom: true,
            states: [{ id: "default", gymState: "buttons" }],
          },
        ],
      };
      const f = {
        component: "button",
        id: "size",
        state: "default",
        theme: "dark",
        check: "sizes",
        selector: ".btn",
        measured: "30px",
        expected: "28px",
        message: "Too tall",
      };
      await writeFile(
        join(run, "report.json"),
        JSON.stringify({
          summary: { open: 1 },
          open: [f],
          waived: [{ ...f, reason: "Intended here" }],
        }),
      );
      const plan = await planSheet(run, inventory),
        page = plan.components[0]!;
      expect(page.notes).toContain("Missing: default | light | 2×");
      expect(page.frames.map((f) => f.label)).toEqual([
        "summary",
        "report",
        "open-finding",
        "waived-finding",
      ]);
      expect(JSON.stringify(page.frames)).toContain("Intended here");
      const index = sheetIndex(plan);
      expect(index.summary).toEqual({ open: 1 });
      expect(index.components[0]).toMatchObject({ open: 1, waived: 1 });
      expect(index.components[0]!.frames[0]).not.toHaveProperty("items");
      expect(index.components.at(-1)!.id).toBe("_system");
      await mkdir(join(run, "captures/button/default/dark"), { recursive: true });
      await writeFile(join(run, "captures/button/default/dark/1x.png"), "invalid");
      await expect(planSheet(run, inventory)).rejects.toThrow("Invalid PNG");
    } finally {
      await rm(run, { recursive: true, force: true });
    }
  });
  it("enforces both budgets, records omissions and never drops open findings", () => {
    for (const limit of [10, 16]) {
      const page: ComponentPage = {
        id: "menu",
        name: "Menu",
        frames: [],
        notes: [],
        links: [],
        open: 1,
        waived: 0,
      };
      for (let i = 0; i < 25; i++)
        page.frames.push({
          path: `${i}.png`,
          label: i === 0 ? "summary" : "motion",
          items: [{ text: `${i}` }],
          height: 100,
        });
      page.frames.push({
        path: "finding.png",
        label: "open-finding",
        items: [{ text: "Actual finding" }],
        height: 100,
      });
      applyBudget(page, limit);
      expect(page.frames).toHaveLength(limit);
      expect(page.frames[0]!.path).toBe("pages/menu/01-summary.png");
      expect(page.frames.some((f) => f.label === "open-finding")).toBe(true);
      expect(page.dropped).toHaveLength(26 - limit);
      expect(page.frames.at(-1)!.note).toContain("Budget omitted");
    }
  });
  it("never drops a frame that holds a picture, only text", () => {
    const picture: Item = {
      label: "crop",
      picture: {
        source: "x.png",
        component: "menu",
        state: "default",
        theme: "dark",
        scale: "2x",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        fullWidth: 10,
        fullHeight: 10,
      },
    };
    const page: ComponentPage = {
      id: "menu",
      name: "Menu",
      frames: [],
      dropped: [],
      notes: [],
      links: [],
      open: 0,
      waived: 0,
    };
    for (let i = 0; i < 14; i++)
      page.frames.push({
        path: `${i}.png`,
        label: "states-2x-dark",
        items: [picture],
        height: 100,
      });
    for (let i = 0; i < 5; i++)
      page.frames.push({
        path: `t${i}.png`,
        label: "report",
        items: [{ text: `${i}` }],
        height: 100,
      });
    // Reports rank first, so a limit of 3 keeps three of them and every picture past the limit.
    applyBudget(page, 3);
    expect(page.frames.filter((f) => f.label === "states-2x-dark")).toHaveLength(14);
    expect(page.frames.filter((f) => f.label === "report")).toHaveLength(3);
    expect(page.dropped?.map((f) => f.label)).toEqual(["report", "report"]);
  });
  it("maps measured regions through the crop and preserves pixels in gridded zooms", async () => {
    const run = await mkdtemp(join(tmpdir(), "sheet-regions-"));
    try {
      const dir = join(run, "captures/button/focus-visible/dark");
      await mkdir(dir, { recursive: true });
      const data = new Uint8Array(140 * 80 * 4).fill(255);
      data.set([20, 40, 60, 255], (8 * 140 + 8) * 4);
      await writeFile(join(dir, "1x.png"), encode({ width: 140, height: 80, data }));
      await writeFile(
        join(dir, "measure-1x.json"),
        JSON.stringify({
          crop: { x: 10, y: 20, width: 140, height: 80 },
          target: { rect: { x: 16, y: 26, width: 128, height: 68 } },
          icons: [{ iconName: "plus", rect: { x: 20, y: 30, width: 14, height: 14 } }],
        }),
      );
      const inventory: Inventory = {
        version: 1,
        nonVisual: [],
        components: [
          {
            id: "button",
            name: "Button",
            kind: "primitive",
            sources: [],
            selector: ".btn",
            zoom: true,
            states: [{ id: "focus-visible", gymState: "buttons" }],
          },
        ],
      };
      const plan = await planSheet(run, inventory);
      const page = plan.components[0]!;
      expect(page.frames[0]!.label).toBe("summary");
      const pictures = page.frames.flatMap((f) =>
        f.items.flatMap((i) => ("picture" in i ? [i.picture] : [])),
      );
      const icon = pictures.find((p) => p.state.includes("icon plus"))!;
      expect(icon.sourceRegion).toEqual({ x: 8, y: 8, width: 18, height: 18 });
      expect(pictureLabel(icon)).toContain("source pixels 8,8 to 26,26");
      const raster = decode(Buffer.from(icon.source.split(",")[1]!, "base64"));
      expect(raster.width).toBe(18 * 9 - 1);
      expect([...raster.data.slice(0, 4)]).toEqual([20, 40, 60, 255]);
      expect([...raster.data.slice(8 * 4, 9 * 4)]).toEqual([255, 0, 168, 255]);
      expect(pictures.some((p) => p.state.includes("focus ring top-left"))).toBe(true);
      expect(pictures.some((p) => p.state.includes("component side edge"))).toBe(true);
      expect(pictures.some((p) => p.state.includes("whole small control"))).toBe(false);
    } finally {
      await rm(run, { recursive: true, force: true });
    }
  });
});
