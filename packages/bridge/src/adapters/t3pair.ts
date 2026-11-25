import { homedir } from "node:os";
import { join } from "node:path";
import { resolveExecutable } from "../platform.ts";
import { jsonCommand } from "./process.ts";
import { T3_SCOPES, exchangePairingToken } from "./t3client.ts";

/** T3 Code's local server, where `t3-pair` and the bridge's own pairing look by default. */
export const T3_DEFAULT_URL = "http://127.0.0.1:3773";

/**
 * The `t3` CLI on this machine: `UPLINK_T3`, then PATH, then where T3 Code installs it
 * (`~/.t3/bin`). The app's bridge has a GUI app's short PATH, which seldom holds `~/.t3/bin`.
 */
export function t3Executable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.UPLINK_T3) return resolveExecutable(env.UPLINK_T3, env);
  return resolveExecutable("t3", env) ?? resolveExecutable(join(homedir(), ".t3", "bin", "t3"), env);
}

/**
 * Pairs with the T3 Code server at `url`: a one-time token with only the bridge's scopes, minted
 * with the local `t3` CLI unless `token` is given (it lasts five minutes), exchanged for a bearer
 * session. T3 Code runs on the bridge's own machine, so the bridge can do this itself.
 */
export async function pairWithT3(
  options: { url?: string; token?: string; baseDir?: string; executable?: string } = {},
) {
  const url = options.url ?? T3_DEFAULT_URL;
  let token = options.token;
  if (!token) {
    // A token from the local t3 CLI is this machine's T3 Code's, so it goes only to this machine:
    // never to a T3 server elsewhere that a `t3-pair --url … --token …` pointed the bridge at.
    if (!isLoopback(url))
      throw new Error(`Only a T3 Code server on this machine can be paired by itself, not ${new URL(url).host}. Run uplink-bridge t3-pair --url <url> --token <token>.`);
    const executable = options.executable ?? t3Executable();
    if (!executable) throw new Error("T3 Code's t3 CLI isn't installed on this machine.");
    const issued = (await jsonCommand(executable, [
      "auth",
      "pairing",
      "create",
      ...T3_SCOPES.flatMap((scope) => ["--scope", scope]),
      "--ttl",
      "5m",
      "--label",
      "Uplink Room bridge",
      "--json",
      ...(options.baseDir ? ["--base-dir", options.baseDir] : []),
    ])) as { credential?: string };
    token = issued.credential;
    if (!token) throw new Error("t3 auth pairing create printed no credential.");
  }
  return exchangePairingToken(url, token);
}

/** Whether `url` names this machine (127.0.0.0/8, ::1 or localhost). */
export function isLoopback(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return host === "localhost" || host === "[::1]" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}
