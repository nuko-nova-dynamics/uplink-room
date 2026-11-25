import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CallSession, MAX_REJOINS, type CallApi, type Disconnect, type SessionState } from "./callSession";

/**
 * A fake room that keeps joins like the backend: each `calls.join` is its own
 * participation (`p1`, `p2`, …), and `calls.leave` / `calls.heartbeat` act on
 * one participation only. Any call can be held open to reorder it against
 * others. Several sessions (devices) can share one backend.
 */
function backend() {
  const live = new Map<string, string>(); // participation -> channel
  const log: string[] = [];
  const holds: { fn: "join" | "leave"; release: () => void }[] = [];
  const pendingHolds: Record<"join" | "leave", number> = { join: 0, leave: 0 };
  let next = 0;
  const hold = async (fn: "join" | "leave") => {
    if (pendingHolds[fn] > 0) {
      pendingHolds[fn]--;
      await new Promise<void>((release) => holds.push({ fn, release }));
    }
  };
  const api: CallApi = {
    join: async (channelId) => {
      const participationId = `p${++next}`;
      log.push(`join ${channelId} -> ${participationId}`);
      await hold("join");
      live.set(participationId, channelId);
      return { callId: `call-${channelId}`, participationId, url: "ws://lk", token: participationId };
    },
    leave: async (participationId) => {
      log.push(`leave ${participationId}`);
      await hold("leave");
      live.delete(participationId);
    },
    heartbeat: async (participationId) => {
      if (!live.has(participationId)) throw { data: { code: "conflict" } };
    },
  };
  return {
    api,
    live,
    log,
    hold: (fn: "join" | "leave") => void pendingHolds[fn]++,
    release: (fn: "join" | "leave") => {
      const held = holds.find((h) => h.fn === fn);
      holds.splice(holds.indexOf(held!), 1);
      held!.release();
    },
  };
}

