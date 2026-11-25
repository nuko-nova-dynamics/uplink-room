import type { BrowserProvider, StartedSession, StartOptions } from "../convex/lib/browserProvider";

/**
 * A browser provider that runs nothing and models what Hyperbeam does, standing
 * in for it in Room API tests:
 *  - roles are per connected user, and adding them is additive, as in
 *    Hyperbeam's `addRoles`/`removeRoles` (a control update is two calls, and a
 *    test can pause between them);
 *  - `disconnect` removes a user from the session;
 *  - `end` (Hyperbeam's DELETE) can be made to fail;
 *  - a session can end at Hyperbeam without any webhook reaching the room;
 *  - profiles (saved logins, ADR 0011): `"new"` makes a profile with an id of its
 *    own, never a session's (the real adapter uses a seed session nobody joins),
 *    `{ id }` loads that profile, and the profile is saved when the session
 *    ends, however it ends. A browser saves its logins; an erase session (#76)
 *    loads nothing and saves an empty profile over it. Two sessions running on
 *    one profile at once are recorded, since the later save would overwrite the
 *    earlier one;
 *  - opening a URL lands when its call returns, so the open page is the URL
 *    whose call returned last. A test can hold a call inside the provider,
 *    before the room's fence or after it, or stall it until it fails at its
 *    deadline;
 *  - a start can make its session and lose the answer, and a start with the
 *    tag of a session still running returns that session, as Hyperbeam's does.
 */
