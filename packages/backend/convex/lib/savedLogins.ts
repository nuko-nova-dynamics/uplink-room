import { v, type Infer } from "convex/values";

/**
 * How long saved logins are kept (ADR 0011): a day, a week, a month, or until
 * someone forgets them. A browser that keeps nothing is Temporary, which is
 * the absence of saved logins, not one of these.
 */
export const vKeep = v.union(v.literal("1d"), v.literal("7d"), v.literal("30d"), v.literal("forever"));
export type Keep = Infer<typeof vKeep>;

const DAY = 24 * 60 * 60 * 1000;

/** Milliseconds each choice keeps saved logins, from when it was picked. `null`: until someone forgets them. */
export const KEEP_MS: Record<Keep, number | null> = { "1d": DAY, "7d": 7 * DAY, "30d": 30 * DAY, forever: null };

/** The choice the app offers first when someone decides to keep logins. */
export const DEFAULT_KEEP: Keep = "7d";

/** Forgotten saved logins stay listed this long, so the channel can see what was forgotten. */
export const SHOW_FORGOTTEN_MS = 30 * DAY;

export const NAME_MAX = 60;

/**
 * A session that saves to a profile runs at least this long before the room
 * ends it, which is when Hyperbeam saves the profile: a browser with saved
 * logins after End, and the session that erases forgotten ones (#76). Live on
 * 2026-11-03, a session ended about 5 s after a login came back logged out
 * when its profile was loaded, and sessions ended 15 s or more after a login
 * stayed logged in: Chrome seems to write new cookies to disk only every few
 * seconds, and the DELETE doesn't wait for it (a hypothesis; the timing is
 * what was measured).
 */
export const SAVE_BEFORE_END_MS = 30 * 1000;

/** Tries at erasing forgotten saved logins before the room gives up: about a day of backoff (#76). */
export const ERASE_MAX_TRIES = 150;

/**
 * The wait before erase try `tries + 1`: 30 seconds, doubling, at most 10
 * minutes. Longer than one try takes: each provider call in it has a 15 s
 * deadline, and a try makes two at most.
 */
export function eraseBackoffMs(tries: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, tries - 1), 10 * 60_000);
}

/** Trims a name for saved logins and checks it isn't empty or too long. Returns null when it is invalid. */
export function cleanName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ");
  return name.length > 0 && name.length <= NAME_MAX ? name : null;
}
