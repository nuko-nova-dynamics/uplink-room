import type { NotifyRequest } from "./notifySpec";

/**
 * The longest notification id Windows accepts. The id becomes the toast's tag,
 * and Electron 45 throws in the Notification constructor for a longer one
 * (shell/browser/api/electron_api_notification.cc), so no banner would show.
 * A renderer key, `<runId>:<promptId>`, runs about 69 characters with a
 * Convex run id and the bridge's UUID prompt ids.
 */
export const MAX_NATIVE_ID = 64;

/**
 * Whether a notification that emitted `close` with this reason is still
 * listed. Windows moves a toast that timed out to Notification Center, and
 * Electron keeps it there until `close()` removes it; a toast the person
 * dismissed (`userCanceled`) or that was hidden (`applicationHidden`) is gone,
 * and so is one that closed with no reason (macOS, Linux).
 */
export function stillListed(reason: string | undefined): boolean {
  return reason === "timedOut";
}

/**
 * `session` is the renderer's session that asked for the banner: one signed-in person in one team,
 * from the moment its Signals mounts until it unmounts or the page goes away.
 */
export type Entry<N> = { nativeId: string; request: NotifyRequest; notification: N; session: string };

/**
 * The banners shown and still listed. Each gets a short system id of its own,
 * whatever the length of the renderer's key, and keeps the request it showed,
 * so a click or a button acts on exactly that approval or terminal, and the
 * renderer can take it away by its key. A renderer that reloads, signs out or
 * opens another team loses its own record of them, so `reconcile` and
 * `endSession` let it take away what it no longer tracks.
 */
export class Banners<N> {
  /** Keeps this launch's ids apart from toasts an earlier launch left in Notification Center. */
  private readonly launch = Date.now().toString(36);
  private count = 0;
  private readonly byKeyMap = new Map<string, Entry<N>>();
  private readonly byNativeMap = new Map<string, Entry<N>>();

  nextId(): string {
    return `u${this.launch}-${++this.count}`;
  }

  /** Tracks a banner, and returns the one it replaces for the same key, which the caller closes. */
  add(
    nativeId: string,
    request: NotifyRequest,
    notification: N,
    session: string,
  ): Entry<N> | undefined {
    const replaced = this.byKeyMap.get(request.id);
    if (replaced) this.forget(replaced);
    const entry = { nativeId, request, notification, session };
    this.byKeyMap.set(request.id, entry);
    this.byNativeMap.set(nativeId, entry);
    return replaced;
  }

  /** A click or a button: the request that banner showed, once. */
  take(nativeId: string): Entry<N> | undefined {
    const entry = this.byNativeMap.get(nativeId);
    if (entry) this.forget(entry);
    return entry;
  }

  /** The banner emitted `close` (or failed): let it go, unless it is still listed. */
  closed(nativeId: string, reason?: string): void {
    if (stillListed(reason)) return;
    const entry = this.byNativeMap.get(nativeId);
    if (entry) this.forget(entry);
  }

  /** The app no longer needs this banner: the caller closes what comes back, which removes it. */
  release(key: string): Entry<N> | undefined {
    const entry = this.byKeyMap.get(key);
    if (entry) this.forget(entry);
    return entry;
  }

  /**
   * A session starts with what is live now (the keys of the runs waiting on that person and the
   * terminals they drive). Any banner whose key isn't among them is out of date, whichever session
   * asked for it, and comes back for the caller to close; the rest now belong to this session.
   */
  reconcile(session: string, live: ReadonlySet<string>): Entry<N>[] {
    const dismissed: Entry<N>[] = [];
    for (const entry of [...this.byNativeMap.values()]) {
      if (live.has(entry.request.id)) entry.session = session;
      else {
        this.forget(entry);
        dismissed.push(entry);
      }
    }
    return dismissed;
  }

  /** The session ended (sign-out, another team): its banners come back for the caller to close. */
  endSession(session: string): Entry<N>[] {
    const dismissed = [...this.byNativeMap.values()].filter((entry) => entry.session === session);
    for (const entry of dismissed) this.forget(entry);
    return dismissed;
  }

  private forget(entry: Entry<N>): void {
    if (this.byKeyMap.get(entry.request.id) === entry) this.byKeyMap.delete(entry.request.id);
    if (this.byNativeMap.get(entry.nativeId) === entry) this.byNativeMap.delete(entry.nativeId);
  }

  get size(): number {
    return this.byNativeMap.size;
  }
}
