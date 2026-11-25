import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useAuth } from "@clerk/electron/react";
import { log } from "./log";

/**
 * Convex wants `{ isLoading, isAuthenticated, fetchAccessToken }`. The Clerk
 * instance puts `aud: "convex"`, name, email and picture in its default session
 * token, so we ask Clerk for that token with no template (ConvexProviderWithClerk
 * would ask for a `convex` JWT template that doesn't exist).
 *
 * After the computer sleeps, the session token has expired and the network may
 * still be coming back, so a token fetch that fails is tried again a few times
 * before Convex is told there's none: Convex gives up on the session then, and
 * the app would sit on "Connecting to your team". `retryConvexAuth()` makes
 * Convex take the session again (App.tsx calls it when Convex refused one that
 * Clerk still has).
 */
const TOKEN_RETRIES_MS = [1_000, 2_000, 4_000, 8_000];

let attempt = 0;
const listeners = new Set<() => void>();

/** Hands Convex the Clerk session again, as if it were new. */
export function retryConvexAuth(): void {
  attempt++;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useClerkConvexAuth() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const retry = useSyncExternalStore(subscribe, () => attempt);
  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      for (let i = 0; ; i++) {
        try {
          const token = await getToken({ skipCache: forceRefreshToken });
          if (i > 0) log.info("auth", "session token fetched after retrying", { tries: i + 1 });
          return token ?? null;
        } catch (error) {
          const wait = TOKEN_RETRIES_MS[i];
          if (wait === undefined) {
            log.warn("auth", "couldn't fetch a session token", { tries: i + 1, type: (error as Error)?.name ?? "unknown" });
            return null;
          }
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    },
    // `retry` makes a new function, which makes Convex take the session again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getToken, retry],
  );
  return useMemo(
    () => ({ isLoading: !isLoaded, isAuthenticated: isSignedIn ?? false, fetchAccessToken }),
    [isLoaded, isSignedIn, fetchAccessToken],
  );
}
