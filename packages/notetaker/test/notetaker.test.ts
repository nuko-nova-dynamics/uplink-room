import { expect, test, vi } from "vitest";
import type { AudioHandlers, JoinMedia } from "../src/media.ts";
import { Notetaker, type RoomApi } from "../src/notetaker.ts";

/** The backend state two Notetaker processes share: the agent's call lease. */
function sharedBackend() {
  return { lease: null as { holder: string; expiresAt: number } | null };
}

/**
 * A fake Room API that records calls and lets the test push watched results.
 * Like a real subscription, a watcher registered after a push gets the latest
 * value. `down` makes every call fail, as if the process lost the network.
 */
function fakeRoom(shared = sharedBackend()) {
  const calls: { fn: string; args: any }[] = [];
  const state = { down: false, joins: 0, unfinished: [] as { callId: string; channelId: string; ended: boolean }[] };
  /** Make the next calls to a function fail: fn -> remaining failures (and their error code). */
  const failures = new Map<string, { times: number; code?: string }>();
  /** Hold the next call to a function open until released; its answer can be overridden. */
  const holds = new Map<string, { release: (answer?: unknown) => void; promise?: Promise<unknown> }>();
  const holdNext = (fn: string) => {
    let release!: (answer?: unknown) => void;
    const promise = new Promise((r) => (release = r));
    holds.set(fn, { release, promise });
    return (answer?: unknown) => release(answer);
  };
  const watchers = new Map<string, (result: unknown) => void>();
  const transcript: { speaker: { memberId: string; name: string; kind: "person" }; text: string; at: number }[] = [];
  const julio = { memberId: "m_julio", name: "Julio", kind: "person" as const };
  const ana = { memberId: "m_ana", name: "Ana", kind: "person" as const };
  const api: RoomApi = {
    async call(fn, args = {}) {
      calls.push({ fn, args });
      if (state.down) throw Object.assign(new Error(`${fn}: offline`), { code: "network_error" });
      const held = holds.get(fn);
      if (held?.promise) {
        const promise = held.promise;
        holds.delete(fn);
        const answer = await promise;
        if (answer !== undefined) return answer;
      }
      const failure = failures.get(fn);
      if (failure && failure.times > 0) {
        failure.times--;
        throw Object.assign(new Error(`${fn} failed`), { code: failure.code ?? "network_error" });
      }
      switch (fn) {
        case "calls.join":
          return { callId: "c1", participationId: `p${++state.joins}`, url: "ws://lk", token: "tok" };
        case "calls.claimLease": {
          const now = Date.now();
          const lease = shared.lease;
          if (lease && lease.holder !== args["holder"] && lease.expiresAt > now) return { held: false, expiresAt: lease.expiresAt, leaseMs: 45_000 };
          shared.lease = { holder: args["holder"] as string, expiresAt: now + 45_000 };
          return { held: true, expiresAt: shared.lease.expiresAt, leaseMs: 45_000 };
        }
        case "calls.unfinished": {
          return state.unfinished;
        }
        case "calls.releaseLease":
          if (shared.lease?.holder === args["holder"]) shared.lease = null;
          return null;
        case "calls.addTranscript":
          for (const line of args["lines"] as { speakerId: string; text: string; at: number; key?: string }[])
            if (!line.key || !transcript.some((t) => (t as { key?: string }).key === line.key)) transcript.push({ speaker: line.speakerId === "m_ana" ? ana : julio, text: line.text, at: line.at, key: line.key } as never);
          return { added: (args["lines"] as unknown[]).length };
        case "calls.transcript":
          return { lines: transcript };
        case "calls.get":
          return { callId: "c1", channelId: "ch1", participants: [], everyone: [julio, ana, { memberId: "m_note", name: "Notetaker", kind: "agent" }] };
        case "channels.list":
          return [{ channelId: "ch1", name: "reef-runner" }];
        default:
          return null;
      }
    },
    watch(fn, args, onUpdate) {
      const key = `${fn}:${JSON.stringify(args)}`;
      watchers.set(key, onUpdate);
      if (values.has(key)) queueMicrotask(() => watchers.get(key) === onUpdate && onUpdate(values.get(key)));
      return () => {
        if (watchers.get(key) === onUpdate) watchers.delete(key);
      };
    },
  };
  const values = new Map<string, unknown>();
  const push = (key: string, value: unknown) => {
    values.set(key, value);
    watchers.get(key)?.(value);
  };
  return { api, calls, failures, transcript, holdNext, push, watchers, state, shared };
}

