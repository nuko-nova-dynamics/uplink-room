import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HermesTerminal, type HermesHost } from "../src/hermesTerminal.ts";
import { HermesRefusal, type HermesEvents } from "../src/hermesGateway.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "hermes-target-"));
  let events: HermesEvents;
  let available = true;
  let snapshot: any = { running: true };
  let waiting = false;
  const host: HermesHost = {
    claim: vi.fn(async () => {
      waiting = false;
      return { ack: "one", text: "hello" };
    }),
    settle: vi.fn(),
    waiting: () => waiting,
    waitAgain: vi.fn(),
    report: vi.fn(),
    heard: vi.fn(),
  };
  const call = vi.fn(async (method: string) => {
    if (method === "session.resume") {
      if (!available) throw new HermesRefusal("not_found");
      return snapshot;
    }
    return { status: "queued" };
  });
  const terminal = new HermesTerminal({
    home,
    tty: "/dev/test",
    host,
    pollMs: 10,
    open: async (_home, callbacks) => {
      events = callbacks;
      return { call, close() {} };
    },
  });
  await mkdir(dirname(terminal.breadcrumb), { recursive: true });
  const crumb = (id: string) => writeFile(terminal.breadcrumb, JSON.stringify({ session_id: id }));
  await crumb("old");
  terminal.start();
  cleanups.push(async () => {
    terminal.close();
    await rm(home, { recursive: true, force: true });
  });
  await expect.poll(() => terminal.session).toBe("old");
  return {
    terminal,
    host,
    call,
    crumb,
    unavailable: () => {
      available = false;
    },
    available: () => {
      available = true;
    },
    post: () => {
      waiting = true;
      terminal.kick();
    },
    reconnect: (next: any) => {
      snapshot = next;
      events.onClose();
    },
    gap: (next: any) => {
      snapshot = next;
      events.onEvent({ type: "session.replay_gap", session_id: "old" });
    },
  };
}

test("a changed breadcrumb suspends delivery until the new session is confirmed", async () => {
  const f = await setup();
  f.unavailable();
  await f.crumb("new");
  f.post();
  await expect
    .poll(() => f.call.mock.calls.filter(([m]) => m === "session.resume").length)
    .toBeGreaterThan(2);
  expect(f.host.claim).not.toHaveBeenCalled();
  expect(f.terminal.session).toBeUndefined();
  f.available();
  await expect.poll(() => f.host.settle).toHaveBeenCalledWith("one", "delivered", "mid_task");
  expect(f.call).toHaveBeenCalledWith(
    "session.steer",
    expect.objectContaining({ session_id: "new" }),
  );
});

test.each(["reconnect", "gap"] as const)(
  "%s applies a pending question from the same session snapshot",
  async (kind) => {
    const f = await setup();
    vi.mocked(f.host.report).mockClear();
    f[kind]({
      running: true,
      prompts: [{ kind: "clarify", question: "Which branch?", prompt_id: "q1" }],
    });
    await expect
      .poll(() => f.host.report)
      .toHaveBeenCalledWith(expect.objectContaining({ state: "waiting" }));
  },
);
