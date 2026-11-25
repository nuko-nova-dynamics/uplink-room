import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { appDir, launch, serveRenderer } from "./lib.ts";

/**
 * Signs a throwaway test person in to the Clerk development instance, so the
 * screenshot script has a session. It uses Clerk's documented test email
 * (`+clerk_test` addresses never send mail, and accept the code 424242) and
 * keeps the session in apps/desktop/.shots-profile (git-ignored).
 */
// `node scripts/signin.ts <shot folder> second` signs in the second test person instead.
const second = process.argv[3] === "second";
const profile = join(appDir, second ? ".shots-profile-2" : ".shots-profile");
const shotDir = process.argv[2] ?? profile;
await mkdir(profile, { recursive: true });

const credsFile = join(profile, "credentials.json");
let creds: { email: string; password: string };
try {
  creds = JSON.parse(await readFile(credsFile, "utf8"));
} catch {
  creds = {
    email: second ? "uplink-shots-2+clerk_test@example.com" : "uplink-shots+clerk_test@example.com",
    password: randomBytes(18).toString("base64url"),
  };
  await writeFile(credsFile, JSON.stringify(creds), { mode: 0o600 });
}

const { server, url } = await serveRenderer();
const { app, page } = await launch(url, profile);
try {
  await page.waitForLoadState("domcontentloaded");
  const gate = page.locator("input[name='identifier'], input[name='emailAddress']").first();
  const signedIn = page.getByText("Hi, I'm Link").or(page.locator(".sidebar")).first();
  await gate.or(signedIn).waitFor({ timeout: 30_000 });
  if (await gate.isVisible()) {
    await gate.fill(creds.email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.locator("input[type='password']").first().waitFor({ timeout: 15_000 });
    await page.locator("input[type='password']").first().fill(creds.password);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    // New accounts verify the email with a code; Clerk's test emails accept 424242.
    const code = page
      .locator("input[autocomplete='one-time-code'], input[name='codeInput']")
      .first();
    await code.or(signedIn).waitFor({ timeout: 20_000 });
    if (await code.isVisible()) await page.keyboard.type("424242", { delay: 80 });
  }
  await signedIn.waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(shotDir, "signin-2.png") });
  console.log(
    "signed in:",
    (await page.locator("body").innerText()).slice(0, 300).replace(/\n+/g, " | "),
  );
} finally {
  await app.close();
  server.close();
}
