/**
 * The Notetaker (ADR 0008): an ordinary agent on the Room API. It watches
 * the calls it's asked to join, joins with `calls.join`, transcribes each
 * participant, and when the last person leaves posts call notes and proposes
 * tasks. A team member decides which proposed tasks become tasks.
 */
import { createHash } from "node:crypto";
import type { JoinMedia, MediaSession } from "./media.ts";
import { memberIdOf, SAMPLE_RATE } from "./media.ts";
import { ownerFor, safeName, type Summarizer } from "./summarize.ts";
import { Segmenter, type SegmenterOptions, type Utterance } from "./utterances.ts";
import type { TranscribeHints, Transcriber } from "./whisper.ts";

/** The part of the Room API client the Notetaker uses (`RoomClient` from @uplink-room/room-client). */
export type RoomApi = {
  call(fn: string, args?: Record<string, unknown>): Promise<unknown>;
  watch(fn: string, args: Record<string, unknown>, onUpdate: (result: unknown) => void, onError?: (error: Error) => void): () => void;
};

type Member = { memberId: string; name: string; kind: "person" | "agent" };
type Invite = { callId: string; channelId: string };
type CallView = {
  callId: string;
  channelId: string;
  endedAt?: number;
  participants: (Member & { takesNotes: boolean })[];
  everyone: Member[];
};

export type NotetakerOptions = {
  api: RoomApi;
  joinMedia: JoinMedia;
  transcribe: Transcriber;
  summarize: Summarizer;
  segmenter?: Omit<SegmenterOptions, "sampleRate">;
  heartbeatMs?: number;
  /** How long finishing keeps retrying lines the room hasn't taken before giving up (logged). */
  finishGiveUpMs?: number;
  /** Names this process for the agent's call lease (calls.claimLease). Default: a random id. */
  leaseHolder?: string;
  log?: (message: string) => void;
};

type Line = { speakerId: string; text: string; at: number; key: string };

type ActiveCall = {
  callId: string;
  channelId: string;
  /** This process's join of the call (calls.join's participationId); heartbeats and the leave name it. */
  participationId?: string;
  media?: MediaSession;
  segmenters: Map<string, Segmenter>;
  /** Transcription runs one utterance at a time, in order. */
  queue: Promise<void>;
  /** Heard but not yet in the room. A line leaves this list only once the room has it. */
  pending: Line[];
  flushing?: Promise<void>;
  heartbeat?: ReturnType<typeof setInterval>;
  heartbeatRetry?: ReturnType<typeof setTimeout>;
  heartbeatFailures: number;
  flusher?: ReturnType<typeof setInterval>;
  stopWatching?: () => void;
  finishing?: Promise<void>;
  /** For notes written for a call taken over from another process: whether this process may still write them. */
  mayWrite?: () => boolean;
  /** Names of the people who have been in the call, from the room's view of it. */
  callNames?: string[];
  /** Names of the team's other people (teams.members), which people in the call may mention. */
  teamNames?: string[];
  /** How many utterances the transcriber was sure were in each language. */
  languages?: Map<string, number>;
};

/** After a failed join, wait this long (doubling, up to a minute) before trying again. */
const JOIN_RETRY_MS = 5_000;
/** Retries of a join that reached the room but failed after, once its invite is gone. */
const MAX_LOCAL_JOIN_RETRIES = 6;
/** Finishing retries unsent lines for this long by default. */
const FINISH_GIVE_UP_MS = 10 * 60_000;
/** Writing the notes: the first retry waits this long, then the wait doubles. */
const RETRY_FIRST_MS = 1_000;
/** The summarizer runs at most this many times per call. */
const SUMMARY_ATTEMPTS = 3;
/** The agent's call lease lasts 45 seconds in the room; this process claims or renews it this often. */
const LEASE_RENEW_MS = 15_000;
/** The lease's length if the room doesn't say (calls.claimLease returns leaseMs). */
const LEASE_MS = 45_000;
/** This process treats its lease as gone this long before it runs out, for clock drift and slow replies. */
const LEASE_MARGIN_MS = 5_000;

