import { readFileSync } from "node:fs";
import { cp, readFile } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/bundler-plugins/vite";
import { defineConfig } from "electron-vite";
import { loadEnv } from "vite";

const version = (path: string) =>
  (JSON.parse(readFileSync(resolve(path), "utf8")) as { version: string }).version;
/** Sentry release names, matching what each process reports (src/main/telemetry.ts, packages/bridge/src/telemetry/sentry.ts). */
const DESKTOP_RELEASE = `uplink-room-desktop@${version("package.json")}`;
const BRIDGE_RELEASE = `uplink-room-bridge@${version("../../packages/bridge/package.json")}`;

/**
 * Release builds (`--mode release`) report errors to Sentry, so they also get hidden source maps
 * (the bundles name no `.map`, and electron-builder.yml leaves the maps out of the app) with a
 * Sentry debug id in each bundle. With `SENTRY_AUTH_TOKEN` set (the Package workflow), the bundles
 * and maps are uploaded; without it nothing is uploaded and the build is otherwise the same.
 * The main bundle holds the app's copy of the bridge, which reports to the bridge's project, so
 * its maps go to both projects.
 */
function sentry(release: boolean, project: string | string[]): Plugin[] {
  if (!release) return [];
  const authToken = process.env["SENTRY_AUTH_TOKEN"];
  // The plugin returns its own Vite plugin type, which electron-vite's Vite types don't match exactly.
  return sentryVitePlugin({
    org: "nuko-nova-dynamics-llc",
    project,
    authToken,
    telemetry: false,
    // A failed upload (Sentry down, a missing project) leaves traces unreadable but mustn't stop a release build.
    errorHandler: (error) => console.warn(`Sentry upload failed: ${error.message}`),
    release: { name: DESKTOP_RELEASE, create: Boolean(authToken), inject: false },
    sourcemaps: { disable: authToken ? false : "disable-upload" },
  }) as unknown as Plugin[];
}

/**
 * The room's site URL (where the Room API's HTTP actions live) for the deployment this build talks
 * to: `.convex.site` beside a `.convex.cloud`, or the local backend's 3211 beside its 3210. The
 * `uplink` and `uplink-mcp` the app carries use it when nothing else names a room (ADR 0042).
 */
export function siteUrlOf(convexUrl: string | undefined): string {
  if (!convexUrl) return "";
  try {
    const url = new URL(convexUrl);
    if (url.hostname.endsWith(".convex.cloud")) url.hostname = url.hostname.replace(/\.convex\.cloud$/, ".convex.site");
    else if (["127.0.0.1", "localhost"].includes(url.hostname) && url.port === "3210") url.port = "3211";
    else return "";
    return url.origin;
  } catch {
    return "";
  }
}

/**
 * Main and preload bundle their dependencies, so the packaged app ships no
 * node_modules except node-pty, which the bridge needs as a native module.
 * `package.json` lists only node-pty under `dependencies` for that reason;
 * everything else is a build-time devDependency.
 */
