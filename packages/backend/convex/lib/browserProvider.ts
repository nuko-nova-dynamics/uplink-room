/**
 * Where shared browsers run (spec #7, ADR 0006). The Room API talks to a
 * provider only through this interface, so Hyperbeam can be replaced and
 * tests can use a fake.
 *
 * The real provider is Hyperbeam, configured by `HYPERBEAM_API_KEY` in the
 * Convex environment. Without the key there is no provider: shared browsers
 * are "not configured" and `browsers.start` fails with `not_configured`.
 *
 * Saved logins (ADR 0011) are Hyperbeam profiles: the provider saves a
 * session's browser state when the session ends, and loads it into a later
 * one. Forgotten saved logins are erased by saving an empty browser over
 * their profile (#76). Only the backend ever sees a profile's id.
 */

/** A running cloud browser. `adminToken` and `embedUrl` never leave the backend except through `browsers.join`. */
export type BrowserSession = {
  sessionId: string;
  embedUrl: string;
  adminToken: string;
};

/** A started session, and the profile it saves to when one was asked for. */
export type StartedSession = BrowserSession & {
  /** The profile this session saves to when it ends. Unset for a temporary browser. Never leaves the backend. */
  profileId?: string;
  /**
   * A start URL the provider couldn't open when the session started. The room
   * opens it once it has recorded the session, so a stalled navigation can't
   * keep the session from being recorded.
   */
  openAfterStart?: string;
};

/**
 * Saved logins for a session (ADR 0011). `"new"` makes a new profile and saves
 * the session's state to it; `{ id }` loads that profile and saves back to it.
 * Unset: nothing is saved or loaded. A profile's id is never the id of a
 * session anyone joins.
 */
export type ProfileOption = "new" | { id: string };

export type StartOptions = {
  /** Unique per shared browser, so a retried start returns the same session instead of a second one. */
  tag: string;
  startUrl?: string;
  profile?: ProfileOption;
  timeouts: {
    /** Seconds with no input before the browser ends (the idle timeout). */
    inactiveSec: number;
    /** Seconds with nobody connected before the browser ends. */
    offlineSec: number;
    /** Seconds after it starts before the browser ends (the longest session). */
    absoluteSec: number;
    /** Seconds of warning before a timeout ends the browser. */
    warningSec: number;
  };
  /** Our auth webhook: the provider asks it whether each new connection may join. */
  authWebhook: { url: string; bearer: string };
  /** Our timeout webhook: the provider tells it when a timeout fires. */
  timeoutWebhook: { url: string; bearer: string };
};

/** A session that erases saved logins (#76). */
export type EraseOptions = {
  /** Unique per saved logins, so a retried start returns the erase session still running instead of a second one. */
  tag: string;
  /** The profile to erase. */
  profileId: string;
  /** Our auth webhook. The session gets a bearer that is stored nowhere, so it admits nobody. */
  authWebhookUrl: string;
};

export interface BrowserProvider {
  readonly name: string;
  start(options: StartOptions): Promise<StartedSession>;
  end(sessionId: string): Promise<void>;
  /** True once the session has terminated. */
  hasEnded(sessionId: string): Promise<boolean>;
  /** Only these provider user IDs may use the mouse and keyboard; everyone else watches. */
  setControl(session: BrowserSession, controllers: string[]): Promise<void>;
  /**
   * Loads a URL in the browser's active tab. `beforeChange` runs right before the call that
   * changes the page; if it answers false, the page is left as it is and the answer is "refused".
   */
  openUrl(session: BrowserSession, url: string, beforeChange?: () => Promise<boolean>): Promise<"opened" | "refused">;
  /** Disconnects these provider users. They can't come back without a new ticket. */
  disconnect(session: BrowserSession, userIds: string[]): Promise<void>;
  /**
   * Ends the session started with `tag`, if one still runs, for a start whose answer was lost.
   * True once no session with that tag runs.
   */
  endTagged(options: { tag: string; authWebhookUrl: string }): Promise<boolean>;
  /**
   * Starts erasing a profile: a session that loads nothing and saves to the
   * profile when it ends, so an empty browser replaces the saved logins.
   * Nobody can join it, and only its id leaves the provider.
   */
  startErase(options: EraseOptions): Promise<{ sessionId: string }>;
  /** Ends an erase session. True once it has ended, which is when the provider saves the empty profile. */
  endErase(sessionId: string): Promise<boolean>;
}