test("asked to join, it joins, transcribes each speaker, and at the end posts notes and proposes tasks", async () => {
  vi.useFakeTimers();
  try {
    const room = fakeRoom();
    let handlers!: AudioHandlers;
    let left = false;
    const joinMedia: JoinMedia = async (url, token, h) => {
      expect([url, token]).toEqual(["ws://lk", "tok"]);
      handlers = h;
      return { leave: async () => void (left = true) };
    };
    const summarize = vi.fn(async () => ({
      notes: "Ana takes the save slot bug.",
      tasks: [{ title: "Fix the save slot bug", owner: "Ana" }, { title: "Order monitors", owner: "Someone else" }],
    }));
    const notetaker = new Notetaker({
      api: room.api,
      joinMedia,
      transcribe: async (u) => (u.speakerId === "m_julio" ? "Ana, can you take the save slot bug?" : "Sure, I'll take it."),
      summarize,
    });

    notetaker.start();
    room.push("calls.invitations:{}", [{ callId: "c1", channelId: "ch1" }]);
    await vi.waitFor(() => expect(handlers).toBeDefined());
    expect(room.calls.find((c) => c.fn === "calls.join")).toEqual({ fn: "calls.join", args: { channelId: "ch1", callId: "c1" } });

    const loud = new Int16Array(160).fill(8000);
    const quiet = new Int16Array(160);
    for (const speaker of ["m_julio", "m_ana"]) {
      for (let i = 0; i < 80; i++) handlers.onAudio(speaker, loud, 1000 + i * 10);
      for (let i = 0; i < 100; i++) handlers.onAudio(speaker, quiet, 1800 + i * 10);
    }
    await vi.advanceTimersByTimeAsync(3_000);
    const added = room.calls.filter((c) => c.fn === "calls.addTranscript").flatMap((c) => c.args.lines);
    expect(added).toMatchObject([
      { speakerId: "m_julio", text: "Ana, can you take the save slot bug?" },
      { speakerId: "m_ana", text: "Sure, I'll take it." },
    ]);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(room.calls.some((c) => c.fn === "calls.heartbeat")).toBe(true);

    // The last person leaves.
    room.push('calls.get:{"callId":"c1"}', { callId: "c1", channelId: "ch1", endedAt: Date.now(), participants: [], everyone: [] });
    await vi.waitFor(() => expect(room.calls.some((c) => c.fn === "calls.propose")).toBe(true));
    expect(left).toBe(true);
    expect(summarize).toHaveBeenCalledWith({
      channel: "reef-runner",
      people: ["Julio", "Ana"],
      lines: [expect.objectContaining({ speaker: "Julio" }), expect.objectContaining({ speaker: "Ana" })],
    });
    const fns = room.calls.map((c) => c.fn);
    expect(fns.indexOf("calls.leave")).toBeLessThan(fns.indexOf("calls.postNotes"));
    expect(room.calls.find((c) => c.fn === "calls.postNotes")!.args).toEqual({ callId: "c1", body: "Ana takes the save slot bug." });
    expect(room.calls.find((c) => c.fn === "calls.propose")!.args.tasks).toEqual([
      { title: "Fix the save slot bug", ownerId: "m_ana", key: expect.any(String) },
      { title: "Order monitors", key: expect.any(String) },
    ]);
    expect(notetaker.activeCalls).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

test("a call where nobody spoke gets no notes", async () => {
  const room = fakeRoom();
  const summarize = vi.fn();
  const notetaker = new Notetaker({
    api: room.api,
    joinMedia: async () => ({ leave: async () => {} }),
    transcribe: async () => "",
    summarize,
  });
  await notetaker.join({ callId: "c1", channelId: "ch1" });
  room.push('calls.get:{"callId":"c1"}', { callId: "c1", channelId: "ch1", endedAt: 1, participants: [], everyone: [] });
  await vi.waitFor(() => expect(notetaker.activeCalls).toEqual([]));
  expect(summarize).not.toHaveBeenCalled();
  expect(room.calls.map((c) => c.fn)).not.toContain("calls.postNotes");
});

test("each utterance is transcribed with the call's names, then the team's (without email addresses), and the language the call has been in", async () => {
  const room = fakeRoom();
  const call = room.api.call.bind(room.api);
  room.api.call = async (fn, args) =>
    fn === "teams.members"
      ? [
          { memberId: "m_julio", name: "Julio", kind: "person" },
          { memberId: "m_marta", name: "Marta Vidal <marta@example.com>", kind: "person" },
          { memberId: "m_ops", name: "ops@example.com", kind: "person" },
          { memberId: "m_note", name: "Notetaker", kind: "agent" },
        ]
      : call(fn, args);
  const hints: unknown[] = [];
  const { speak } = await joined(room, {
    transcribe: async (_u, h) => {
      hints.push(h);
      return { text: "Vale.", language: "es" };
    },
  });
  room.push('calls.get:{"callId":"c1"}', {
    callId: "c1",
    channelId: "ch1",
    participants: [{ memberId: "m_julio", name: "Julio", kind: "person", takesNotes: false }],
    everyone: [
      { memberId: "m_julio", name: "Julio", kind: "person" },
      { memberId: "m_ana", name: "Ana", kind: "person" },
      { memberId: "m_note", name: "Notetaker", kind: "agent" },
    ],
  });
  speak("m_julio.p1");
  speak("m_ana.p1");
  await vi.waitFor(() => expect(hints).toHaveLength(2));
  expect(hints).toEqual([{ names: ["Julio", "Ana", "Marta Vidal"] }, { names: ["Julio", "Ana", "Marta Vidal"], language: "es" }]);
});

/** Joins a call through an invite and returns the audio handlers and how to speak into them. */
async function joined(room: ReturnType<typeof fakeRoom>, extra: Partial<ConstructorParameters<typeof Notetaker>[0]> = {}) {
  let handlers!: AudioHandlers;
  const notetaker = new Notetaker({
    api: room.api,
    joinMedia: async (_url, _token, h) => {
      handlers = h;
      return { leave: async () => {} };
    },
    transcribe: async () => "Ana takes the save slot bug.",
    summarize: async () => ({ notes: "Notes.", tasks: [] }),
    ...extra,
  });
  notetaker.start();
  room.push("calls.invitations:{}", [{ callId: "c1", channelId: "ch1" }]);
  await vi.waitFor(() => expect(handlers).toBeDefined());
  const speak = (speaker: string) => {
    const loud = new Int16Array(160).fill(8000);
    const quiet = new Int16Array(160);
    for (let i = 0; i < 80; i++) handlers.onAudio(speaker, loud, 1000 + i * 10);
    for (let i = 0; i < 100; i++) handlers.onAudio(speaker, quiet, 1800 + i * 10);
  };
  return { notetaker, handlers, speak };
}

test("a failed join is forgotten and tried again while the invite is still there", async () => {
  vi.useFakeTimers();
  try {
    const room = fakeRoom();
    room.failures.set("calls.join", { times: 1 });
    const notetaker = new Notetaker({
      api: room.api,
      joinMedia: async () => ({ leave: async () => {} }),
      transcribe: async () => "",
      summarize: vi.fn(),
    });
    notetaker.start();
    room.push("calls.invitations:{}", [{ callId: "c1", channelId: "ch1" }]);
    await vi.waitFor(() => expect(room.calls.filter((c) => c.fn === "calls.join")).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(notetaker.activeCalls).toEqual([]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(room.calls.filter((c) => c.fn === "calls.join")).toHaveLength(2);
    expect(notetaker.activeCalls).toEqual(["c1"]);
  } finally {
    vi.useRealTimers();
  }
});

test("failed heartbeats are retried and don't end the notes while people are still talking", async () => {
  vi.useFakeTimers();
  try {
    const room = fakeRoom();
    const { notetaker } = await joined(room);
    room.failures.set("calls.heartbeat", { times: 3 });
    await vi.advanceTimersByTimeAsync(60_000);
    const fns = room.calls.map((c) => c.fn);
    expect(fns.filter((f) => f === "calls.heartbeat").length).toBeGreaterThan(3);
    expect(fns).not.toContain("calls.leave");
    expect(fns).not.toContain("calls.postNotes");
    expect(notetaker.activeCalls).toEqual(["c1"]);
  } finally {
    vi.useRealTimers();
  }
});

test("a heartbeat the room refuses (it dropped the Notetaker) joins the call again instead of ending it", async () => {
  vi.useFakeTimers();
  try {
    const room = fakeRoom();
    const { notetaker } = await joined(room);
    room.failures.set("calls.heartbeat", { times: 1, code: "conflict" });
    await vi.advanceTimersByTimeAsync(21_000);
    expect(room.calls.filter((c) => c.fn === "calls.join")).toHaveLength(2);
    expect(room.calls.map((c) => c.fn)).not.toContain("calls.postNotes");
    expect(notetaker.activeCalls).toEqual(["c1"]);
  } finally {
    vi.useRealTimers();
  }
});

test("LiveKit disconnecting for good ends the notes", async () => {
  const room = fakeRoom();
  const { notetaker, handlers } = await joined(room);
  handlers.onDisconnected?.();
  await vi.waitFor(() => expect(notetaker.activeCalls).toEqual([]));
  expect(room.calls.map((c) => c.fn)).toContain("calls.leave");
});

test("lines that fail to upload are kept and sent again with the same keys, so none is lost or doubled", async () => {
  vi.useFakeTimers();
  try {
    const room = fakeRoom();
    const { speak } = await joined(room);
    room.failures.set("calls.addTranscript", { times: 1 });
    speak("m_julio");
    await vi.advanceTimersByTimeAsync(3_000);
    const first = room.calls.filter((c) => c.fn === "calls.addTranscript");
    expect(first).toHaveLength(1);
    expect(room.transcript).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(3_000);
    const sends = room.calls.filter((c) => c.fn === "calls.addTranscript");
    expect(sends).toHaveLength(2);
    expect(sends[1]!.args.lines[0].key).toBe(sends[0]!.args.lines[0].key);
    expect(room.transcript).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

test("flushing with nothing to send doesn't block later flushes", async () => {
  vi.useFakeTimers();
  try {
    const room = fakeRoom();
    const { speak } = await joined(room);
    await vi.advanceTimersByTimeAsync(6_000); // two empty flushes
    speak("m_ana");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(room.transcript).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

test("lines still pending when the call ends are retried until the room takes them, and the notes include them", async () => {
  vi.useFakeTimers();
  try {
    const room = fakeRoom();
    const summarize = vi.fn(async () => ({ notes: "Notes.", tasks: [] }));
    const { speak } = await joined(room, { summarize });
    room.failures.set("calls.addTranscript", { times: 6 });
    speak("m_ana");
    room.push('calls.get:{"callId":"c1"}', { callId: "c1", channelId: "ch1", endedAt: 1, participants: [], everyone: [] });
    await vi.advanceTimersByTimeAsync(120_000);

    expect(room.transcript).toHaveLength(1);
    const fns = room.calls.map((c) => c.fn);
    expect(fns.lastIndexOf("calls.addTranscript")).toBeLessThan(fns.indexOf("calls.postNotes"));
    expect(summarize).toHaveBeenCalledWith(expect.objectContaining({ lines: [expect.objectContaining({ text: "Ana takes the save slot bug." })] }));
    // Proposing none still tells the room the notes are complete, so no later process writes them again.
    expect(room.calls.find((c) => c.fn === "calls.propose")!.args).toEqual({ callId: "c1", tasks: [] });
  } finally {
    vi.useRealTimers();
  }
});

test("after a long, logged give-up the notes still include the lines the room never took", async () => {
  vi.useFakeTimers();
  try {
    const room = fakeRoom();
    const log: string[] = [];
    const summarize = vi.fn(async () => ({ notes: "Notes.", tasks: [] }));
    const { speak, notetaker } = await joined(room, { summarize, log: (m) => log.push(m), finishGiveUpMs: 60_000 });
    room.failures.set("calls.addTranscript", { times: 10_000 });
    speak("m_ana");
    room.push('calls.get:{"callId":"c1"}', { callId: "c1", channelId: "ch1", endedAt: 1, participants: [], everyone: [] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(room.calls.map((c) => c.fn)).not.toContain("calls.postNotes");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(summarize).toHaveBeenCalledWith(expect.objectContaining({ lines: [expect.objectContaining({ text: "Ana takes the save slot bug." })] }));
    expect(log.some((m) => /gave up/i.test(m))).toBe(true);
    expect(notetaker.activeCalls).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

test("a media join that fails after calls.join is retried while the call is live, though the invite is gone", async () => {
  vi.useFakeTimers();
  try {
    const room = fakeRoom();
    let attempts = 0;
    const notetaker = new Notetaker({
      api: room.api,
      joinMedia: async () => {
        if (++attempts === 1) throw new Error("LiveKit unreachable");
        return { leave: async () => {} };
      },
      transcribe: async () => "",
      summarize: vi.fn(),
    });
    notetaker.start();
    room.push("calls.invitations:{}", [{ callId: "c1", channelId: "ch1" }]);
    await vi.advanceTimersByTimeAsync(0);
    // calls.join marked the invite joined, so it's no longer pending.
    room.push("calls.invitations:{}", []);
    expect(notetaker.activeCalls).toEqual([]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(attempts).toBe(2);
    expect(notetaker.activeCalls).toEqual(["c1"]);
    expect(room.calls.filter((c) => c.fn === "calls.join").every((c) => c.args.callId === "c1")).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("a rejoin decided on a stale view never joins once the call has finished", async () => {
  vi.useFakeTimers();
  try {
    const room = fakeRoom();
    const { notetaker } = await joined(room);
    room.failures.set("calls.heartbeat", { times: 1, code: "conflict" });
    const releaseGet = room.holdNext("calls.get");
    await vi.advanceTimersByTimeAsync(20_000);
    // The call ends while the Notetaker is still asking whether it's live.
    room.push('calls.get:{"callId":"c1"}', { callId: "c1", channelId: "ch1", endedAt: 1, participants: [], everyone: [] });
    await vi.waitFor(() => expect(notetaker.activeCalls).toEqual([]));
    releaseGet({ callId: "c1", channelId: "ch1", participants: [{ memberId: "m_julio", name: "Julio", kind: "person", takesNotes: false }], everyone: [] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(room.calls.filter((c) => c.fn === "calls.join")).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

test("stopping while a join is in flight tears down what that join opens", async () => {
  vi.useFakeTimers();
  try {
    const room = fakeRoom();
    let connect!: () => void;
    let mediaLeft = false;
    const notetaker = new Notetaker({
      api: room.api,
      joinMedia: () =>
        new Promise((resolve) => {
          connect = () => resolve({ leave: async () => void (mediaLeft = true) });
        }),
      transcribe: async () => "",
      summarize: vi.fn(),
    });
    notetaker.start();
    room.push("calls.invitations:{}", [{ callId: "c1", channelId: "ch1" }]);
    await vi.waitFor(() => expect(connect).toBeDefined());
    const stopping = notetaker.stop();
    connect();
    await stopping;

    expect(mediaLeft).toBe(true);
    expect(room.calls.map((c) => c.fn)).toContain("calls.leave");
    const before = room.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.calls.length).toBe(before);
    expect(notetaker.activeCalls).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

test("replaced by another Notetaker process (same identity), it stops here without leaving or writing notes", async () => {
  vi.useFakeTimers();
  try {
    const room = fakeRoom();
    const summarize = vi.fn(async () => ({ notes: "Notes.", tasks: [] }));
    const { handlers, speak, notetaker } = await joined(room, { summarize });
    speak("m_julio");
    handlers.onReplaced?.();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(notetaker.activeCalls).toEqual([]);
    expect(room.transcript).toHaveLength(1);
    const fns = room.calls.map((c) => c.fn);
    expect(fns).not.toContain("calls.leave");
    expect(fns).not.toContain("calls.postNotes");
    expect(summarize).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("only the process holding the agent's lease takes calls; another takes over once the holder crashes", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  try {
    const shared = sharedBackend();
    const roomA = fakeRoom(shared);
    const roomB = fakeRoom(shared);
    const make = (room: ReturnType<typeof fakeRoom>) =>
      new Notetaker({
        api: room.api,
        joinMedia: async () => ({ leave: async () => {} }),
        transcribe: async () => "",
        summarize: vi.fn(),
      });
    const a = make(roomA);
    const b = make(roomB);
    a.start();
    await vi.advanceTimersByTimeAsync(0);
    b.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(roomA.watchers.has("calls.invitations:{}")).toBe(true);
    expect(roomB.watchers.has("calls.invitations:{}")).toBe(false);

    // Both see the invite; only A joins.
    roomA.push("calls.invitations:{}", [{ callId: "c1", channelId: "ch1" }]);
    roomB.push("calls.invitations:{}", [{ callId: "c1", channelId: "ch1" }]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(a.activeCalls).toEqual(["c1"]);
    expect(roomB.calls.filter((c) => c.fn === "calls.join")).toHaveLength(0);
    // A's join cleared the invite in the room.
    roomA.push("calls.invitations:{}", []);
    roomB.push("calls.invitations:{}", []);

    // A crashes: it stops renewing. Its lease runs out and B takes calls.
    roomA.state.down = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(roomB.watchers.has("calls.invitations:{}")).toBe(true);
    roomB.push("calls.invitations:{}", [{ callId: "c2", channelId: "ch1" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(roomB.calls.filter((c) => c.fn === "calls.join")).toHaveLength(1);
    await b.stop();
    expect(shared.lease).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("a process that loses its lease stops taking new calls and tries to win it back", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  try {
    const shared = sharedBackend();
    const room = fakeRoom(shared);
    const notetaker = new Notetaker({
      api: room.api,
      joinMedia: async () => ({ leave: async () => {} }),
      transcribe: async () => "",
      summarize: vi.fn(),
    });
    notetaker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(room.watchers.has("calls.invitations:{}")).toBe(true);
    // Another process holds it now (this one was paused past expiry).
    shared.lease = { holder: "someone-else", expiresAt: Date.now() + 45_000 };
    await vi.advanceTimersByTimeAsync(15_000);
    expect(room.watchers.has("calls.invitations:{}")).toBe(false);
    shared.lease = null;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(room.watchers.has("calls.invitations:{}")).toBe(true);
    await notetaker.stop();
  } finally {
    vi.useRealTimers();
  }
});

test("a transient calls.get failure during a media retry reschedules the retry instead of dropping it", async () => {
  vi.useFakeTimers();
  try {
    const room = fakeRoom();
    let attempts = 0;
    const notetaker = new Notetaker({
      api: room.api,
      joinMedia: async () => {
        if (++attempts === 1) throw new Error("LiveKit unreachable");
        return { leave: async () => {} };
      },
      transcribe: async () => "",
      summarize: vi.fn(),
    });
    notetaker.start();
    room.push("calls.invitations:{}", [{ callId: "c1", channelId: "ch1" }]);
    await vi.advanceTimersByTimeAsync(0);
    room.push("calls.invitations:{}", []);
    room.failures.set("calls.get", { times: 1 });
    await vi.advanceTimersByTimeAsync(5_000); // first retry: calls.get fails
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000); // rescheduled with backoff
    expect(attempts).toBe(2);
    expect(notetaker.activeCalls).toEqual(["c1"]);
  } finally {
    vi.useRealTimers();
  }
});

test("the Notetaker keeps its own join alive and leaves only that join", async () => {
  vi.useFakeTimers();
  try {
    const room = fakeRoom();
    await joined(room);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(room.calls.find((c) => c.fn === "calls.heartbeat")!.args).toEqual({ participationId: "p1" });
    room.push('calls.get:{"callId":"c1"}', { callId: "c1", channelId: "ch1", endedAt: 1, participants: [], everyone: [] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(room.calls.find((c) => c.fn === "calls.leave")!.args).toEqual({ participationId: "p1" });
  } finally {
    vi.useRealTimers();
  }
});

test("a revoked key or scope ends the call here at once: media off, no retries, no notes", async () => {
  vi.useFakeTimers();
  try {
    const room = fakeRoom();
    let mediaLeft = false;
    const summarize = vi.fn();
    const notetaker = new Notetaker({
      api: room.api,
      joinMedia: async () => ({ leave: async () => void (mediaLeft = true) }),
      transcribe: async () => "",
      summarize,
    });
    notetaker.start();
    room.push("calls.invitations:{}", [{ callId: "c1", channelId: "ch1" }]);
    await vi.waitFor(() => expect(notetaker.activeCalls).toEqual(["c1"]));
    room.failures.set("calls.heartbeat", { times: 100, code: "forbidden" });
    await vi.advanceTimersByTimeAsync(21_000);

    expect(mediaLeft).toBe(true);
    expect(notetaker.activeCalls).toEqual([]);
    const beats = room.calls.filter((c) => c.fn === "calls.heartbeat").length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.calls.filter((c) => c.fn === "calls.heartbeat")).toHaveLength(beats);
    expect(summarize).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("a pending join retry is dropped once another process holds the lease", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  try {
    const shared = sharedBackend();
    const room = fakeRoom(shared);
    const notetaker = new Notetaker({
      api: room.api,
      joinMedia: async () => {
        throw new Error("LiveKit unreachable");
      },
      transcribe: async () => "",
      summarize: vi.fn(),
    });
    notetaker.start();
    room.push("calls.invitations:{}", [{ callId: "c1", channelId: "ch1" }]);
    await vi.advanceTimersByTimeAsync(0);
    room.push("calls.invitations:{}", []);
    // Another process takes the lease before the retry fires.
    shared.lease = { holder: "someone-else", expiresAt: Date.now() + 45_000 };
    await vi.advanceTimersByTimeAsync(4_000);
    const joins = room.calls.filter((c) => c.fn === "calls.join").length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(room.calls.filter((c) => c.fn === "calls.join")).toHaveLength(joins);
    await notetaker.stop();
  } finally {
    vi.useRealTimers();
  }
});

test("one member on two devices: each device's audio is cut separately, and both lines name the member", async () => {
  vi.useFakeTimers();
  try {
    const room = fakeRoom();
    const heard: string[] = [];
    const { handlers } = await joined(room, {
      transcribe: async (u) => {
        heard.push(`${u.speakerId}:${u.samples.length}`);
        return `from ${u.speakerId}`;
      },
    });
    const loud = new Int16Array(160).fill(8000);
    const quiet = new Int16Array(160);
    // Both devices talk at once, frame by frame.
    for (let i = 0; i < 80; i++) {
      handlers.onAudio("m_ana.p1", loud, 1000 + i * 10);
      handlers.onAudio("m_ana.p2", loud, 1000 + i * 10);
    }
    for (let i = 0; i < 100; i++) {
      handlers.onAudio("m_ana.p1", quiet, 1800 + i * 10);
      handlers.onAudio("m_ana.p2", quiet, 1800 + i * 10);
    }
    await vi.advanceTimersByTimeAsync(3_000);
    expect(heard).toHaveLength(2);
    expect(room.transcript.map((l) => l.speaker.memberId)).toEqual(["m_ana", "m_ana"]);
  } finally {
    vi.useRealTimers();
  }
});

test("writing the call notes survives failed writes: notes and proposals are retried, proposals with the same keys", async () => {
  vi.useFakeTimers();
  try {
    const room = fakeRoom();
    let summaries = 0;
    const summarize = vi.fn(async () => {
      if (++summaries === 1) throw new Error("claude -p timed out");
      return { notes: "Ana takes the bug.", tasks: [{ title: "Fix the save slot bug", owner: "Ana" }] };
    });
    const { speak } = await joined(room, { summarize });
    speak("m_ana");
    await vi.advanceTimersByTimeAsync(3_000);
    room.failures.set("calls.postNotes", { times: 1 });
    room.failures.set("calls.propose", { times: 1 });
    room.push('calls.get:{"callId":"c1"}', { callId: "c1", channelId: "ch1", endedAt: 1, participants: [], everyone: [] });
    await vi.advanceTimersByTimeAsync(120_000);

    expect(summarize).toHaveBeenCalledTimes(2);
    expect(room.calls.filter((c) => c.fn === "calls.postNotes")).toHaveLength(2);
    const proposes = room.calls.filter((c) => c.fn === "calls.propose");
    expect(proposes).toHaveLength(2);
    expect(proposes[1]!.args.tasks[0].key).toBeDefined();
    expect(proposes[1]!.args.tasks.map((t: { key: string }) => t.key)).toEqual(proposes[0]!.args.tasks.map((t: { key: string }) => t.key));
  } finally {
    vi.useRealTimers();
  }
});

test("renewals failing past the lease's expiry stop new joins, so two processes never join one call", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  try {
    const shared = sharedBackend();
    const roomA = fakeRoom(shared);
    const roomB = fakeRoom(shared);
    const make = (room: ReturnType<typeof fakeRoom>) =>
      new Notetaker({ api: room.api, joinMedia: async () => ({ leave: async () => {} }), transcribe: async () => "", summarize: vi.fn() });
    const a = make(roomA);
    a.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.takingCalls).toBe(true);
    // A's renewals fail (its claims don't reach the room), but its invite subscription stays up.
    roomA.failures.set("calls.claimLease", { times: 1_000 });
    await vi.advanceTimersByTimeAsync(42_000);
    // The lease ran out by A's clock (with a margin) before A's next tick: an invite now isn't joined.
    roomA.push("calls.invitations:{}", [{ callId: "c1", channelId: "ch1" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(roomA.calls.filter((c) => c.fn === "calls.join")).toHaveLength(0);

    // The next failed renewal, past expiry, stops A watching invites. B takes the lease.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(a.takingCalls).toBe(false);
    const b = make(roomB);
    b.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(b.takingCalls).toBe(true);
    // A's connectivity comes back and the invite reaches both before A's next lease check: only B joins.
    roomA.failures.delete("calls.claimLease");
    roomA.push("calls.invitations:{}", [{ callId: "c2", channelId: "ch1" }]);
    roomB.push("calls.invitations:{}", [{ callId: "c2", channelId: "ch1" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(roomA.calls.filter((c) => c.fn === "calls.join")).toHaveLength(0);
    expect(roomB.calls.filter((c) => c.fn === "calls.join")).toHaveLength(1);
    // A's next check finds B holding the lease: A still takes no calls.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(a.takingCalls).toBe(false);
    await Promise.all([a.stop(), b.stop()]);
  } finally {
    vi.useRealTimers();
  }
});

test("taking over the lease, it rejoins a live call the crashed process was in", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  try {
    const room = fakeRoom();
    room.state.unfinished = [{ callId: "c1", channelId: "ch1", ended: false }];
    const notetaker = new Notetaker({ api: room.api, joinMedia: async () => ({ leave: async () => {} }), transcribe: async () => "", summarize: vi.fn() });
    notetaker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(room.calls.filter((c) => c.fn === "calls.join").map((c) => c.args)).toEqual([{ channelId: "ch1", callId: "c1" }]);
    expect(notetaker.activeCalls).toEqual(["c1"]);
    // Later lease ticks don't join it again.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(room.calls.filter((c) => c.fn === "calls.join")).toHaveLength(1);
    await notetaker.stop();
  } finally {
    vi.useRealTimers();
  }
});

test("taking over the lease, it writes notes and proposals for a call that ended while no Notetaker was in it", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  try {
    const room = fakeRoom();
    room.state.unfinished = [{ callId: "c1", channelId: "ch1", ended: true }];
    room.transcript.push({ speaker: { memberId: "m_ana", name: "Ana", kind: "person" }, text: "I'll fix the save slot bug.", at: 1 });
    const summarize = vi.fn(async () => ({ notes: "Ana fixes the save slot bug.", tasks: [{ title: "Fix the save slot bug", owner: "Ana" }] }));
    const notetaker = new Notetaker({ api: room.api, joinMedia: async () => ({ leave: async () => {} }), transcribe: async () => "", summarize });
    notetaker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(room.calls.filter((c) => c.fn === "calls.join")).toHaveLength(0);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(room.calls.find((c) => c.fn === "calls.postNotes")!.args).toEqual({ callId: "c1", body: "Ana fixes the save slot bug." });
    expect(room.calls.find((c) => c.fn === "calls.propose")!.args.tasks).toEqual([
      { title: "Fix the save slot bug", ownerId: "m_ana", key: expect.any(String) },
    ]);
    // Once per process, even while the room still lists it.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(summarize).toHaveBeenCalledTimes(1);
    await notetaker.stop();
  } finally {
    vi.useRealTimers();
  }
});

test("losing the lease while calls.join is in flight undoes that join: no LiveKit session, and its join is left", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  try {
    const shared = sharedBackend();
    const room = fakeRoom(shared);
    const joinMedia = vi.fn<JoinMedia>(async () => ({ leave: async () => {} }));
    const notetaker = new Notetaker({ api: room.api, joinMedia, transcribe: async () => "", summarize: vi.fn() });
    notetaker.start();
    await vi.advanceTimersByTimeAsync(0);
    const answerJoin = room.holdNext("calls.join");
    room.push("calls.invitations:{}", [{ callId: "c1", channelId: "ch1" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(room.calls.filter((c) => c.fn === "calls.join")).toHaveLength(1);

    // Another process takes the lease before the room answers the join, and keeps renewing it.
    shared.lease = { holder: "someone-else", expiresAt: Date.now() + 10 * 60_000 };
    await vi.advanceTimersByTimeAsync(15_000);
    expect(notetaker.takingCalls).toBe(false);
    answerJoin();
    await vi.advanceTimersByTimeAsync(0);

    expect(joinMedia).not.toHaveBeenCalled();
    expect(room.calls.filter((c) => c.fn === "calls.leave").map((c) => c.args)).toEqual([{ participationId: "p1" }]);
    expect(notetaker.activeCalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.calls.filter((c) => c.fn === "calls.heartbeat")).toHaveLength(0);
    await notetaker.stop();
  } finally {
    vi.useRealTimers();
  }
});

test("a join whose LiveKit connect outlasts a lost and regained lease is undone: it belongs to the old lease", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  try {
    const shared = sharedBackend();
    const room = fakeRoom(shared);
    let connect!: () => void;
    let mediaLeft = false;
    const notetaker = new Notetaker({
      api: room.api,
      joinMedia: () =>
        new Promise((resolve) => {
          connect = () => resolve({ leave: async () => void (mediaLeft = true) });
        }),
      transcribe: async () => "",
      summarize: vi.fn(),
    });
    notetaker.start();
    await vi.advanceTimersByTimeAsync(0);
    room.push("calls.invitations:{}", [{ callId: "c1", channelId: "ch1" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toBeDefined();

    // While LiveKit connects, another process holds the lease for a while (and may join this call), then this one wins it back.
    shared.lease = { holder: "someone-else", expiresAt: Date.now() + 45_000 };
    await vi.advanceTimersByTimeAsync(15_000);
    expect(notetaker.takingCalls).toBe(false);
    shared.lease = null;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(notetaker.takingCalls).toBe(true);
    connect();
    await vi.advanceTimersByTimeAsync(0);

    expect(mediaLeft).toBe(true);
    expect(room.calls.filter((c) => c.fn === "calls.leave").map((c) => c.args)).toEqual([{ participationId: "p1" }]);
    expect(notetaker.activeCalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.calls.filter((c) => c.fn === "calls.heartbeat")).toHaveLength(0);
    await notetaker.stop();
  } finally {
    vi.useRealTimers();
  }
});

test("stopping while it writes the notes for a recovered call waits until the notes and the proposals are written", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  try {
    const room = fakeRoom();
    room.state.unfinished = [{ callId: "c1", channelId: "ch1", ended: true }];
    room.transcript.push({ speaker: { memberId: "m_ana", name: "Ana", kind: "person" }, text: "I'll fix the save slot bug.", at: 1 });
    let finishSummary!: (summary: { notes: string; tasks: { title: string; owner?: string }[] }) => void;
    const summarize = vi.fn(() => new Promise<{ notes: string; tasks: { title: string; owner?: string }[] }>((resolve) => (finishSummary = resolve)));
    const notetaker = new Notetaker({ api: room.api, joinMedia: async () => ({ leave: async () => {} }), transcribe: async () => "", summarize });
    notetaker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(summarize).toHaveBeenCalledTimes(1);

    // SIGTERM arrives while the summarizer is still running.
    let stopped = false;
    const stopping = notetaker.stop().then(() => void (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    finishSummary({ notes: "Ana fixes the save slot bug.", tasks: [{ title: "Fix the save slot bug", owner: "Ana" }] });
    await stopping;

    const fns = room.calls.map((c) => c.fn);
    expect(fns).toContain("calls.postNotes");
    expect(room.calls.find((c) => c.fn === "calls.propose")!.args.tasks).toEqual([{ title: "Fix the save slot bug", ownerId: "m_ana", key: expect.any(String) }]);
    // Only then does it give up the lease, so the process can exit.
    expect(fns.indexOf("calls.propose")).toBeLessThan(fns.indexOf("calls.releaseLease"));
  } finally {
    vi.useRealTimers();
  }
});

type Summary = { notes: string; tasks: { title: string; owner?: string }[] };

/** A process that took over call c1 (ended, with a line) and is summarizing it; `finish` hands it the summary. */
async function recovering(shared: ReturnType<typeof sharedBackend>) {
  const room = fakeRoom(shared);
  room.state.unfinished = [{ callId: "c1", channelId: "ch1", ended: true }];
  room.transcript.push({ speaker: { memberId: "m_ana", name: "Ana", kind: "person" }, text: "I'll fix the save slot bug.", at: 1 });
  let finish!: (summary: Summary) => void;
  const summarize = vi.fn(() => new Promise<Summary>((resolve) => (finish = resolve)));
  const notetaker = new Notetaker({ api: room.api, joinMedia: async () => ({ leave: async () => {} }), transcribe: async () => "", summarize });
  notetaker.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(summarize).toHaveBeenCalledTimes(1);
  return { room, notetaker, finish: (summary: Summary) => finish(summary) };
}

test("stopping keeps renewing the lease while recovered notes outlast it, so another process doesn't write them too", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  try {
    const shared = sharedBackend();
    const a = await recovering(shared);
    const stopping = a.notetaker.stop();
    expect(a.notetaker.takingCalls).toBe(false);

    // The summarizer runs past the 45-second lease. Another process starts meanwhile and must not take over.
    const roomB = fakeRoom(shared);
    roomB.state.unfinished = [{ callId: "c1", channelId: "ch1", ended: true }];
    const summarizeB = vi.fn(async () => ({ notes: "Other wording.", tasks: [{ title: "Repair save slots" }] }));
    const b = new Notetaker({ api: roomB.api, joinMedia: async () => ({ leave: async () => {} }), transcribe: async () => "", summarize: summarizeB });
    b.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(b.takingCalls).toBe(false);
    expect(summarizeB).not.toHaveBeenCalled();
    // A takes no new calls while it drains.
    a.room.push("calls.invitations:{}", [{ callId: "c2", channelId: "ch1" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(a.room.calls.filter((c) => c.fn === "calls.join")).toHaveLength(0);

    a.finish({ notes: "Ana fixes the save slot bug.", tasks: [{ title: "Fix the save slot bug", owner: "Ana" }] });
    await stopping;
    const fns = a.room.calls.map((c) => c.fn);
    expect(fns).toContain("calls.propose");
    expect(fns.indexOf("calls.propose")).toBeLessThan(fns.indexOf("calls.releaseLease"));
    expect(shared.lease).toBeNull();
    // No renewal after the release.
    const claims = a.room.calls.filter((c) => c.fn === "calls.claimLease").length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(a.room.calls.filter((c) => c.fn === "calls.claimLease")).toHaveLength(claims);
    await b.stop();
  } finally {
    vi.useRealTimers();
  }
});

test("if the lease is lost while stopping drains recovered notes, those notes and proposals aren't written", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  try {
    const shared = sharedBackend();
    const a = await recovering(shared);
    const stopping = a.notetaker.stop();
    // Another process holds the lease at the next renewal (this one was paused past expiry).
    shared.lease = { holder: "someone-else", expiresAt: Date.now() + 10 * 60_000 };
    await vi.advanceTimersByTimeAsync(15_000);
    a.finish({ notes: "Ana fixes the save slot bug.", tasks: [{ title: "Fix the save slot bug", owner: "Ana" }] });
    await stopping;
    const fns = a.room.calls.map((c) => c.fn);
    expect(fns).not.toContain("calls.postNotes");
    expect(fns).not.toContain("calls.propose");
  } finally {
    vi.useRealTimers();
  }
});

test("a recovered call's notes abandoned when the lease is lost are written once this process wins the lease back", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  try {
    const shared = sharedBackend();
    const room = fakeRoom(shared);
    room.state.unfinished = [{ callId: "c1", channelId: "ch1", ended: true }];
    room.transcript.push({ speaker: { memberId: "m_ana", name: "Ana", kind: "person" }, text: "I'll fix the save slot bug.", at: 1 });
    const summary: Summary = { notes: "Ana fixes the save slot bug.", tasks: [{ title: "Fix the save slot bug", owner: "Ana" }] };
    // The first summary is held until the test releases it; later ones answer at once.
    let finishFirst!: (summary: Summary) => void;
    const summarize = vi.fn(async () => summary);
    summarize.mockImplementationOnce(() => new Promise<Summary>((resolve) => (finishFirst = resolve)));
    const notetaker = new Notetaker({ api: room.api, joinMedia: async () => ({ leave: async () => {} }), transcribe: async () => "", summarize });
    notetaker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(summarize).toHaveBeenCalledTimes(1);

    // While it summarizes, another process holds the lease for a while, then this one wins it back.
    shared.lease = { holder: "someone-else", expiresAt: Date.now() + 45_000 };
    await vi.advanceTimersByTimeAsync(15_000);
    expect(notetaker.takingCalls).toBe(false);
    shared.lease = null;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(notetaker.takingCalls).toBe(true);
    // The summary under the old lease arrives: that job must not write.
    finishFirst(summary);
    await vi.advanceTimersByTimeAsync(0);
    expect(room.calls.filter((c) => c.fn === "calls.postNotes")).toHaveLength(0);

    // The room still lists the call; the next check under the new lease writes it, once.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(room.calls.filter((c) => c.fn === "calls.postNotes").map((c) => c.args)).toEqual([{ callId: "c1", body: "Ana fixes the save slot bug." }]);
    expect(room.calls.filter((c) => c.fn === "calls.propose").map((c) => c.args.tasks)).toEqual([
      [{ title: "Fix the save slot bug", ownerId: "m_ana", key: expect.any(String) }],
    ]);
    expect(summarize).toHaveBeenCalledTimes(2);
    await notetaker.stop();
  } finally {
    vi.useRealTimers();
  }
});

test("stopping disconnects the calls it's in at once, even while a calls.unfinished lookup hangs", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
  try {
    const room = fakeRoom();
    let mediaLeft = false;
    const notetaker = new Notetaker({
      api: room.api,
      joinMedia: async () => ({ leave: async () => void (mediaLeft = true) }),
      transcribe: async () => "",
      summarize: vi.fn(),
    });
    notetaker.start();
    room.push("calls.invitations:{}", [{ callId: "c1", channelId: "ch1" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(notetaker.activeCalls).toEqual(["c1"]);
    // The next lease tick looks for unfinished calls, and the room doesn't answer.
    const answerUnfinished = room.holdNext("calls.unfinished");
    await vi.advanceTimersByTimeAsync(15_000);

    let stopped = false;
    const stopping = notetaker.stop().then(() => void (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(mediaLeft).toBe(true);
    expect(room.calls.find((c) => c.fn === "calls.leave")!.args).toEqual({ participationId: "p1" });
    expect(stopped).toBe(false);
    answerUnfinished();
    await stopping;
  } finally {
    vi.useRealTimers();
  }
});