export default defineConfig(({ mode }) => {
  const release = mode === "release";
  const sourcemap = release ? ("hidden" as const) : false;
  // The deployment the app talks to: .env.release for a release build, .env.local otherwise.
  const roomUrl = siteUrlOf(loadEnv(mode, resolve("."), "VITE_")["VITE_CONVEX_URL"]);
  return {
    main: {
      define: {
        // The room `uplink login` and `uplink-mcp` use by default (packages/room-client/src/config.ts).
        __UPLINK_ROOM_URL__: JSON.stringify(roomUrl),
        // Release builds turn on error reports in the main process and in the app's bridge.
        ...(release
          ? {
              __UPLINK_DESKTOP_RELEASE__: JSON.stringify(DESKTOP_RELEASE),
              __UPLINK_BRIDGE_RELEASE__: JSON.stringify(BRIDGE_RELEASE),
            }
          : {}),
      },
      plugins: sentry(release, ["uplink-room-desktop", "uplink-room-bridge"]),
      build: {
        sourcemap,
        externalizeDeps: false,
        rollupOptions: {
          input: {
            index: resolve("src/main/index.ts"),
            // The bridge that ships inside the app (src/main/bridge.ts runs it).
            bridge: resolve("../../packages/bridge/src/bin.ts"),
            // The Room API's command-line tool and MCP server, which resources/bin/uplink and
            // uplink-mcp run (ADR 0042).
            uplink: resolve("../../packages/room-client/src/cli.ts"),
            "uplink-mcp": resolve("../../packages/room-client/src/mcp.ts"),
          },
          external: ["node-pty"],
        },
      },
    },
    preload: {
      plugins: sentry(release, "uplink-room-desktop"),
      build: {
        sourcemap,
        // A sandboxed preload can't load other files, so Clerk's preload is bundled in.
        externalizeDeps: false,
        rollupOptions: {
          input: { index: resolve("src/preload/index.ts") },
          // A sandboxed preload script must be CommonJS.
          output: { format: "cjs", entryFileNames: "[name].cjs" },
        },
      },
    },
    renderer: {
      root: resolve("src/renderer"),
      // `.env.local` sits next to package.json, not in the renderer root.
      envDir: resolve("."),
      // Clerk accepts only allowlisted origins, and http://localhost:5173 is one.
      server: { port: 5173, strictPort: true },
      plugins: [react(), excalidrawFonts(), ...sentry(release, "uplink-room-desktop")],
      build: {
        sourcemap,
        rollupOptions: {
          input: {
            index: resolve("src/renderer/index.html"),
            harness: resolve("src/renderer/harness.html"),
            // Served only at uplink-frame://browser/ (src/main/browserFrame.ts).
            "browser-frame": resolve("src/renderer/browser-frame.html"),
            // Shared-browser screens with sample data, for review screenshots (scripts/browser-shots.ts).
            "browser-harness": resolve("src/renderer/browser-harness.html"),
            // Cloud machine settings with sample data, for review screenshots (scripts/cloud-shots.ts).
            "cloud-harness": resolve("src/renderer/cloud-harness.html"),
            // The update prompt and Settings, Updates with sample data, for review screenshots (scripts/update-shots.ts).
            "update-harness": resolve("src/renderer/update-harness.html"),
            // The Space view with sample data, for screenshots and e2e/space.spec.ts.
            "space-harness": resolve("src/renderer/space-harness.html"),
            "space-sample": resolve("src/renderer/space-sample.html"),
            // The UI gym: every screen and state with sample data, for scripts/gym.ts. Never in a
            // release build (main/startPath.ts also refuses it outside a temp profile).
            ...(release ? {} : { gym: resolve("src/renderer/gym.html") }),
            // The PDF viewer frame, served from the frame origin (src/main/frame.ts).
            "pdf-frame": resolve("src/renderer/pdf-frame.html"),
          },
        },
      },
    },
  };
});

/**
 * Excalidraw's hand-drawn fonts, served by the app at `/excalidraw/fonts/` instead of
 * from its CDN (the app's CSP allows fonts only from itself and Google Fonts). Xiaolai,
 * the 12 MB Chinese, Japanese and Korean face, is left out; that text falls back to a
 * system font.
 */
function excalidrawFonts(): Plugin {
  const fonts = resolve("node_modules/@excalidraw/excalidraw/dist/prod/fonts");
  const skip = (path: string) => !path.includes(`${sep}Xiaolai`);
  let outDir = "";
  return {
    name: "uplink-excalidraw-fonts",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use("/excalidraw/fonts/", async (req, res, next) => {
        const file = normalize(
          join(fonts, decodeURIComponent((req.url ?? "").split("?")[0] ?? "")),
        );
        if (!file.startsWith(fonts + sep) || !skip(file)) return next();
        try {
          const body = await readFile(file);
          res.setHeader("content-type", "font/woff2");
          res.end(body);
        } catch {
          next();
        }
      });
    },
    async writeBundle() {
      await cp(fonts, join(outDir, "excalidraw", "fonts"), { recursive: true, filter: skip });
    },
  };
}
