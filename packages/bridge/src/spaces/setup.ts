import { homedir } from "node:os";
import { join } from "node:path";
import { resolveExecutable } from "../platform.ts";
import { SpaceGateway, defaultGatewayHosts } from "./gateway.ts";
import { CuaCliHost } from "./host.ts";

/** The gateway's port unless `UPLINK_SPACE_GATEWAY_PORT` says otherwise (taken: the system picks one). */
const DEFAULT_GATEWAY_PORT = 3219;

/**
 * Spaces for `uplink-bridge run`, when Cua's CLI is on this machine: `UPLINK_CUA`, else `cua` on
 * PATH, else `~/.local/bin/cua` (where Cua's installer puts it, which an app's PATH often lacks).
 * The gateway listens on `UPLINK_SPACE_GATEWAY_HOSTS` (comma-separated) or, by default, loopback
 * and the machine's Tailscale addresses.
 */
export function spacesOption(env: NodeJS.ProcessEnv = process.env) {
  const executable =
    env.UPLINK_CUA ??
    resolveExecutable("cua", env) ??
    resolveExecutable(join(homedir(), ".local", "bin", process.platform === "win32" ? "cua.exe" : "cua"), env);
  if (!executable) return undefined;
  const hosts = env.UPLINK_SPACE_GATEWAY_HOSTS?.split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const port = Number(env.UPLINK_SPACE_GATEWAY_PORT);
  return {
    host: new CuaCliHost({ executable, env }),
    gateway: new SpaceGateway({
      hosts: hosts?.length ? hosts : defaultGatewayHosts(),
      port: Number.isInteger(port) && port >= 0 && port < 65536 && env.UPLINK_SPACE_GATEWAY_PORT ? port : DEFAULT_GATEWAY_PORT,
    }),
    onError: (error: unknown) => console.warn(`Spaces: ${(error as Error).message ?? error}`),
  };
}
