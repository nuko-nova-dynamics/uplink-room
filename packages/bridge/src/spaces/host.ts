/**
 * The bridge's Space adapter: what it needs from Cua on its machine (spec #6, ADR 0009).
 *
 * `SpaceHost` is the seam. `CuaCliHost` drives Cua through its MIT `cua` CLI, checked against
 * `cua` 0.10.0 and a live local Linux Space on 2026-11-02:
 *  - `cua spaces ls --json --no-size` lists the registered Spaces (`{"spaces": [...]}`).
 *  - `cua sb info <id> --json` gives a local Space's `cua-spacesd` address (`endpoints.env`).
 *  - `cua sb ls --local --json --no-size` gives each local Space's `state` (running, stopped,
 *    suspended); `spaces ls` leaves a stopped local container's power state empty.
 *  - Cua's own credential store, `$CUA_HOME/spaces-credentials.json` (0600, this user's), holds
 *    each Space's token, and the URL of a Space added by address.
 *  - `cua spacesd call <url> <Service/Method> <proto3 JSON>` calls `cua-spacesd`, with the token
 *    in `CUA_ENV_TOKEN`, never in the arguments, where other processes could read it.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SpaceAction, SpacePower, SpaceScreenshot } from "@uplink-room/protocol";
import { spawnExecutable } from "../platform.ts";

export interface SpaceInfo {
  /** Cua's id: `local:<name>` or `direct:<host:port>`. */
  spaceRef: string;
  name: string;
  os?: string;
  kind?: string;
  /** Cua's `power_state`: empty while running, else "stopped" or "suspended". */
  state: SpacePower;
}

/** How to reach a Space's `cua-spacesd`: its base URL and its env token, which grants full control. */
export interface SpaceEndpoint {
  url: string;
  token: string;
}

export interface ViewerTicket {
  ticket: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  /** `/viewer/`, relative to the `cua-spacesd` base URL. */
  viewerPath: string;
}

export interface Principal {
  id: string;
  name: string;
  kind: "human" | "agent";
}

export interface SpaceHost {
  /** The Spaces on this machine the bridge may share. */
  list(): Promise<SpaceInfo[]>;
  connect(spaceRef: string): Promise<SpaceEndpoint>;
  /** A Cua viewer ticket: view-only unless `interactive`. */
  viewerTicket(
    endpoint: SpaceEndpoint,
    options: { interactive: boolean; principal: Principal; ttlSeconds: number },
  ): Promise<ViewerTicket>;
  /** Runs a Space action with the Space's own token. */
  act(endpoint: SpaceEndpoint, action: SpaceAction): Promise<{ screenshot?: SpaceScreenshot }>;
}

