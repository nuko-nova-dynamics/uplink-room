/**
 * One spelling per repo (lib/repos.ts): what projects keep, what the picker saves and what the
 * bridge matches a T3 Code project against.
 */
import { expect, test } from "vitest";
import { normalizeRepo, repoKey } from "../convex/lib/repos";

test("a bare owner/name becomes github.com/owner/name, however it's typed", () => {
  for (const typed of ["nuko/billing", "  nuko/billing  ", "nuko/billing/", "nuko/billing.git"]) {
    expect(normalizeRepo(typed)).toBe("github.com/nuko/billing");
  }
  expect(normalizeRepo("Nuko/Billing")).toBe("github.com/Nuko/Billing");
  expect(repoKey("Nuko/Billing")).toBe(repoKey("https://github.com/nuko/billing"));
});

test("a repo with a host keeps its host, in lower case, and gets no github.com", () => {
  expect(normalizeRepo("https://github.com/nuko/billing.git")).toBe("github.com/nuko/billing");
  expect(normalizeRepo("git@github.com:nuko/billing.git")).toBe("github.com/nuko/billing");
  expect(normalizeRepo("GitLab.Example.com/Team/App")).toBe("gitlab.example.com/Team/App");
  expect(normalizeRepo("ssh://git@gitlab.example.com/team/app.git")).toBe("gitlab.example.com/team/app");
  // Two segments whose first has a dot is a host and a path, not an owner and a name.
  expect(normalizeRepo("bitbucket.org/team")).toBe("bitbucket.org/team");
});

test("a remote that names a host without a dot keeps it, and doesn't become a GitHub repo", () => {
  expect(normalizeRepo("git@gitbox:payroll.git")).toBe("gitbox/payroll");
  expect(normalizeRepo("ssh://git@gitbox/payroll.git")).toBe("gitbox/payroll");
  expect(normalizeRepo("https://gitbox/payroll")).toBe("gitbox/payroll");
  // The same two words typed bare are an owner and a name on GitHub.
  expect(normalizeRepo("gitbox/payroll")).toBe("github.com/gitbox/payroll");
});
