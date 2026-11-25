import { parse } from "yaml";

/**
 * The update feed (docs/releases.md). Installed apps and the download page read it at
 * `https://uplinkroom.com/updates/<channel>/<file>`, which next.config.ts rewrites to this public
 * Vercel Blob store (`uplink-room-updates`, team Miami Web AI). Moving the files elsewhere means
 * changing this address only; installed apps keep the uplinkroom.com one.
 */
export const UPDATES_ORIGIN = "https://4slsl7bmrg2qn9i3.public.blob.vercel-storage.com";

export const CHANNELS = ["latest", "test"] as const;
export type Channel = (typeof CHANNELS)[number];

export function channelFrom(value: unknown): Channel {
  return value === "test" ? "test" : "latest";
}

/** The feed files electron-builder writes for each platform, named after the channel. */
export const FEED_FILES = {
  mac: (channel: Channel) => `${channel}-mac.yml`,
  windows: (channel: Channel) => `${channel}.yml`,
  linux: (channel: Channel) => `${channel}-linux.yml`,
} as const;
export type Platform = keyof typeof FEED_FILES;
export const PLATFORMS: readonly Platform[] = ["mac", "windows", "linux"];

export type Feed = {
  version: string;
  releaseDate?: string;
  files: { url: string; size?: number }[];
};

/** Reads one feed file (`latest-mac.yml` and the rest), or null when it isn't one. */
export function parseFeed(text: string): Feed | null {
  let data: unknown;
  try {
    data = parse(text);
  } catch {
    return null;
  }
  const d = data as { version?: unknown; releaseDate?: unknown; files?: unknown } | null;
  if (!d || typeof d.version !== "string" || !Array.isArray(d.files)) return null;
  const files = d.files.flatMap((f: unknown) => {
    const file = f as { url?: unknown; size?: unknown } | null;
    if (!file || typeof file.url !== "string" || !/^[\w.-]+$/.test(file.url)) return [];
    return [{ url: file.url, ...(typeof file.size === "number" ? { size: file.size } : {}) }];
  });
  return {
    version: d.version,
    ...(typeof d.releaseDate === "string" ? { releaseDate: d.releaseDate } : {}),
    files,
  };
}

/** One installer on the download page. */
export type Download = { label: string; file: string; href: string; size?: number };

/**
 * The installers worth offering from a platform's feed, in the order shown. The zip and blockmap
 * files are for updates, not first installs.
 */
export function downloadsFor(platform: Platform, feed: Feed, channel: Channel): Download[] {
  const pick = (test: (name: string) => boolean, label: string): Download[] =>
    feed.files
      .filter((f) => test(f.url))
      .map((f) => ({
        label,
        file: f.url,
        href: `/updates/${channel}/${encodeURIComponent(f.url)}`,
        ...(f.size !== undefined ? { size: f.size } : {}),
      }));
  switch (platform) {
    case "mac":
      return [
        ...pick((n) => n.endsWith(".dmg") && n.includes("arm64"), "Apple silicon"),
        ...pick((n) => n.endsWith(".dmg") && !n.includes("arm64"), "Intel"),
      ];
    case "windows":
      return [
        ...pick((n) => n.endsWith(".exe") && n.includes("x64"), "x64"),
        ...pick((n) => n.endsWith(".exe") && n.includes("arm64"), "Arm"),
      ];
    case "linux":
      return [
        ...pick((n) => n.endsWith(".AppImage"), "AppImage, x64"),
        ...pick((n) => n.endsWith(".deb"), "Debian and Ubuntu (.deb), x64"),
      ];
  }
}

/** Fetches a platform's feed from the store, cached for five minutes. Null when nothing is published. */
export async function fetchFeed(platform: Platform, channel: Channel): Promise<Feed | null> {
  try {
    const response = await fetch(
      `${UPDATES_ORIGIN}/updates/${channel}/${FEED_FILES[platform](channel)}`,
      {
        next: { revalidate: 300 },
      },
    );
    if (!response.ok) return null;
    return parseFeed(await response.text());
  } catch {
    return null;
  }
}

export function formatSize(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
