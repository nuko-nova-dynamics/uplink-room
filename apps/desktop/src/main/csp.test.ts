import { expect, test } from "vitest";
import { appCsp } from "./csp";

/** The policy's directives, by name. */
const directives = (csp: string) => new Map(csp.split("; ").map((d) => [d.split(" ")[0]!, d.split(" ").slice(1)] as const));

test("Krisp's WebAssembly may compile, and nothing else is let through by it", () => {
  // UPLINK-ROOM-DESKTOP-3: without 'wasm-unsafe-eval', Krisp's blob script threw `CompileError:
  // WebAssembly.Module(): ... 'unsafe-eval' is not an allowed source of script`, Krisp never
  // turned on, and its enable step never settled.
  const script = directives(appCsp("clerk.uplinkroom.com")).get("script-src")!;
  expect(script).toContain("'wasm-unsafe-eval'");
  expect(script).toContain("blob:");
  // WebAssembly only: JavaScript eval stays refused.
  expect(script).not.toContain("'unsafe-eval'");
});

test("Krisp's model service and LiveKit Cloud are reachable", () => {
  const connect = directives(appCsp(undefined)).get("connect-src")!;
  expect(connect).toContain("https://integrations.livekit.io");
  expect(connect).toContain("wss://*.livekit.cloud");
  expect(directives(appCsp(undefined)).get("worker-src")).toEqual(["'self'", "blob:"]);
});

test("a file link from the room's site, such as a Pair's or a direct message's PDF, can be fetched", () => {
  // The PDF viewer fetches the bytes; grant links are on the deployment's site (*.convex.site).
  expect(directives(appCsp(undefined)).get("connect-src")).toContain("https://*.convex.site");
});
