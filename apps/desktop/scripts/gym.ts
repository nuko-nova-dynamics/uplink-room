import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, chromium, type ElectronApplication, type Page } from "@playwright/test";
import { prepare } from "./gymPrepare.ts";
import { appDir, freePort } from "./lib.ts";

/**
 * The UI gym's proof (src/renderer/gym/): every screen and state of the built app with sample data,
 * no sign-in and no backend. For each state it saves
 *   shots/<state>-<default|small>-<dark|light>.png  the real window, traffic lights included (macOS);
 *   videos/<state>.mp4                              hovering, focusing and clicking the chrome;
 *   detector/<state>-<theme>.json                   `impeccable detect --cdp` on the page as shown.
 *
 *   pnpm --filter @uplink-room/desktop build
 *   node scripts/gym.ts <out folder> [state ...]
 *
 * The app runs quiet (no banner, no sound), and the permission states are read, never asked for.
 */
const out = process.argv[2];
if (!out) throw new Error("Usage: node scripts/gym.ts <out folder> [state ...]");
const only = process.argv.slice(3);
const SIZES = { default: { width: 1320, height: 840 }, small: { width: 960, height: 600 } } as const;
const THEMES = ["dark", "light"] as const;
// Picked per run, so a gym in another worktree on this computer can't drive this one's window.
const PORT = await freePort();
const IMPECCABLE = "impeccable@4.8.0";

for (const dir of ["shots", "videos", "detector", "logs"]) await mkdir(join(out, dir), { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "uplink-gym-"));
const env = () => {
  // Synthetic media: the device step's sample devices, level meter and camera picture, so the gym never
  // opens this computer's microphone or camera.
  const e = { ...process.env, UPLINK_QUIET: "1", UPLINK_NO_UPDATES: "1", UPLINK_FAKE_MEDIA: "1", UPLINK_NOTIFY_LOG: join(out, "logs", "banners.jsonl") } as Record<string, string>;
  delete e["ELECTRON_RUN_AS_NODE"];
  delete e["ELECTRON_RENDERER_URL"];
  return e;
};
const states: { id: string; title: string; flows?: string[] }[] = [];
const url = (state: string, theme = "dark") => `uplink-room://app/gym.html?state=${state}&theme=${theme}`;

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
}