/** Why a Space couldn't be shared or used: `unknown_space`, `unreachable`, `invalid_action` or `cua_failed`. */
export class SpaceError extends Error {
  reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** Screenshots are at most this long as base64, so a result fits one room message and row. */
const SCREENSHOT_MAX_BASE64 = 700_000;
const CALL_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT = 8 * 1024 * 1024;

const NAMED_KEYS: Record<string, string> = {
  enter: "KEY_ENTER",
  return: "KEY_ENTER",
  tab: "KEY_TAB",
  space: "KEY_SPACE",
  backspace: "KEY_BACKSPACE",
  delete: "KEY_DELETE",
  escape: "KEY_ESCAPE",
  esc: "KEY_ESCAPE",
  home: "KEY_HOME",
  end: "KEY_END",
  pageup: "KEY_PAGE_UP",
  pagedown: "KEY_PAGE_DOWN",
  up: "KEY_ARROW_UP",
  down: "KEY_ARROW_DOWN",
  left: "KEY_ARROW_LEFT",
  right: "KEY_ARROW_RIGHT",
  shift: "KEY_SHIFT",
  ctrl: "KEY_CONTROL",
  control: "KEY_CONTROL",
  alt: "KEY_ALT",
  option: "KEY_ALT",
  meta: "KEY_META",
  cmd: "KEY_META",
  command: "KEY_META",
  super: "KEY_META",
  win: "KEY_META",
};
const MODIFIERS = new Set(["KEY_SHIFT", "KEY_CONTROL", "KEY_ALT", "KEY_META"]);
const BUTTONS = { left: "MOUSE_BUTTON_LEFT", right: "MOUSE_BUTTON_RIGHT", middle: "MOUSE_BUTTON_MIDDLE" } as const;

function keyInput(key: string): { named: string } | { character: string } {
  const named = NAMED_KEYS[key.toLowerCase()];
  if (named) return { named };
  if ([...key].length === 1) return { character: key };
  throw new SpaceError("invalid_action", `Unknown key ${key}.`);
}

function target(screenshotId: string | undefined) {
  return screenshotId
    ? { space: "COORDINATE_SPACE_SCREENSHOT", screenshotId }
    : { space: "COORDINATE_SPACE_SCREEN" };
}

/** The `cua.env.v1` call for a Space action that isn't a screenshot. */
export function actionCall(action: Exclude<SpaceAction, { kind: "screenshot" }>): [string, unknown] {
  switch (action.kind) {
    case "click":
      return [
        "ComputerService/Pointer",
        {
          target: target(action.screenshotId),
          click: {
            position: { x: action.x, y: action.y },
            button: BUTTONS[action.button ?? "left"],
            ...(action.count ? { count: action.count } : {}),
          },
        },
      ];
    case "move":
      return ["ComputerService/Pointer", { target: target(action.screenshotId), move: { position: { x: action.x, y: action.y } } }];
    case "scroll":
      return [
        "ComputerService/Pointer",
        {
          target: target(action.screenshotId),
          scroll: {
            ...(action.x !== undefined && action.y !== undefined ? { position: { x: action.x, y: action.y } } : {}),
            deltaX: action.dx,
            deltaY: action.dy,
            unit: "SCROLL_UNIT_LINE",
          },
        },
      ];
    case "type":
      return ["ComputerService/Keyboard", { type: { text: action.text } }];
    case "key": {
      const keys = action.keys.map(keyInput);
      if (keys.length === 1) return ["ComputerService/Keyboard", { press: { key: keys[0] } }];
      // Modifiers held around one key is a press; anything else is a chord in press order.
      const last = keys.at(-1)!;
      const held = keys.slice(0, -1);
      if (held.every((k) => "named" in k && MODIFIERS.has(k.named)))
        return ["ComputerService/Keyboard", { press: { key: last, modifiers: held.map((k) => (k as { named: string }).named) } }];
      return ["ComputerService/Keyboard", { hotkey: { keys } }];
    }
  }
}

/** Cua records "running", "suspended" or "stopped", and empty when it doesn't know (a running Space it added by address). */
export function powerOf(recorded: string | undefined): SpacePower {
  return recorded === "stopped" || recorded === "suspended" ? recorded : "running";
}

export class CuaCliHost implements SpaceHost {
  private executable: string;
  private env: NodeJS.ProcessEnv;
  constructor(options: { executable?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.executable = options.executable ?? "cua";
    this.env = { ...process.env, ...options.env, DO_NOT_TRACK: "1", CUA_TELEMETRY: "0" };
  }
  private home() {
    return this.env.CUA_HOME || join(homedir(), ".cua");
  }
  /** Runs `cua` and parses its JSON output. `token` goes in `CUA_ENV_TOKEN`. */
  private run(args: string[], token?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const env = { ...this.env };
      delete env.CUA_ENV_TOKEN;
      if (token) env.CUA_ENV_TOKEN = token;
      const child = spawnExecutable(this.executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      const out: Buffer[] = [];
      let size = 0;
      let err = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new SpaceError("cua_failed", "cua took too long to answer."));
      }, CALL_TIMEOUT_MS);
      child.stdout!.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > OUTPUT_LIMIT) child.kill();
        else out.push(chunk);
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        if (err.length < 4000) err += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new SpaceError("cua_failed", `cua could not run: ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new SpaceError("cua_failed", err.trim().split("\n").at(-1) || `cua exited with ${code}`));
        try {
          resolve(JSON.parse(Buffer.concat(out).toString("utf8")));
        } catch {
          reject(new SpaceError("cua_failed", "cua printed something that isn't JSON."));
        }
      });
    });
  }
  async list(): Promise<SpaceInfo[]> {
    const listed = (await this.run(["spaces", "ls", "--json", "--no-size"])) as {
      spaces?: {
        id?: string;
        name?: string;
        display_name?: string;
        os?: string;
        kind?: string;
        power_state?: string;
        powerState?: string;
      }[];
    };
    const spaces = (listed.spaces ?? []).filter((s) => typeof s.id === "string" && /^(local|direct):/.test(s.id));
    // `spaces ls` leaves a stopped local container's power state empty (cua 0.10.0); its sandbox
    // listing has each local Space's `state`. If that call fails, the listing's own value is used.
    const local = spaces.some((s) => s.id!.startsWith("local:"))
      ? await this.localStates().catch(() => new Map<string, string>())
      : new Map<string, string>();
    return spaces.map((s) => ({
      spaceRef: s.id!,
      name: s.display_name || s.name || s.id!,
      ...(s.os ? { os: s.os } : {}),
      ...(s.kind ? { kind: s.kind } : {}),
      state: powerOf(s.power_state || s.powerState || local.get(s.id!)),
    }));
  }
  /** Each local sandbox's state, from `cua sb ls --local --json --no-size`. */
  private async localStates(): Promise<Map<string, string>> {
    const sandboxes = (await this.run(["sb", "ls", "--local", "--json", "--no-size"])) as { id?: unknown; state?: unknown }[];
    const states = new Map<string, string>();
    if (!Array.isArray(sandboxes)) return states;
    for (const s of sandboxes) if (typeof s.id === "string" && typeof s.state === "string") states.set(s.id, s.state);
    return states;
  }
  async connect(spaceRef: string): Promise<SpaceEndpoint> {
    let credentials: Record<string, { url?: string; token?: string }>;
    try {
      credentials = JSON.parse(await readFile(join(this.home(), "spaces-credentials.json"), "utf8"));
    } catch {
      throw new SpaceError("unreachable", "Cua keeps no credentials for Spaces on this machine.");
    }
    const credential = credentials[spaceRef];
    if (!credential?.token) throw new SpaceError("unreachable", `Cua keeps no token for ${spaceRef}.`);
    let url = credential.url;
    if (!url) {
      const info = (await this.run(["sb", "info", spaceRef, "--json"])) as { endpoints?: { env?: string } };
      url = info.endpoints?.env;
    }
    if (!url) throw new SpaceError("unreachable", `Cua has no address for ${spaceRef}.`);
    return { url: url.replace(/\/$/, ""), token: credential.token };
  }
  private call(endpoint: SpaceEndpoint, method: string, body: unknown) {
    return this.run(["spacesd", "call", endpoint.url, method, JSON.stringify(body)], endpoint.token);
  }
  async viewerTicket(
    endpoint: SpaceEndpoint,
    options: { interactive: boolean; principal: Principal; ttlSeconds: number },
  ): Promise<ViewerTicket> {
    const result = (await this.call(endpoint, "SystemService/CreateViewerTicket", {
      ttl: `${options.ttlSeconds}s`,
      policy: options.interactive ? "SESSION_POLICY_ALLOW_ACTIVATION" : "SESSION_POLICY_VIEW_ONLY",
      clipboard: options.interactive,
      principal: {
        id: options.principal.id,
        displayName: options.principal.name,
        kind: options.principal.kind === "agent" ? "PRINCIPAL_KIND_AGENT" : "PRINCIPAL_KIND_HUMAN",
      },
    })) as { ticket?: string; expiresAt?: string; viewerPath?: string };
    if (!result.ticket) throw new SpaceError("cua_failed", "cua-spacesd returned no viewer ticket.");
    return {
      ticket: result.ticket,
      expiresAt: Date.parse(result.expiresAt ?? "") || Date.now() + options.ttlSeconds * 1000,
      viewerPath: (result.viewerPath ?? "/viewer/").split("#")[0]!,
    };
  }
  async act(endpoint: SpaceEndpoint, action: SpaceAction): Promise<{ screenshot?: SpaceScreenshot }> {
    if (action.kind !== "screenshot") {
      const [method, body] = actionCall(action);
      await this.call(endpoint, method, body);
      return {};
    }
    for (const [quality, maxDimension] of [
      [70, 1280],
      [50, 960],
      [40, 640],
    ] as const) {
      const shot = (await this.call(endpoint, "ComputerService/Screenshot", {
        format: "IMAGE_FORMAT_JPEG",
        quality,
        maxDimension,
      })) as { image?: string; imageSize?: { width?: number; height?: number }; screenshotId?: string };
      if (!shot.image) throw new SpaceError("cua_failed", "cua-spacesd returned no image.");
      if (shot.image.length > SCREENSHOT_MAX_BASE64) continue;
      return {
        screenshot: {
          image: shot.image,
          format: "jpeg",
          width: shot.imageSize?.width ?? 0,
          height: shot.imageSize?.height ?? 0,
          ...(shot.screenshotId ? { screenshotId: shot.screenshotId } : {}),
        },
      };
    }
    throw new SpaceError("cua_failed", "The screenshot is too large to send.");
  }
}
