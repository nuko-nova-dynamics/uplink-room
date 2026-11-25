import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@uplink-room/backend/api";
import { appDir, launch, notifyLog, serveRenderer } from "./lib.ts";
import { seed, type Seeded } from "./seed.ts";

/**
 * Takes the review screenshots (apps/desktop/screenshots/) from the built app,
 * signed in to the Clerk development instance and talking to the local Convex
 * backend. Run `node scripts/signin.ts` once first, then:
 *
 *   pnpm --filter @uplink-room/desktop build
 *   node scripts/screenshots.ts
 *
 * It creates the team through the app's own screen the first time, seeds it
 * through the Room API (scripts/seed.ts), and then captures each view in dark
 * and light. The app runs quiet (scripts/lib.ts): banners it would show are
 * written to .shots-notifications.jsonl, and it makes no sound.
 */
const profile = join(appDir, ".shots-profile");
const outDir = join(appDir, "screenshots");
const convexUrl = (await readFile(join(appDir, ".env.local"), "utf8"))
  .match(/^VITE_CONVEX_URL=(.+)$/m)![1]!
  .trim();
// The local backend serves HTTP actions on the port after its client port.
const siteUrl = convexUrl.replace(/:(\d+)$/, (_, port: string) => `:${Number(port) + 1}`);
await mkdir(outDir, { recursive: true });
await rm(notifyLog, { force: true });

type ClerkGlobal = {
  Clerk: { session: { getToken(o?: { skipCache?: boolean }): Promise<string> } };
};

const { server, url } = await serveRenderer();
const { app, page } = await launch(url, profile);
page.on("pageerror", (error) => console.log("page error:", error.message));

