/**
 * One spelling per repo, so `git@github.com:nuko/billing.git`,
 * `https://github.com/nuko/billing`, `github.com/nuko/billing` and a bare `nuko/billing` (as the
 * repo picker asks people to type it) all become `github.com/nuko/billing`: the spelling T3 Code's
 * repository keys use, which the bridge matches a run's repo against. Only a bare `owner/name` gets
 * `github.com/`: a remote that names its host (a scheme, `user@`, or `host:`) keeps it, so
 * `git@gitbox:payroll.git` is `gitbox/payroll`.
 */
export function normalizeRepo(repo: string): string {
  let r = repo.trim();
  const namesHost = /^[a-z+]+:\/\//i.test(r) || r.includes("@") || r.includes(":");
  r = r.replace(/^[a-z+]+:\/\//i, "");
  r = r.replace(/^[^@/]+@([^:/]+):/, "$1/");
  r = r.replace(/^[^@/]+@/, "");
  r = r.replace(/\.git$/i, "").replace(/\/+$/, "");
  const parts = r.split("/");
  // owner/name, typed with no host: a host has a dot (github.com, gitlab.example.com).
  if (!namesHost && parts.length === 2 && parts[0] && parts[1] && !parts[0].includes(".")) return `github.com/${r}`;
  const [host, ...rest] = parts;
  return [host?.toLowerCase(), ...rest].join("/");
}

/**
 * What two spellings of the same repo share, for matching a project's repo strings with synced
 * repos: the normalized spelling in lower case, since GitHub's names ignore case.
 */
export function repoKey(repo: string): string {
  return normalizeRepo(repo).toLowerCase();
}

/** The string a project keeps for a synced repo: `github.com/` and the name as GitHub writes it. */
export function githubRepoString(fullName: string): string {
  return `github.com/${fullName}`;
}