export function fakeBrowserProvider() {
  const started: StartOptions[] = [];
  const ended: string[] = [];
  const opened: { sessionId: string; url: string }[] = [];
  const disconnected: { sessionId: string; userId: string }[] = [];
  /** Who holds the control role in each session. */
  const control = new Map<string, Set<string>>();
  const terminated = new Set<string>();
  /** The profile each session saves to, and the one it loaded. */
  const savesTo = new Map<string, string>();
  const loaded = new Map<string, string>();
  const saves = new Map<string, number>();
  /** What each profile holds after its last save. */
  const contents = new Map<string, "logins" | "empty">();
  /** Erase sessions started, in order. */
  const erases: { sessionId: string; tag: string; profileId: string; authWebhookUrl: string }[] = [];
  const eraseSessions = new Set<string>();
  /** Profiles that had two sessions running at once. */
  const overlaps: string[] = [];
  let profiles = 0;
  let failNextStart: string | undefined;
  let failingEnds = 0;
  let failingOpenUrls = 0;
  let loseNextStartAnswer = false;
  let crashAfterNextStart = false;
  let failingTagLookups = 0;
  let failingControlUpdates = 0;
  let failingEraseStarts = 0;
  let failingEraseEnds = 0;
  /** Every control update asked for, including ones that failed. */
  const controlUpdates: { sessionId: string; controllers: string[] }[] = [];
  let pause: { reached: () => void; released: Promise<void> } | undefined;
  let holdOpen: { at: "query" | "change"; reached: () => void; released: Promise<"land" | "fail"> } | undefined;
  let holdStart: { reached: () => void; released: Promise<void> } | undefined;
  let holdEnd: { reached: () => void; released: Promise<void> } | undefined;
  /** Tag lookups for starts whose answer was lost. */
  const tagLookups: string[] = [];

  /** Hyperbeam saves the session's profile when the session terminates. */
  const terminate = (sessionId: string) => {
    if (terminated.has(sessionId)) return;
    terminated.add(sessionId);
    const profileId = savesTo.get(sessionId);
    if (profileId) {
      saves.set(profileId, (saves.get(profileId) ?? 0) + 1);
      contents.set(profileId, eraseSessions.has(sessionId) ? "empty" : "logins");
    }
  };

  /** A new session on `profileId`: note it if another one on that profile still runs. */
  const claimProfile = (sessionId: string, profileId: string) => {
    for (const [other, profile] of [...savesTo, ...loaded]) {
      if (other !== sessionId && profile === profileId && !terminated.has(other)) overlaps.push(profileId);
    }
  };

  const holders = (sessionId: string) => {
    let set = control.get(sessionId);
    if (!set) control.set(sessionId, (set = new Set()));
    return set;
  };

  /** A test's handle on a call held inside the provider. `reached` resolves once the call is held. */
  function hold<T>(set: (h: { reached: () => void; released: Promise<T> }) => void) {
    let reached!: () => void;
    let release!: (outcome: T) => void;
    const reachedP = new Promise<void>((r) => (reached = r));
    const released = new Promise<T>((r) => (release = r));
    set({ reached, released });
    return { reached: reachedP, release };
  }

  const provider: BrowserProvider = {
    name: "fake",
    async start(options) {
      if (failNextStart) {
        const reason = failNextStart;
        failNextStart = undefined;
        throw new Error(reason);
      }
      if (holdStart) {
        const h = holdStart;
        holdStart = undefined;
        h.reached();
        await h.released;
      }
      started.push(options);
      const n = started.length;
      const sessionId = `session-${n}`;
      const profileId =
        options.profile === undefined ? undefined : options.profile === "new" ? `profile-${++profiles}` : options.profile.id;
      if (profileId) {
        claimProfile(sessionId, profileId);
        savesTo.set(sessionId, profileId);
      }
      if (options.profile !== undefined && options.profile !== "new") loaded.set(sessionId, options.profile.id);
      if (loseNextStartAnswer) {
        // Hyperbeam made the session, and its answer never reached the room.
        loseNextStartAnswer = false;
        throw new Error("fetch failed: the connection was reset");
      }
      if (crashAfterNextStart) {
        // Hyperbeam made the session, and provisioning dies before it reports it: an answer the room
        // can't record stands in for an action that crashed or hit Convex's 10-minute limit.
        crashAfterNextStart = false;
        return { sessionId, embedUrl: "x", adminToken: "x", openAfterStart: 42 as unknown as string } satisfies StartedSession;
      }
      return {
        sessionId,
        embedUrl: `https://fake${n}.hyperbeam.test/s${n}?token=embed-${n}`,
        adminToken: `admin-${n}`,
        ...(profileId ? { profileId } : {}),
        // Hyperbeam ignores start_url when a session loads a profile, so the room opens it afterwards.
        ...(profileId && options.startUrl ? { openAfterStart: options.startUrl } : {}),
      } satisfies StartedSession;
    },
    async end(sessionId) {
      if (holdEnd) {
        const h = holdEnd;
        holdEnd = undefined;
        h.reached();
        await h.released;
      }
      if (failingEnds > 0) {
        failingEnds--;
        throw new Error("Hyperbeam answered 503: try again");
      }
      ended.push(sessionId);
      terminate(sessionId);
    },
    async hasEnded(sessionId) {
      return terminated.has(sessionId);
    },
    async setControl(session, controllers) {
      controlUpdates.push({ sessionId: session.sessionId, controllers: [...controllers] });
      if (failingControlUpdates > 0) {
        failingControlUpdates--;
        throw new Error("Hyperbeam didn't answer within 10 s");
      }
      // removeRoles(controllers, roles, exclusive=true), then addRoles(controllers, roles).
      const set = holders(session.sessionId);
      for (const user of [...set]) if (!controllers.includes(user)) set.delete(user);
      if (pause) {
        const p = pause;
        pause = undefined;
        p.reached();
        await p.released;
      }
      for (const user of controllers) set.add(user);
    },
    async openUrl(session, url, beforeChange) {
      if (failingOpenUrls > 0) {
        failingOpenUrls--;
        throw new Error("Hyperbeam didn't answer within 10 s");
      }
      /** Holds the call here if the test asked to, then fails it or goes on. */
      const maybeHold = async (at: "query" | "change") => {
        if (holdOpen?.at !== at) return;
        const h = holdOpen;
        holdOpen = undefined;
        h.reached();
        if ((await h.released) === "fail") throw new Error("Hyperbeam didn't answer within 10 s");
      };
      // tabs.query, then the room's fence, then tabs.update, which changes the page.
      await maybeHold("query");
      if (beforeChange && !(await beforeChange())) return "refused";
      await maybeHold("change");
      opened.push({ sessionId: session.sessionId, url });
      return "opened";
    },
    async disconnect(session, userIds) {
      for (const userId of userIds) {
        disconnected.push({ sessionId: session.sessionId, userId });
        holders(session.sessionId).delete(userId);
      }
    },
    async startErase(options) {
      if (failingEraseStarts > 0) {
        failingEraseStarts--;
        throw new Error("Hyperbeam answered 502");
      }
      // A session with this tag still running is returned instead of a second one, as Hyperbeam does.
      const running = erases.find((e) => e.tag === options.tag && !terminated.has(e.sessionId));
      if (running) return { sessionId: running.sessionId };
      const sessionId = `erase-${erases.length + 1}`;
      claimProfile(sessionId, options.profileId);
      erases.push({ sessionId, ...options });
      eraseSessions.add(sessionId);
      savesTo.set(sessionId, options.profileId);
      return { sessionId };
    },
    async endTagged({ tag }) {
      tagLookups.push(tag);
      if (failingTagLookups > 0) {
        failingTagLookups--;
        throw new Error("Hyperbeam answered 502");
      }
      const index = started.findIndex((o, i) => o.tag === tag && !terminated.has(`session-${i + 1}`));
      // Still running: that session comes back and is ended. Otherwise a harmless new one is made and ended.
      if (index >= 0) {
        const sessionId = `session-${index + 1}`;
        ended.push(sessionId);
        terminate(sessionId);
      }
      return true;
    },
    async endErase(sessionId) {
      if (failingEraseEnds > 0) {
        failingEraseEnds--;
        throw new Error("Hyperbeam didn't answer within 15 s");
      }
      ended.push(sessionId);
      terminate(sessionId);
      return true;
    },
  };

  return {
    provider,
    started,
    ended,
    opened,
    disconnected,
    erases,
    overlaps,
    /** Who may use the mouse and keyboard in a session right now. */
    controllers: (sessionId: string) => [...holders(sessionId)].sort(),
    /** The page a session shows: the URL whose call returned last. */
    openPage: (sessionId: string) => opened.filter((o) => o.sessionId === sessionId).at(-1)?.url,
    /** Hyperbeam ended this session by itself, such as on a timeout, and no webhook may arrive. */
    terminate,
    /** How many times a profile was saved: once each time a session using it ended. */
    profileSaves: (profileId: string) => saves.get(profileId) ?? 0,
    /** What a profile holds: the logins a browser saved, or the empty browser an erase saved over them. */
    profileContents: (profileId: string) => contents.get(profileId),
    /** How many sessions loaded a profile. */
    profileLoads: (profileId: string) => [...loaded.values()].filter((p) => p === profileId).length,
    /** The profile a session saves to when it ends, if any. */
    savesTo: (sessionId: string) => savesTo.get(sessionId),
    /** The profile a session started from, if it loaded one. */
    loadedProfile: (sessionId: string) => loaded.get(sessionId),
    isTerminated: (sessionId: string) => terminated.has(sessionId),
    failNextStart: (reason: string) => {
      failNextStart = reason;
    },
    controlUpdates,
    /** The next `n` control updates fail, as a stalled Hyperbeam call would at its deadline. */
    failControlUpdates: (n: number) => {
      failingControlUpdates = n;
    },
    /** The next URL opened fails, as a stalled Hyperbeam session endpoint would at its deadline. */
    failNextOpenUrl: () => {
      failingOpenUrls = 1;
    },
    /** The next `n` URLs opened fail. */
    failOpenUrls: (n: number) => {
      failingOpenUrls = n;
    },
    /** The next start makes its session, then its answer is lost. */
    loseNextStartAnswer: () => {
      loseNextStartAnswer = true;
    },
    /** The next start makes its session, then provisioning dies before reporting it. */
    crashAfterNextStart: () => {
      crashAfterNextStart = true;
    },
    /** The next `n` lookups by tag fail. */
    failTagLookups: (n: number) => {
      failingTagLookups = n;
    },
    tagLookups,
    /** The next `n` DELETEs fail, as a transient Hyperbeam error would. */
    failEnds: (n: number) => {
      failingEnds = n;
    },
    /** The next `n` erase sessions fail to start, and the next `m` fail to end. */
    failErases: (n: number, m = 0) => {
      failingEraseStarts = n;
      failingEraseEnds = m;
    },
    /**
     * The next control update stops between its remove and add calls until
     * `release()`. `reached` resolves once it is paused there.
     */
    pauseNextControlUpdate: () => {
      const handle = hold<void>((h) => (pause = h));
      return { reached: handle.reached, release: () => handle.release() };
    },
    /**
     * The next URL opened is held inside its provider call: at "query" (its
     * first call, before the room's fence) or at "change" (after the fence,
     * while the page changes). `release("land")` goes on, and `release("fail")`
     * fails it, as its deadline would.
     */
    holdNextOpenUrl: (at: "query" | "change" = "query") => hold<"land" | "fail">((h) => (holdOpen = { at, ...h })),
    /** The next DELETE is held until `release()`, as a stalled Hyperbeam call would be. */
    holdNextEnd: () => {
      const handle = hold<void>((h) => (holdEnd = h));
      return { reached: handle.reached, release: () => handle.release() };
    },
    /** The next start is held inside the provider until `release()`. */
    holdNextStart: () => {
      const handle = hold<void>((h) => (holdStart = h));
      return { reached: handle.reached, release: () => handle.release() };
    },
  };
}

export type FakeBrowserProvider = ReturnType<typeof fakeBrowserProvider>;
