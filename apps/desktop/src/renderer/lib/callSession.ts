/**
 * Joining, leaving and staying in a call, without React or LiveKit (spec #5).
 * CallProvider (call.tsx) supplies the Room API calls and a LiveKit room; the
 * tests (callSession.test.ts) supply fakes.
 *
 * The latest request wins. Every join and leave takes a new generation; after
 * every await, a join that is no longer the latest stops and undoes what it
 * opened (the LiveKit room it connected, the join the room made for it). It
 * never turns the microphone on. A disposed session never starts again.
 *
 * Each `calls.join` is its own participation in the room, and `calls.leave`
 * ends only the participation it names. So leaves never need to be waited for
 * or ordered: a slow leave can't remove a newer join, on this device or another.
 *
 * Presence (docs/calls.md, "Staying in a call"):
 *  - The heartbeat starts as soon as `calls.join` returns, before LiveKit or the
 *    microphone. Media never holds it back: in 0.2.0 to 0.2.2 it started only after
 *    the microphone, and a microphone whose noise filter never finished starting
 *    (Krisp under the app's old content security policy) meant no heartbeat at all,
 *    so the room dropped every join after 60 seconds.
 *  - A beat that fails for any reason but "you're not in this call" is tried again
 *    within seconds, not at the next 20 second beat, so a blip can't use up the
 *    60 second window.
 *  - `catchUp` beats at once when the computer wakes, the screen unlocks, the
 *    network comes back or the window shows again, and a beat that fires late (the
 *    computer slept) says so in the log.
 *  - When the room has dropped the join (the heartbeat's conflict, or LiveKit
 *    disconnecting for a reason that isn't final), the session joins the same
 *    channel again on its own, keeping the person's mute, at most a few times in a
 *    few minutes.
 */

export type JoinResult = { callId: string; participationId: string; url: string; token: string };

export type CallApi = {
  join(channelId: string): Promise<JoinResult>;
  leave(participationId: string): Promise<unknown>;
  heartbeat(participationId: string): Promise<unknown>;
};

/** The LiveKit side of one join. */
export type MediaRoom = {
  connect(url: string, token: string): Promise<void>;
  enableMicrophone(url: string): Promise<void>;
  disconnect(): Promise<void>;
};

/** Why LiveKit disconnected, and whether joining again could help. */
export type Disconnect = { reason: string; final: boolean };

export type SessionState = {
  status: "idle" | "joining" | "connected" | "reconnecting";
  callId: string | null;
  participationId: string | null;
  channelId: string | null;
};

export type SessionLog = (level: "debug" | "info" | "warn" | "error", message: string, fields?: Record<string, string | number | boolean | null | undefined>) => void;

export type CallSessionOptions = {
  api: CallApi;
  /** `rejoin` is true when the session joins again on its own, so media keeps what the person chose (their mute). */
  createRoom(events: { onDisconnected(why?: Disconnect): void }, join: { rejoin: boolean }): MediaRoom;
  onState(state: SessionState): void;
  onError(error: unknown): void;
  /** The session joined the same channel again on its own (the room had dropped the join). */
  onRejoined?(why: string): void;
  /** The room refused the join for good (no access to its channel any more): the call ended here. */
  onRemoved?(): void;
  /** Join and leave cues (DESIGN.md, Sound). */
  cue(cue: "join" | "leave"): void;
  log?: SessionLog;
  heartbeatMs?: number;
  /** Waits before a failed beat is tried again: the first, second, and every one after. */
  retryMs?: readonly number[];
  now?: () => number;
};

const IDLE: SessionState = { status: "idle", callId: null, participationId: null, channelId: null };

/** The room refused the heartbeat: this join isn't in the call any more. */
function dropped(error: unknown): boolean {
  return (error as { data?: { code?: string } } | null)?.data?.code === "conflict";
}

/**
 * The room refused the heartbeat for good: the person can't reach the call's channel any more (left
 * or removed from a private channel: `not_found`), or the join isn't theirs to keep (`forbidden`,
 * also when they're no longer in the team). The backend checks access before it checks whether the
 * join ended, so this comes before LiveKit's own removal, which can be late. Anything else (the
 * network, a session still signing in after sleep) is tried again.
 */
function refused(error: unknown): boolean {
  const code = (error as { data?: { code?: string } } | null)?.data?.code;
  return code === "not_found" || code === "forbidden";
}

