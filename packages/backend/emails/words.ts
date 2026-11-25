const DAY = 24 * 60 * 60 * 1000;

/**
 * Whole days until `expiresAt`, rounded up, or null when it never expires. Emails say "in 4 days"
 * rather than a date: the room doesn't know the reader's time zone, and a date could be a day off.
 */
export function daysLeft(expiresAt: number | undefined, now: number): number | null {
  if (expiresAt === undefined) return null;
  return Math.max(0, Math.ceil((expiresAt - now) / DAY));
}

export function roleName(role: "admin" | "member"): string {
  return role === "admin" ? "an admin" : "a member";
}