/** One device: a CallSession whose rooms record their connection and microphone. */
function device(room: ReturnType<typeof backend>, connectHold?: Promise<void>, micHold?: Promise<void>, gate: { disconnect?: Promise<void> } = {}) {
  const states: SessionState[] = [];
  const rooms: { token?: string; connected: boolean; mic: boolean; disconnected: boolean; rejoin: boolean; disconnect?: (why?: Disconnect) => void }[] = [];
  const rejoined: string[] = [];
  const removed: string[] = [];
  const session = new CallSession({
    api: room.api,
    heartbeatMs: 20_000,
    onRejoined: (why) => rejoined.push(why),
    onRemoved: () => removed.push("removed"),
    createRoom: (events, join) => {
      const r: (typeof rooms)[number] = { connected: false, mic: false, disconnected: false, rejoin: join?.rejoin ?? false, disconnect: events.onDisconnected };
      rooms.push(r);
      return {
        connect: async (_url, token) => {
          r.token = token;
          await connectHold;
          r.connected = true;
        },
        enableMicrophone: async () => {
          await micHold;
          r.mic = true;
        },
        disconnect: async () => {
          // Closing a room can take a while (LiveKit's leave); a test can hold it here.
          if (gate.disconnect) await gate.disconnect;
          r.disconnected = true;
          r.connected = false;
          r.mic = false;
        },
      };
    },
    onState: (state) => states.push(state),
    onError: () => {},
    cue: () => {},
  });
  /** The channels whose rooms have a live microphone right now. */
  const micsIn = () => rooms.filter((r) => r.mic).map((r) => room.live.get(r.token!) ?? `left:${r.token}`);
  return { session, states, rooms, micsIn, rejoined, removed };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const settle = () => vi.advanceTimersByTimeAsync(0);

test("joining connects, turns the microphone on and keeps its own join alive every 20 seconds", async () => {
  const room = backend();
  const { session, states, micsIn } = device(room);
  const beats = vi.spyOn(room.api, "heartbeat");
  await session.join("a");
  expect(micsIn()).toEqual(["a"]);
  expect(states.at(-1)).toMatchObject({ status: "connected", callId: "call-a", participationId: "p1", channelId: "a" });
  await vi.advanceTimersByTimeAsync(40_000);
  expect(beats.mock.calls).toEqual([["p1"], ["p1"]]);
});

test("leaving while calls.join is pending never connects, and leaves the join the room made", async () => {
  const room = backend();
  const { session, rooms, states } = device(room);
  room.hold("join");
  const joining = session.join("a");
  await settle();
  await session.leave();
  expect(states.at(-1)).toMatchObject({ status: "idle", callId: null });
  room.release("join");
  await joining;
  await settle();
  expect(rooms).toHaveLength(0);
  expect(room.log).toEqual(["join a -> p1", "leave p1"]);
  expect(room.live.size).toBe(0);
});

test("leaving while LiveKit is still connecting disconnects without turning the microphone on", async () => {
  const room = backend();
  let connect!: () => void;
  const { session, rooms } = device(room, new Promise<void>((r) => (connect = r)));
  const joining = session.join("a");
  await vi.waitFor(() => expect(rooms).toHaveLength(1));
  await session.leave();
  connect();
  await joining;
  await settle();
  expect(rooms[0]).toMatchObject({ mic: false, connected: false, disconnected: true });
  expect(room.log.filter((l) => l.startsWith("leave"))).toEqual(["leave p1"]);
  const beats = vi.spyOn(room.api, "heartbeat");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(beats).not.toHaveBeenCalled();
});

test("disposing (sign out, the team chooser) disconnects, stops the heartbeat and leaves in the room", async () => {
  const room = backend();
  const { session, rooms } = device(room);
  await session.join("a");
  const beats = vi.spyOn(room.api, "heartbeat");
  await session.dispose();
  expect(rooms[0]).toMatchObject({ disconnected: true, mic: false });
  expect(room.live.size).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(beats).not.toHaveBeenCalled();
  // A disposed session starts nothing.
  await session.join("b");
  expect(room.log).not.toContain("join b -> p2");
});

test("disposing while a channel switch is joining the new channel never connects to it", async () => {
  const room = backend();
  const { session, micsIn } = device(room);
  await session.join("a");
  room.hold("join");
  const switching = session.join("b");
  await settle();
  await session.dispose();
  room.release("join");
  await switching;
  await settle();
  expect(micsIn()).toEqual([]);
  expect(room.live.size).toBe(0);
  expect(session.state.status).toBe("idle");
});

test("H1: a slow request for B never resumes after you moved on to C", async () => {
  const room = backend();
  const { session, micsIn, states } = device(room);
  await session.join("a");
  room.hold("leave"); // A's leave is slow
  room.hold("join"); // and so is B's join
  const toB = session.join("b");
  await settle();
  const toC = session.join("c");
  await toC;
  expect(micsIn()).toEqual(["c"]);
  room.release("leave");
  room.release("join");
  await toB;
  await settle();

  expect(micsIn()).toEqual(["c"]);
  expect([...room.live.values()]).toEqual(["c"]);
  expect(states.at(-1)).toMatchObject({ status: "connected", channelId: "c" });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(session.state.status).toBe("connected");
});

test("two devices for one member: a slow leave on the laptop never drops the phone's join", async () => {
  const room = backend();
  const laptop = device(room);
  const phone = device(room);
  await laptop.session.join("a");
  room.hold("leave");
  const leaving = laptop.session.leave();
  await phone.session.join("a");
  room.release("leave");
  await leaving;
  await vi.advanceTimersByTimeAsync(20_000);

  expect(phone.session.state).toMatchObject({ status: "connected", channelId: "a" });
  expect(phone.micsIn()).toEqual(["a"]);
  expect([...room.live.keys()]).toEqual([phone.session.state.participationId]);
});

test("rejoining while the old leave is still on its way keeps the new join", async () => {
  const room = backend();
  const { session } = device(room);
  await session.join("a");
  room.hold("leave");
  const leaving = session.leave();
  await session.join("a");
  room.release("leave");
  await leaving;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(session.state).toMatchObject({ status: "connected", participationId: "p2" });
  expect([...room.live.keys()]).toEqual(["p2"]);
});

test("cancelling a pending join and joining again keeps only the new join", async () => {
  const room = backend();
  const { session, micsIn } = device(room);
  room.hold("join");
  const first = session.join("a");
  await settle();
  await session.leave();
  await session.join("a");
  room.release("join");
  await first;
  await settle();
  expect(micsIn()).toEqual(["a"]);
  expect([...room.live.keys()]).toEqual(["p2"]);
  expect(session.state).toMatchObject({ status: "connected", participationId: "p2" });
});

test("a heartbeat the room refuses (this join was dropped) joins the same channel again, without leaving the dropped join", async () => {
  const room = backend();
  const { session, rooms, rejoined } = device(room);
  await session.join("a");
  room.live.delete("p1");
  await vi.advanceTimersByTimeAsync(20_000);
  expect(rooms[0]!.disconnected).toBe(true);
  expect(rooms[1]).toMatchObject({ rejoin: true, connected: true, mic: true });
  expect(session.state).toMatchObject({ status: "connected", channelId: "a", participationId: "p2" });
  expect(rejoined).toEqual(["rejoined"]);
  expect(room.log.filter((l) => l.startsWith("leave"))).toEqual([]);
  // And the new join is kept alive.
  const beats = vi.spyOn(room.api, "heartbeat");
  await vi.advanceTimersByTimeAsync(20_000);
  expect(beats.mock.calls).toEqual([["p2"]]);
});

test("joining again on its own stops after a few tries in a few minutes, and the call ends here", async () => {
  const room = backend();
  const { session } = device(room);
  await session.join("a");
  for (let i = 0; i <= MAX_REJOINS; i++) {
    room.live.clear();
    await vi.advanceTimersByTimeAsync(20_000);
  }
  expect(session.state.status).toBe("idle");
  expect(room.log.filter((l) => l.startsWith("join"))).toHaveLength(1 + MAX_REJOINS);
});

test("a heartbeat lost to the network keeps the call", async () => {
  const room = backend();
  const { session, rooms } = device(room);
  await session.join("a");
  vi.spyOn(room.api, "heartbeat").mockRejectedValueOnce(new Error("offline"));
  await vi.advanceTimersByTimeAsync(20_000);
  expect(rooms[0]!.disconnected).toBe(false);
  expect(session.state.status).toBe("connected");
});

test("LiveKit dropping the connection while the microphone turns on ends the join and starts no heartbeat", async () => {
  const room = backend();
  let micOn!: () => void;
  let disconnected!: () => void;
  const session = new CallSession({
    api: room.api,
    heartbeatMs: 20_000,
    createRoom: (events) => {
      disconnected = events.onDisconnected;
      return {
        connect: async () => {},
        enableMicrophone: () => new Promise<void>((r) => (micOn = r)),
        disconnect: async () => {},
      };
    },
    onState: () => {},
    onError: () => {},
    cue: () => {},
  });
  const beats = vi.spyOn(room.api, "heartbeat");
  const joining = session.join("a");
  await vi.waitFor(() => expect(micOn).toBeDefined());
  disconnected();
  micOn();
  await joining;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(beats).not.toHaveBeenCalled();
  expect(session.state.status).toBe("idle");
  expect(room.live.size).toBe(0);
});

// ---------- presence (the calls that ended after a minute, 2026-11-04) ----------

test("the heartbeat starts when calls.join returns, even when the microphone never finishes starting", async () => {
  // 0.2.0 to 0.2.2: Krisp's start never settled under the app's old content security policy, so
  // enableMicrophone never resolved, no heartbeat ever ran, and the room dropped each join at 60 s.
  const room = backend();
  const { session, states } = device(room, undefined, new Promise<void>(() => {}));
  const beats = vi.spyOn(room.api, "heartbeat");
  void session.join("a");
  await vi.advanceTimersByTimeAsync(65_000);
  expect(beats.mock.calls).toEqual([["p1"], ["p1"], ["p1"]]);
  expect(room.live.has("p1")).toBe(true);
  expect(states.at(-1)).toMatchObject({ status: "connected", participationId: "p1" });
});

test("a beat that fails on the network is tried again within seconds, not at the next beat", async () => {
  const room = backend();
  const { session } = device(room);
  await session.join("a");
  const beats = vi.spyOn(room.api, "heartbeat");
  beats.mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline"));
  // Due at 20 s, then again at 22 s and 26 s: all inside the room's 60 second window.
  await vi.advanceTimersByTimeAsync(27_000);
  expect(beats).toHaveBeenCalledTimes(3);
  expect(session.state.status).toBe("connected");
});

test("after the computer sleeps, catching up beats at once and joins again if the room dropped the join meanwhile", async () => {
  const room = backend();
  const { session, rooms } = device(room);
  await session.join("a");
  const beats = vi.spyOn(room.api, "heartbeat");
  // Asleep: no timer ran, and the room dropped the quiet join.
  room.live.delete("p1");
  session.catchUp("resume");
  await vi.advanceTimersByTimeAsync(0);
  expect(beats.mock.calls[0]).toEqual(["p1"]);
  await vi.advanceTimersByTimeAsync(0);
  expect(rooms.at(-1)).toMatchObject({ rejoin: true, connected: true });
  expect(session.state).toMatchObject({ status: "connected", participationId: "p2" });
});

test("catching up when nothing was dropped just beats, and keeps the same join", async () => {
  const room = backend();
  const { session } = device(room);
  await session.join("a");
  const beats = vi.spyOn(room.api, "heartbeat");
  session.catchUp("unlock-screen");
  await vi.advanceTimersByTimeAsync(0);
  expect(beats.mock.calls).toEqual([["p1"]]);
  // The next beat is a full interval later.
  await vi.advanceTimersByTimeAsync(19_000);
  expect(beats).toHaveBeenCalledTimes(1);
  expect(session.state.participationId).toBe("p1");
});

test("LiveKit disconnecting for a reason that isn't final leaves that join and joins again; a final one ends the call", async () => {
  const room = backend();
  const { session, rooms } = device(room);
  await session.join("a");
  rooms[0]!.disconnect!({ reason: "SIGNAL_CLOSE", final: false });
  await vi.advanceTimersByTimeAsync(0);
  expect(room.log).toContain("leave p1");
  expect(session.state).toMatchObject({ status: "connected", participationId: "p2" });
  rooms[1]!.disconnect!({ reason: "ROOM_DELETED", final: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(session.state.status).toBe("idle");
  expect(rooms).toHaveLength(2);
});

// ---------- review round 1 (PR #98): a rejoin never overrides what the person did since ----------

/** A device whose room disconnects can be held, and a way to make the room drop its join. */
function droppable() {
  const room = backend();
  const gate: { disconnect?: Promise<void> } = {};
  const d = device(room, undefined, undefined, gate);
  let release = () => {};
  const holdDisconnect = () => (gate.disconnect = new Promise<void>((r) => (release = r)));
  const releaseDisconnect = () => {
    gate.disconnect = undefined;
    release();
  };
  /** The room drops the join and the session finds out (a refused beat), so it starts joining again. */
  const drop = async (id: string) => {
    room.live.delete(id);
    d.session.catchUp("resume");
    await vi.advanceTimersByTimeAsync(0);
  };
  return { room, ...d, holdDisconnect, releaseDisconnect, drop };
}

test("leaving while a rejoin is still closing the old room: the rejoin stops, no new join, no room left connected", async () => {
  const { room, session, rooms, holdDisconnect, releaseDisconnect, drop } = droppable();
  await session.join("a");
  holdDisconnect();
  await drop("p1");
  await session.leave();
  releaseDisconnect();
  await vi.advanceTimersByTimeAsync(0);
  expect(room.log.filter((l) => l.startsWith("join"))).toEqual(["join a -> p1"]);
  expect(rooms.filter((r) => r.connected)).toHaveLength(0);
  expect(session.state.status).toBe("idle");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(room.live.size).toBe(0);
});

test("switching to another channel while a rejoin is closing the old room: only the new channel's call is left", async () => {
  const { room, session, rooms, holdDisconnect, releaseDisconnect, drop } = droppable();
  await session.join("a");
  holdDisconnect();
  await drop("p1");
  const switching = session.join("b");
  releaseDisconnect();
  await switching;
  await vi.advanceTimersByTimeAsync(0);
  expect(session.state).toMatchObject({ status: "connected", channelId: "b" });
  expect(room.log.filter((l) => l.startsWith("join"))).toEqual(["join a -> p1", "join b -> p2"]);
  expect(rooms.filter((r) => r.connected)).toHaveLength(1);
  expect([...room.live.values()]).toEqual(["b"]);
});

test("leaving while a rejoin's calls.join is on its way: the join it made is left, and nothing connects", async () => {
  const { room, session, rooms, drop } = droppable();
  await session.join("a");
  room.hold("join");
  await drop("p1");
  await session.leave();
  room.release("join");
  await vi.advanceTimersByTimeAsync(0);
  expect(room.log).toContain("leave p2");
  expect(rooms.filter((r) => r.connected)).toHaveLength(0);
  expect(room.live.size).toBe(0);
  expect(session.state.status).toBe("idle");
});


test("a heartbeat refused for good (not_found, forbidden) ends the call here at once; one lost to the network keeps being retried", async () => {
  const room = backend();
  const { session, rooms, removed } = device(room);
  await session.join("a");
  const beats = vi.spyOn(room.api, "heartbeat");
  // The network: retried at 2, 4, then every 8 seconds, for as long as it lasts, and the call stays.
  beats.mockRejectedValue(new Error("offline"));
  await vi.advanceTimersByTimeAsync(20_000 + 2_000 + 4_000 + 8_000 + 8_000 + 8_000);
  expect(beats.mock.calls.length).toBeGreaterThanOrEqual(6);
  expect(session.state.status).toBe("connected");
  expect(rooms[0]!.disconnected).toBe(false);
  // The room says the channel is out of reach: no retry, no rejoin, LiveKit disconnected.
  beats.mockRejectedValue({ data: { code: "not_found" } });
  await vi.advanceTimersByTimeAsync(8_000);
  expect(session.state.status).toBe("idle");
  expect(rooms[0]!.disconnected).toBe(true);
  expect(removed).toEqual(["removed"]);
  const tried = beats.mock.calls.length;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(beats.mock.calls.length).toBe(tried);
  expect(room.log).toEqual(["join a -> p1"]);

  // `forbidden` (the join isn't this member's, or they left the team) is final too.
  const other = device(room);
  await other.session.join("b");
  beats.mockRejectedValue({ data: { code: "forbidden" } });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(other.session.state.status).toBe("idle");
  expect(other.rooms[0]!.disconnected).toBe(true);
  expect(other.removed).toEqual(["removed"]);
});
