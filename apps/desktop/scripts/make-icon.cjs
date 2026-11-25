// Renders the app's icons from the code-built Link rig (design/link-rig.js):
//
//  - build/icon.png, the app icon, as DESIGN.md's Brand section and design
//    round 7 (option b) chose: Link's face close up on a graphite tile in the
//    macOS icon shape. electron-builder makes the .icns, .ico and Linux sizes
//    from it.
//  - build/notification.png (`notification`), the banner icon on Windows and
//    Linux: Link, waiting, on the same graphite tile (DESIGN.md, Notifications).
//    macOS always shows the app icon on a banner.
//
//   unset ELECTRON_RUN_AS_NODE && pnpm --filter @uplink-room/desktop icon
//   unset ELECTRON_RUN_AS_NODE && pnpm --filter @uplink-room/desktop icon notification
const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const VARIANTS = {
  // Apple's icon grid: an 824-point tile centred on a 1024-point canvas.
  icon: { file: "icon.png", canvas: 1024, tile: 824, state: "idle", closeUp: true, still: false },
  // Link whole and waiting, its antenna lit. The rig's reduced-motion pose has no hop mid-air.
  notification: { file: "notification.png", canvas: 256, tile: 256, state: "waiting", closeUp: false, still: true },
};
const variant = VARIANTS[process.argv.includes("notification") ? "notification" : "icon"];
const { canvas: CANVAS, tile: TILE } = variant;
const rig = readFileSync(join(__dirname, "../../../design/link-rig.js"), "utf8");
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;width:${CANVAS}px;height:${CANVAS}px;overflow:hidden}
.canvas{width:${CANVAS}px;height:${CANVAS}px;display:grid;place-items:center}
.tile{position:relative;overflow:hidden;display:grid;place-items:center;width:${TILE}px;height:${TILE}px;
  border-radius:22.4%;background:#1C1F24;box-shadow:inset 0 0 0 ${Math.max(1, Math.round(TILE / 206))}px #ffffff14}
.inner{display:grid;place-items:center;${variant.closeUp ? "transform:translateY(18%) scale(1.7)" : ""}}
</style></head><body><div class="canvas"><div class="tile"><div class="inner" id="host"></div></div></div>
${variant.still ? "<script>window.matchMedia = () => ({ matches: true });</script>" : ""}
<script>${rig}</script>
<script>new UplinkCast.Char(document.getElementById("host"), { kind: "link", state: "${variant.state}", lively: false, size: ${Math.round(TILE * 0.86)}, label: "Uplink Room" });</script>
</body></html>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: CANVAS,
    height: CANVAS,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  // The rig's first blink comes after at least a second; capture before it.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: CANVAS, height: CANVAS });
  const out = join(__dirname, "../build");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, variant.file), image.resize({ width: CANVAS, height: CANVAS }).toPNG());
  console.log(`Wrote build/${variant.file}`);
  app.quit();
});