/** An error's type and the room's code, for a log line (never its message: that can hold anything). */
function describe(error: unknown): { type: string; code: string | undefined } {
  const e = error as { name?: string; constructor?: { name?: string }; data?: { code?: string } } | null;
  return { type: e?.name ?? e?.constructor?.name ?? typeof error, code: e?.data?.code };
}

const short = (id: string | null) => (id ? id.slice(0, 8) : null);

/** How long the room keeps a quiet join (packages/backend/convex/calls.ts, PRESENCE_WINDOW_MS). */
export const PRESENCE_WINDOW_MS = 60_000;
/** At most this many joins on its own in REJOIN_WINDOW_MS, so a room that keeps refusing doesn't loop. */
export const MAX_REJOINS = 4;
export const REJOIN_WINDOW_MS = 5 * 60_000;

export class CallSession {
  readonly #options: CallSessionOptions;
  readonly #log: SessionLog;
  readonly #now: () => number;
  #generation = 0;
  #disposed = false;
  #state: SessionState = IDLE;
  #room: MediaRoom | null = null;
  /** Joins already left in the room, so an undo doesn't leave them twice. */
  readonly #left = new Set<string>();

  // ---------- the heartbeat ----------
  #beatTimer: ReturnType<typeof setTimeout> | null = null;
  /** The join the heartbeat keeps alive, and its generation. */
  #beating: { participationId: string; generation: number } | null = null;
  /** The generation of the beat in flight, if any. */
  #inFlight: number | null = null;
  /** Set while a beat is in flight, so a catch-up asked for meanwhile beats again once it lands. */
  #again = false;
  #lastOk = 0;
  #failures = 0;
  #beats = 0;
  readonly #rejoins: number[] = [];

  constructor(options: CallSessionOptions) {
    this.#options = options;
    this.#log = options.log ?? (() => {});
    this.#now = options.now ?? Date.now;
  }

  get state(): SessionState {
    return this.#state;
  }

  /** The heartbeat's health, for "Copy diagnostics". */
  get presence() {
    return {
      beats: this.#beats,
      failures: this.#failures,
      lastOkSecondsAgo: this.#lastOk ? Math.round((this.#now() - this.#lastOk) / 1000) : null,
      rejoins: this.#rejoins.length,
    };
  }

