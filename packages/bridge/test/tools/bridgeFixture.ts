import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeMessage, RoomMessage } from "@uplink-room/protocol";
import { afterEach } from "vitest";
import { Bridge, type RoomLink } from "../../src/bridge.ts";
import { quoteCommand } from "../../src/platform.ts";
import type { TerminalHost } from "../../src/terminal.ts";

export class FakeRoom implements RoomLink {
  messages: BridgeMessage[] = [];
  handler?: (message: RoomMessage) => void;
  send(message: BridgeMessage) {
    this.messages.push(message);
  }
  onMessage(handler: (message: RoomMessage) => void) {
    this.handler = handler;
  }
  deliver(message: RoomMessage) {
    this.handler!(message);
  }
}
export const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
export async function setup(options: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "uplink-bridge-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const room = (options.link as FakeRoom | undefined) ?? new FakeRoom();
  const bridge = new Bridge({
    link: room,
    limits: { mostOpenAccess: "suggest", slots: 1, longestProfileMs: 1000 },
    profilesDir: join(dir, "profiles"),
    ...options,
  });
  cleanups.push(() => bridge.close());
  await bridge.start();
  return { room, bridge, dir };
}
export const driver = { memberId: "driver", name: "Driver" };
export function start(room: FakeRoom, terminalId: string, command: string, more = {}) {
  room.deliver({
    v: 1,
    type: "start_terminal",
    terminalId,
    command,
    startedBy: driver,
    access: "suggest",
    usesSlot: true,
    ...more,
  });
}

/** A command line that runs test/tools/term.mjs in the platform's shell. */
export const term = (...args: string[]) =>
  quoteCommand([process.execPath, join(import.meta.dirname, "term.mjs"), ...args]);

export const screen = (room: FakeRoom) =>
  room.messages
    .filter((m) => m.type === "terminal_output")
    .map((m) => m.data)
    .join("");

/**
 * Terminals that exit only when the test says so (`exit`), like Windows terminals whose process-tree
 * kill is still running: kill() and killNow() are recorded, and settle once the terminal has exited.
 */
export function stoppableHost() {
  const terminals = new Map<string, { kills: string[]; exit: () => void }>();
  const host: TerminalHost = {
    spawn(_file, _args, options) {
      const exits: ((event: { exitCode: number }) => void)[] = [];
      let exited = false;
      let settle = () => {};
      const done = new Promise<void>((resolve) => (settle = resolve));
      const record = {
        kills: [] as string[],
        exit: () => {
          if (exited) return;
          exited = true;
          settle();
          exits.forEach((listener) => listener({ exitCode: 1 }));
        },
      };
      terminals.set(String(options.env?.UPLINK_TERMINAL_REF), record);
      return {
        write: () => {},
        resize: () => {},
        onData: () => ({ dispose: () => {} }),
        onExit: (listener) => (exits.push(listener), { dispose: () => {} }),
        kill: () => (record.kills.push("kill"), done),
        killNow: () => (record.kills.push("killNow"), done),
      };
    },
  };
  return { host, terminals };
}
