/**
 * Where the room may send A2A requests (ADR 0012). The room only talks to the
 * origin a person registered: the Agent Card's interface must be on that
 * origin, and redirects are refused, so a card can't point the room's requests
 * (and the agent's token) at another host.
 *
 * Production peers use https on a public address. `A2A_ALLOW_INSECURE_PEERS=1`
 * on a deployment also allows http and private or local addresses, for local
 * development and tests. The deployment's own hosts are refused either way.
 *
 * Text checks here catch what a person typed. What a name resolves to is
 * checked when each connection opens (guardedFetch.ts), so a name that
 * resolves, or rebinds, to a private address is refused there.
 */
import { roomError } from "../errors";

export const INSECURE_PEERS_ENV = "A2A_ALLOW_INSECURE_PEERS";

/** The spec's well-known path (A2A 1.0, section 8.2). */
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";

export function allowInsecurePeers(): boolean {
  const value = process.env[INSECURE_PEERS_ENV];
  return value === "1" || value === "true";
}

function ipv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) return null;
  const nums = parts.map(Number);
  return nums.every((n) => n <= 255) ? nums : null;
}

/** An IPv6 address as 16 bytes, or null. Accepts `::`, a dotted IPv4 tail and a zone (`%en0`). */
function ipv6(host: string): number[] | null {
  let text = host
    .replace(/^\[|\]$/g, "")
    .split("%")[0]!
    .toLowerCase();
  if (!text.includes(":")) return null;
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    const v4 = ipv4(text.slice(lastColon + 1));
    if (!v4) return null;
    tail = v4;
    text = text.slice(0, lastColon + 1) + "0:0";
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const words = (part: string) => (part ? part.split(":") : []);
  const head = words(halves[0]!);
  const back = halves.length === 2 ? words(halves[1]!) : [];
  const missing = 8 - head.length - back.length;
  if ((halves.length === 2 && missing < 1) || (halves.length === 1 && missing !== 0)) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...back];
  if (all.some((w) => !/^[0-9a-f]{1,4}$/.test(w))) return null;
  const bytes = all.flatMap((w) => {
    const n = parseInt(w, 16);
    return [n >> 8, n & 255];
  });
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

function blockedV4([a, b, c, d]: number[]): boolean {
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) || // carrier-grade NAT, Tailscale, Alibaba's metadata at 100.100.100.200
    (a === 169 && b === 254) || // link-local, cloud metadata at 169.254.169.254
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 168 && b === 63 && c === 129 && d === 16) || // Azure's host endpoint
    a! >= 224 // multicast, reserved, broadcast
  );
}

/**
 * True for an IP address the room never calls: loopback, private, link-local,
 * carrier-grade NAT, cloud metadata, documentation, multicast and reserved
 * ranges, in IPv4 or IPv6, including IPv4 carried inside IPv6 (mapped,
 * compatible, NAT64 and 6to4). Anything that isn't an IP address is false.
 */
export function isBlockedAddress(address: string): boolean {
  const v4 = ipv4(address);
  if (v4) return blockedV4(v4);
  const b = ipv6(address);
  if (!b) return false;
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 16)) return true; // ::
  if (zero(0, 15) && b[15] === 1) return true; // ::1
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return blockedV4(b.slice(12)); // ::ffff:a.b.c.d
  if (zero(0, 12)) return blockedV4(b.slice(12)); // ::a.b.c.d (deprecated compatible form)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return zero(4, 12) ? blockedV4(b.slice(12)) : true; // NAT64 64:ff9b::/96; 64:ff9b:1::/48 is local
  }
  if (b[0] === 0x20 && b[1] === 0x02) return blockedV4(b.slice(2, 6)); // 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true; // Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation
  if (b[0] === 0x01 && zero(1, 8)) return true; // discard 100::/64
  if ((b[0]! & 0xfe) === 0xfc) return true; // unique local fc00::/7, incl. AWS metadata fd00:ec2::254
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // link-local fe80::/10
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return true; // old site-local fec0::/10
  if (b[0] === 0xff) return true; // multicast
  return false;
}

/** An IP literal in a URL host (`[::1]` or `127.0.0.1`), or null for a name. */
export function ipLiteral(hostname: string): string | null {
  const host = hostname.replace(/^\[|\]$/g, "");
  return ipv4(host) || ipv6(host) ? host : null;
}

/** The deployment's own hosts. The room never calls itself, even in development. */
export function isDeploymentHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.endsWith(".convex.cloud") || host.endsWith(".convex.site")) return true;
  for (const env of ["CONVEX_CLOUD_URL", "CONVEX_SITE_URL"]) {
    const value = process.env[env];
    if (!value) continue;
    try {
      if (new URL(value).hostname.toLowerCase() === host) return true;
    } catch {
      // Not a URL.
    }
  }
  return false;
}

/**
 * Names and literals refused before any lookup: local names, blocked IP
 * literals, and the deployment's own hosts. Names that resolve to a blocked
 * address are refused at connection time (guardedFetch.ts).
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  return isBlockedAddress(host);
}

/**
 * The Agent Card URL for what a person typed: a card URL ending in `.json` as
 * given, otherwise the well-known card at that address's root.
 */
export function cardUrlFor(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw roomError(
      "invalid",
      "That isn't a URL. Give the agent's address, such as https://hermes.example.com.",
    );
  }
  if (url.username || url.password) {
    throw roomError(
      "invalid",
      "Give the address without a user name or password. Add a token as the agent's credential instead.",
    );
  }
  if (isDeploymentHost(url.hostname)) {
    throw roomError(
      "invalid",
      "That is this deployment's own address. Give the agent's gateway address.",
    );
  }
  const insecure = allowInsecurePeers();
  if (url.protocol !== "https:" && !(insecure && url.protocol === "http:")) {
    throw roomError("invalid", "The agent's address must use https.");
  }
  if (!insecure && isPrivateHost(url.hostname)) {
    throw roomError(
      "invalid",
      "That is a private or local address, which the room can't reach. Give the agent's public https address.",
    );
  }
  url.hash = "";
  if (url.pathname.endsWith(".json")) return url.toString();
  return `${url.origin}${AGENT_CARD_PATH}`;
}

/** Null when the room may send to `endpoint` for a card read from `cardUrl`; else why not. */
export function endpointRefusal(cardUrl: string, endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return `The Agent Card names ${JSON.stringify(endpoint)} as its address, which isn't a URL.`;
  }
  const registered = new URL(cardUrl);
  if (url.origin !== registered.origin) {
    return `The Agent Card says the agent answers at ${url.origin}, which isn't the address you registered (${registered.origin}). Register ${url.origin} instead if you trust it.`;
  }
  if (url.username || url.password)
    return "The Agent Card's address carries a user name or password, which the room won't send.";
  return null;
}