/** A failed join. `reachedRoom`: calls.join succeeded (so the invite cleared) before something else failed. */
class JoinFailure extends Error {
  readonly reason: unknown;
  readonly reachedRoom: boolean;
  constructor(reason: unknown, reachedRoom: boolean) {
    super(String(reason));
    this.reason = reason;
    this.reachedRoom = reachedRoom;
  }
}

/** Thrown before a write this process may no longer make: another process may hold the lease and write the same notes. */
class LeaseLost extends Error {
  constructor() {
    super("this process no longer holds the call lease");
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The people's names, safe for a prompt or a log (safeName): agents and names with nothing left are skipped. */
function personNames(members: Member[]): string[] {
  return members.flatMap((m) => {
    const name = m.kind === "person" ? safeName(m.name) : undefined;
    return name ? [name] : [];
  });
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

export class Notetaker {
  readonly #options: NotetakerOptions;
  readonly #log: (message: string) => void;
  readonly #calls = new Map<string, ActiveCall>();
  /** The latest pending invites, from the live `calls.invitations` query. */
  #invites: Invite[] = [];
  readonly #retries = new Map<string, { timer: ReturnType<typeof setTimeout>; attempt: number }>();
  /** Joins in flight, so `stop()` can wait for them. */
  readonly #joining = new Map<string, Promise<void>>();
  #stopped = false;
  #stopInvites?: () => void;
  readonly #holder: string;
  #leaseTimer?: ReturnType<typeof setInterval>;
  /** When this process's lease runs out, by its own clock (with the margin taken off). */
  #leaseValidUntil = 0;
  /** Calls this process finished or took over: it never rejoins them or writes their notes again. */
  readonly #handled = new Set<string>();
  #recovering?: Promise<void>;
  /** Notes being written for calls taken over from a crashed process, so `stop()` can wait for them. */
  readonly #recoveryJobs = new Set<Promise<void>>();
  /**
   * Goes up each time this process starts or stops taking calls. A join remembers
   * the generation it started under and is undone if it changed by the time the
   * join is set up: another process may have held the lease meanwhile and joined
   * the same call.
   */
  #leaseGeneration = 0;
  /** Lease claims in flight, so `stop()` releases the lease only after the last one is answered. */
  readonly #ticks = new Set<Promise<void>>();
  /** Set once `stop()` has released the lease: no more claims. */
  #released = false;
  /** Invites not joined because the lease looked expired, to join once it's renewed. */
  readonly #skipped = new Set<string>();

  constructor(options: NotetakerOptions) {
    this.#options = options;
    this.#log = options.log ?? (() => {});
    this.#holder = options.leaseHolder ?? `notetaker-${crypto.randomUUID()}`;
  }

  /**
   * Starts taking calls. Only one process per agent does at a time: this one
   * claims the agent's call lease and watches invites only while it holds it,
   * renewing it every 15 seconds. Without it, it keeps trying, and takes over
   * once the holder stops renewing (a crash) or releases it (a clean stop).
   */
  start(): void {
    void this.#tickLease();
    this.#leaseTimer = setInterval(() => void this.#tickLease(), LEASE_RENEW_MS);
  }

  /** Whether this process holds the lease and is watching invites. */
  get takingCalls(): boolean {
    return this.#stopInvites !== undefined;
  }

  /** Whether the lease is still this process's by its own clock: every join needs it. */
  #leaseValid(): boolean {
    return Date.now() < this.#leaseValidUntil;
  }

  #tickLease(): Promise<void> {
    const tick: Promise<void> = this.#claimLease().finally(() => this.#ticks.delete(tick));
    this.#ticks.add(tick);
    return tick;
  }

  /**
   * Claims or renews the lease. While `stop()` drains notes it took over, it
   * only renews: it takes no new calls, and once the lease is gone it stops
   * claiming and those notes aren't written.
   */
  async #claimLease(): Promise<void> {
    if (this.#released || (this.#stopped && !this.#leaseValid())) return;
    let held: boolean;
    // Timed from before the request: the room started the lease no earlier than this.
    const sentAt = Date.now();
    try {
      const claim = (await this.#options.api.call("calls.claimLease", { holder: this.#holder })) as { held: boolean; leaseMs?: number };
      held = claim.held;
      this.#leaseValidUntil = held ? sentAt + (claim.leaseMs ?? LEASE_MS) - LEASE_MARGIN_MS : 0;
    } catch (error) {
      // A blip changes nothing while the lease lasts. Past its end, another process may hold it.
      this.#log(`Couldn't claim the call lease: ${String(error)}`);
      if (this.#stopInvites && !this.#leaseValid()) this.#stopTakingCalls("The call lease ran out while renewing failed: not taking new calls.");
      else if (this.#stopped && !this.#leaseValid()) this.#loseLeaseWhileStopping("The call lease ran out while renewing failed");
      return;
    }
    if (this.#stopped) {
      if (!held) this.#loseLeaseWhileStopping("Another process holds the call lease");
      return;
    }
    if (held && this.#stopInvites && this.#skipped.size > 0) {
      // Invites skipped while the lease looked expired are joined now.
      for (const invite of this.#invites.filter((i) => this.#skipped.has(i.callId))) this.#joinInvite(invite);
    }
    this.#skipped.clear();
    if (held) void this.#recover();
    if (held && !this.#stopInvites) {
      this.#log("Holding the call lease: taking calls.");
      this.#leaseGeneration++;
      this.#stopInvites = this.#options.api.watch(
        "calls.invitations",
        {},
        (result) => {
          this.#invites = (result as Invite[] | null) ?? [];
          for (const invite of this.#invites) this.#joinInvite(invite);
        },
        (error) => this.#log(`Watching invites failed: ${error.message}`),
      );
    } else if (!held && this.#stopInvites) {
      this.#stopTakingCalls("Another process holds the call lease: not taking new calls.");
    }
  }

  /** While stopping: the lease is gone, so notes taken over from another process are left to whoever holds it. */
  #loseLeaseWhileStopping(reason: string): void {
    this.#leaseGeneration++;
    if (this.#recoveryJobs.size > 0) this.#log(`${reason}: not writing the notes for calls I took over.`);
  }

  /** Stops watching invites and drops pending join retries. Calls already joined run to their end. */
  #stopTakingCalls(reason: string): void {
    this.#log(reason);
    this.#leaseGeneration++;
    this.#stopInvites?.();
    this.#stopInvites = undefined;
    this.#invites = [];
    for (const retry of this.#retries.values()) clearTimeout(retry.timer);
    this.#retries.clear();
  }

  /**
   * Takes over what a crashed process left (calls.unfinished): joins live calls
   * this agent was in and isn't any more, and writes notes and proposals for
   * calls that ended meanwhile. Proposal keys make a repeat harmless.
   */
  #recover(): Promise<void> {
    this.#recovering ??= (async () => {
      try {
        const calls = ((await this.#options.api.call("calls.unfinished")) as { callId: string; channelId: string; ended: boolean }[] | null) ?? [];
        for (const { callId, channelId, ended } of calls) {
          if (this.#stopped || !this.takingCalls || !this.#leaseValid()) return;
          if (this.#handled.has(callId) || this.#calls.has(callId) || this.#joining.has(callId)) continue;
          if (!ended) {
            this.#log(`Joining call ${callId} again: no Notetaker is in it.`);
            this.#joinInvite({ callId, channelId });
            continue;
          }
          this.#handled.add(callId);
          this.#log(`Writing the notes for call ${callId}: it ended while no Notetaker was in it.`);
          // Written only while this process holds the lease it took the call under.
          const generation = this.#leaseGeneration;
          const mayWrite = () => this.#leaseGeneration === generation && this.#leaseValid();
          const call: ActiveCall = { callId, channelId, segmenters: new Map(), queue: Promise.resolve(), pending: [], heartbeatFailures: 0, mayWrite };
          // Tracked so stop() waits for it: a process that exits mid-write could leave the notes without their proposals.
          const job: Promise<void> = this.#notes(call)
            .catch((error) => {
              this.#log(`Couldn't write the call notes: ${String(error)}`);
              // Abandoned with its lease: once this job is over, the next #recover() under a lease this process
              // holds again retries the call. Until then #handled keeps a second job for it from starting.
              if (error instanceof LeaseLost) this.#handled.delete(callId);
            })
            .finally(() => this.#recoveryJobs.delete(job));
          this.#recoveryJobs.add(job);
        }
      } catch (error) {
        this.#log(`Couldn't list unfinished calls (will try again): ${String(error)}`);
      } finally {
        this.#recovering = undefined;
      }
    })();
    return this.#recovering;
  }

  /** Whether this process still holds the lease it held at `generation`, by the room's last answer and its own clock. */
  #holdsLease(generation: number): boolean {
    return this.takingCalls && this.#leaseValid() && this.#leaseGeneration === generation && !this.#stopped;
  }

  /** Checks the lease with the room right now (a retry can fire between lease ticks). */
  async #stillHoldsLease(): Promise<boolean> {
    await this.#tickLease();
    return this.takingCalls && this.#leaseValid() && !this.#stopped;
  }

  /**
   * Joins an invite unless already in (or waiting to retry) that call. A failed
   * join is retried with backoff while the invite is pending. A join that got
   * into the room before failing (LiveKit unreachable) cleared its invite, so
   * it's retried from local state while the room says the call is live.
   */
  #joinInvite(invite: Invite, attempt = 0): void {
    // The lease must still be ours by this process's clock: another process may have it once it runs out.
    if (this.#stopped || !this.takingCalls) return;
    if (!this.#leaseValid()) {
      this.#skipped.add(invite.callId);
      return;
    }
    if (this.#calls.has(invite.callId) || (attempt === 0 && this.#retries.has(invite.callId))) return;
    this.#retries.delete(invite.callId);
    this.#startJoin(invite, this.#leaseGeneration).catch((error: unknown) => {
      if (this.#stopped) return;
      const reachedRoom = error instanceof JoinFailure && error.reachedRoom;
      this.#log(`Couldn't join ${invite.callId}: ${String(error instanceof JoinFailure ? error.reason : error)}`);
      this.#retryLater(invite, attempt, reachedRoom);
    });
  }

  /**
   * Tries the join again after a backoff: while the invite is pending, or, for
   * a join that reached the room before failing, while the room says the call
   * is live. If asking the room fails (a blip), it reschedules instead of giving
   * up, within the same attempt limit.
   */
  #retryLater(invite: Invite, attempt: number, reachedRoom: boolean): void {
    const delay = Math.min(JOIN_RETRY_MS * 2 ** attempt, 60_000);
    const timer = setTimeout(() => {
      this.#retries.delete(invite.callId);
      void (async () => {
        if (this.#stopped || this.#calls.has(invite.callId)) return;
        // Only while this process still holds the lease: another one may have taken over.
        if (!(await this.#stillHoldsLease())) return;
        const still = this.#invites.find((i) => i.callId === invite.callId);
        if (still) return this.#joinInvite(still, attempt + 1);
        if (!reachedRoom || attempt + 1 > MAX_LOCAL_JOIN_RETRIES) return;
        try {
          const view = (await this.#options.api.call("calls.get", { callId: invite.callId })) as CallView | null;
          if (view && view.endedAt === undefined && !this.#stopped) this.#joinInvite(invite, attempt + 1);
        } catch (getError) {
          this.#log(`Couldn't check call ${invite.callId} (will try again): ${String(getError)}`);
          if (!this.#stopped) this.#retryLater(invite, attempt + 1, reachedRoom);
        }
      })();
    }, delay);
    this.#retries.set(invite.callId, { timer, attempt });
  }

  /**
   * Leaves every call (writing what was heard) and stops watching invites. Joins
   * in flight are waited for and undone. Notes it's writing for a call it took
   * over are finished first, proposals included, while it keeps renewing the
   * lease (taking no new calls); only then is the lease released. If the lease
   * is lost meanwhile, those notes aren't written: the new holder writes them.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#stopInvites?.();
    this.#stopInvites = undefined;
    this.#invites = [];
    for (const retry of this.#retries.values()) clearTimeout(retry.timer);
    this.#retries.clear();
    // Calls already joined disconnect now; joins in flight undo themselves when they return.
    const leaving = [...this.#calls.values()].filter((call) => !this.#joining.has(call.callId)).map((call) => this.#finish(call, { summarize: false }));
    await Promise.allSettled(this.#joining.values());
    leaving.push(...[...this.#calls.values()].map((call) => this.#finish(call, { summarize: false })));
    // Listing unfinished calls stops at the next call once stopped; what it started is in #recoveryJobs.
    await this.#recovering;
    await Promise.all([...leaving, Promise.allSettled(this.#recoveryJobs)]);
    clearInterval(this.#leaseTimer);
    this.#released = true;
    await Promise.allSettled(this.#ticks);
    // Let another process take calls at once, rather than after the lease runs out.
    await this.#options.api.call("calls.releaseLease", { holder: this.#holder }).catch(() => {});
  }

  /** The calls it's in right now. */
  get activeCalls(): string[] {
    return [...this.#calls.keys()];
  }

  /** Joins a call, whether or not this process holds the lease (invites go through the lease; see #joinInvite). */
  join(invite: Invite): Promise<void> {
    return this.#startJoin(invite);
  }

  /** `leaseGeneration`: the lease this join needs; it's undone if that lease is gone once the join is set up. */
  #startJoin(invite: Invite, leaseGeneration?: number): Promise<void> {
    if (this.#calls.has(invite.callId) || this.#stopped) return Promise.resolve();
    const run = this.#join(invite, leaseGeneration).finally(() => this.#joining.delete(invite.callId));
    this.#joining.set(invite.callId, run);
    return run;
  }

  async #join(invite: Invite, leaseGeneration?: number): Promise<void> {
    const call: ActiveCall = {
      callId: invite.callId,
      channelId: invite.channelId,
      segmenters: new Map(),
      queue: Promise.resolve(),
      pending: [],
      heartbeatFailures: 0,
    };
    this.#calls.set(invite.callId, call);
    const api = this.#options.api;
    // Lost the lease this join started under: another process may have joined this call meanwhile.
    const leaseLost = () => leaseGeneration !== undefined && !this.#holdsLease(leaseGeneration);
    // Stopped, replaced or without its lease while this join was in flight: undo what it opened and stop.
    const abandoned = () => this.#stopped || this.#calls.get(call.callId) !== call || leaseLost();
    let reachedRoom = false;
    const undo = async () => {
      if (leaseLost() && !this.#stopped) this.#log(`Lost the call lease while joining call ${call.callId}: leaving it.`);
      if (this.#calls.get(call.callId) === call) this.#calls.delete(call.callId);
      await call.media?.leave().catch(() => {});
      if (call.participationId) await api.call("calls.leave", { participationId: call.participationId }).catch(() => {});
    };
    try {
      // With callId the room joins only this call, and never starts a new one if it ended.
      const { url, token, participationId } = (await api.call("calls.join", {
        channelId: invite.channelId,
        callId: invite.callId,
      })) as { url: string; token: string; participationId: string };
      reachedRoom = true;
      call.participationId = participationId;
      if (abandoned()) return await undo();
      call.media = await this.#options.joinMedia(url, token, {
        onAudio: (speakerId, frame, at) => this.#segmenter(call, speakerId).push(frame, at),
        onSpeakerGone: (speakerId) => call.segmenters.get(speakerId)?.flush(),
        onDisconnected: () => {
          this.#log(`LiveKit disconnected from call ${call.callId}.`);
          void this.#finish(call, { summarize: true });
        },
        onReplaced: () => {
          // Another process with this agent's identity joined: it takes over the call and its notes.
          this.#log(`Another Notetaker process took over call ${call.callId}; stopping here.`);
          void this.#finish(call, { summarize: false, leaveRoom: false });
        },
      });
      if (abandoned()) return await undo();
    } catch (error) {
      // Forget the failed join, so the next invite (or the retry) can try again.
      await undo();
      throw new JoinFailure(error, reachedRoom);
    }
    this.#log(`Joined call ${call.callId}.`);
    call.heartbeat = setInterval(() => void this.#beat(call), this.#options.heartbeatMs ?? 20_000);
    call.flusher = setInterval(() => void this.#flushLines(call), 3_000);
    // The team's names help speech-to-text spell people the call mentions. Without them it still works.
    api
      .call("teams.members")
      .then((members) => {
        call.teamNames = personNames((members as Member[] | null) ?? []);
      })
      .catch((error: unknown) => this.#log(`Couldn't list the team's members (names won't help transcription): ${String(error)}`));
    call.stopWatching = api.watch("calls.get", { callId: call.callId }, (result) => {
      const view = result as CallView | null;
      if (view) call.callNames = personNames(view.everyone);
      const peopleLeft = view?.participants.some((p) => p.kind === "person") ?? false;
      if (view && (view.endedAt !== undefined || !peopleLeft)) void this.#finish(call, { summarize: true });
    });
  }

  /**
   * One heartbeat. A failure never ends the notes: a network error is retried
   * with backoff, and if the room dropped the Notetaker (`conflict`) while the
   * call is still live, it joins again. Only the room (the call ended) or
   * LiveKit (disconnected for good) ends the notes.
   */
  async #beat(call: ActiveCall): Promise<void> {
    if (call.finishing) return;
    clearTimeout(call.heartbeatRetry);
    const api = this.#options.api;
    try {
      await api.call("calls.heartbeat", { participationId: call.participationId });
      call.heartbeatFailures = 0;
      return;
    } catch (error) {
      if (call.finishing) return;
      if (errorCode(error) === "conflict") {
        const stale = () => Boolean(call.finishing) || this.#stopped || this.#calls.get(call.callId) !== call;
        try {
          const view = (await api.call("calls.get", { callId: call.callId })) as CallView | null;
          // The call may have finished while we asked: never act on a stale view.
          if (stale()) return;
          if (view && view.endedAt === undefined) {
            // callId: the room refuses if this call ended meanwhile, instead of starting a new one.
            const rejoined = (await api.call("calls.join", { channelId: call.channelId, callId: call.callId })) as {
              participationId: string;
            };
            if (stale()) {
              // Finished (or replaced) while rejoining: end only the join this rejoin made.
              await api.call("calls.leave", { participationId: rejoined.participationId }).catch(() => {});
              return;
            }
            call.participationId = rejoined.participationId;
            this.#log(`Joined call ${call.callId} again after the room dropped me.`);
            call.heartbeatFailures = 0;
            return;
          }
        } catch (rejoinError) {
          if (stale()) return;
          this.#log(`Couldn't rejoin ${call.callId}: ${String(rejoinError)}`);
        }
      }
      if (call.finishing || this.#stopped) return;
      const code = errorCode(error);
      if (code === "unauthenticated" || code === "forbidden") {
        // The key was revoked or lost its scope: stop listening at once. It can't leave or write notes either.
        this.#log(`Not allowed in call ${call.callId} any more (${code}); disconnecting.`);
        void this.#finish(call, { summarize: false, leaveRoom: false, retryLines: false });
        return;
      }
      call.heartbeatFailures++;
      const delay = Math.min(1_000 * 2 ** call.heartbeatFailures, 15_000);
      this.#log(`Heartbeat failed (${String(error)}); trying again in ${delay / 1000}s.`);
      call.heartbeatRetry = setTimeout(() => void this.#beat(call), delay);
    }
  }

  #segmenter(call: ActiveCall, speakerId: string): Segmenter {
    let segmenter = call.segmenters.get(speakerId);
    if (!segmenter) {
      segmenter = new Segmenter(speakerId, { sampleRate: SAMPLE_RATE, ...this.#options.segmenter }, (u) => this.#heard(call, u));
      call.segmenters.set(speakerId, segmenter);
    }
    return segmenter;
  }

  #heard(call: ActiveCall, utterance: Utterance): void {
    call.queue = call.queue.then(async () => {
      try {
        // Read when the utterance's turn comes, so it uses every line heard before it.
        const result = await this.#options.transcribe(utterance, this.#hints(call));
        const { text, language } = typeof result === "string" ? { text: result, language: undefined } : result;
        if (language) {
          call.languages ??= new Map();
          call.languages.set(language, (call.languages.get(language) ?? 0) + 1);
        }
        // The key makes a retried upload idempotent in the room (calls.addTranscript).
        // Audio is cut per join (each device separately); the line names the member.
        if (text) call.pending.push({ speakerId: memberIdOf(utterance.speakerId), text, at: utterance.startedAt, key: crypto.randomUUID() });
      } catch (error) {
        this.#log(`Transcription failed: ${String(error)}`);
      }
    });
  }

  /** The call's names (its people first, then the rest of the team) and the language most of it has been in. */
  #hints(call: ActiveCall): TranscribeHints {
    const names = [...new Set([...(call.callNames ?? []), ...(call.teamNames ?? [])])];
    const language = [...(call.languages ?? new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0];
    return { ...(names.length ? { names } : {}), ...(language ? { language } : {}) };
  }

  /** Sends heard lines, 50 at a time. A batch leaves `pending` only after the room took it. */
  #flushLines(call: ActiveCall): Promise<void> {
    if (call.flushing) return call.flushing;
    const run = (async () => {
      try {
        while (call.pending.length > 0) {
          const lines = call.pending.slice(0, 50);
          await this.#options.api.call("calls.addTranscript", { callId: call.callId, lines });
          call.pending.splice(0, lines.length);
        }
      } catch (error) {
        this.#log(`Couldn't add to the transcript yet (kept to send again): ${String(error)}`);
      }
    })();
    // Stored before it's cleared, even when there was nothing to send and it finished at once.
    call.flushing = run;
    void run.then(() => {
      if (call.flushing === run) call.flushing = undefined;
    });
    return run;
  }

  /**
   * Ends note-taking for a call. Lines the room hasn't taken yet are retried
   * with backoff until it does; only after a long, logged give-up does it go on
   * without them, and then the notes still include them. `leaveRoom: false`
   * when another process replaced this one: it keeps the membership and writes
   * the notes.
   */
  #finish(
    call: ActiveCall,
    { summarize, leaveRoom = true, retryLines = true }: { summarize: boolean; leaveRoom?: boolean; retryLines?: boolean },
  ): Promise<void> {
    call.finishing ??= (async () => {
      this.#handled.add(call.callId);
      clearInterval(call.heartbeat);
      clearTimeout(call.heartbeatRetry);
      clearInterval(call.flusher);
      call.stopWatching?.();
      await call.media?.leave().catch(() => {});
      for (const segmenter of call.segmenters.values()) segmenter.flush();
      await call.queue;
      const giveUpMs = this.#options.finishGiveUpMs ?? FINISH_GIVE_UP_MS;
      const started = Date.now();
      for (let wait = 1_000; call.pending.length > 0; wait = Math.min(wait * 2, 30_000)) {
        await call.flushing;
        await this.#flushLines(call);
        if (call.pending.length === 0) break;
        if (!retryLines) {
          this.#log(`Dropped ${call.pending.length} line(s) of call ${call.callId}: not allowed to add them.`);
          break;
        }
        if (Date.now() - started >= giveUpMs) {
          this.#log(
            `Gave up adding ${call.pending.length} line(s) to the transcript of ${call.callId} after ${Math.round((Date.now() - started) / 1000)}s; the notes include them.`,
          );
          break;
        }
        await sleep(wait);
      }
      if (leaveRoom && call.participationId) {
        await this.#options.api.call("calls.leave", { participationId: call.participationId }).catch(() => {});
        this.#log(`Left call ${call.callId}.`);
      }
      if (summarize) await this.#notes(call).catch((error) => this.#log(`Couldn't write the call notes: ${String(error)}`));
      if (this.#calls.get(call.callId) === call) this.#calls.delete(call.callId);
    })();
    return call.finishing;
  }

  /**
   * Writes the call notes and proposes the tasks. A failed step is retried
   * with backoff until the finish give-up time; the summary is made once and
   * kept (at most three tries, since each runs the summarizer), so a retry
   * never posts different notes. Each proposed task carries a key from its
   * content, so the room proposes it once however often it's sent.
   */
  async #notes(call: ActiveCall): Promise<void> {
    const api = this.#options.api;
    const started = Date.now();
    const input = await this.#retry(call, started, "read the transcript", () => this.#notesInput(call));
    if (!input) return;
    let summary: Awaited<ReturnType<Summarizer>> | undefined;
    for (let attempt = 1; !summary; attempt++) {
      try {
        summary = await this.#options.summarize(input.summary);
      } catch (error) {
        if (attempt >= SUMMARY_ATTEMPTS) throw error;
        this.#log(`Summarizing call ${call.callId} failed (try ${attempt} of ${SUMMARY_ATTEMPTS}): ${String(error)}`);
        await sleep(RETRY_FIRST_MS * attempt);
      }
    }
    // Points that cite no transcript line, or a line the transcript doesn't have, aren't posted.
    if (summary.dropped?.length) this.#log(`Left ${summary.dropped.length} point(s) out of the notes for call ${call.callId}: they cite no line of the transcript, or one it doesn't have.`);
    const notes = summary.notes;
    await this.#retry(call, started, "post the call notes", () => api.call("calls.postNotes", { callId: call.callId, body: notes }));
    // Proposed even when there are none: that tells the room the notes are complete (calls.unfinished).
    const tasks = summary.tasks.map((task) => {
      const ownerId = ownerFor(task.owner, input.people)?.memberId;
      return {
        title: task.title,
        ...(task.description ? { description: task.description } : {}),
        ...(ownerId ? { ownerId } : {}),
        key: proposalKey(task.title, task.description, ownerId),
      };
    });
    await this.#retry(call, started, "propose the tasks", () => api.call("calls.propose", { callId: call.callId, tasks }));
  }

  /** What the summarizer gets: the room's transcript plus lines it never took. */
  async #notesInput(call: ActiveCall): Promise<{ summary: Parameters<Summarizer>[0]; people: Member[] } | null> {
    const api = this.#options.api;
    const transcript = (await api.call("calls.transcript", { callId: call.callId })) as {
      lines: { speaker: Member; text: string; at: number }[];
    };
    const view = (await api.call("calls.get", { callId: call.callId })) as CallView;
    // Lines the room never took (finishing gave up) still belong in the notes.
    const names = new Map(view.everyone.map((m) => [m.memberId, m]));
    const lines = [
      ...transcript.lines,
      ...call.pending.map((l) => ({
        speaker: names.get(l.speakerId) ?? { memberId: l.speakerId, name: "Someone", kind: "person" as const },
        text: l.text,
        at: l.at,
      })),
    ].sort((a, b) => a.at - b.at);
    if (lines.length === 0) return null;
    const channels = (await api.call("channels.list")) as { channelId: string; name: string }[];
    // Names go to the summarizer clean: no email addresses or line breaks, whatever a member picked.
    const people = view.everyone.filter((m) => m.kind === "person").map((m) => ({ ...m, name: safeName(m.name) ?? "Teammate" }));
    // The rest of the team, so a name the call mentions is spelled right. Optional: the notes don't need it.
    const team = ((await api.call("teams.members").catch(() => null)) as Member[] | null) ?? [];
    const inCall = new Set(people.map((p) => p.memberId));
    const others = personNames(team.filter((m) => !inCall.has(m.memberId)));
    // The language speech-to-text heard most picks the notes' headings. A call taken over from a crashed process has none: English.
    const language = this.#hints(call).language;
    return {
      people,
      summary: {
        channel: channels.find((c) => c.channelId === call.channelId)?.name ?? "channel",
        people: people.map((p) => p.name),
        ...(others.length ? { others } : {}),
        lines: lines.map((l) => ({ speaker: safeName(l.speaker.name) ?? "Teammate", text: l.text, at: l.at })),
        ...(language ? { language } : {}),
      },
    };
  }

  /** Runs `step` until it succeeds, with backoff, until the finish give-up time (counted from `started`); then throws its last error. */
  async #retry<T>(call: ActiveCall, started: number, what: string, step: () => Promise<T>): Promise<T> {
    const giveUpMs = this.#options.finishGiveUpMs ?? FINISH_GIVE_UP_MS;
    for (let wait = RETRY_FIRST_MS; ; wait = Math.min(wait * 2, 30_000)) {
      if (call.mayWrite && !call.mayWrite()) throw new LeaseLost();
      try {
        return await step();
      } catch (error) {
        if (this.#stopped || Date.now() - started + wait > giveUpMs) throw error;
        this.#log(`Couldn't ${what} for call ${call.callId}, trying again in ${Math.round(wait / 1000)}s: ${String(error)}`);
        await sleep(wait);
      }
    }
  }
}

/** A proposed task's key: the same task always gets the same key, so the room proposes it once. */
function proposalKey(title: string, description: string | undefined, ownerId: string | undefined): string {
  return createHash("sha256").update(JSON.stringify([title, description ?? "", ownerId ?? ""])).digest("hex").slice(0, 32);
}
