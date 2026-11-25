/**
 * What `uplink login` saves, in `$UPLINK_HOME/cli.json` (default `~/.uplink-room/cli.json`), mode
 * 0600: the Room API address and one credential, an agent key or a person's CLI sign-in (ADR
 * 0030). The command-line tool and `uplink-mcp` both read it; UPLINK_URL and UPLINK_AGENT_KEY
 * override it.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Env = Record<string, string | undefined>;

declare const __UPLINK_ROOM_URL__: string | undefined;

/**
 * The room the desktop app talks to, built into the copy of this tool the app carries
 * (apps/desktop/electron.vite.config.ts defines it: the production deployment's site URL in a
 * release build, the development one otherwise). Run from source, there is none.
 */
export const BUILT_IN_URL: string | undefined = typeof __UPLINK_ROOM_URL__ === "string" && __UPLINK_ROOM_URL__ ? __UPLINK_ROOM_URL__ : undefined;

/** How to sign in, as error messages say it: the app's copy knows its room, so it needs no --url. */
export const LOGIN_COMMAND = BUILT_IN_URL ? "uplink login" : "uplink login --url <site url>";

/** A mistake in how the tool was used or configured, as opposed to an API error. */
export class CliError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

export function configPath(env: Env): string {
  return join(env.UPLINK_HOME || join(homedir(), ".uplink-room"), "cli.json");
}

/**
 * A CLI sign-in this computer replaced or signed out of while the room couldn't be reached to
 * revoke it. Its token is kept (as privately as the current one) until `uplink logout --pending`
 * revokes it: revoking by signInId would need a sign-in for the same person, which a saved agent
 * key or someone else's sign-in isn't.
 */
export type UnrevokedSignIn = { url: string; signIn: string };

/**
 * `key` is an agent key; `signIn` is a person's CLI sign-in token (`urs_…`). At most one is saved.
 * `unrevoked` lists sign-ins still waiting to be revoked.
 */
export type SavedConfig = { url?: string; key?: string; signIn?: string; unrevoked?: UnrevokedSignIn[] };

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export async function readSavedConfig(env: Env): Promise<SavedConfig> {
  const path = configPath(env);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new CliError("config", `Could not read ${path}: ${(error as Error).message}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new CliError("config", `${path} is not valid JSON. Run \`uplink login\` again.`);
  }
  const config: SavedConfig = {};
  const url = nonEmpty(parsed.url);
  const key = nonEmpty(parsed.key);
  const signIn = nonEmpty(parsed.signIn);
  if (url) config.url = url;
  if (key) config.key = key;
  if (signIn) config.signIn = signIn;
  const unrevoked = (Array.isArray(parsed.unrevoked) ? (parsed.unrevoked as Record<string, unknown>[]) : []).flatMap((entry) => {
    const entryUrl = nonEmpty(entry?.url);
    const entrySignIn = nonEmpty(entry?.signIn);
    return entryUrl && entrySignIn ? [{ url: entryUrl, signIn: entrySignIn }] : [];
  });
  if (unrevoked.length) config.unrevoked = unrevoked;
  return config;
}

export async function saveConfig(env: Env, config: SavedConfig): Promise<string> {
  const path = configPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const fields = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0)),
  );
  await writeFile(path, `${JSON.stringify(fields, null, 2)}\n`, { mode: 0o600 });
  // `mode` only applies when the file is created. Windows has no Unix modes
  // and Node has no ACL API, so there the file is private only because the
  // default folder is inside the person's profile, which admits only them,
  // SYSTEM and administrators. An UPLINK_HOME elsewhere must be just as private.
  await chmod(path, 0o600);
  return path;
}

/** Whether two addresses are the same deployment: the same scheme, host and port. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * The address and credential to call the Room API with: the environment's, else what was saved.
 * A saved credential belongs to the address it was saved with, so when UPLINK_URL names another
 * deployment and UPLINK_AGENT_KEY isn't set, this refuses rather than send it there.
 */
export async function roomCredentials(env: Env): Promise<{ url?: string; key?: string }> {
  const saved = await readSavedConfig(env);
  const url = env.UPLINK_URL || saved.url || BUILT_IN_URL;
  if (env.UPLINK_AGENT_KEY) return { url, key: env.UPLINK_AGENT_KEY };
  const key = saved.signIn || saved.key;
  if (key && url && !(saved.url && sameOrigin(saved.url, url))) {
    const what = saved.signIn ? "sign-in" : "agent key";
    throw new CliError(
      "wrong_deployment",
      `The ${what} in ${configPath(env)} was saved for ${saved.url ?? "an unknown address"}, not ${url} (UPLINK_URL), so it isn't sent there. ` +
        `Sign in to ${url} with \`uplink login --url ${url}\` (it replaces the saved one), set UPLINK_AGENT_KEY to a key for it, or unset UPLINK_URL.`,
    );
  }
  return { url, ...(key ? { key } : {}) };
}
