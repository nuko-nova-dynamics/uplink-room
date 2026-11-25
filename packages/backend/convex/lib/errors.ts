import { ConvexError } from "convex/values";

export type RoomErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid"
  | "conflict"
  | "no_free_slot"
  /** A feature needs a setting the deployment doesn't have yet, such as `HYPERBEAM_API_KEY`. */
  | "not_configured"
  /**
   * A post in a direct message opened with a run whose output people outside it can see, from a
   * sender who hasn't acknowledged that yet: resend with `acknowledgeWarning: true` (ADR 0039).
   */
  | "warning_required";

/**
 * A refusal a mutation returns instead of throwing, so the writes it made before refusing stay, such
 * as counting a wrong pair code (a thrown error would undo them). Over HTTP the Room API answers it as
 * the error it names; the app's direct call gets it as `{ refused: { code, message } }`.
 */
export type RoomRefusal = {
  refused: { code: RoomErrorCode; message: string };
  /**
   * Set on a refusal the room threw and answered in its place (ADR 0046, lib/refusals.ts): a
   * client throws it again as its error. A refusal returned on purpose, like this one, has none,
   * and reaches the app as the value it is.
   */
  thrown?: true;
};

export function roomRefusal(code: RoomErrorCode, message: string): RoomRefusal {
  return { refused: { code, message } };
}

export function isRoomRefusal(value: unknown): value is RoomRefusal {
  if (typeof value !== "object" || value === null || !("refused" in value)) return false;
  const refused = (value as { refused: unknown }).refused;
  return typeof refused === "object" && refused !== null && typeof (refused as { code?: unknown }).code === "string";
}

/** An error the Room API returns to its caller, with a stable code. */
export function roomError(code: RoomErrorCode, message: string): ConvexError<{
  code: RoomErrorCode;
  message: string;
}> {
  return new ConvexError({ code, message });
}
