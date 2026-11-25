import { readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { sentryRollupPlugin } from "@sentry/bundler-plugins/rollup";
import { build } from "rolldown";

/**
 * Bundles the bridge into one file, `dist/uplink-bridge.mjs`, for installs
 * outside this repo (an npm tarball, or inside the desktop app). Everything is
 * inlined except node-pty, whose native binary must stay a real package.
 *
 * The bundle is a release build: it sets `__UPLINK_BRIDGE_RELEASE__`, which turns
 * on error reports (src/telemetry/sentry.ts). Its source map is hidden (the bundle
 * names no `.map`) and carries a Sentry debug id. With `SENTRY_AUTH_TOKEN` set (the
 * Package workflow), the bundle and its map go to the `uplink-room-bridge` project;
 * without it nothing is uploaded and the build is otherwise the same.
 */
const root = join(import.meta.dirname, "..");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  version: string;
};
const release = `uplink-room-bridge@${version}`;
const authToken = process.env["SENTRY_AUTH_TOKEN"];

await rm(join(root, "dist"), { recursive: true, force: true });
await build({
  input: join(root, "src/bin.ts"),
  platform: "node",
  external: ["node-pty", ...builtinModules, /^node:/],
  transform: { define: { __UPLINK_BRIDGE_RELEASE__: JSON.stringify(release) } },
  plugins: [
    sentryRollupPlugin({
      org: "nuko-nova-dynamics-llc",
      project: "uplink-room-bridge",
      authToken,
      telemetry: false,
      // A failed upload (Sentry down, a missing project) leaves traces unreadable but mustn't stop a release build.
      errorHandler: (error) => console.warn(`Sentry upload failed: ${error.message}`),
      release: { name: release, create: Boolean(authToken), inject: false },
      sourcemaps: { disable: authToken ? false : "disable-upload" },
    }),
  ],
  output: {
    file: join(root, "dist/uplink-bridge.mjs"),
    format: "esm",
    sourcemap: "hidden",
  },
});
console.log(`Built dist/uplink-bridge.mjs (${release})`);
