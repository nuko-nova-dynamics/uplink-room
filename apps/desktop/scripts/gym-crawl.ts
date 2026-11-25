import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { prepare } from "./gymPrepare.ts";
import { appDir, freePort } from "./lib.ts";

/**
 * The gym's crawler: every gym state (src/renderer/gym/states.ts), and everything each one opens.
 * For each state it captures the screen in dark and light at the default and smallest window sizes,
 * then clicks every enabled button on the screen, one at a time from a fresh load. Whatever opens
 * (a dialog, menu, popover or listbox) is captured too, in dark and light. Every capture gets a
 * contrast audit: each visible piece of text against the background it really sits on, with the
 * opacity of its ancestors applied. Text under WCAG AA (4.5:1, or 3:1 for large text) is reported.
 *
 *   pnpm --filter @uplink-room/desktop build
 *   node scripts/gym-crawl.ts <out folder> [state ...]
 *
 * Writes shots/*.png, report.json (every capture with its contrast failures) and report.md.
 * The gym has no backend: its mutations go nowhere, so clicking every button is safe.
 */
const out = process.argv[2];
if (!out) throw new Error("Usage: node scripts/gym-crawl.ts <out folder> [state ...]");
const only = process.argv.slice(3);
const SIZES = { default: { width: 1320, height: 840 }, small: { width: 960, height: 600 } } as const;
const THEMES = ["dark", "light"] as const;
// Picked per run, so a crawl in another worktree on this computer can't drive this one's window.
const PORT = await freePort();
const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .popover, .menu, .picker, .toast';
await mkdir(join(out, "shots"), { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "uplink-gym-crawl-"));
const url = (state: string, theme: string) => `uplink-room://app/gym.html?state=${state}&theme=${theme}`;

type Failure = { text: string; ratio: number; need: number; color: string; background: string; selector: string };
type Capture = { state: string; opened: string | null; theme: string; size: string; file: string; failures: Failure[]; dragTraps: string[]; errors: string[] };

