// The clicks some gym states need before they show what they're about, shared by the gym's capture
// (gym.ts) and its crawl (gym-crawl.ts), so both look at the screen a state names.
import type { Page } from "@playwright/test";

/** Clicks some states need before they show what they are about. */
export async function prepare(page: Page, state: string): Promise<void> {
  if (state.startsWith("inventory-files"))
    await page.getByRole("tab", { name: "Files", exact: true }).click();
  // Link a machine: this computer links in one click with no code; another machine gets a code and
  // its steps for one system.
  if (state.startsWith("link-machine")) {
    await page.getByRole("button", { name: "Link a machine" }).click();
    if (state.startsWith("link-machine-this")) await page.locator("#link-panel-this").waitFor();
    else {
      await page.getByRole("tab", { name: "Another machine" }).click();
      await page.locator("#machine-name").fill("rosa-mbp");
      await page.getByRole("button", { name: "Get a pairing code" }).click();
      await page.locator(".link-code").waitFor();
    }
    const os = state.endsWith("-windows")
      ? "Windows"
      : state === "link-machine-other"
        ? "Linux"
        : null;
    if (os) await page.locator(".link-os").getByRole("radio", { name: os }).click();
  }
  if (state === "browser") await page.getByRole("button", { name: /^Shared browser/ }).click();
  if (state === "many-members") await page.locator(".members-btn").click();
  if (state === "start-run-shell") {
    await page.locator(".drawer").getByRole("button", { name: "Start a run" }).click();
    await page
      .getByRole("radiogroup", { name: "Harness" })
      .getByRole("radio", { name: "Shell", exact: true })
      .click();
  }
  // ADR 0044: giving a task to a roster agent, from the task drawer, a board card and the roster.
  if (state === "start-run-roster") {
    await page.locator(".drawer").getByRole("button", { name: "Start a run" }).click();
    await page.getByRole("radio", { name: "An agent from the roster" }).click();
    await page.locator(".machine-option", { hasText: "Grok Bot" }).click();
  }
  if (state === "project-give-agent") {
    await page.locator(".card-wrap").first().hover();
    await page
      .locator(".card-wrap")
      .first()
      .getByRole("button", { name: "Give to an agent" })
      .click();
    await page.locator(".dialog").waitFor();
  }
  if (state === "roster-give-task") {
    await page.locator(".roster-item", { hasText: "Grok Bot" }).click();
    await page.getByRole("menu", { name: "Give it a task" }).waitFor();
  }
  // ADR 0025: the teammate's machine in Start a run, shown with why it's off, or picked.
  if (state.startsWith("start-run-teammate")) {
    await page.locator(".drawer").getByRole("button", { name: "Start a run" }).click();
    if (state === "start-run-teammate-suggest")
      await page.getByRole("button", { name: /can't take a run now/ }).click();
    else await page.locator(".machine-option", { hasText: "loiko-mini" }).click();
    await page.locator(".machine-option", { hasText: "loiko-mini" }).scrollIntoViewIfNeeded();
  }
  if (state === "error-call") await page.getByRole("button", { name: "Join call" }).click();
  if (state === "setup-pair-error") {
    await page.locator(".setup").getByRole("button", { name: "Link this computer" }).click();
    await page.locator(".setup-error-note").waitFor();
  }
  if (state === "setup-devices") {
    await page.locator(".setup").getByRole("button", { name: "Test", exact: true }).click();
    await page.locator(".setup").getByRole("button", { name: "Preview", exact: true }).click();
    await page.waitForTimeout(800);
  }
  if (state === "agent-run-refused")
    await page
      .locator(".panel-section")
      .getByRole("button", { name: /Testing/ })
      .click();
  // ADR 0031: approving a hosted assistant, its name, team and scopes open under its row.
  if (state === "settings-connector-review") {
    await page
      .locator(".connectors .panel-section", { hasText: "Claude" })
      .getByRole("button", { name: "Review" })
      .click();
  }
  if (state.startsWith("settings-rex")) {
    // Only on Machines: the crawl may have left Settings on another section, which a reload keeps.
    const section = page.locator(".panel-section", {
      has: page.getByText("Rex tabs", { exact: true }),
    });
    if (await section.count()) await section.evaluate((el) => el.scrollIntoView({ block: "end" }));
  }
  if (state === "terminal-rex-wide") {
    // Scrolled with the wheel over the screen, as a person would, to the tab's far edge and last row.
    const frame = page.locator(".xterm-frame");
    await frame.locator(".xterm-rows").waitFor();
    const box = (await frame.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(4000, 0);
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(300);
  }
  if (state === "start-run-mode") {
    await page.getByRole("button", { name: "Start a run" }).click();
    // The mode picker is a UI SDK Select: open it, then choose.
    await page.locator("#run-mode").click();
    await page.getByRole("option", { name: "Edit files without asking" }).click();
    await page.locator("#run-mode").scrollIntoViewIfNeeded();
  }
  if (state === "settings-machine-mode") {
    const section = page.locator(".panel-section", {
      has: page.getByText("Most an agent may do on its own here", { exact: true }),
    });
    await section.first().evaluate((el) => el.scrollIntoView({ block: "center" }));
  }
  if (state.startsWith("start-run-rex")) {
    await page.getByRole("button", { name: "Start a run" }).click();
    if (state === "start-run-rex")
      await page.getByRole("radio", { name: "In Rex", exact: true }).click();
    await page.locator(".dialog").getByText("Where it runs").scrollIntoViewIfNeeded();
  }
  if (state === "chat-thread") await page.locator(".replies-btn", { hasText: "5 replies" }).click();
  if (state === "thread-tools") {
    await page.locator(".thread-fold", { hasText: "Worked" }).first().click();
    await page.locator(".thread-fold.step", { hasText: "pnpm test export" }).first().click();
  }
  if (state === "thread-diff") await page.getByRole("button", { name: "Show diff" }).click();
  // ADR 0043: a screenshot waiting in the box, and the header menu with the access level and the agent's mode.
  if (state === "thread-files") {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKklEQVR4nGP8z8Dwn4ECwESJ5lEDRg0YNWDUgFEDRg0YNWDUgFEDqGcAAMtvAh9zJ2bAAAAAAElFTkSuQmCC",
      "base64",
    );
    await page
      .locator(".thread-composer input[type=file]")
      .setInputFiles({ name: "readings-below-datum.png", mimeType: "image/png", buffer: png });
    await page.locator(".thread-composer .pending-file").first().waitFor();
  }
  if (state === "thread-mode-menu" || state.startsWith("thread-menu-"))
    await page.locator(".access-menu-btn").click();
  if (state === "thread-long")
    await page.locator(".thread-scroll").evaluate((el) => void (el.scrollTop = 0));
  // The agent's thread open in Replies (ADR 0024).
  if (state === "agent-thread")
    await page
      .locator(".msg", { hasText: "Release notes for Thursday" })
      .locator(".replies-btn")
      .click();
  if (state === "agent-proposal-accepted")
    await page.locator(".thread-proposal").getByRole("button", { name: "Open thread" }).click();
  if (state === "chat-pins") await page.getByRole("button", { name: "Pinned messages" }).click();
  // Live runs in chat (ADR 0026): the @ list as it opens, and the new direct message picker.
  if (state === "runs-mention-list") {
    await page.getByRole("combobox", { name: "Message" }).last().pressSequentially("@c");
    await page.locator(".mention-list").waitFor();
  }
  // Hosted assistants (slice 14 of #139): the @ list with Duet's "Checks in on its own schedule", and adding a webhook.
  if (state === "hosted-mention-list") {
    await page.getByRole("combobox", { name: "Message" }).last().pressSequentially("@");
    await page.locator(".mention-list").waitFor();
  }
  if (state === "settings-agent-webhook-add") {
    await page
      .locator(".panel-section", { hasText: "Routine webhook" })
      .getByRole("button", { name: "Add" })
      .click();
    await page
      .locator(".panel-section", { hasText: "Routine webhook" })
      .getByLabel("POST to")
      .fill("https://api.grokbot.example/v1/routines/rt_8c41f2/webhook");
  }
  if (state === "runs-new-dm")
    await page.getByRole("button", { name: "New direct message" }).click();
  // A reply reaches the team run too, so the reply box carries the warning (ADR 0039, amended 2026-11-05).
  if (state === "runs-dm-thread") {
    const message = page.locator(".msg", { hasText: "It keeps the zoom and the station" });
    await message.hover();
    await message.getByRole("button", { name: "Reply", exact: true }).click();
    await page.locator(".replies-panel .composer-note").waitFor();
  }
  if (state === "runs-new-dm-team-run") {
    await page.getByRole("button", { name: "New direct message" }).click();
    await page
      .getByRole("list", { name: "Live runs" })
      .getByRole("button", { name: /Claude Code \(Theo Park\)/ })
      .click();
    await page.locator(".new-dm-warn").waitFor();
  }
  if (state === "chat-picker") {
    const message = page.locator(".msg", { hasText: "Chart is wired to live readings" });
    await message.hover();
    await message.getByRole("button", { name: "React", exact: true }).click();
  }
  // GitHub (ADR 0020): the repo picker in New project and in a project's Repos.
  if (state === "repo-picker-new" || state === "repo-picker-typed") {
    await page.locator(".nav-heading").getByRole("button", { name: "New project" }).click();
    await page.locator("#project-repos").click();
    await page.keyboard.type(state === "repo-picker-new" ? "tide" : "harbor-labs/legacy-tides", {
      delay: 20,
    });
  }
  if (state === "repo-picker-repos")
    await page
      .locator(".main-head")
      .getByRole("button", { name: /^Repos/ })
      .click();
  if (state === "setup-permissions-denied") {
    await page
      .locator(".setup")
      .getByRole("button", { name: "Open Screen Recording in System Settings" })
      .click();
  }
  // A new document can inherit the host pointer's hover on its first message. Capture this
  // conversation at rest; the inventory's hover step runs after preparation when requested.
  if (state === "pair-active") await page.mouse.move(0, 0);
}
