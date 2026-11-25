import { relative, sep } from "node:path";

/**
 * Which bundled page the window may open. The gym (renderer/gym/) renders a sample team and writes
 * preferences (notifications off, setup done) into the profile it runs in, so it runs only
 * unpackaged and only in a profile under the system's temp folder, as scripts/gym.ts makes one.
 */
export function startPathAllowed(startPath: string, run: { packaged: boolean; userData: string; tmp: string }): boolean {
  if (!startPath.startsWith("/gym.html")) return true;
  if (run.packaged) return false;
  const inside = relative(run.tmp, run.userData);
  return inside !== "" && !inside.startsWith("..") && !inside.startsWith(sep);
}

/**
 * Whether a link may leave the app for the system browser. The gym's crawl clicks every button, and
 * its sample team's links (a fake GitHub org's settings, sample run pages) would each open a tab in
 * the browser of whoever runs it, so the gym opens nothing outside; it logs the link instead.
 */
export function opensOutside(url: string, startPath: string): boolean {
  return /^https?:\/\//.test(url) && !startPath.startsWith("/gym.html");
}
