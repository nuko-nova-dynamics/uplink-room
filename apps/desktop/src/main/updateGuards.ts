/**
 * Two small guards around electron-updater (updates.ts), kept apart from Electron so they're tested.
 */

/**
 * Runs `start` and always returns a promise. electron-updater's `downloadUpdate()` isn't `async`:
 * it resolves the feed's files synchronously, so a feed entry without a checksum throws
 * `ERR_UPDATER_NO_CHECKSUM` before a `.catch` could attach. Here that throw becomes a rejection.
 */
export function attempt<T>(start: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => resolve(start()));
}

// oxlint-disable-next-line typescript/no-explicit-any -- the shape EventEmitter listeners have.
type Listener = (...args: any[]) => void;
type Emitter = {
  listeners(event: string): unknown[];
  removeListener(event: string, listener: Listener): unknown;
};

/**
 * Remembers which listeners an emitter has for `event` now, and later removes any added since.
 * MacUpdater's `quitAndInstall()`, called before Squirrel.Mac has staged the update, leaves a
 * listener on the native updater that quits the app whenever staging next succeeds, which could be
 * in the middle of a call. The app doesn't call it that early, and prunes such a listener when an
 * update fails, so none can outlive the update it was for.
 */
export function listenerGuard(emitter: Emitter, event: string): { prune(): number } {
  const known = new Set(emitter.listeners(event));
  return {
    prune() {
      let removed = 0;
      for (const listener of emitter.listeners(event)) {
        if (known.has(listener)) continue;
        emitter.removeListener(event, listener as Listener);
        removed += 1;
      }
      return removed;
    },
  };
}
