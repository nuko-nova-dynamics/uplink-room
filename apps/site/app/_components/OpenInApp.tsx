"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { appInviteLink, appOpenLink, inviteToken, openPath } from "../../lib/handoff";
import { platformOf } from "../../lib/platform";

type Read =
  | { state: "reading" }
  | { state: "missing" }
  | { state: "ready"; appLink: string; token: string | null; desktop: boolean };

/**
 * Reads the link's fragment in the browser (never sent to the server, see lib/handoff.ts) and
 * opens Uplink Room with it. Chromium browsers open the app straight away and do nothing when it
 * isn't installed; Safari and Firefox show an error page for an app they don't know, so there the
 * person opens it with the button. Phones get a note that the app is for computers.
 */
export function OpenInApp({ kind }: { kind: "invite" | "open" }) {
  const [read, setRead] = useState<Read>({ state: "reading" });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const hash = window.location.hash;
    const nav = navigator as Navigator & { userAgentData?: { platform?: string; brands?: unknown[] } };
    const desktop = platformOf(nav.userAgent, nav.userAgentData?.platform) !== null;
    let next: Read = { state: "missing" };
    if (kind === "invite") {
      const token = inviteToken(hash);
      if (token) next = { state: "ready", appLink: appInviteLink(token), token, desktop };
    } else {
      const path = openPath(hash);
      if (path) next = { state: "ready", appLink: appOpenLink(path), token: null, desktop };
    }
    setRead(next);
    if (next.state === "ready" && desktop && nav.userAgentData) window.location.href = next.appLink;
  }, [kind]);

  const title = kind === "invite" ? "Join your team on Uplink Room" : "Open Uplink Room";
  const token = read.state === "ready" ? read.token : null;

  if (read.state === "missing") {
    return (
      <div className="handoff">
        <h1>{kind === "invite" ? "This invite link is incomplete" : "This link is incomplete"}</h1>
        <p className="lead">
          {kind === "invite"
            ? "The part after the # is missing or was changed. Open the link from the email again, or ask whoever invited you to send a new one."
            : "The part after the # is missing or was changed. Open the link from the email again."}
        </p>
      </div>
    );
  }

  return (
    <div className="handoff">
      <h1>{title}</h1>
      {read.state === "ready" && !read.desktop ? (
        <p className="lead">
          Uplink Room is a desktop app. Open this link on your Mac, Windows or Linux computer.
        </p>
      ) : (
        <p className="lead">
          {kind === "invite"
            ? "Uplink Room opens and asks you to join. If it doesn't, open it here, or download it first and come back to this page."
            : "Uplink Room opens where the email pointed. If it doesn't, open it here, or download it first."}
        </p>
      )}
      <div className="actions">
        {read.state === "ready" ? (
          <a className="button" href={read.appLink}>
            Open Uplink Room
          </a>
        ) : (
          <span className="button" aria-disabled="true">
            Open Uplink Room
          </span>
        )}
        <Link className="button quiet" href="/download">
          Download Uplink Room
        </Link>
      </div>
      {token ? (
        <section className="handoff-token" aria-labelledby="paste-token">
          <h2 id="paste-token">Or paste the invite token</h2>
          <p>
            In Uplink Room, choose <b>Create or join a team</b> from the team menu, or wait for the
            first screen after you sign in, and paste it under <b>Join with an invite token</b>.
          </p>
          <div className="token-row">
            <code className="token-box">{token}</code>
            <button
              className="button quiet"
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(token);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? "Copied" : "Copy the token"}
            </button>
          </div>
          <p className="handoff-note">
            The token works once. It stays on this page: it's the part of the address after the #,
            which browsers never send to uplinkroom.com.
          </p>
        </section>
      ) : null}
    </div>
  );
}