try {
  const sidebar = page.locator(".sidebar");
  const gate = page.getByText("Pick a team, make one");
  await sidebar.or(gate).first().waitFor({ timeout: 40_000 });

  if (await gate.isVisible()) {
    // The test person's name ("Julio Díaz") was set through Clerk's backend API, since this instance
    // doesn't collect names at sign-up. Refresh the session token so its `name` claim has it, then
    // create the team through the app's own screen.
    await page.evaluate(() =>
      (window as unknown as ClerkGlobal).Clerk.session.getToken({ skipCache: true }),
    );
    await page.reload();
    await gate.waitFor({ timeout: 30_000 });
    await page.getByLabel("Create a team").fill("Nuko Nova");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await sidebar.waitFor({ timeout: 30_000 });
  }

  const token = () =>
    page.evaluate(() =>
      (window as unknown as ClerkGlobal).Clerk.session.getToken({ skipCache: true }),
    );

  // `FRESH=1 node scripts/screenshots.ts` starts a new team, so the seed data isn't the leftovers of
  // an earlier run's checks (which settle, snooze and file things).
  if (process.env["FRESH"]) {
    const client = new ConvexHttpClient(convexUrl);
    client.setAuth(await token());
    const fresh = await client.mutation(api.teams.create, { name: "Nuko Nova" });
    await page.evaluate((id) => localStorage.setItem("uplink.team", id), fresh);
    await page.reload();
    await sidebar.waitFor({ timeout: 30_000 });
  }

  const teamId = await page.evaluate(() => localStorage.getItem("uplink.team"));
  if (!teamId) throw new Error("No team was remembered after creating one.");

  // Seed once per team.
  const hasProjects = await page.locator(".sidebar").getByText("Reef Runner").count();
  let seeded: Seeded | undefined;
  if (hasProjects === 0) {
    console.log("seeding…");
    seeded = await seed({ convexUrl, siteUrl, teamId, token });
    console.log("seeded");
    await page.waitForTimeout(1500);
  }

  const click = (name: string | RegExp, scope = ".sidebar") =>
    page.locator(scope).getByRole("button", { name }).first().click();
  const settle = (ms = 900) => page.waitForTimeout(ms);
  const shot = async (name: string, theme: "dark" | "light") => {
    await page.evaluate((t) => (document.documentElement.dataset["theme"] = t), theme);
    await settle(400);
    await page.screenshot({ path: join(outDir, `${name}-${theme}.png`) });
  };
  const both = async (name: string) => {
    await shot(name, "dark");
    await shot(name, "light");
    await page.evaluate(() => (document.documentElement.dataset["theme"] = "dark"));
  };
  /** The banner log so far: shown banners, and when the app took each away (main/notifications.ts). */
  const logLines = async () =>
    (await readFile(notifyLog, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown> & { event: string; id?: string });
  /** The last cue played and how many have played, as the app records them (lib/sound.ts). */
  const lastCue = () => page.evaluate(() => document.documentElement.dataset["cue"] ?? "none");

  // 0. The first-run setup (views/Setup.tsx), shown once on each computer. Forget it was seen, then
  // step through: welcome, permissions (macOS), linking this computer, done.
  await page.evaluate(() => localStorage.removeItem("uplink.onboarded"));
  await page.reload();
  const onboarding = page.locator(".setup");
  await onboarding.waitFor({ timeout: 30_000 });
  for (let step = 1; ; step++) {
    await settle(1400);
    await both(`40-setup-${step}`);
    const last = onboarding.getByRole("button", { name: "Open my Inbox" });
    if (await last.count()) {
      await last.click();
      break;
    }
    await onboarding.getByRole("button", { name: /^(Get started|Continue)$/ }).click();
  }
  await onboarding.waitFor({ state: "detached" });
  console.log("setup done; seen flag:", await page.evaluate(() => localStorage.getItem("uplink.onboarded")));

  // 1. Inbox, with the first Needs you row focused so its keys show.
  await click(/^Inbox/);
  await settle(1500);
  await both("01-inbox");
  // Only live things move: in the Roster, Working, Waiting and Failed characters move; idle and
  // done ones hold still. Compare each character's drawing over a second.
  console.log(
    "roster motion:",
    await page.evaluate(async () => {
      const items = [...document.querySelectorAll(".roster-item")];
      const draw = () => items.map((item) => item.querySelector(".char-host svg")?.innerHTML);
      const first = draw();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const second = draw();
      return items
        .map((item, i) =>
          first[i] === undefined
            ? null
            : `${item.querySelector("b")?.textContent} (${item.querySelector("small")?.textContent}) ${first[i] === second[i] ? "still" : "moves"}`,
        )
        .filter(Boolean)
        .join("; ");
    }),
  );

  // 2. The board of a project.
  await click("Reef Runner");
  await settle(1500);
  await both("02-board");

  // 3. The task panel, then the start-a-run dialog on top of it.
  await page.locator(".card", { hasText: "Save slots on the title screen" }).first().click();
  await settle(1200);
  await both("03-task-panel");
  await page.locator(".drawer").getByRole("button", { name: "Close task" }).click();
  await page.locator(".card", { hasText: "Write the release notes" }).first().click();
  await settle();
  await page.locator(".drawer").getByRole("button", { name: "Start a run" }).click();
  await settle(1000);
  await both("04-start-a-run");
  // Codex can't use a profile, so the dialog turns the choice off and says why. The pointer stays on
  // the pressed segment: its label must stay readable while hovered.
  await page.getByRole("group", { name: "Harness" }).getByRole("button", { name: "Codex" }).click();
  await settle();
  await both("20-start-a-run-no-profile");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // 5. A shared terminal: the one I drive, with Hermes's suggestion and wheel request waiting.
  await click("Settings", ".sidebar-bottom");
  await settle();
  await page.locator(".settings-pane").getByRole("tab", { name: "Team" }).click();
  await settle();
  await page.locator(".term-row", { hasText: "Claude Code" }).first().click();
  await settle(2500);
  await both("05-terminal");
  // As the driver, typing reaches terminals.input and shows up in "Who typed what".
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("pnpm test", { delay: 30 });
  await page.keyboard.press("Enter");
  await settle(1500);
  console.log(
    "who typed what:",
    (await page.locator(".log-line").first().innerText()).replace(/\s+/g, " "),
  );

  // 6. Machine settings: a personal machine (with a terminal lowered to Drive, was Open) and the team machine.
  await click("Settings", ".sidebar-bottom");
  await settle();
  await page.locator(".settings-pane").getByRole("tab", { name: "Personal" }).click();
  await settle(1200);
  await both("06-machine-personal");
  await page.locator(".settings-pane").getByRole("tab", { name: "Team" }).click();
  await settle(1200);
  await both("07-machine-team");

  // 8. A channel with Markdown and an HTML message.
  await click(/reef-runner/);
  await settle(1500);
  // Post an HTML page through the composer, the way a person would.
  await page.getByRole("button", { name: "HTML", exact: true }).click();
  await page
    .getByLabel("Message")
    .fill(
      `<!doctype html><body style="margin:0;font:13px system-ui;background:#fff;color:#15171a"><div style="padding:12px 16px"><b>Build time, last 5 runs</b><svg viewBox="0 0 300 80" style="display:block;max-width:320px;margin-top:6px"><polyline fill="none" stroke="#4f6fb3" stroke-width="3" points="10,60 70,48 130,52 190,30 250,22"/><g fill="#4f6fb3"><circle cx="10" cy="60" r="4"/><circle cx="70" cy="48" r="4"/><circle cx="130" cy="52" r="4"/><circle cx="190" cy="30" r="4"/><circle cx="250" cy="22" r="4"/></g></svg></div></body>`,
    );
  await page.getByRole("button", { name: "Post", exact: true }).click();
  await settle(2500);
  await page.locator(".messages").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await settle(600);
  await both("08-channel-html");

  // Extras: unfiled runs, agents, the profile warning, the Inbox on its own.
  await click(/^Unfiled/);
  await settle();
  await both("09-unfiled");
  await click("Settings", ".sidebar-bottom");
  await page.locator(".settings-nav").getByRole("button", { name: "Agents" }).click();
  await settle();
  await both("10-agents");
  await page.getByRole("button", { name: "Add an agent" }).click();
  await settle(1800);
  await both("11-add-agent");
  await page.keyboard.press("Escape");
  await page.locator(".settings-nav").getByRole("button", { name: "Profiles" }).click();
  await page.getByRole("button", { name: "New profile" }).click();
  await page.getByLabel("Machine").selectOption({ label: "julio-mbp (yours)" });
  await settle();
  await both("12-new-profile");
  await page.keyboard.press("Escape");

  // New project (from the sidebar), New task (from the Inbox), and the pairing command with its --url.
  const dialog = page.getByRole("dialog");
  await click(/^Inbox/);
  await settle(1200);
  await page.getByRole("button", { name: "New project" }).click();
  await dialog.getByLabel("Name").fill("Billing");
  await dialog.getByLabel(/^Repos/).fill("nuko-nova-dynamics/billing");
  await settle();
  await both("17-new-project");
  await page.keyboard.press("Escape");
  await page.locator(".main-head").getByRole("button", { name: "New task" }).click();
  await dialog.getByLabel("Title").fill("Write the invoice export");
  await settle();
  await both("18-new-task");
  await page.keyboard.press("Escape");
  await click("Settings", ".sidebar-bottom");
  await page.locator(".settings-nav").getByRole("button", { name: "Machines" }).click();
  await page.getByRole("button", { name: "Link a machine" }).click();
  await dialog.getByLabel("Name for the machine").fill("julio-desktop");
  await dialog.getByRole("button", { name: "Get a pairing code" }).click();
  await settle(1200);
  await both("19-pairing-command");
  console.log("pairing command:", (await dialog.getByLabel("Pairing command").innerText()).trim());
  await page.keyboard.press("Escape");

  // Settings, Notifications: the sound cues (Link reacting to one) and the banner previews.
  await click("Settings", ".sidebar-bottom");
  await page.locator(".settings-nav").getByRole("button", { name: "Notifications" }).click();
  await settle();
  await page.getByRole("listitem").filter({ hasText: "Needs you" }).click();
  await settle(500);
  await both("41-notifications");
  // Appearance, with the pointer on the pressed theme segment (it used to hide its label).
  await page.locator(".settings-nav").getByRole("button", { name: "Appearance" }).click();
  await settle();
  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Dark" }).hover();
  await settle();
  await both("42-appearance");
  // Spacious rows, then back to Compact, the default.
  await page.getByRole("group", { name: "Row density" }).getByRole("button", { name: "Spacious" }).click();
  await click(/^Inbox/);
  await settle(1200);
  await both("43-inbox-spacious");
  await click("Settings", ".sidebar-bottom");
  await page.locator(".settings-nav").getByRole("button", { name: "Appearance" }).click();
  await page.getByRole("group", { name: "Row density" }).getByRole("button", { name: "Compact" }).click();

  // Live events, once the app is open: work that needs me and the wheel coming back to me. Each
  // plays its cue and asks for a banner; quiet runs write the banner to the log instead.
  if (seeded) {
    await click(/^Inbox/);
    await settle(1000);
    const before = await lastCue();
    await seeded.later.needsYou();
    await settle(2000);
    console.log("cue after new work needs me:", before, "->", await lastCue());
    await both("44-inbox-needs-you-live");
    await seeded.later.wheelToMe();
    await settle(2000);
    console.log("cue after Hermes passed me the wheel:", await lastCue());
    const banners = (await logLines()).filter((line) => line.event === "show") as unknown as {
      id: string;
      nativeId: string;
      title: string;
      subtitle?: string;
      body: string;
      buttons: { text: string }[];
    }[];
    // Windows refuses a notification id over 64 characters, and a run's key is longer.
    const tooLong = banners.filter((b) => b.nativeId.length > 64);
    if (tooLong.length > 0) throw new Error(`banner ids over 64 characters: ${tooLong.map((b) => b.nativeId)}`);
    for (const b of banners)
      console.log(
        `banner (key ${b.id.length} chars, id ${b.nativeId}):`,
        b.title,
        "|",
        b.subtitle ?? "",
        "|",
        b.body.replace(/\n/g, " / "),
        "| buttons:",
        b.buttons.map((x) => x.text).join(", "),
      );
  }

  // ---- checks that act on the data, after the pictures ----
  const inboxCounts = async () => ({
    needs: await page.locator("section[aria-label='Needs you'] .inbox-row").count(),
    done: await page.locator("section[aria-label='Done'] .inbox-row").count(),
  });
  await click(/^Inbox/);
  await settle(1500);
  console.log("inbox before:", await inboxCounts());

  // Allow from the row: the toast stays quiet, and the task panel records who allowed it.
  await page
    .locator(".inbox-row", { hasText: "Save slots on the title screen" })
    .getByRole("button", { name: "Allow" })
    .click();
  await settle(1500);
  await page.locator(".inbox-row", { hasText: "Save slots on the title screen" }).dblclick();
  await settle(1200);
  console.log(
    "allowed line:",
    await page
      .locator(".drawer")
      .getByText(/allowed/)
      .first()
      .innerText(),
  );
  await page.locator(".drawer").getByRole("button", { name: "Close task" }).click();

  // Settle with S on the first Done row, then snooze the next one with H and "In 1 hour".
  // (Rows are clicked on their right edge: that focuses them without opening the task, which would pause the keys.)
  const doneRow = () => page.locator("section[aria-label='Done'] .inbox-row").first();
  if ((await inboxCounts()).done > 0) {
    await doneRow().locator(".right").click();
    await page.keyboard.press("s");
    await settle(1500);
    console.log("inbox after settle:", await inboxCounts(), "cue:", await lastCue());
  }
  if ((await inboxCounts()).done > 0) {
    await doneRow().locator(".right").click();
    await page.keyboard.press("z");
    await page.getByRole("menuitem", { name: "In 1 hour" }).click();
    await settle(1500);
    console.log("inbox after snooze:", await inboxCounts());
  }

  // One-click filing of an unfiled run under its suggested project.
  await click(/^Unfiled/);
  await settle(1000);
  const before = await page.locator(".inbox-row").count();
  await page.getByRole("button", { name: "File in Website" }).click();
  await settle(1500);
  console.log("unfiled before/after:", before, await page.locator(".inbox-row").count());
  await click("Website");
  await settle(1200);
  console.log(
    "website board has the filed task:",
    (await page.locator(".card", { hasText: "Compress hero images" }).count()) > 0,
  );

  // Create the first project and a task with no project through the app, as a new team would.
  await page.getByRole("button", { name: "New project" }).click();
  await dialog.getByLabel("Name").fill("Billing");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await settle(1500);
  console.log(
    "new project opens its board:",
    (await page.locator(".main-head h1").first().innerText()).trim(),
  );
  await click(/^Inbox/);
  await settle(1000);
  await page.locator(".main-head").getByRole("button", { name: "New task" }).click();
  await dialog.getByLabel("Title").fill("Task with no project");
  await dialog.getByRole("button", { name: "Create task" }).click();
  await settle(1500);
  console.log(
    "new task opens its panel:",
    (await page.locator(".drawer h1").first().innerText()).trim(),
  );
  // A thread run filed under a task: the room stops threads too (`stop_thread`), so Stop is on.
  await click(/^Unfiled/);
  await settle(1000);
  await page
    .locator(".inbox-row", { hasText: "Try a lighter sprite atlas" })
    .getByRole("button", { name: "File in Reef Runner" })
    .click();
  await settle(1500);
  await click("Reef Runner");
  await settle(1200);
  await page.locator(".card", { hasText: "Try a lighter sprite atlas" }).first().click();
  await settle(1200);
  await both("22-thread-run");
  console.log(
    "thread run's Stop is on:",
    await page.locator(".drawer").getByRole("button", { name: "Stop run" }).isEnabled(),
  );
  await page.locator(".drawer").getByRole("button", { name: "Close task" }).click();

  // Tasks with no project, including the one made above, on their own board.
  await click("No project");
  await settle(1200);
  await both("21-no-project-board");
  if (seeded) {
    // A click on Allow for an approval that is gone opens its task and answers nothing. The save
    // slots approval is answered on another computer and the run works on; then a click on its
    // banner's Allow comes back from main, as it would from a toast in Notification Center.
    await seeded.later.saveSlotsMovesOn();
    await settle(1500);
    const shown = (await logLines()).filter((line) => line.event === "show");
    const allowed = shown.find((line) => String(line["body"]).includes("pnpm test --filter save"))!;
    const [runId, promptId] = allowed.id!.split(":");
    const taskId = seeded.tasks["Save slots on the title screen"];
    const errorsBefore = await page.locator(".toast .state-failed").count();
    // Main hands back the session a banner belongs to: this page's, which its first snapshot
    // reported in the latest reconcile.
    const reconciles = (await logLines()).filter((line) => line.event === "reconcile");
    const thisSession = String(reconciles[reconciles.length - 1]?.["session"]);
    await app.evaluate(
      ({ BrowserWindow }, answer) =>
        BrowserWindow.getAllWindows()[0]!.webContents.send("uplink:notification", answer),
      {
        choice: "allow",
        session: thisSession,
        request: {
          kind: "needs",
          id: `${runId}:${promptId}`,
          who: "Claude Code",
          task: "Save slots on the title screen",
          text: "Wants to run pnpm test --filter save",
          canAllow: true,
          runId,
          promptId,
          taskId,
        },
      },
    );
    await settle(1500);
    if ((await page.locator(".drawer").count()) === 0) {
      await page.screenshot({ path: join(tmpdir(), "uplink-shots-debug.png") });
      throw new Error(`no task panel opened; heading: ${await page.locator(".main-head").first().innerText()}`);
    }
    const tookAway = (await logLines()).filter((line) => line.id === allowed.id && line.event !== "show");
    console.log("its banner, once the approval went:", tookAway.map((line) => line.event).join(", "));
    console.log(
      "allow on a gone approval opened:",
      (await page.locator(".drawer h1").first().innerText()).trim(),
      "| error toasts:",
      (await page.locator(".toast .state-failed").count()) - errorsBefore,
    );
    await page.locator(".drawer").getByRole("button", { name: "Close task" }).click();

    // The page reloads, and meanwhile the website deploy finishes elsewhere: the new session's
    // first snapshot tells main what is live, and main takes the deploy's banner away.
    const deployKey = shown.find((line) => String(line["body"]).includes("deploy website"))?.id;
    await page.reload({ waitUntil: "domcontentloaded" });
    await seeded.later.finishDeploy();
    await page.locator(".sidebar").waitFor({ timeout: 30_000 });
    await settle(3000);
    const afterReload = (await logLines()).filter((line) => line.id === deployKey || line.event === "reconcile");
    console.log(
      "after a reload, the finished deploy's banner went by:",
      afterReload.map((line) => (line.event === "reconcile" ? `reconcile ${JSON.stringify(line["dismissed"])}` : line.event)).join(", "),
    );

    // Opening another team ends this session, and its banners go with it.
    const before = (await logLines()).length;
    await page.locator(".team-btn").click();
    // The current team is the one with a check mark.
    await page
      .locator(".pop button", { hasText: "Nuko Nova" })
      .filter({ hasNot: page.locator("svg") })
      .first()
      .click();
    await settle(3000);
    const switched = (await logLines()).slice(before);
    for (const line of switched)
      if (line.event === "end" || line.event === "reconcile")
        console.log(`after opening another team: ${line.event}`, JSON.stringify(line["dismissed"]));

    // A click main handed back just before the old team's banners went: it belongs to that team's
    // session, so in the new team it neither opens nor answers anything.
    const oldSession = String(switched.find((line) => line.event === "end")?.["session"]);
    const heading = await page.locator(".main-head h1").first().innerText();
    const errors = await page.locator(".toast .state-failed").count();
    for (const choice of ["allow", "open"])
      await app.evaluate(
        ({ BrowserWindow }, answer) =>
          BrowserWindow.getAllWindows()[0]!.webContents.send("uplink:notification", answer),
        {
          choice,
          session: oldSession,
          request: {
            kind: "needs",
            id: `${runId}:${promptId}`,
            who: "Claude Code",
            task: "Save slots on the title screen",
            text: "Wants to run pnpm test --filter save",
            canAllow: true,
            runId,
            promptId,
            taskId,
          },
        },
      );
    await settle(1500);
    console.log(
      "the old team's banner clicked in the new team:",
      (await page.locator(".drawer").count()) === 0 &&
        (await page.locator(".main-head h1").first().innerText()) === heading &&
        (await page.locator(".toast .state-failed").count()) === errors
        ? "nothing opened or answered"
        : "SOMETHING HAPPENED",
    );
  }
  console.log("done");
} finally {
  await app.close();
}

// The sign-in screen, from a profile with no session, with Clerk's card in each theme.
{
  const empty = await mkdtemp(join(tmpdir(), "uplink-signin-"));
  const { app: fresh, page: gate } = await launch(url, empty);
  try {
    for (const theme of ["dark", "light"] as const) {
      await gate.evaluate((t) => localStorage.setItem("uplink.theme", t), theme);
      await gate.reload();
      await gate.locator("input[name='identifier']").waitFor({ timeout: 40_000 });
      await gate.waitForTimeout(1500);
      await gate.screenshot({ path: join(outDir, `00-sign-in-${theme}.png`) });
    }
  } finally {
    await fresh.close();
    await rm(empty, { recursive: true, force: true });
    server.close();
  }
}
