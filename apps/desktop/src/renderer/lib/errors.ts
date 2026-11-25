import { ConvexError } from "convex/values";

/** The message the Room API sent (`ConvexError` with `{ code, message }`), or a plain fallback. */
export function errorMessage(error: unknown): string {
  if (error instanceof ConvexError) {
    const data = error.data as unknown;
    if (typeof data === "string") return data;
    if (data && typeof data === "object" && "message" in data && typeof data.message === "string") {
      return data.message;
    }
  }
  if (error instanceof Error) {
    // Convex wraps server errors as "[Request ID: …] Server Error\nUncaught Error: …".
    const match = /Uncaught \w*Error: (.+)/.exec(error.message);
    return match?.[1] ?? error.message;
  }
  return "Something went wrong. Try again.";
}