// ---------- screenshots and the detector, in one window driven over CDP ----------
const electronBin = (await import("electron")).default as unknown as string;
const child = spawn(electronBin, [appDir, `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`], {
  env: { ...env(), UPLINK_START_PATH: "/gym.html" },
  stdio: "ignore",
});
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
  // The page lists its states (gym/states.ts).
  await page.waitForFunction(() => "gymStates" in window);
  const listed = await page.evaluate(() => (window as unknown as { gymStates: { id: string; title: string; flows?: string[] }[] }).gymStates);
  states.push(...listed.filter((s) => !only.length || only.includes(s.id)));
  await writeFile(join(out, "states.json"), JSON.stringify(states, null, 1));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`${page!.url()}: ${error.message}`));
  // macOS: the window's id, for a capture of the real window. Elsewhere the page alone.
  const windowId = (() => {
    if (process.platform !== "darwin") return null;
    const listed = JSON.parse(execFileSync("peekaboo", ["window", "list", "--pid", String(child.pid), "--json"], { encoding: "utf8" }));
    return (listed.data.windows as { window_id: number }[])[0]?.window_id ?? null;
  })();

  for (const state of states) {
    let shown = true;
    for (const [size, { width, height }] of Object.entries(SIZES)) {
      await page.evaluate(([w, h]) => window.resizeTo(w!, h!), [width, height]);
      for (const theme of THEMES) {
        // Each theme loads the state afresh, so what the detector and the capture see is that theme's page.
        await page.goto(url(state.id, theme));
        shown = await page.locator(".app, .setup").first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
        if (!shown) break;
        await settle(page);
        await prepare(page, state.id).catch((error: Error) => errors.push(`${state.id} prepare: ${error.message.split("\n")[0]}`));
        await page.waitForTimeout(350);
        const file = join(out, "shots", `${state.id}-${size}-${theme}.png`);
        // The real window when macOS lets the gym capture it; the page alone when it can't (a locked screen).
        let captured = false;
        if (windowId) {
          try {
            execFileSync("screencapture", ["-x", "-o", `-l${windowId}`, file], { stdio: "pipe" });
            captured = true;
          } catch (error) {
            errors.push(`${state.id} window capture: ${String((error as { stderr?: Buffer }).stderr ?? error).trim()}; saved the page instead`);
          }
        }
        if (!captured) await page.screenshot({ path: file });
        if (size === "default") {
          // Exit 0: no findings. Exit 2: findings, printed as JSON all the same. Exit 1: the page couldn't be scanned.
          const scan = (() => {
            try {
              const stdout = execFileSync("npx", ["-y", IMPECCABLE, "detect", "--cdp", String(PORT), "--target", "gym.html", "--json"], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                // From the repository root, so the detector reads .impeccable/config.json and DESIGN.md.
                cwd: join(appDir, "..", ".."),
              });
              return { exitCode: 0, findings: JSON.parse(stdout || "[]") as unknown };
            } catch (error) {
              const failed = error as { status?: number; stdout?: string; stderr?: string };
              const findings = (() => {
                try {
                  return JSON.parse(failed.stdout ?? "") as unknown;
                } catch {
                  return null;
                }
              })();
              return { exitCode: failed.status ?? 1, findings, ...(findings === null ? { stderr: failed.stderr } : {}) };
            }
          })();
          await writeFile(join(out, "detector", `${state.id}-${theme}.json`), JSON.stringify(scan, null, 1));
        }
      }
      if (!shown) break;
    }
    if (!shown) {
      errors.push(`${state.id}: the page didn't render`);
      console.log("FAILED", state.id);
      continue;
    }
    console.log("shots", state.id);
  }
  await writeFile(join(out, "logs", "page-errors.txt"), errors.join("\n"));
  await browser.close();
} finally {
  child.kill();
}

// ---------- one video per state ----------
/** Hovers, focuses and clicks every control in the title rows, the footer and the call dock. */
async function interact(app: ElectronApplication, page: Page, state: string): Promise<void> {
  const pause = (ms = 450) => page.waitForTimeout(ms);
  // A control under an overlay or a drawer is skipped rather than waited for.
  page.setDefaultTimeout(2500);
  const chrome = ".sidebar-top button, .main-head button, .drawer-head button, .sidebar-bottom button, .call-dock button";
  const setup = page.locator(".setup");
  if (await setup.count()) {
    for (const button of await setup.locator(".setup-side button, .setup-pair button").all()) {
      await button.hover();
      await pause(350);
      await button.click();
      await pause(700);
    }
    const tile = setup.locator(".setup-tile");
    if (await tile.count()) {
      await tile.hover();
      await pause(600);
    }
    await page.keyboard.press("Tab");
    await pause();
    await page.keyboard.press("Tab");
    await pause();
    await setup.getByRole("button", { name: /Continue|Open my Inbox|Get started/ }).hover();
    await pause(700);
    return;
  }
  for (const control of await page.locator(chrome).all()) {
    if (!(await control.isVisible())) continue;
    if (await control.hover().then(() => true, () => false)) await pause(300);
  }
  await page.locator("body").click({ position: { x: 640, y: 420 } }).catch(() => {});
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    await pause(260);
  }
  for (const opener of await page.locator(".main-head [aria-expanded], .sidebar-top [aria-expanded]").all()) {
    if (!(await opener.isVisible())) continue;
    if (!(await opener.click().then(() => true, () => false))) continue;
    await pause(900);
    await page.keyboard.press("Escape");
    // An opener can leave the header once its panel is open (the side panel's own toggle does).
    const still = await opener.getAttribute("aria-expanded", { timeout: 1_000 }).catch(() => null);
    if (still === "true") await opener.click();
    await pause(400);
  }
  const dock = page.locator(".call-dock");
  if (await dock.count()) {
    for (const name of ["Mute", "Unmute", "Turn camera on", "Turn camera off"]) {
      await dock.getByRole("button", { name }).click().catch(() => {});
      await pause(600);
    }
  }
  // Settings… in the app menu (Command-comma) opens Settings, as the gear does.
  if (state === "inbox" && process.platform === "darwin") {
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("settings")?.click());
    await page.locator(".settings").waitFor();
    await pause(1200);
  }
}

