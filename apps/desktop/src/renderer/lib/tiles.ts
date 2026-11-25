/** Choosing a member's tile on the call stage, without React or LiveKit. */

/** One LiveKit participant: one join. A member on two devices has two. */
export type TileLike = { identity: string; join: string; camera?: unknown };

/** The tile to show for a member: one with a camera on, from any of their joins, else their first. */
export function memberTile<T extends TileLike>(tiles: readonly T[], memberId: string): T | undefined {
  const theirs = tiles.filter((t) => t.identity === memberId);
  return theirs.find((t) => t.camera) ?? theirs[0];
}
