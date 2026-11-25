import type { NextConfig } from "next";
import { UPDATES_ORIGIN } from "./lib/feed";

const config: NextConfig = {
  // The repo type-checks every package with tsc-rs (`pnpm typecheck`), so the build doesn't again.
  typescript: { ignoreBuildErrors: true },
  poweredByHeader: false,
  /**
   * The update feed: installed apps read `https://uplinkroom.com/updates/<channel>/<file>` (the
   * desktop app's electron-builder.yml `publish` URL), and the download page links to the same
   * addresses. Only the two channels pass; anything else is a 404 here.
   *
   * vercel.json turns off Vercel's caching of these external rewrites
   * (`x-vercel-enable-rewrite-caching: 0`). With it on, the CDN stored a differential download's
   * 206 byte-range response under the plain URL and served those few KB to every later full
   * download for the month Blob's Cache-Control allows. Blob's own CDN still caches the files and
   * answers ranges correctly.
   */
  async rewrites() {
    return [
      {
        source: "/updates/:channel(latest|test)/:file",
        destination: `${UPDATES_ORIGIN}/updates/:channel/:file`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default config;