/** What a teammate posts during a chat flow, through the gym's chat scene (gym/chat.ts). */
async function teammate(page: Page, who: "ana" | "theo" | "mia", channel: "general" | "crit" | "ana" | "theo", body: string, replyTo?: string) {
  // They type first, so the video shows "is typing" before the message lands.
  await page.evaluate(
    ([w, c, r]) => (window as unknown as { gymChat: { teammateTypes: (...a: unknown[]) => void } }).gymChat.teammateTypes(w, c, r || undefined),
    [who, channel, replyTo ?? ""] as const,
  );
  await page.waitForTimeout(1500);
  await page.evaluate(
    ([w, c, b, r]) =>
      (window as unknown as { gymChat: { teammatePosts: (...a: unknown[]) => string } }).gymChat.teammatePosts(w, c, b, r || undefined),
    [who, channel, body, replyTo ?? ""] as const,
  );
}

/** Types like a person: a key at a time, with a short pause between. */
async function typeOut(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 28 });
}

/**
 * The chat states' videos: sending, editing, reacting, a thread, unread and search, each its own
 * short video, driven with the keyboard and mouse the way a person would.
 */
const chatFlows: Record<string, (page: Page) => Promise<void>> = {
  send: async (page) => {
    const box = page.getByRole("combobox", { name: "Message", exact: true });
    await box.click();
    await typeOut(page, "Checked: Bayview is in the note, second paragraph.");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    await typeOut(page, "And the 4 minutes are explained");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    await typeOut(page, "in plain words.");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(700);
    await teammate(page, "ana", "general", "Perfect, thank you!");
    await page.waitForTimeout(900);
    await typeOut(page, "Two lines:");
    await page.keyboard.press("Shift+Enter");
    await typeOut(page, "1. the fix");
    await page.keyboard.press("Shift+Enter");
    await typeOut(page, "2. who to ask");
    await page.waitForTimeout(400);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
  },
  edit: async (page) => {
    const box = page.getByRole("combobox", { name: "Message", exact: true });
    await box.click();
    await typeOut(page, "Release note is final at 11");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(700);
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(700);
    await page.keyboard.press("End");
    await typeOut(page, ", after Bayview is checked");
    await page.waitForTimeout(400);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
    const mine = page.locator(".msg", { hasText: "Release note is in the doc" });
    await mine.hover();
    await page.waitForTimeout(500);
    await mine.getByRole("button", { name: "More actions" }).click();
    await page.waitForTimeout(700);
    await page.getByRole("menuitem", { name: "Delete message" }).click();
    await page.waitForTimeout(1100);
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(800);
    // More: mark unread from a message, so the New line moves above it.
    const older = page.locator(".msg", { hasText: "Staging export: 12 stations" });
    await older.hover();
    await page.waitForTimeout(400);
    await older.getByRole("button", { name: "More actions" }).click();
    await page.waitForTimeout(700);
    await page.getByRole("menuitem", { name: "Mark unread from here" }).click();
    await page.waitForTimeout(1500);
  },
  react: async (page) => {
    const message = page.locator(".msg", { hasText: "Chart is wired to live readings" });
    await message.scrollIntoViewIfNeeded();
    await message.hover({ force: true });
    await page.waitForTimeout(600);
    await message.getByRole("button", { name: "React", exact: true }).click();
    await page.waitForTimeout(700);
    await typeOut(page, "rocket");
    await page.waitForTimeout(500);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(900);
    const question = page.locator(".msg", { hasText: "can you check the release note" });
    await question.locator(".reactions button, .reaction").first().click().catch(() => {});
    await page.waitForTimeout(1200);
  },
  thread: async (page) => {
    const message = page.locator(".channel-col:not(.side-panel) .msg", { hasText: "Blue is predicted, green is observed", hasNot: page.locator(".thread-ref") });
    await message.scrollIntoViewIfNeeded();
    await message.hover();
    await page.waitForTimeout(500);
    await message.getByRole("button", { name: "Reply" }).first().click();
    await page.waitForTimeout(900);
    await page.getByRole("combobox", { name: "Reply", exact: true }).click();
    await typeOut(page, "v2 looks right to me. Shipping it with the export.");
    await page.getByText("Also send to #general").click();
    await page.waitForTimeout(400);
    await page.getByRole("combobox", { name: "Reply", exact: true }).click();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    const parent = await message.getAttribute("data-message");
    await teammate(page, "theo", "general", "Thanks! I'll keep an eye on the live line today.", parent ?? undefined);
    await page.waitForTimeout(1400);
    await page.getByRole("button", { name: "Close replies" }).click();
    await page.waitForTimeout(800);
  },
  unread: async (page) => {
    await page.waitForTimeout(800);
    const list = page.locator(".channel-col:not(.side-panel) .messages").first();
    await list.hover();
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(1200);
    // Back up to the New line with the bar's Jump, then down again.
    await page.getByRole("button", { name: "Jump" }).click().catch(() => {});
    await page.waitForTimeout(900);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(900);
    await teammate(page, "ana", "crit", "Mocked the age below the title, it reads better.");
    await page.waitForTimeout(1200);
    await page.getByRole("combobox", { name: "Message", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1200);
  },
  search: async (page) => {
    const box = page.getByRole("searchbox", { name: "Search messages" });
    await box.click();
    await page.keyboard.press("ControlOrMeta+A");
    await typeOut(page, "export");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
    // From is a UI SDK Select: its trigger opens a popup list.
    await page.getByRole("combobox", { name: "From" }).click().catch(() => {});
    await page.waitForTimeout(500);
    await page.getByRole("option", { name: "Ana Ruiz" }).click().catch(() => {});
    await page.waitForTimeout(1000);
    await page.locator(".search-result").first().click();
    await page.waitForTimeout(2200);
  },
};

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// A state with chat flows gets one video per flow; the rest get the chrome tour.
type Take = { state: (typeof states)[number]; flow: string | null; name: string };
const takes = states.flatMap((state): Take[] =>
  state.flows ? state.flows.map((flow) => ({ state, flow, name: `${state.id}-${flow}` })) : [{ state, flow: null, name: state.id }],
);
for (const { state, flow, name } of takes) {
  const raw = join(out, "videos", `${name}-raw`);
  await rm(raw, { recursive: true, force: true });
  const app = await electron.launch({
    ...(process.platform === "linux" ? { chromiumSandbox: true, timeout: 30_000 } : {}),
    args: [appDir, `--user-data-dir=${profile}`],
    env: { ...env(), UPLINK_START_PATH: `/gym.html?state=${state.id}&theme=dark` },
    recordVideo: { dir: raw, size: SIZES.default },
  });
  const appChild = app.process();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize(SIZES.default);
    if (!(await page.locator(".app, .setup").first().waitFor({ timeout: 15_000 }).then(() => true, () => false))) continue;
    await settle(page);
    await prepare(page, state.id).catch(() => {});
    const drive = flow ? chatFlows[flow]!(page) : interact(app, page, state.id);
    await drive.catch((error: Error) => console.log(name, "video:", error.message.split("\n")[0]));
    await page.waitForTimeout(600);
  } finally {
    try {
      await app.close();
    } finally {
      if (process.platform === "linux") appChild.kill();
    }
  }
  const [webm] = (await readdir(raw)).filter((f) => f.endsWith(".webm"));
  if (!webm) continue;
  if (hasFfmpeg) {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(raw, webm), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "30", "-preset", "veryfast", "-movflags", "+faststart", join(out, "videos", `${name}.mp4`)]);
    await rm(raw, { recursive: true, force: true });
  } else {
    await rename(join(raw, webm), join(out, "videos", `${name}.webm`));
    await rm(raw, { recursive: true, force: true });
  }
  console.log("video", name);
}
await rm(profile, { recursive: true, force: true });
console.log(`Saved to ${out}`);