/** Roles the driver's connections get. Nobody else has any (ADR 0006). */
export const DRIVER_ROLES = ["control", "clipboard_copy"] as const;

const ENGINE = "https://engine.hyperbeam.com/v0/vm";

class ProviderError extends Error {}

/**
 * Hyperbeam's REST API, as documented at docs.hyperbeam.com (checked 2026-11-02,
 * and "Start Chromium Session" again on 2026-11-03). It has no call to delete a
 * saved profile, but a session started with `profile: { save: <id> }` overwrites
 * that profile when it ends, which is how forgotten saved logins are erased.
 */
export function hyperbeamProvider(
  apiKey: string,
  fetchFn: typeof fetch = (...a) => fetch(...a),
  {
    retryDelayMs = 500,
    sessionCallTimeoutMs = 10_000,
    engineCallTimeoutMs = 15_000,
    startCallTimeoutMs = 30_000,
  }: { retryDelayMs?: number; sessionCallTimeoutMs?: number; engineCallTimeoutMs?: number; startCallTimeoutMs?: number } = {},
): BrowserProvider {
  async function call(url: string, init: { method: string; token: string; body?: unknown; timeoutMs?: number }) {
    if (init.timeoutMs === undefined) return send(url, init);
    // A Convex action runs at most 10 minutes and isn't retried, so a call that may stall gets a deadline.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs);
    try {
      return await send(url, init, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw new ProviderError(`Hyperbeam didn't answer within ${init.timeoutMs / 1000} s.`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async function send(url: string, init: { method: string; token: string; body?: unknown }, signal?: AbortSignal) {
    const response = await fetchFn(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${init.token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderError(`Hyperbeam answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    // Hyperbeam sends its JSON as `text/plain; charset=utf-8` (seen live, 2026-11-02), so parse
    // whatever came back instead of trusting the header. An empty or non-JSON body is no answer.
    const text = await response.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }
  /** Session endpoints live at the embed URL without its query string. */
  const baseUrl = (session: BrowserSession) => session.embedUrl.split("?")[0]!;

  /** Session endpoint calls (tabs, roles, users) each get this deadline. */
  const timeoutMs = sessionCallTimeoutMs;

  /** Loads a URL in the active tab, or a new tab when none is found. Each call has a deadline. */
  async function openUrl(session: BrowserSession, url: string, beforeChange?: () => Promise<boolean>) {
    const token = session.adminToken;
    // Session endpoints answer `{ "result": ... }` (seen live, 2026-11-02).
    const answer = (await call(`${baseUrl(session)}/tabs.query`, { method: "POST", token, body: [{ active: true }], timeoutMs })) as
      | { result?: { id?: number }[] }
      | { id?: number }[]
      | null;
    const tabs = Array.isArray(answer) ? answer : answer?.result;
    const tabId = Array.isArray(tabs) ? tabs.find((t) => typeof t.id === "number")?.id : undefined;
    if (beforeChange && !(await beforeChange())) return "refused" as const;
    if (tabId === undefined) {
      await call(`${baseUrl(session)}/tabs.create`, { method: "POST", token, body: [{ url, active: true }], timeoutMs });
    } else {
      await call(`${baseUrl(session)}/tabs.update`, { method: "POST", token, body: [tabId, { url }], timeoutMs });
    }
    return "opened" as const;
  }

  /** Starts a session, saying plainly when the account can't use profiles. */
  async function post(body: Record<string, unknown>, timeoutMs?: number): Promise<BrowserSession> {
    let data: Record<string, unknown> | null;
    try {
      data = (await call(ENGINE, { method: "POST", token: apiKey, body, ...(timeoutMs ? { timeoutMs } : {}) })) as Record<
        string,
        unknown
      > | null;
    } catch (error) {
      // Profiles are an account feature Hyperbeam turns on by request; without it every form of
      // `profile` is refused with `err_api_restricted` (seen live on the dev key, 2026-11-02).
      if ("profile" in body && String(error).includes("err_api_restricted")) {
        throw new ProviderError(
          "Hyperbeam hasn't turned on saved logins (profiles) for this account. Ask Hyperbeam to enable them, or start a temporary browser.",
        );
      }
      throw error;
    }
    const sessionId = data?.["session_id"];
    const embedUrl = data?.["embed_url"];
    const adminToken = data?.["admin_token"];
    if (typeof sessionId !== "string" || typeof embedUrl !== "string" || typeof adminToken !== "string") {
      throw new ProviderError("Hyperbeam's answer had no session.");
    }
    return { sessionId, embedUrl, adminToken };
  }

  return {
    name: "hyperbeam",
    async start(o) {
      // Every call here has a deadline, so a stalled Hyperbeam ends in an error the room handles
      // (`provision`'s catch) instead of leaving the browser starting.
      // A profile's id is the id of the session that created it, and an embed URL's path is its
      // session id in base64url. So a new profile is made by a seed session nobody joins: its
      // embed URL never leaves this function, its auth webhook bearer is random and stored
      // nowhere, and it is ended at once. Visible sessions then load that profile and save back
      // to it by id (`profile: { load, save }`, docs.hyperbeam.com "Starting a Chromium
      // Session"), so nobody who joins a browser can read the profile id from its URL.
      let profileId: string | undefined;
      if (o.profile === "new") {
        const seed = await post({
          tag: `${o.tag}:profile-seed`,
          region: "NA",
          profile: true,
          default_roles: [],
          auth: { type: "webhook", value: { url: o.authWebhook.url, bearer: crypto.randomUUID() } },
          timeout: { offline: 120, absolute: 300 },
        }, startCallTimeoutMs);
        profileId = seed.sessionId;
        // The seed saves its (empty) profile when it ends. If it were still running when a
        // browser loads and saves the same id, its later save could overwrite real logins. So it
        // is ended and confirmed ended before any browser uses the profile; otherwise nothing
        // starts, and the seed's own timeouts end it with no browser depending on its profile.
        const seedUrl = `${ENGINE}/${encodeURIComponent(seed.sessionId)}`;
        let ended = false;
        for (let attempt = 0; attempt < 3 && !ended; attempt++) {
          if (attempt > 0 && retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
          await call(seedUrl, { method: "DELETE", token: apiKey, timeoutMs: engineCallTimeoutMs }).catch(() => {});
          const state = (await call(seedUrl, { method: "GET", token: apiKey, timeoutMs: engineCallTimeoutMs }).catch(() => null)) as Record<
            string,
            unknown
          > | null;
          ended = state?.["termination_date"] != null;
        }
        if (!ended) {
          throw new ProviderError("Couldn't finish setting up saved logins at Hyperbeam. Try again, or start a temporary browser.");
        }
      } else if (o.profile !== undefined) {
        profileId = o.profile.id;
      }

      const session = await post({
        ...(o.startUrl ? { start_url: o.startUrl } : {}),
        tag: o.tag,
        region: "NA",
        ...(profileId ? { profile: { load: profileId, save: profileId } } : {}),
        // Nobody may click or type until the backend makes them the driver.
        default_roles: [],
        auth: { type: "webhook", value: o.authWebhook },
        timeout: {
          inactive: o.timeouts.inactiveSec,
          offline: o.timeouts.offlineSec,
          absolute: o.timeouts.absoluteSec,
          warning: o.timeouts.warningSec,
          webhook: o.timeoutWebhook,
        },
      }, startCallTimeoutMs);
      // Hyperbeam ignores `start_url` when a session loads a profile: it opens the profile's restored
      // tabs, or a New Tab for an empty one (seen live, 2026-11-03). So the room opens the start URL
      // after it has recorded the session.
      return {
        ...session,
        ...(profileId ? { profileId } : {}),
        ...(profileId && o.startUrl ? { openAfterStart: o.startUrl } : {}),
      };
    },
    // A stalled DELETE or lookup gives up at its deadline, so a stop try always reports back.
    async end(sessionId) {
      await call(`${ENGINE}/${encodeURIComponent(sessionId)}`, { method: "DELETE", token: apiKey, timeoutMs: engineCallTimeoutMs });
    },
    async hasEnded(sessionId) {
      const data = (await call(`${ENGINE}/${encodeURIComponent(sessionId)}`, {
        method: "GET",
        token: apiKey,
        timeoutMs: engineCallTimeoutMs,
      })) as Record<string, unknown> | null;
      return data?.["termination_date"] != null;
    },
    async endTagged(o) {
      // Hyperbeam's session list and lookups don't show tags, but a start with the tag of a session
      // still running returns that session instead of a new one (docs.hyperbeam.com, "Start Chromium
      // Session", `tag`). So this starts with the tag, and a body that is harmless if nothing runs
      // and a new session is made: no profile, no start URL, no roles, an auth bearer stored
      // nowhere, and short timeouts. Whichever session comes back is ended and confirmed ended.
      const data = (await call(ENGINE, {
        method: "POST",
        token: apiKey,
        timeoutMs: engineCallTimeoutMs,
        body: {
          tag: o.tag,
          region: "NA",
          default_roles: [],
          auth: { type: "webhook", value: { url: o.authWebhookUrl, bearer: crypto.randomUUID() } },
          timeout: { offline: 60, absolute: 120 },
        },
      })) as Record<string, unknown> | null;
      const sessionId = data?.["session_id"];
      if (typeof sessionId !== "string") throw new ProviderError("Hyperbeam's answer had no session.");
      const url = `${ENGINE}/${encodeURIComponent(sessionId)}`;
      await call(url, { method: "DELETE", token: apiKey, timeoutMs: engineCallTimeoutMs }).catch(() => {});
      const state = (await call(url, { method: "GET", token: apiKey, timeoutMs: engineCallTimeoutMs })) as Record<
        string,
        unknown
      > | null;
      return state?.["termination_date"] != null;
    },
    async setControl(session, controllers) {
      const token = session.adminToken;
      // Exclusive: take the roles from everyone except the controllers (from everyone, if none).
      await call(`${baseUrl(session)}/removeRoles`, { method: "POST", token, body: [controllers, DRIVER_ROLES, true], timeoutMs });
      if (controllers.length > 0) {
        await call(`${baseUrl(session)}/addRoles`, { method: "POST", token, body: [controllers, DRIVER_ROLES], timeoutMs });
      }
    },
    openUrl,
    async disconnect(session, userIds) {
      for (const userId of userIds) {
        await call(`${baseUrl(session)}/users/${encodeURIComponent(userId)}`, {
          method: "DELETE",
          token: session.adminToken,
          timeoutMs,
        });
      }
    },
    async startErase(o) {
      // `save` with a session id overwrites that profile when the session ends, and nothing is
      // loaded, so the session's empty browser replaces the saved logins (docs.hyperbeam.com,
      // "Start Chromium Session"; seen live on 2026-11-03, ADR 0011). Like the seed, nobody joins
      // it: its embed URL and admin token never leave this function, and its auth webhook bearer
      // is random and stored nowhere. If the room never ends it, its own timeouts do, and it
      // saves then. Every call has a deadline, so a try always reports back.
      const session = await post(
        {
          tag: o.tag,
          region: "NA",
          profile: { save: o.profileId },
          default_roles: [],
          auth: { type: "webhook", value: { url: o.authWebhookUrl, bearer: crypto.randomUUID() } },
          timeout: { offline: 120, absolute: 300 },
        },
        engineCallTimeoutMs,
      );
      return { sessionId: session.sessionId };
    },
    async endErase(sessionId) {
      const url = `${ENGINE}/${encodeURIComponent(sessionId)}`;
      // A DELETE can fail because the session already ended (by its own timeouts); ask either way.
      await call(url, { method: "DELETE", token: apiKey, timeoutMs: engineCallTimeoutMs }).catch(() => {});
      const state = (await call(url, { method: "GET", token: apiKey, timeoutMs: engineCallTimeoutMs })) as Record<
        string,
        unknown
      > | null;
      return state?.["termination_date"] != null;
    },
  };
}

/** Where this deployment's HTTP actions (our webhooks) live. Convex sets CONVEX_SITE_URL in every deployment. */
export function siteUrl(): string {
  return (process.env["CONVEX_SITE_URL"] ?? "https://convex-site.invalid").replace(/\/$/, "");
}

let override: BrowserProvider | null | undefined;

/** Tests swap in a fake (or `null` for "not configured"); `undefined` goes back to the environment. */
export function setBrowserProviderForTests(provider: BrowserProvider | null | undefined): void {
  override = provider;
}

/** The configured provider, or null when shared browsers aren't configured. */
export function browserProvider(): BrowserProvider | null {
  if (override !== undefined) return override;
  const key = process.env["HYPERBEAM_API_KEY"];
  return key ? hyperbeamProvider(key) : null;
}

/** The env var an admin sets to turn shared browsers on. The UI and errors name it. */
export const PROVIDER_ENV_VAR = "HYPERBEAM_API_KEY";
