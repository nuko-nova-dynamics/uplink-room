import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { Locator, Page } from "@playwright/test";
import { cropRect } from "./plan.ts";
import type { Rect, Scale } from "./types.ts";

const execFile = promisify(execFileCallback);

type WindowBox = Rect & { id: string };

/** X11's native title popup is a sibling window, absent from page.screenshot(). */
export function tooltipWindows(tree: string): WindowBox[] {
  return [
    ...tree.matchAll(
      /^\s+(0x[\da-f]+) \(has no name\): \(\)\s+(\d+)x(\d+)[+-]-?\d+[+-]-?\d+\s+([+-]-?\d+)([+-]-?\d+)/gm,
    ),
  ]
    .map((m) => ({
      id: m[1]!,
      width: Number(m[2]),
      height: Number(m[3]),
      x: Number(m[4]!.replace(/^\+/, "")),
      y: Number(m[5]!.replace(/^\+/, "")),
    }))
    .filter((box) => box.width > 10 && box.height > 10);
}

/** Capture real platform pixels, keeping the trigger and the native popup in the same crop. */
export async function captureNativeTooltip(page: Page, target: Locator, scale: Scale) {
  const display = process.env["DISPLAY"];
  if (!display) throw new Error("Native tooltip capture requires the pinned X11 display");
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    x: screenX + (outerWidth - innerWidth) / 2,
    y: screenY + outerHeight - innerHeight,
  }));
  const trigger = await target.boundingBox();
  if (!trigger) throw new Error("Native tooltip trigger has no box");
  if (!(await target.getAttribute("title"))) throw new Error("Native tooltip has no title");

  // CDP mouse events alone do not reliably move the platform pointer. Moving away first also
  // dismisses a popup from a preceding capture, including one with the same X11 window id.
  await execFile("xdotool", ["mousemove", "0", "0"]);
  await page.waitForTimeout(500);
  await execFile("xdotool", [
    "mousemove",
    String(Math.round((viewport.x + trigger.x + trigger.width / 2) * scale)),
    String(Math.round((viewport.y + trigger.y + trigger.height / 2) * scale)),
  ]);
  let popup: WindowBox | undefined;
  for (let attempt = 0; attempt < 30 && !popup; attempt++) {
    await page.waitForTimeout(100);
    const { stdout } = await execFile("xwininfo", ["-root", "-tree"]);
    for (const candidate of tooltipWindows(stdout)) {
      // Only accept a visible override-redirect popup inside this gym's viewport.
      if (
        candidate.x < viewport.x * scale ||
        candidate.y < viewport.y * scale ||
        candidate.x + candidate.width > (viewport.x + viewport.width) * scale ||
        candidate.y + candidate.height > (viewport.y + viewport.height) * scale
      )
        continue;
      const { stdout: info } = await execFile("xwininfo", ["-id", candidate.id]);
      if (/Map State: IsViewable/.test(info) && /Override Redirect State: yes/.test(info)) {
        popup = candidate;
        break;
      }
    }
  }
  if (!popup) throw new Error("The native title tooltip window did not appear");
  const surface = {
    x: popup.x / scale - viewport.x,
    y: popup.y / scale - viewport.y,
    width: popup.width / scale,
    height: popup.height / scale,
  };
  const left = Math.min(trigger.x, surface.x);
  const top = Math.min(trigger.y, surface.y);
  const crop = cropRect(
    {
      x: left,
      y: top,
      width: Math.max(trigger.x + trigger.width, surface.x + surface.width) - left,
      height: Math.max(trigger.y + trigger.height, surface.y + surface.height) - top,
    },
    viewport,
    scale,
  );
  const { stdout: png } = await execFile(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "x11grab",
      "-video_size",
      `${crop.width * scale}x${crop.height * scale}`,
      "-i",
      `${display}+${Math.round((viewport.x + crop.x) * scale)},${Math.round((viewport.y + crop.y) * scale)}`,
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 },
  );
  return { png, crop, surface, windowId: popup.id };
}
