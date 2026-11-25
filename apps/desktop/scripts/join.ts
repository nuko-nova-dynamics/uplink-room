import { join } from "node:path";
import { appDir, launch, serveRenderer } from "./lib.ts";

/**
 * The two-person flow, through the app's own screens:
 *  1. The admin (first test person) invites the second one in Settings, Members, and copies the token.
 *  2. The second person signs in (`node scripts/signin.ts <folder> second` once), pastes the token at the
 *     team gate, and joins.
 *  3. As a teammate they see: the Inbox zero line, someone else's machine (settings locked, with the reason),
 *     a terminal they don't drive (keyboard off, ask for the wheel, suggest), and the plain warning before
 *     making a profile on someone else's machine.
 *
 *   node scripts/join.ts
 */
const outDir = join(appDir, "screenshots");
const { server, url } = await serveRenderer();
const SECOND_EMAIL = "uplink-shots-2+clerk_test@example.com";

// 1. The admin makes the invite.
let token = "";
{
  const { app, page } = await launch(url, join(appDir, ".shots-profile"));
  try {
    const gate = page.getByText("Pick a team, make one");
    await gate.or(page.locator(".sidebar")).first().waitFor({ timeout: 40_000 });
    // Each run serves the app on a new port, so the remembered team is lost. With several teams
    // (every `FRESH=1` screenshots run makes one) the gate shows: take the newest, the last listed.
    if (await gate.isVisible()) await page.locator("button", { hasText: "Nuko Nova" }).last().click();
    await page.locator(".sidebar").waitFor({ timeout: 40_000 });
    await page.locator(".sidebar-bottom").getByRole("button", { name: "Settings" }).click();
    await page.locator(".settings-nav").getByRole("button", { name: "Members" }).click();
    await page.getByRole("button", { name: "Invite someone" }).click();
    await page.getByLabel("Email", { exact: true }).fill(SECOND_EMAIL);
    // No email: the second person is a test account, and the script carries the token itself.
    await page.getByLabel("Email them the invite").uncheck();
    await page.getByRole("button", { name: "Make an invite" }).click();
    // The box shows the join link; the token is the part after "#".
    token = (await page.locator(".secret-box").textContent())!.trim().split("#").pop()!;
    console.log("invite token made:", token.slice(0, 6) + "…");
  } finally {
    await app.close();
  }
}

// 2 and 3. The second person joins and looks around.
{
  const { app, page } = await launch(url, join(appDir, ".shots-profile-2"));
  page.on("pageerror", (error) => console.log("page error:", error.message));
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
  try {
    const gate = page.getByText("Pick a team, make one");
    const sidebar = page.locator(".sidebar");
    await gate.or(sidebar).first().waitFor({ timeout: 40_000 });
    if (await gate.isVisible()) {
      // Refresh the session token so its name claim has the name set in Clerk, then reload.
      await page.evaluate(() =>
        (
          window as unknown as { Clerk: { session: { getToken(o: object): Promise<string> } } }
        ).Clerk.session.getToken({ skipCache: true }),
      );
      await page.reload();
      await gate.waitFor({ timeout: 30_000 });
      await page.getByLabel("Join with an invite token").fill(token);
      await page.getByRole("button", { name: "Join", exact: true }).click();
      await sidebar.waitFor({ timeout: 30_000 });
      console.log("joined");
    }
    await settle(1500);
    // A new computer shows onboarding first; it's covered by screenshots.ts, so skip it here.
    const onboarding = page.locator(".onboarding");
    if (await onboarding.isVisible()) {
      await page.keyboard.press("Escape");
      await onboarding.waitFor({ state: "detached" });
    }

    // Inbox zero, with Link beside the line.
    await page
      .locator(".sidebar")
      .getByRole("button", { name: /^Inbox/ })
      .click();
    await settle(1500);
    await both("13-inbox-zero");

    // A terminal they don't drive.
    await page.locator(".sidebar-bottom").getByRole("button", { name: "Settings" }).click();
    await settle();
    await page.locator(".settings-pane").getByRole("tab", { name: "Team" }).click();
    await settle();
    await page.locator(".term-row", { hasText: "Claude Code" }).first().click();
    await settle(2500);
    await page.getByLabel("Suggest a command").fill("pnpm lint");
    await page
      .getByRole("complementary", { name: "Terminal controls" })
      .getByRole("button", { name: "Suggest" })
      .click();
    await settle(1200);
    console.log("keyboard badge:", (await page.locator(".kb-badge").textContent())?.trim());
    await both("14-terminal-not-driver");

    // Someone else's personal machine: settings locked, with the reason.
    await page.locator(".sidebar-bottom").getByRole("button", { name: "Settings" }).click();
    await settle();
    await page.locator(".settings-pane").getByRole("tab", { name: "Personal" }).click();
    await settle(1200);
    await both("15-machine-not-mine");

    // The plain warning before a profile on someone else's machine.
    await page.locator(".settings-nav").getByRole("button", { name: "Profiles" }).click();
    await page.getByRole("button", { name: "New profile" }).click();
    // The machine field is a UI SDK Select: open it, then choose.
    await page.getByLabel("Machine").click();
    await page.getByRole("option", { name: "julio-mbp (Julio Díaz's)" }).click();
    await page.getByLabel("Name").fill("My Claude login");
    await settle();
    const make = page.getByRole("button", { name: "Make profile" });
    console.log("make profile disabled before accepting:", await make.isDisabled());
    await both("16-profile-warning");
    await page.getByLabel(/I understand that/).check();
    console.log("make profile disabled after accepting:", await make.isDisabled());
    await make.click();
    await settle(1500);
    console.log(
      "profiles:",
      (await page.locator(".settings-pane table tbody").innerText()).replace(/\s+/g, " "),
    );
    console.log("done");
  } finally {
    await app.close();
    server.close();
  }
}
