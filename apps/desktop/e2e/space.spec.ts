import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

/**
 * Spec #6: the Space view's access controls, on the harness page (src/renderer/space-harness.tsx),
 * which renders the real view with sample data and no sign-in. The sample Space is on studio-mac,
 * which allows at most Drive; Julio shared it and drives it, Ana is a teammate.
 *
 * With SPACE_SHOTS=1 it also writes the review screenshots, dark and light, to screenshots/.
 */
const appDir = join(import.meta.dirname, "..");
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  const env = { ...process.env, UPLINK_START_PATH: "/space-harness.html" } as Record<string, string>;
  delete env["ELECTRON_RUN_AS_NODE"];
  delete env["ELECTRON_RENDERER_URL"];
  app = await electron.launch({ args: [appDir], env });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1360, height: 820 });
});

test.afterAll(async () => {
  await app?.close();
});

async function open(query: string) {
  // `origin` is "null" for the app's custom scheme, so build it from the scheme and host.
  const url = new URL(page.url());
  await page.goto(`${url.protocol}//${url.host}/space-harness.html?${query}`);
  await expect(page.getByTestId("space-stage")).toBeVisible();
}

const access = (name: string) => page.getByRole("group", { name: "Teammates can" }).getByRole("button", { name });

async function shot(name: string) {
  if (!process.env["SPACE_SHOTS"]) return;
  // Let the sample screen and fonts load before the capture.
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(appDir, "screenshots", `${name}.png`) });
}

test("the driver who shared it can lower access but not pass the machine's limit, and is asked for the wheel", async () => {
  for (const theme of ["dark", "light"]) {
    await open(`as=julio&access=drive&theme=${theme}`);
    await expect(access("Open")).toBeDisabled();
    await expect(access("Open")).toHaveAttribute("title", "studio-mac allows at most Drive.");
    await expect(access("Drive")).toHaveAttribute("aria-pressed", "true");
    // The driver's badge is just "Input on" since #101; the frame's title still names the driver.
    await expect(page.getByText("Input on", { exact: true })).toBeVisible();
    await expect(page.locator("iframe.space-frame")).toHaveAttribute("title", /you're driving/);
    await expect(page.getByRole("button", { name: "Hand it over" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pass the wheel" })).toBeVisible();
    await expect(page.frameLocator("iframe.space-frame").getByRole("img")).toBeVisible();
    await shot(`28-space-driving-${theme}`);
  }
  await access("Watch").click();
  await expect(page.locator("body")).toHaveAttribute("data-last-action", "setAccess:watch");
});

test("a teammate watches with the keyboard off, sees the access as text, and asks for the wheel on Drive", async () => {
  for (const theme of ["dark", "light"]) {
    await open(`as=ana&access=drive&theme=${theme}`);
    // Someone who can't change the access sees it as text, not as controls they can't use.
    await expect(page.getByRole("group", { name: "Teammates can" })).toHaveCount(0);
    await expect(page.locator(".access-read")).toContainText("Drive");
    await expect(page.getByText("You're watching")).toBeVisible();
    await expect(page.getByText("Watching: Julio is driving")).toBeVisible();
    await expect(page.getByRole("button", { name: "Ask for the wheel" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Take the wheel" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Pass the wheel" })).toHaveCount(0);
    await expect(page.getByLabel("Suggest to the driver")).toBeEnabled();
    await shot(`29-space-watching-${theme}`);
  }
});

test("on Watch a teammate can't suggest or ask for the wheel; on Open they take it", async () => {
  await open("as=ana&access=watch");
  await expect(page.getByLabel("Suggest to the driver")).toBeDisabled();
  await expect(page.getByLabel("Suggest to the driver")).toHaveAttribute("placeholder", "This Space is on Watch");
  await expect(page.getByRole("button", { name: /wheel/ })).toHaveCount(0);

  await open("as=ana&access=open");
  await expect(page.getByRole("button", { name: "Take the wheel" })).toBeVisible();
});

test("a Space it can't reach says why and offers to try again, and an ended one says so", async () => {
  for (const theme of ["dark", "light"]) {
    await open(`as=ana&access=drive&stage=unreachable&theme=${theme}`);
    await expect(page.getByRole("status").filter({ hasText: "Can't reach studio-mac from this computer" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await shot(`30-space-unreachable-${theme}`);
  }
  await open("as=ana&stage=stopped");
  await expect(page.getByText("This Space is stopped on studio-mac. It shows here again when it starts.")).toBeVisible();
  await open("as=ana&stage=ended");
  await expect(page.getByText("This Space is no longer shared.")).toBeVisible();
  // An ended Space has no access to change, and its header says it ended.
  await expect(page.getByRole("group", { name: "Teammates can" })).toHaveCount(0);
  await expect(page.getByLabel("Driver")).toContainText("Ended");
});
