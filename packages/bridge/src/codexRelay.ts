/**
 * `uplink-bridge say` and `reply` from inside Codex's sandbox (ADR 0038). Codex runs the agent's
 * commands in a sandbox that, in its default `workspace-write` mode, blocks network access, and a
 * Unix socket outside the workspace with it: checked with Codex 0.166.0 on 2026-11-05, a sandboxed
 * `nc -U` to a socket in /tmp failed where the same command outside Codex got its answer. So the CLI
 * can't reach the bridge from there. Instead it prints the request, signed with the terminal's secret,
 * and the terminal's `PostToolUse` hook, which Codex runs outside the sandbox with the terminal's
 * environment, finds it in the command's output and posts it, then tells the agent how it went.
 *
 * The signature is an HMAC with the terminal's secret (`UPLINK_TERMINAL_SECRET`), which only the
 * terminal's own processes have. Text that merely contains a request, such as a file the agent reads,
 * can't post anything, and each request posts once (its nonce).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { runSayFiles, type RunSayFile } from "./runFiles.ts";

/** Set in the environment of a Codex terminal's app server, and so of the commands Codex runs. */
export const RELAY_ENV = "UPLINK_CODEX_RELAY";

/** A `say` or `reply` the hook posts, with any files it sends (ADR 0047), as the command read them. */
export type RelayedRequest = { nonce: string; text: string; in?: string; replyTo?: string; files?: RunSayFile[] };

const PREFIX = "uplink-bridge-request:";
const REQUEST = /uplink-bridge-request:([A-Za-z0-9_-]{1,200000})\.([A-Za-z0-9_-]{43})/g;

const sign = (secret: string, body: string) => createHmac("sha256", secret).update(PREFIX + body).digest("base64url");

/** The line the CLI prints for the hook: the request and its signature. */
export function relayRequest(secret: string, request: Omit<RelayedRequest, "nonce">): string {
  const body = Buffer.from(JSON.stringify({ v: 1, nonce: randomBytes(16).toString("base64url"), ...request })).toString("base64url");
  return `${PREFIX}${body}.${sign(secret, body)}`;
}

/** The requests in a tool's output that carry this terminal's signature. */
export function relayedRequests(secret: string, output: string): RelayedRequest[] {
  const found: RelayedRequest[] = [];
  for (const [, body, signature] of output.matchAll(REQUEST)) {
    const expected = Buffer.from(sign(secret, body!));
    const given = Buffer.from(signature!);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) continue;
    try {
      const request = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as Record<string, unknown>;
      if (request.v !== 1 || typeof request.nonce !== "string" || typeof request.text !== "string") continue;
      const files = runSayFiles(request.files);
      found.push({
        nonce: request.nonce,
        text: request.text,
        ...(typeof request.in === "string" ? { in: request.in } : {}),
        ...(typeof request.replyTo === "string" ? { replyTo: request.replyTo } : {}),
        ...(files.length ? { files } : {}),
      });
    } catch {
      // Not a request of ours, or one naming files wrongly.
    }
  }
  return found;
}
