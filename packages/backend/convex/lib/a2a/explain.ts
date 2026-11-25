/**
 * What the room tells a person when an agent's gateway refuses a call (ADR 0012, ADR 0018): what
 * happened, in the agent's name, with the gateway's own words quoted, and what to do about it.
 */
import { A2ACallError, RPC } from "./protocol";
import { methodFor, type Dialect, type Op } from "./dialect";

/**
 * The call was refused for its A2A version: JSON-RPC's "method not found", or A2A's "version not
 * supported", which a 1.0 agent answers to a request without the version header (it reads that as
 * 0.3, spec 3.6.2). Either way the agent didn't take the call, so nothing it carried was acted on.
 * An answer that came with an HTTP 5xx doesn't count: it may come after the agent took it.
 */
export function wrongVersion(error: unknown): boolean {
  return (
    error instanceof A2ACallError &&
    error.kind === "rpc" &&
    (error.code === RPC.methodNotFound || error.code === RPC.versionNotSupported) &&
    !error.ambiguous
  );
}

/** A2A's "version not supported", said plainly: the agent refused the request for its version and took nothing. */
export function versionRefused(error: unknown): boolean {
  return (
    error instanceof A2ACallError &&
    error.kind === "rpc" &&
    error.code === RPC.versionNotSupported &&
    !error.ambiguous
  );
}

/** The gateway refused the request's credentials (HTTP 401 or 403). */
export function credentialRefused(error: unknown): boolean {
  return (
    error instanceof A2ACallError &&
    error.kind === "http" &&
    (error.status === 401 || error.status === 403)
  );
}

/** ` It said: “…”.`, or nothing when the gateway gave no words of its own. */
export function quote(error: unknown): string {
  const said = error instanceof A2ACallError ? error.said : undefined;
  return said ? ` It said: “${said}”.` : "";
}

/** `inSettings`: shown beside the token's own buttons (Check connection), so it needn't say where they are. */
export function tokenRefused(
  agentName: string,
  status: number | undefined,
  hasToken: boolean,
  inSettings = false,
): string {
  const http = status ? ` (HTTP ${status})` : "";
  const where = inSettings ? "" : ` in ${agentName}'s A2A settings`;
  return hasToken
    ? `${agentName}'s gateway refused the room's token${http}. Replace the token${where}.`
    : `${agentName}'s gateway asks for a token${http}, and the room has none for it. Add one${where}.`;
}

/** One attempt: what was asked (a send, a stream, a task read), in which A2A version. */
export type Attempt = { op: Op; dialect: Dialect; error: unknown };

/**
 * Neither A2A version answered. `first` is the version the card names (or the room learned),
 * `second` the one tried after it; each names the method that was refused.
 */
export function neitherAnswered(
  agentName: string,
  first: Attempt & { promised: boolean },
  second: Attempt,
): string {
  const which = first.promised ? "its Agent Card promises" : "it answered before";
  const words = quote(first.error) || quote(second.error);
  return `${agentName} doesn't answer ${methodFor(first.dialect, first.op)}, the A2A ${first.dialect} method ${which}, or ${methodFor(second.dialect, second.op)} from A2A ${second.dialect}.${words} Check that the address on its Agent Card is its A2A endpoint.`;
}

/** The first version was refused for its version; the other one answered with another refusal. */
export function otherRefused(
  agentName: string,
  first: Omit<Attempt, "error"> & { promised: boolean },
  second: Attempt,
): string {
  const which = first.promised ? "its Agent Card promises" : "it answered before";
  const reason =
    second.error instanceof A2ACallError
      ? (second.error.said ?? second.error.message)
      : String(second.error);
  return `${agentName} doesn't answer ${methodFor(first.dialect, first.op)}, the A2A ${first.dialect} method ${which}, and refused ${methodFor(second.dialect, second.op)} from A2A ${second.dialect}: “${reason}”.`;
}

/** One version's method wasn't found, and the room didn't try the other (it had learned this one). */
export function notAnswered(agentName: string, op: Op, dialect: Dialect, error: unknown): string {
  return `${agentName} doesn't answer ${methodFor(dialect, op)}, the A2A ${dialect} method it answered before.${quote(error)} Run Check connection in ${agentName}'s A2A settings.`;
}
