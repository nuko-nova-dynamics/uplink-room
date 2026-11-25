/**
 * Check connection (a2a.checkConnection, ADR 0018): one harmless, authenticated call to an agent's
 * gateway, which shows whether the room's token works and which A2A version answers, before
 * anyone sends it work. The call reads a task that doesn't exist (GetTask, or tasks/get in 0.3):
 * it changes nothing at the agent, and "task not found" means the method is there and the
 * token was taken.
 */
import { A2ACallError, call, RPC, type Credential, type Endpoint, type Transport } from "./protocol";
import { methodFor, otherDialect, type Dialect } from "./dialect";
import { credentialRefused, neitherAnswered, quote, tokenRefused } from "./explain";
import { redact } from "./redact";

export type ConnectionCheck = { ok: boolean; dialect?: Dialect; summary: string };

export async function checkConnection(
  transport: Transport,
  endpoint: Endpoint,
  credential: Credential | null,
  peer: { agentName: string; declared: Dialect; speaks: Dialect; learned: boolean; needsCredential: boolean },
  timeoutMs: number,
): Promise<ConnectionCheck> {
  const result = await probe(transport, endpoint, credential, peer, timeoutMs);
  // The summary quotes the gateway, which may echo the request's headers: the token never stays in it.
  return { ...result, summary: redact(result.summary, credential) };
}

async function probe(
  transport: Transport,
  endpoint: Endpoint,
  credential: Credential | null,
  peer: { agentName: string; declared: Dialect; speaks: Dialect; learned: boolean; needsCredential: boolean },
  timeoutMs: number,
): Promise<ConnectionCheck> {
  const name = peer.agentName;
  const id = `uplink-room-connection-check-${crypto.randomUUID()}`;
  const answered = (dialect: Dialect): ConnectionCheck => {
    const method = methodFor(dialect, "get");
    const token = credential
      ? " and took the room's token."
      : peer.needsCredential
        ? " without a token, though its Agent Card asks for one."
        : " without a token.";
    const other =
      dialect === peer.declared
        ? ""
        : ` Its Agent Card says A2A ${peer.declared}, so the room speaks A2A ${dialect} to it from now on.`;
    return { ok: true, dialect, summary: `${name} answered ${method} over A2A ${dialect}${token}${other}` };
  };
  const first = peer.speaks;
  const second = otherDialect(first);
  let missed: { dialect: Dialect; error: unknown } | null = null;
  for (const dialect of [first, second]) {
    const method = methodFor(dialect, "get")!;
    try {
      await call(transport, endpoint, credential, method, { id, historyLength: 0 }, timeoutMs, dialect);
      return answered(dialect);
    } catch (error) {
      if (!(error instanceof A2ACallError)) {
        return { ok: false, summary: `The check failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (error.kind === "rpc" && error.code === RPC.taskNotFound) return answered(dialect);
      if (credentialRefused(error)) {
        return { ok: false, summary: tokenRefused(name, error.status, !!credential, true) };
      }
      const wrongVersion =
        error.kind === "rpc" &&
        !error.ambiguous &&
        (error.code === RPC.methodNotFound || error.code === RPC.versionNotSupported);
      if (wrongVersion && !missed) {
        missed = { dialect, error };
        continue;
      }
      if (wrongVersion) {
        return {
          ok: false,
          summary: neitherAnswered(
            name,
            { op: "get", ...missed!, promised: !peer.learned && missed!.dialect === peer.declared },
            { op: "get", dialect, error },
          ),
        };
      }
      if (error.kind === "rpc") {
        return {
          ok: false,
          dialect,
          summary: `${name} answered ${method} over A2A ${dialect} with an error.${quote(error) || ` ${error.message}`}`,
        };
      }
      return { ok: false, summary: `Couldn't reach ${name}'s gateway: ${error.message}` };
    }
  }
  // Unreachable: the loop returns on its second pass.
  return { ok: false, summary: `${name} didn't answer the check.` };
}
