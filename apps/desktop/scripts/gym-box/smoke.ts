// Run only on a Linux box. Two fresh launches must produce identical 2x button crops.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openGym, showState } from "../upclose/launch.ts";

if (process.platform !== "linux") throw new Error("Run the smoke on a Linux box.");
const out = process.env["OUT"];
if (!out) throw new Error("OUT must name the output folder.");
await mkdir(out, { recursive: true });
const passes = [];
for (let pass = 1; pass <= 2; pass++) {
  const gym = await openGym({ scale: 2 });
  try {
    const { page } = gym;
    if (!(await showState(page, "inbox", "dark"))) throw new Error("Inbox did not render.");
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      return {
        dpr: devicePixelRatio,
        body: getComputedStyle(document.body).fontFamily,
        faces: [...document.fonts].map((f) => ({ family: f.family, status: f.status })),
        resources: performance
          .getEntriesByType("resource")
          .map((r) => r.name)
          .filter((n) => /\.(woff2?|ttf|otf)(\?|$)/.test(n)),
      };
    });
    if (fonts.dpr !== 2) throw new Error(`Expected DPR 2, got ${fonts.dpr}`);
    const session = await page.context().newCDPSession(page);
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument");
    const { nodeId } = await session.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: ".main-head .btn",
    });
    const platformFonts = await session.send("CSS.getPlatformFontsForNode", { nodeId });
    await session.detach();
    const buttons = [];
    for (const [index, button] of (await page.locator(".btn").all()).entries()) {
      if (!(await button.isVisible())) continue;
      const rect = await button.boundingBox();
      if (!rect) throw new Error(`Button ${index} has no box.`);
      // Element screenshots round fractional CSS edges outward. Use a device-aligned clip
      // to keep a 28 px box at exactly 56 pixels, even at fractional layout positions.
      const clip = {
        x: Math.round(rect.x * 2) / 2,
        y: Math.round(rect.y * 2) / 2,
        width: rect.width,
        height: rect.height,
      };
      const png = await page.screenshot({
        path: join(out, `button-${index}-pass-${pass}.png`),
        clip,
        animations: "disabled",
        scale: "device",
      });
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);
      if (rect?.height !== 28 || height !== 56)
        throw new Error(`Button ${index}: ${rect?.height} CSS px, ${height} device px`);
      buttons.push({
        index,
        rect,
        width,
        height,
        sha256: createHash("sha256").update(png).digest("hex"),
        font: await button.evaluate((el) => getComputedStyle(el).fontFamily),
      });
    }
    if (!buttons.length) throw new Error("No visible .btn elements.");
    passes.push({ fonts, platformFonts, buttons });
  } finally {
    await gym.close();
  }
}
const deterministic = JSON.stringify(passes[0]?.buttons) === JSON.stringify(passes[1]?.buttons);
await writeFile(join(out, "smoke.json"), JSON.stringify({ deterministic, passes }, null, 2));
if (!deterministic) throw new Error("Button captures differ between fresh launches.");
console.log(
  `PASS: ${passes[0]?.buttons.length} buttons are 28 CSS px / 56 device px; two fresh launches match byte for byte.`,
);
