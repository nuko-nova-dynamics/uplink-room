/**
 * The join link (`/invite#<token>`) and the welcome email's links (`/open#team/<id>/...`) carry
 * what they open in the URL fragment. Browsers never send a fragment to the server, so the token
 * reaches no request log; these pages read it in the browser and hand it to the desktop app as
 * `uplink-room://invite/<token>` or `uplink-room://open/<path>` (apps/desktop/src/main/deepLink.ts
 * checks the same shapes).
 */
const TOKEN = /^[A-Za-z0-9_-]{8,128}$/;
const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/** The invite token in a `#<token>` fragment, or null when it's missing or malformed. */
export function inviteToken(hash: string): string | null {
  const value = hash.replace(/^#/, "").trim();
  return TOKEN.test(value) ? value : null;
}

/** The app place in a `#team/<id>/...` fragment, or null. */
export function openPath(hash: string): string[] | null {
  const segments = hash.replace(/^#/, "").split("/").filter(Boolean);
  const ok =
    segments.length >= 2 && segments.length <= 6 && segments[0] === "team" && segments.every((s) => SEGMENT.test(s));
  return ok ? segments : null;
}

export function appInviteLink(token: string): string {
  return `uplink-room://invite/${token}`;
}

export function appOpenLink(path: string[]): string {
  return `uplink-room://open/${path.join("/")}`;
}
