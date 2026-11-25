import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { PostHog } from "posthog-node";
import { isId, POSTHOG_HOST, scrubEvent, type EventName, type EventProps } from "./analyticsSpec";

/**
 * "Share usage data" and this install's anonymous ID, kept in the main process so both processes
 * read one setting and main knows it before any window opens. On by default.
 */
export type Consent = { enabled: boolean; deviceId: string };

/** Who is signed in, once the renderer has opened a team: member and team IDs, nothing else. */
export type Identity = { memberId: string; teamId: string };

/** Reads the setting from `file`, or starts one (on, with a new anonymous ID) if it's missing or unreadable. */
export function loadConsent(file: string): Consent {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Consent>;
    if (typeof parsed.enabled === "boolean" && typeof parsed.deviceId === "string" && parsed.deviceId) {
      return { enabled: parsed.enabled, deviceId: parsed.deviceId };
    }
  } catch {
    // First launch, or a damaged file: start over.
  }
  const fresh = { enabled: true, deviceId: randomUUID() };
  saveConsent(file, fresh);
  return fresh;
}

function saveConsent(file: string, consent: Consent): void {
  try {
    writeFileSync(file, JSON.stringify(consent));
  } catch (error) {
    console.warn("Uplink Room: couldn't save the usage data setting.", error);
  }
}

export function parseIdentity(value: unknown): Identity | null {
  const v = value as Partial<Identity> | null;
  return v && isId(v.memberId) && isId(v.teamId) ? { memberId: v.memberId, teamId: v.teamId } : null;
}

type Client = Pick<PostHog, "captureImmediate" | "shutdown">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MainAnalyticsOptions {
  key: string | undefined;
  file: string;
  /** For tests: the HTTP client posthog-node sends with. */
  fetch?: typeof fetch;
}

/**
 * Main-process events (posthog-node). Each one is sent at once with `captureImmediate`, so
 * nothing waits in a queue: once "Share usage data" is off, nothing more leaves the app. Without
 * a project key (development, tests) there is no client and every call does nothing.
 */
export class MainAnalytics {
  private readonly options: MainAnalyticsOptions;
  private consent: Consent;
  private identity: Identity | null = null;
  private client: Client | null = null;

  constructor(options: MainAnalyticsOptions) {
    this.options = options;
    this.consent = loadConsent(options.file);
  }

  get state(): Consent {
    return { ...this.consent };
  }

  setEnabled(enabled: boolean): void {
    this.consent = { ...this.consent, enabled };
    saveConsent(this.options.file, this.consent);
  }

  /**
   * The member and team now open, or null after sign-out, and the anonymous ID the renderer moved
   * to when it reset (a sign-out or another team). Main keeps that ID, so its own events before the
   * next team opens, `app_launched` among them, never land on the member the old ID merged into.
   */
  identify(identity: Identity | null, deviceId?: string): void {
    this.identity = identity;
    if (deviceId && UUID.test(deviceId) && deviceId !== this.consent.deviceId) {
      this.consent = { ...this.consent, deviceId };
      saveConsent(this.options.file, this.consent);
    }
  }

  private ensureClient(): Client | null {
    if (!this.options.key) return null;
    this.client ??= new PostHog(this.options.key, {
      host: POSTHOG_HOST,
      // A desktop app: let PostHog read the OS from the event, and never look up a location.
      isServer: false,
      disableGeoip: true,
      requestTimeout: 10_000,
      // No retries: a retry could go out after "Share usage data" is turned off.
      fetchRetryCount: 0,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    return this.client;
  }

  async capture<E extends EventName>(event: E, properties: EventProps<E>): Promise<void> {
    if (!this.consent.enabled) return;
    const client = this.ensureClient();
    if (!client) return;
    const scrubbed = scrubEvent({
      event,
      properties: { ...properties, ...(this.identity ? { team_id: this.identity.teamId } : {}) },
    });
    if (!scrubbed) return;
    try {
      await client.captureImmediate({
        distinctId: this.identity?.memberId ?? this.consent.deviceId,
        event: scrubbed.event,
        properties: scrubbed.properties ?? {},
      });
    } catch {
      // Analytics never gets in the way of the app.
    }
  }

  async shutdown(): Promise<void> {
    await this.client?.shutdown(2_000).catch(() => undefined);
  }
}
