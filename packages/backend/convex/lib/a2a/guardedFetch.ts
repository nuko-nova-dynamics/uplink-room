"use node";
/**
 * The A2A worker's only way out to an agent's gateway (ADR 0012). It runs in
 * Convex's Node.js runtime because the default runtime's fetch gives no say
 * over DNS or the address it connects to.
 *
 * Each request resolves the host again, in the socket's own `lookup` hook, and
 * refuses the connection when any answer is a blocked address (private,
 * loopback, link-local, metadata, reserved, or IPv4 inside IPv6). The address
 * checked is the address the socket connects to, so a name that changes its
 * answer between registration and use (DNS rebinding) is caught at that use.
 * IP literals are checked directly, since Node doesn't look them up. TLS still
 * verifies the certificate against the host name. Redirects are never
 * followed. The deployment's own hosts are refused always.
 *
 * What remains: an address that is public on paper but internal to Convex's
 * network isn't on the list, and the list can't know it.
 */
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import {
  allowInsecurePeers,
  ipLiteral,
  isBlockedAddress,
  isDeploymentHost,
  isPrivateHost,
} from "./peerUrl";

export type Resolved = { address: string; family: number }[];
export type Resolver = (hostname: string) => Promise<Resolved>;

const systemResolver: Resolver = (hostname) =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

let override: Resolver | undefined;

/** Tests answer DNS themselves; `undefined` goes back to the system resolver. */
export function setResolverForTests(resolver: Resolver | undefined): void {
  override = resolver;
}

/** Refused before anything was sent. `blocked` tells the A2A client so (protocol.ts). */
export class BlockedAddressError extends Error {
  readonly blocked = true;
}

function blockedMessage(host: string, address: string): string {
  return `${host} resolves to ${address}, a private or reserved address the room won't call.`;
}

/** A `lookup` for http.request that refuses blocked answers. */
export function guardedLookup(resolve: Resolver, allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname)
      .then((answers) => {
        if (answers.length === 0) {
          throw Object.assign(new Error(`${hostname} has no address.`), { code: "ENOTFOUND" });
        }
        if (!allowPrivate) {
          const bad = answers.find((a) => isBlockedAddress(a.address));
          if (bad) throw new BlockedAddressError(blockedMessage(hostname, bad.address));
        }
        const wanted =
          options.family === 4 || options.family === 6
            ? answers.filter((a) => a.family === options.family)
            : answers;
        const list = wanted.length ? wanted : answers;
        if (options.all) callback(null, list);
        else callback(null, list[0]!.address, list[0]!.family);
      })
      .catch((error: Error) => callback(error as NodeJS.ErrnoException, "", 0));
  };
}

type Init = {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

/** Statuses whose Response can't carry a body. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * Who may be called. The A2A worker's default: https only, and http and private addresses too
 * when A2A_ALLOW_INSECURE_PEERS is set. Link previews (`strict`, `allowHttp`) fetch public http and
 * https pages and never a private address, whatever the deployment's settings.
 */
export type GuardPolicy = { allowHttp?: boolean; strict?: boolean };

/** Like fetch, for the A2A worker and link previews: no redirects, and only to allowed addresses. */
export async function guardedFetch(url: string, init: Init, policy: GuardPolicy = {}): Promise<Response> {
  const target = new URL(url);
  const insecure = policy.strict ? false : allowInsecurePeers();
  if (isDeploymentHost(target.hostname)) {
    throw new BlockedAddressError(
      `${target.hostname} is this deployment's own address; the room won't call it.`,
    );
  }
  const httpOk = insecure || policy.allowHttp === true;
  if (target.protocol !== "https:" && !(httpOk && target.protocol === "http:")) {
    throw new BlockedAddressError("The room calls agents only over https.");
  }
  const literal = ipLiteral(target.hostname);
  if (!insecure && (literal ? isBlockedAddress(literal) : isPrivateHost(target.hostname))) {
    throw new BlockedAddressError(blockedMessage(target.hostname, literal ?? target.hostname));
  }
  const lookup = guardedLookup(override ?? systemResolver, insecure);
  const client = target.protocol === "https:" ? https : http;
  // The body goes out whole, with its length. Without Content-Length Node sends it chunked, and a
  // server that reads only Content-Length (Python's http.server, which Hermes's A2A gateway runs
  // on) reads an empty body: Hermes then answers "method not found: " with no method named.
  const body = init.body === undefined ? undefined : Buffer.from(init.body, "utf8");
  const headers = body ? { ...init.headers, "content-length": String(body.byteLength) } : init.headers;
  return new Promise<Response>((resolve, reject) => {
    // Settles exactly once. An upgrade or a close without an answer would otherwise leave it
    // waiting forever: Node hands a 101 to the `upgrade` event, never to the response callback.
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = client.request(
      target,
      {
        method: init.method,
        headers,
        lookup,
        // A fresh connection per request, so every request is looked up and checked.
        agent: false,
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (incoming) => {
        if (settled) {
          incoming.destroy();
          return;
        }
        settled = true;
        const headers = new Headers();
        for (let i = 0; i + 1 < incoming.rawHeaders.length; i += 2) {
          headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
        }
        const status = incoming.statusCode ?? 502;
        const body =
          NULL_BODY.has(status) || init.method === "HEAD"
            ? null
            : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        if (!body) incoming.resume();
        resolve(
          new Response(body, {
            status: status < 200 || status > 599 ? 502 : status,
            statusText: incoming.statusMessage ?? "",
            headers,
          }),
        );
      },
    );
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      fail(
        new Error(
          "The agent's gateway tried to switch protocols (HTTP 101), which the room doesn't speak.",
        ),
      );
    });
    request.on("error", fail);
    request.on("close", () =>
      fail(new Error("The agent's gateway closed the connection without an answer.")),
    );
    request.end(body);
  });
}
