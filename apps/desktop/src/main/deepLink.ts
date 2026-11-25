/**
 * Links into the app: `uplink-room://invite/<token>` (the join link's page, apps/site/app/invite,
 * opens it) and `uplink-room://open/team/<teamId>/...` (the welcome email's steps, through
 * apps/site/app/open). The operating system hands them to the app as `open-url` on macOS and as a
 * command-line argument on Windows and Linux, at launch or in a second launch.
 *
 * `uplink-room://app/` belongs to Clerk's OAuth sign-in (index.ts), so it is never one of these.
 *
 * Links wait here until the app's window takes them, since the first can arrive before the window
 * has loaded, and the person may still have to sign in.
 */
export type DeepLink = { kind: "invite"; token: string } | { kind: "open"; path: string[] };

const SCHEME = "uplink-room:";
const TOKEN = /^[A-Za-z0-9_-]{8,128}$/;
const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

export function parseDeepLink(value: unknown): DeepLink | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== SCHEME) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.hostname === "invite") {
    const token = segments[0] ? decodeSafe(segments[0]) : null;
    return segments.length === 1 && token && TOKEN.test(token) ? { kind: "invite", token } : null;
  }
  if (url.hostname === "open") {
    const ok =
      segments.length >= 2 && segments.length <= 6 && segments[0] === "team" && segments.every((s) => SEGMENT.test(s));
    return ok ? { kind: "open", path: segments } : null;
  }
  return null;
}

function decodeSafe(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** The first app link among command-line arguments (Windows and Linux pass the link that way). */
export function deepLinkFromArgv(argv: readonly string[]): DeepLink | null {
  for (const arg of argv) {
    if (!arg.startsWith("uplink-room://")) continue;
    const link = parseDeepLink(arg);
    if (link) return link;
  }
  return null;
}

/** Links not yet taken by the window. `onArrive` tells the window to take them. */
export class DeepLinkQueue {
  private links: DeepLink[] = [];
  private readonly onArrive: () => void;
  constructor(onArrive: () => void = () => {}) {
    this.onArrive = onArrive;
  }

  push(link: DeepLink): void {
    // The same link twice in a row (a double click in the browser) is one link.
    const last = this.links.at(-1);
    if (last && JSON.stringify(last) === JSON.stringify(link)) return;
    this.links.push(link);
    if (this.links.length > 10) this.links.shift();
    this.onArrive();
  }

  take(): DeepLink[] {
    const taken = this.links;
    this.links = [];
    return taken;
  }
}
