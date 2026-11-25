import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import {
  PLATFORMS,
  channelFrom,
  downloadsFor,
  fetchFeed,
  formatSize,
  type Channel,
  type Feed,
  type Platform,
} from "../../lib/feed";
import { PLATFORM_NAMES, platformOf } from "../../lib/platform";

export const metadata: Metadata = {
  title: "Download",
  description: "Download Uplink Room for macOS (Apple silicon), Windows and Linux.",
};

/**
 * The latest version for each platform, read from the update feed (`latest-mac.yml`, `latest.yml`,
 * `latest-linux.yml`) when the page is requested; each feed is cached for five minutes. The
 * visitor's platform, from the request's user agent, comes first. `?channel=test` lists the test
 * channel's builds instead (docs/releases.md).
 */
export default async function DownloadPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const channel = channelFrom((await searchParams)["channel"]);
  const request = await headers();
  const visitor = platformOf(
    request.get("user-agent") ?? "",
    request.get("sec-ch-ua-platform")?.replaceAll('"', ""),
  );
  const order = visitor ? [visitor, ...PLATFORMS.filter((p) => p !== visitor)] : [...PLATFORMS];
  const feeds = new Map(
    await Promise.all(PLATFORMS.map(async (p) => [p, await fetchFeed(p, channel)] as const)),
  );
  const published = order.filter((p) => feeds.get(p));

  return (
    <>
      <div className="download-head">
        <h1>{channel === "test" ? "Test builds" : "Download Uplink Room"}</h1>
        <p>
          {channel === "test"
            ? "Builds for checking a release before it ships. A test build keeps its data apart from the released app and updates only to newer test builds."
            : "The desktop app for macOS, Windows and Linux. Once it's installed, it keeps itself up to date."}
        </p>
      </div>

      {published.length === 0 ? (
        <div className="empty">
          <h2>{channel === "test" ? "No test build right now" : "No release is published yet"}</h2>
          <p>
            {channel === "test"
              ? "The test channel is empty. A test build shows up here once it's published."
              : "The first public version isn't out yet. Installers for each platform show up here as soon as it is."}
          </p>
        </div>
      ) : (
        <div className="platforms">
          {order.map((platform) => (
            <PlatformBlock
              key={platform}
              platform={platform}
              feed={feeds.get(platform) ?? null}
              channel={channel}
              yours={platform === visitor}
            />
          ))}
        </div>
      )}
    </>
  );
}

function PlatformBlock({
  platform,
  feed,
  channel,
  yours,
}: {
  platform: Platform;
  feed: Feed | null;
  channel: Channel;
  yours: boolean;
}) {
  const downloads = feed ? downloadsFor(platform, feed, channel) : [];
  return (
    <section className="platform" aria-labelledby={`p-${platform}`}>
      <div>
        <h2 id={`p-${platform}`}>{PLATFORM_NAMES[platform]}</h2>
        {feed ? <p className="platform-meta">{released(feed)}</p> : null}
        {yours ? <p className="yours">This computer</p> : null}
      </div>
      <div>
        {downloads.length > 0 ? (
          <ul className="files">
            {downloads.map((d) => (
              <li className="file" key={d.file}>
                <div className="file-name">
                  <b>{d.label}</b>
                  <span>
                    <span className="mono">{d.file}</span>
                    {d.size ? `, ${formatSize(d.size)}` : ""}
                  </span>
                </div>
                <a className="button" href={d.href} download>
                  Download
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="platform-meta">Not published for {PLATFORM_NAMES[platform]} yet.</p>
        )}
        <ul className="notes">{NOTES[platform]}</ul>
      </div>
    </section>
  );
}

function released(feed: Feed): string {
  if (!feed.releaseDate) return `Version ${feed.version}`;
  const date = new Date(feed.releaseDate);
  if (Number.isNaN(date.getTime())) return `Version ${feed.version}`;
  const day = date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  return `Version ${feed.version}, released ${day}`;
}

const NOTES: Record<Platform, ReactNode> = {
  mac: (
    <>
      <li>Open the dmg and drag Uplink Room to Applications.</li>
      <li>
        Not sure which Mac you have? In the Apple menu, About This Mac lists a Chip on Apple silicon
        and a Processor on Intel.
      </li>
    </>
  ),
  windows: (
    <>
      <li>
        Run the installer. It installs for you alone, in{" "}
        <code>%LOCALAPPDATA%\Programs\Uplink Room</code>.
      </li>
      <li>
        The installer isn't code-signed yet, so SmartScreen asks first: choose More info, then Run
        anyway.
      </li>
    </>
  ),
  linux: (
    <>
      <li>
        AppImage: make it executable with <code>chmod +x</code> and run it. It needs FUSE 2 (
        <code>sudo apt install libfuse2t64</code> on Ubuntu 24.04), and it keeps itself up to date.
      </li>
      <li>
        .deb: install it with <code>sudo apt install ./</code> and the file name. A .deb install
        doesn't update itself, so get new versions here.
      </li>
    </>
  ),
};