/** Runs in the page: every visible text run and its contrast against what it actually sits on. */
function audit(scope: string | null): Failure[] {
  type RGBA = [number, number, number, number];
  // Any CSS colour, rgb() or the color(srgb …) that color-mix() computes to: the browser paints it
  // on a 1×1 canvas and the pixel is read back.
  const pixel = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  const parsed = new Map<string, RGBA>();
  const parse = (c: string): RGBA => {
    const known = parsed.get(c);
    if (known) return known;
    pixel.clearRect(0, 0, 1, 1);
    pixel.fillStyle = "rgba(0,0,0,0)";
    pixel.fillStyle = c;
    pixel.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = pixel.getImageData(0, 0, 1, 1).data;
    const out: RGBA = [r!, g!, b!, a! / 255];
    parsed.set(c, out);
    return out;
  };
  const over = (top: RGBA, under: RGBA): RGBA => {
    const a = top[3] + under[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i]! * top[3] + under[i]! * under[3] * (1 - top[3])) / a).concat(a) as RGBA;
  };
  const lum = (c: RGBA) =>
    [0, 1, 2]
      .map((i) => c[i]! / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  /** The colour behind an element: its own background and every ancestor's, composited. */
  const behind = (el: Element): RGBA => {
    const layers: RGBA[] = [];
    for (let e: Element | null = el; e; e = e.parentElement) {
      const bg = parse(getComputedStyle(e).backgroundColor);
      if (bg[3] > 0) layers.push(bg);
      if (bg[3] >= 1) break;
    }
    let c: RGBA = parse(getComputedStyle(document.body).backgroundColor);
    if (c[3] === 0) c = [255, 255, 255, 1];
    for (const l of layers.reverse()) c = over(l, c);
    return c;
  };
  const opacityOf = (el: Element) => {
    let o = 1;
    for (let e: Element | null = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
    return o;
  };
  // Every element the scope matches (a dialog and a toast can be open at once), not only the first.
  const roots = scope ? Array.from(document.querySelectorAll(scope)) : [document.body];
  const failures: Failure[] = [];
  const seen = new Set<Element>();
  for (const root of roots)
  for (let walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.textContent ?? "").trim();
    const el = n.parentElement;
    if (!text || !el || seen.has(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || s.visibility === "hidden" || s.display === "none") continue;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    // Hidden on purpose until hover (a code block's Copy): its hovered audit checks it shown.
    const opacity = opacityOf(el);
    if (opacity === 0) continue;
    // Disabled controls are exempt from WCAG contrast; they're still reported if illegible (under 2:1).
    const disabled = el.closest("button:disabled, [aria-disabled='true'], input:disabled, select:disabled") !== null;
    const bg = behind(el);
    let fg = parse(s.color);
    fg = over([fg[0], fg[1], fg[2], fg[3] * opacity], bg);
    const [a, b] = [lum(fg), lum(bg)];
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const size = parseFloat(s.fontSize);
    const bold = Number(s.fontWeight) >= 700;
    const need = disabled ? 2 : size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    if (ratio < need) {
      const sel = [el.tagName.toLowerCase(), ...Array.from(el.classList).slice(0, 3).map((c) => `.${c}`)].join("");
      failures.push({ text: text.slice(0, 60), ratio: Math.round(ratio * 100) / 100, need, color: s.color, background: `rgba(${bg.map((v, i) => (i < 3 ? Math.round(v) : v.toFixed(2))).join(",")})`, selector: sel });
    }
  }
  return failures;
}

/**
 * Runs in the page: every visible control whose middle is in a window drag region. On macOS the
 * window takes every mouse press in a drag region, so a real click never reaches such a control,
 * though the crawl's own clicks (sent through DevTools) do. The Settings close button was one: it
 * sat on the dialog's title row, a `.main-head`, without being inside it. Electron builds the regions
 * in document order, each `drag` element adding its box and each `no-drag` one cutting its box out,
 * so the last such element over a point decides it.
 */
function dragTraps(scope: string | null): string[] {
  const regions = Array.from(document.querySelectorAll<HTMLElement>("*"))
    .map((el) => ({ el, region: getComputedStyle(el).getPropertyValue("-webkit-app-region").trim() }))
    .filter(({ region }) => region === "drag" || region === "no-drag")
    .map(({ el, region }) => ({ drag: region === "drag", box: el.getBoundingClientRect() }));
  const draggable = (x: number, y: number) => {
    let drag = false;
    for (const { drag: d, box } of regions)
      if (x >= box.left && x < box.right && y >= box.top && y < box.bottom) drag = d;
    return drag;
  };
  const controls = 'button:not(:disabled), a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="menuitem"], [role="tab"], [role="option"], [role="switch"], [role="checkbox"], [role="radio"]';
  const roots = scope ? Array.from(document.querySelectorAll(scope)) : [document.body];
  const traps: string[] = [];
  for (const root of roots)
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(controls))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      // Only what a person can see there: a control under a modal's scrim isn't clickable anyway.
      const top = document.elementFromPoint(x, y);
      if (!top || !(el === top || el.contains(top))) continue;
      if (!draggable(x, y)) continue;
      const label = (el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || el.tagName).trim().replace(/\s+/g, " ").slice(0, 50);
      traps.push(`"${label}" (${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).trim().split(/\s+/).join(".")}` : ""})`);
    }
  return [...new Set(traps)];
}

const electronBin = (await import("electron")).default as unknown as string;
const env = { ...process.env, UPLINK_QUIET: "1", UPLINK_NO_UPDATES: "1", UPLINK_FAKE_MEDIA: "1", UPLINK_START_PATH: "/gym.html" } as Record<string, string>;
delete env["ELECTRON_RUN_AS_NODE"];
delete env["ELECTRON_RENDERER_URL"];
const child = spawn(electronBin, [appDir, `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`], { env, stdio: "ignore" });
const captures: Capture[] = [];
/** Screens that never loaded (state, theme, size, why): coverage the report must not claim. */
const missed: string[] = [];
try {
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => undefined);
    if (!browser) await new Promise((r) => setTimeout(r, 500));
  }
  if (!browser) throw new Error("The gym's window didn't open.");
  let page: Page | undefined;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("gym.html"));
    if (!page) await new Promise((r) => setTimeout(r, 250));
  }
  if (!page) throw new Error("No gym page.");
  await page.waitForFunction(() => "gymStates" in window);
  const states = (await page.evaluate(() => (window as unknown as { gymStates: { id: string }[] }).gymStates)).filter(
    (s) => !only.length || only.includes(s.id),
  );
  const errors: string[] = [];
  const sharedTried = new Set<string>();
  page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]!));

  // The state as it's named: loaded, then the clicks it needs (its thread, its browser, its picker)
  // done, so the crawl audits that screen and not the channel under it.
  const load = async (state: string, theme: string) => {
    await page!.goto(url(state, theme));
    await page!.locator(".app, .setup").first().waitFor({ timeout: 15_000 });
    await page!.evaluate(() => document.fonts.ready);
    await prepare(page!, state);
    await page!.waitForTimeout(500);
  };
  const capture = async (state: string, opened: string | null, theme: string, size: string, scope: string | null) => {
    const name = `${state}${opened ? `--${opened.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40)}` : ""}-${size}-${theme}.png`;
    const file = join(out, "shots", name);
    await page!.screenshot({ path: file });
    const failures = await page!.evaluate(audit, scope);
    const traps = await page!.evaluate(dragTraps, scope);
    // Hovered: each button's own text, with :hover styles applied (a fill that changes on hover can hide its label).
    if (size === "default") {
      const buttons = page!.locator(`${scope ? `:is(${scope})` : "body"} button:not(:disabled)`);
      const count = Math.min(await buttons.count(), 60);
      for (let i = 0; i < count; i++) {
        const b = buttons.nth(i);
        if (!(await b.isVisible().catch(() => false))) continue;
        await b.hover({ timeout: 800 }).catch(() => {});
        await b.evaluate((el) => el.setAttribute("data-crawl-hover", ""));
        await page!.waitForTimeout(160);
        for (const f of await page!.evaluate(audit, "[data-crawl-hover]")) failures.push({ ...f, text: `(hovered) ${f.text}` });
        await b.evaluate((el) => el.removeAttribute("data-crawl-hover"));
      }
      await page!.mouse.move(1, 1);
    }
    captures.push({ state, opened, theme, size, file: `shots/${name}`, failures, dragTraps: traps, errors: errors.splice(0) });
  };

  for (const { id } of states) {
    // The screen itself.
    for (const [size, dims] of Object.entries(SIZES)) {
      await page.evaluate(([w, h]) => window.resizeTo(w!, h!), [dims.width, dims.height]);
      for (const theme of THEMES) {
        const ok = await load(id, theme).then(
          () => true,
          (e: unknown) => (missed.push(`${id} (${theme}, ${size}): ${String(e).split("\n")[0]}`), false),
        );
        if (ok) await capture(id, null, theme, size, null);
      }
    }
    // Everything it opens, at the default size.
    await page.evaluate(([w, h]) => window.resizeTo(w!, h!), [SIZES.default.width, SIZES.default.height]);
    const ok = await load(id, "dark").then(
      () => true,
      (e: unknown) => (missed.push(`${id} (dark, its dialogs): ${String(e).split("\n")[0]}`), false),
    );
    if (!ok) continue;
    const labels = await page.evaluate(() => {
      // A state whose clicks opened a modal dialog (gymPrepare.ts) can only be used inside it: the
      // overlay covers every other control, so clicking those would only time out.
      const modal = document.querySelector('[aria-modal="true"]');
      return Array.from(document.querySelectorAll<HTMLElement>('button:not(:disabled), [role="button"]:not([aria-disabled="true"])'))
        // Each keeps its place among all of them, hidden ones included, so the click after a reload
        // finds the same control.
        .map((b, index) => ({ b, index }))
        .filter(({ b }) => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.top < innerHeight && r.left < innerWidth && (!modal || modal.contains(b));
        })
        .map(({ b, index }) => ({
          index,
          label: (b.getAttribute("aria-label") || b.getAttribute("title") || b.innerText || "").trim().replace(/\s+/g, " "),
          // The sidebar and the window's header are the same on every screen: their dialogs are captured once.
          shared: b.closest(".sidebar, .titlebar, .app-header, .header") !== null,
        }))
        .slice(0, 80);
    });
    const tried = new Set<string>();
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i]!.label || `button ${i + 1}`;
      const key = labels[i]!.shared ? `shared:${label}` : label;
      if (tried.has(key) || sharedTried.has(key)) continue;
      tried.add(key);
      if (labels[i]!.shared) sharedTried.add(key);
      for (const theme of THEMES) {
        try {
          await load(id, theme);
          const button = page.locator('button:not(:disabled), [role="button"]:not([aria-disabled="true"])').nth(labels[i]!.index);
          const before = await page.locator(OVERLAY).count();
          await button.click({ timeout: 2000 });
          await page.waitForTimeout(450);
          const after = await page.locator(OVERLAY).count();
          if (after <= before) break; // It didn't open anything: a navigation or an action, not a state to capture.
          await capture(id, label, theme, "default", OVERLAY);
        } catch (e) {
          // The screen loaded before, so this is a reload or a click that failed, not a button that
          // opens nothing: what it would have opened isn't covered.
          missed.push(`${id} → ${label} (${theme}): ${String(e).split("\n")[0]}`);
          break;
        }
      }
    }
  }
} finally {
  // The app writes its last log lines into the profile as it quits: remove the profile once it has exited.
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill();
    });
  }
  await rm(profile, { recursive: true, force: true });
}

await writeFile(join(out, "report.json"), JSON.stringify(captures, null, 1));
const failing = captures.filter((c) => c.failures.length);
// One line per control and screen: a trap shows the same in both themes.
const trapped = [...new Set(captures.flatMap((c) => c.dragTraps.map((t) => `${c.state}${c.opened ? ` → ${c.opened}` : ""} (${c.size}): ${t}`)))];
const lines = [
  `# Gym crawl`,
  ``,
  `${captures.length} captures across ${new Set(captures.map((c) => c.state)).size} states, ${captures.filter((c) => c.opened).length} of them dialogs, menus or popovers. ${failing.length} have text under WCAG AA contrast. ${trapped.length} controls sit in a window drag region, where a real click never reaches them.`,
  ``,
  ...(missed.length ? [`**${missed.length} screens didn't load, so this report doesn't cover them:**`, ``, ...missed.map((m) => `- ${m}`), ``] : []),
  ...(trapped.length ? [`## Controls a real click can't reach`, ``, `Each is in a window drag region (\`-webkit-app-region: drag\`), so on macOS the window takes the click.`, ``, ...trapped.map((t) => `- ${t}`), ``] : []),
  ...failing.flatMap((c) => [
    `## ${c.state}${c.opened ? ` → ${c.opened}` : ""} (${c.theme}, ${c.size})`,
    ``,
    `![](${c.file})`,
    ``,
    ...c.failures.slice(0, 12).map((f) => `- "${f.text}" ${f.ratio}:1, needs ${f.need}:1 (${f.selector}, ${f.color} on ${f.background})`),
    ``,
  ]),
];
await writeFile(join(out, "report.md"), lines.join("\n"));
console.log(lines.slice(0, 3).join("\n"));
if (trapped.length) {
  console.error(`${trapped.length} controls sit in a window drag region:\n${trapped.join("\n")}`);
  process.exitCode = 1;
}
if (missed.length) {
  console.error(`${missed.length} screens didn't load:\n${missed.join("\n")}`);
  process.exitCode = 1;
}
