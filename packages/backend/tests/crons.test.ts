import { afterEach, expect, test, vi } from "vitest";

/** #51: crons are defined on deploy; the cloud-machine reconciler only where cloud machines can run. */

afterEach(() => {
  vi.unstubAllEnvs();
});

async function cronNames() {
  vi.resetModules();
  return Object.keys((await import("../convex/crons")).default.crons);
}

test("the reconciler's cron is scheduled only on deployments with the Vercel settings", async () => {
  for (const name of ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"]) vi.stubEnv(name, "");
  expect(await cronNames()).not.toContain("reconcile cloud machines");
  vi.stubEnv("VERCEL_TOKEN", "token");
  expect(await cronNames()).not.toContain("reconcile cloud machines");
  vi.stubEnv("VERCEL_TEAM_ID", "team_1");
  vi.stubEnv("VERCEL_PROJECT_ID", "prj_1");
  const names = await cronNames();
  expect(names).toContain("reconcile cloud machines");
  expect(names).toContain("restart stalled A2A steps");
  expect(names).toContain("delete finished call revocations");
  expect(names).toContain("delete ended CLI sign-ins");
  expect(names).toContain("delete unapproved connectors");
});