  #set(state: SessionState) {
    this.#state = state;
    this.#options.onState(state);
  }

  /** Marks a reconnect in progress (LiveKit's Reconnecting and Reconnected events). */
  setReconnecting(reconnecting: boolean) {
    if (this.#state.status === "idle" || this.#state.status === "joining") return;
    this.#log(reconnecting ? "warn" : "info", reconnecting ? "livekit reconnecting" : "livekit reconnected");
    this.#set({ ...this.#state, status: reconnecting ? "reconnecting" : "connected" });
  }

  async join(channelId: string): Promise<void> {
    if (this.#disposed) return;
    if (this.#state.channelId === channelId && this.#state.status !== "idle") return;
    // A join the person asked for starts the count of joins on its own over.
    this.#rejoins.length = 0;
    await this.#join(channelId, false);
  }

  async #join(channelId: string, rejoin: boolean): Promise<void> {
    const generation = ++this.#generation;
    const current = () => generation === this.#generation && !this.#disposed;
    const api = this.#options.api;
    // Out of whatever call we're in. Not awaited: that leave ends only its own join. A rejoin has
    // already dropped its old room; anything still here is disconnected too, never left running.
    if (!rejoin) void this.#drop({ quiet: false, leaveRoom: true });
    else if (this.#room) {
      const stray = this.#room;
      this.#room = null;
      void stray.disconnect().catch(() => {});
    }
    this.#set({ ...IDLE, status: rejoin ? "reconnecting" : "joining", channelId });
    this.#log("info", rejoin ? "joining again" : "joining", { channel: short(channelId) });

    let joined: JoinResult;
    try {
      joined = await api.join(channelId);
    } catch (error) {
      if (current()) {
        this.#log("error", "calls.join failed", describe(error));
        this.#options.onError(error);
        this.#set(IDLE);
      }
      return;
    }
    const { callId, participationId } = joined;
    if (!current()) {
      // A newer request (or dispose) came in: the room made this join for nothing.
      await this.#leaveInRoom(participationId);
      return;
    }
    this.#log("info", "joined in the room", { call: short(callId), join: short(participationId) });
    this.#set({ status: rejoin ? "reconnecting" : "joining", callId, participationId, channelId });
    // Presence first: the room keeps this join while it hears from it, whatever LiveKit and the
    // microphone do next.
    this.#startHeartbeat(participationId, generation);

    const room = this.#options.createRoom(
      {
        onDisconnected: (why) => {
          if (this.#room !== room) return;
          this.#log(why?.final === false ? "warn" : "info", "livekit disconnected", { reason: why?.reason ?? "unknown", final: why?.final ?? true });
          if (why && !why.final && current() && this.#mayRejoin()) {
            void this.#rejoin(channelId, `livekit ${why.reason}`, true);
            return;
          }
          // A join still turning the microphone on must stop, not keep heartbeats for a dead room.
          this.#generation++;
          void this.#drop({ quiet: true, leaveRoom: false });
        },
      },
      { rejoin },
    );
    this.#room = room;
    // Undo what this join opened. Both steps are safe to repeat if a newer request already did them.
    const undo = async () => {
      if (this.#room === room) this.#room = null;
      this.#stopHeartbeat(generation);
      await room.disconnect().catch(() => {});
      await this.#leaveInRoom(participationId);
    };
    try {
      await room.connect(joined.url, joined.token);
      if (!current()) return await undo();
      this.#log("info", "livekit connected", { join: short(participationId) });
      this.#set({ status: "connected", callId, participationId, channelId });
      if (rejoin) this.#options.onRejoined?.("rejoined");
      else this.#options.cue("join");
      await room.enableMicrophone(joined.url);
      if (!current()) return await undo();
      this.#log("info", "microphone started", { join: short(participationId) });
    } catch (error) {
      if (!current()) return await undo();
      this.#log("error", "joining failed", describe(error));
      this.#options.onError(error);
      await this.#drop({ quiet: true, leaveRoom: true });
    }
  }

  /** Leaves the call you're in, or cancels a join in flight. */
  async leave(): Promise<void> {
    this.#generation++;
    this.#log("info", "leaving");
    await this.#drop({ quiet: false, leaveRoom: true });
  }

  /** The call ended in the room: disconnect here only. */
  async ended(): Promise<void> {
    this.#generation++;
    this.#log("info", "the call ended in the room");
    await this.#drop({ quiet: true, leaveRoom: false });
  }

  /**
   * Beat now: the computer woke or unlocked, the network came back, the window showed again, or the
   * room's list of who's in the call stopped listing this join. A beat that's refused joins again.
   */
  catchUp(why: string): void {
    if (!this.#beating) return;
    const quiet = this.#lastOk ? this.#now() - this.#lastOk : null;
    this.#log("info", "catching up", { why, quietSeconds: quiet === null ? null : Math.round(quiet / 1000) });
    if (this.#inFlight === this.#beating.generation) {
      this.#again = true;
      return;
    }
    this.#scheduleBeat(0);
  }

  /** CallProvider unmounted for good (sign out, another team): disconnect, leave in the room, never start again. */
  async dispose(why = "signed out or another team"): Promise<void> {
    this.#disposed = true;
    this.#generation++;
    if (this.#state.status !== "idle") this.#log("info", "ending the call here", { why });
    await this.#drop({ quiet: true, leaveRoom: true });
  }

  // ---------- presence ----------

  #startHeartbeat(participationId: string, generation: number) {
    this.#stopHeartbeat();
    this.#beating = { participationId, generation };
    this.#lastOk = this.#now();
    this.#failures = 0;
    this.#scheduleBeat(this.#options.heartbeatMs ?? 20_000);
  }

  /** Stops the heartbeat, or only the one for `generation` when given. */
  #stopHeartbeat(generation?: number) {
    if (generation !== undefined && this.#beating?.generation !== generation) return;
    if (this.#beatTimer) clearTimeout(this.#beatTimer);
    this.#beatTimer = null;
    this.#beating = null;
    this.#again = false;
  }

  #scheduleBeat(ms: number) {
    if (this.#beatTimer) clearTimeout(this.#beatTimer);
    const due = this.#now() + ms;
    this.#beatTimer = setTimeout(() => {
      this.#beatTimer = null;
      const late = this.#now() - due;
      // Timers stop while the computer sleeps; more than a few seconds late means it did, or the window was throttled.
      if (late > 5_000) this.#log("warn", "heartbeat ran late", { lateSeconds: Math.round(late / 1000) });
      void this.#beat();
    }, ms);
  }

  async #beat(): Promise<void> {
    const beating = this.#beating;
    if (!beating || this.#inFlight === beating.generation) return;
    const { participationId, generation } = beating;
    const still = () => this.#beating?.generation === generation && this.#beating.participationId === participationId;
    this.#inFlight = generation;
    const sent = this.#now();
    try {
      await this.#options.api.heartbeat(participationId);
      if (!still()) return;
      this.#beats++;
      const quiet = sent - this.#lastOk;
      this.#lastOk = this.#now();
      if (this.#failures > 0) this.#log("info", "heartbeat ok again", { after: this.#failures, quietSeconds: Math.round(quiet / 1000) });
      else this.#log("debug", "heartbeat ok", { beat: this.#beats, ms: this.#now() - sent });
      // A beat every so often is also an info line, so the log shows presence without one line per beat.
      if (this.#beats % 15 === 1) this.#log("info", "heartbeats ok", { beats: this.#beats, join: short(participationId) });
      this.#failures = 0;
      this.#scheduleBeat(this.#again ? 0 : (this.#options.heartbeatMs ?? 20_000));
    } catch (error) {
      if (!still()) return;
      if (refused(error)) {
        // Ended here at once: LiveKit is disconnected and capture stops, whatever the room's own
        // removal is still doing. calls.leave would be refused the same way, so it isn't sent.
        this.#log("warn", "the room refused this join for good; ending the call here", { join: short(participationId), ...describe(error) });
        this.#generation++;
        void this.#drop({ quiet: true, leaveRoom: false });
        this.#options.onRemoved?.();
        return;
      }
      if (dropped(error)) {
        this.#log("warn", "the room dropped this join", { join: short(participationId), quietSeconds: Math.round((sent - this.#lastOk) / 1000) });
        const channelId = this.#state.channelId;
        if (channelId && this.#mayRejoin()) void this.#rejoin(channelId, "dropped", false);
        else {
          this.#generation++;
          void this.#drop({ quiet: true, leaveRoom: false });
        }
        return;
      }
      this.#failures++;
      const retry = this.#options.retryMs ?? [2_000, 4_000, 8_000];
      const wait = retry[Math.min(this.#failures - 1, retry.length - 1)]!;
      this.#log("warn", "heartbeat failed", { ...describe(error), failures: this.#failures, retryInSeconds: wait / 1000 });
      this.#scheduleBeat(wait);
    } finally {
      if (this.#inFlight === generation) this.#inFlight = null;
      if (still()) this.#again = false;
    }
  }

  #mayRejoin(): boolean {
    const now = this.#now();
    while (this.#rejoins.length && now - this.#rejoins[0]! > REJOIN_WINDOW_MS) this.#rejoins.shift();
    return !this.#disposed && this.#rejoins.length < MAX_REJOINS;
  }

  /**
   * Joins the channel again on its own. `leaveRoom` when the old join may still be live in the room.
   * Its own generation stands for the rejoin: a leave, a switch to another channel or a dispose
   * while the old room is still closing moves the generation on, and the rejoin stops there. Once
   * it's joining, `#join`'s own checks undo whatever it opened if the person moves on.
   */
  async #rejoin(channelId: string, why: string, leaveRoom: boolean): Promise<void> {
    this.#rejoins.push(this.#now());
    this.#log("warn", "joining the call again", { why, attempt: this.#rejoins.length });
    const token = ++this.#generation;
    await this.#drop({ quiet: true, leaveRoom, keep: true });
    if (this.#disposed || this.#generation !== token) {
      this.#log("info", "not joining again: you left or moved on meanwhile");
      return;
    }
    await this.#join(channelId, true);
  }

  /** Ends one join in the room, once. Never throws. */
  async #leaveInRoom(participationId: string): Promise<void> {
    if (this.#left.has(participationId)) return;
    this.#left.add(participationId);
    await this.#options.api.leave(participationId).catch(() => {});
  }

  /**
   * Disconnects the current room, stops the heartbeat and, if asked, ends the current join in the
   * room. `keep` leaves the state as reconnecting to the same channel instead of idle (a rejoin).
   */
  async #drop({ quiet, leaveRoom, keep = false }: { quiet: boolean; leaveRoom: boolean; keep?: boolean }): Promise<void> {
    this.#stopHeartbeat();
    const room = this.#room;
    this.#room = null;
    const { participationId, status, channelId } = this.#state;
    const wasIn = status === "connected" || status === "reconnecting";
    if (keep && channelId) this.#set({ ...IDLE, status: "reconnecting", channelId });
    else if (status !== "idle") this.#set(IDLE);
    const left = leaveRoom && participationId ? this.#leaveInRoom(participationId) : undefined;
    if (room) await room.disconnect().catch(() => {});
    if (!quiet && wasIn) this.#options.cue("leave");
    await left;
  }
}
