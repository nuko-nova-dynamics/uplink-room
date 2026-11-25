/**
 * Link previews (spec #63, ADR 0015). The backend fetches a page a member linked and keeps its
 * title, description, site name and image; the app shows only that, and loads the image from
 * Convex storage, so a link never learns a member's address and nothing from the page runs.
 *
 * Any member chooses what is fetched, so every request follows these rules:
 *  - http or https only, on port 80 or 443, with no user name or password in the URL;
 *  - never this deployment, and never a private, loopback, link-local, metadata or reserved
 *    address (lib/a2a/peerUrl.ts): checked before each request, again after every redirect (at
 *    most 3), and again by the socket as it connects (linkPreviewNode.ts, lib/a2a/guardedFetch.ts);
 *  - at most 1 MB of HTML within 5 seconds; only Open Graph, Twitter card and <title> tags are
 *    read, as text; nothing on the page runs;
 *  - the image at most 5 MB, PNG, JPEG, GIF or WebP by its bytes, never SVG, copied into storage.
 *
 * `fetchLinkPreview` is pure apart from its `PreviewNet`, so tests drive it with a fake network.
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { ipLiteral, isBlockedAddress, isDeploymentHost, isPrivateHost } from "./a2a/peerUrl";

/** Links per message that get a preview. */
export const MAX_PREVIEWS = 3;
/** A preview is reused this long before a new message with the same link fetches it again. */
export const PREVIEW_KEPT_MS = 24 * 60 * 60 * 1000;
/** A preview still pending after this long is asked for again. */
const PENDING_RETRY_MS = 2 * 60 * 1000;
export const USER_AGENT =
  "Mozilla/5.0 (compatible; UplinkRoomLinkPreview/1.0; link previews for Uplink Room team chat)";

export type PreviewLimits = { htmlBytes: number; imageBytes: number; timeoutMs: number; redirects: number };
export const LIMITS: PreviewLimits = {
  htmlBytes: 1024 * 1024,
  imageBytes: 5 * 1024 * 1024,
  timeoutMs: 5000,
  redirects: 3,
};

/** One HTTP exchange, with no redirects followed. */
export type PreviewResponse = { status: number; headers: Headers; body: ReadableStream<Uint8Array> | null };

/** The network a preview fetch uses: the real one (linkPreviewNode.ts) or a test's fake. */
export type PreviewNet = {
  /** Every address a host name resolves to. */
  resolve(hostname: string): Promise<string[]>;
  get(url: string, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<PreviewResponse>;
};

let netOverride: PreviewNet | undefined;
let limitsOverride: Partial<PreviewLimits> | undefined;

/** Tests swap in a fake network and shorter limits; `undefined` goes back to the real ones. */
export function setPreviewNetForTests(net: PreviewNet | undefined, limits?: Partial<PreviewLimits>): void {
  netOverride = net;
  limitsOverride = limits;
}

export function previewNetOverride(): PreviewNet | undefined {
  return netOverride;
}

export function previewLimits(): PreviewLimits {
  return { ...LIMITS, ...limitsOverride };
}

// --- Which links ---------------------------------------------------------------

/** A link as previews key it: lower-case scheme and host, no default port, no fragment. */
export function normalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  return url.toString();
}

const LINK = /https?:\/\/[^\s<>"'`]+/gi;

/** The first 3 different http(s) links in a body, normalized. */
export function previewLinks(body: string, format: "markdown" | "html"): string[] {
  if (format === "html") return [];
  // Code blocks and inline code aren't links.
  const text = body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
  const out: string[] = [];
  for (const match of text.matchAll(LINK)) {
    // Trailing punctuation and a Markdown link's closing parenthesis aren't part of the link.
    const trimmed = match[0].replace(/[).,;:!?\]]+$/, "");
    const url = normalizeUrl(trimmed);
    if (url && !out.includes(url)) out.push(url);
    if (out.length === MAX_PREVIEWS) break;
  }
  return out;
}

// --- The rules ------------------------------------------------------------------

/** Why a URL may not be fetched at all, before any lookup; null when it may be. */
export function refusal(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "only http and https links get previews";
  if (url.username || url.password) return "a link with a user name or password gets no preview";
  if (url.port && url.port !== "80" && url.port !== "443") return "only ports 80 and 443 are fetched";
  const host = url.hostname;
  if (isDeploymentHost(host)) return "the room doesn't fetch its own address";
  const literal = ipLiteral(host);
  if (literal ? isBlockedAddress(literal) : isPrivateHost(host)) return `${host} is a private or reserved address`;
  return null;
}

/** Refuses a host any of whose addresses is blocked. */
async function checkAddresses(net: PreviewNet, raw: string): Promise<string | null> {
  const host = new URL(raw).hostname;
  if (ipLiteral(host)) return null;
  let addresses: string[];
  try {
    addresses = await net.resolve(host);
  } catch {
    return `${host} doesn't resolve`;
  }
  if (addresses.length === 0) return `${host} has no address`;
  const bad = addresses.find((a) => isBlockedAddress(a));
  return bad ? `${host} resolves to ${bad}, a private or reserved address` : null;
}

class PreviewError extends Error {}

/** The team turned link previews off while this fetch was queued or running. */
export const TURNED_OFF = "link previews were turned off";

/** Asked before every request: whether the team that wants the preview still has previews on. */
export type StillOn = () => Promise<boolean>;

/**
 * GETs a URL, following at most `limits.redirects` redirects, each checked like the first.
 * Returns the final response and URL.
 */
async function getChecked(
  net: PreviewNet,
  start: string,
  accept: string,
  limits: PreviewLimits,
  signal: AbortSignal,
  stillOn: StillOn,
): Promise<{ response: PreviewResponse; url: string }> {
  let url = start;
  for (let hop = 0; ; hop++) {
    // Before anything goes out, the DNS lookup included.
    if (!(await stillOn())) throw new PreviewError(TURNED_OFF);
    const refused = refusal(url) ?? (await checkAddresses(net, url));
    if (refused) throw new PreviewError(refused);
    const response = await net.get(url, { headers: { "user-agent": USER_AGENT, accept }, signal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (!location) throw new PreviewError(`HTTP ${response.status} with no Location`);
      if (hop >= limits.redirects) throw new PreviewError(`more than ${limits.redirects} redirects`);
      url = new URL(location, url).toString();
      continue;
    }
    return { response, url };
  }
}

/** Reads a body, refusing one longer than `max` bytes. */
async function readAtMost(response: PreviewResponse, max: number, what: string): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => {});
    throw new PreviewError(`${what} is larger than ${max} bytes`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new PreviewError(`${what} is larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Runs `work` with a deadline; past it, the signal aborts and the preview fails. */
async function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new PreviewError(`no answer within ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// --- Reading the page -------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Plain text: entities decoded, tags and control characters dropped, space folded, clipped. */
function plain(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const clean = decodeEntities(text.replace(/<[^>]*>/g, " "))
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

export type PageMeta = { title?: string; description?: string; siteName?: string; image?: string };

/** The Open Graph, Twitter card and <title> tags of a page, as plain text. */
export function parseMeta(html: string, pageUrl: string): PageMeta {
  const meta = new Map<string, string>();
  // A `>` inside a quoted attribute doesn't end the tag.
  for (const match of html.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = attributes(match[0]);
    const key = (attrs["property"] ?? attrs["name"] ?? "").toLowerCase();
    const content = attrs["content"];
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const imageRaw =
    meta.get("og:image:secure_url") ?? meta.get("og:image") ?? meta.get("og:image:url") ?? meta.get("twitter:image") ?? meta.get("twitter:image:src");
  let image: string | undefined;
  if (imageRaw) {
    try {
      const resolved = new URL(decodeEntities(imageRaw.trim()), pageUrl);
      if (resolved.protocol === "http:" || resolved.protocol === "https:") image = resolved.toString();
    } catch {
      image = undefined;
    }
  }
  const out: PageMeta = {};
  const title = plain(meta.get("og:title") ?? meta.get("twitter:title") ?? titleTag, 200);
  const description = plain(meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description"), 300);
  const siteName = plain(meta.get("og:site_name"), 100);
  if (title) out.title = title;
  if (description) out.description = description;
  if (siteName) out.siteName = siteName;
  if (image) out.image = image;
  return out;
}

/** The raster type of an image by its first bytes, or null (SVG, HTML, anything else). */
export function sniffImage(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  const at = (i: number) => bytes[i] ?? -1;
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (at(0) === 0x89 && ascii(1, 4) === "PNG" && at(4) === 0x0d && at(5) === 0x0a) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

export type FetchedPreview =
  | { ok: true; meta: PageMeta; image?: { bytes: Uint8Array<ArrayBuffer>; type: string }; imageError?: string }
  | { ok: false; error: string; turnedOff?: boolean };

/**
 * Fetches a page's preview under the rules above. Never throws. `stillOn` is asked before every
 * request, the page's, each redirect's and the image's; once it says no, nothing more is fetched.
 */
export async function fetchLinkPreview(
  raw: string,
  net: PreviewNet,
  limits: PreviewLimits,
  stillOn: StillOn = async () => true,
): Promise<FetchedPreview> {
  let page: { meta: PageMeta };
  try {
    page = await withDeadline(limits.timeoutMs, async (signal) => {
      const { response, url } = await getChecked(net, raw, "text/html,application/xhtml+xml", limits, signal, stillOn);
      if (response.status < 200 || response.status > 299) {
        await response.body?.cancel().catch(() => {});
        throw new PreviewError(`HTTP ${response.status}`);
      }
      const type = (response.headers.get("content-type") ?? "").toLowerCase();
      if (!type.includes("text/html") && !type.includes("application/xhtml")) {
        await response.body?.cancel().catch(() => {});
        throw new PreviewError(`not an HTML page (${type || "no type"})`);
      }
      const bytes = await readAtMost(response, limits.htmlBytes, "The page");
      const charset = /charset=([\w-]+)/.exec(type)?.[1] ?? "utf-8";
      let html: string;
      try {
        html = new TextDecoder(charset, { fatal: false }).decode(bytes);
      } catch {
        html = new TextDecoder("utf-8").decode(bytes);
      }
      return { meta: parseMeta(html, url) };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, ...(message === TURNED_OFF ? { turnedOff: true } : {}) };
  }
  if (!page.meta.title && !page.meta.description) return { ok: false, error: "the page has no title or description" };
  if (!page.meta.image) return { ok: true, meta: page.meta };
  try {
    const image = await withDeadline(limits.timeoutMs, async (signal) => {
      const { response } = await getChecked(net, page.meta.image!, "image/png,image/jpeg,image/gif,image/webp", limits, signal, stillOn);
      if (response.status < 200 || response.status > 299) {
        await response.body?.cancel().catch(() => {});
        throw new PreviewError(`image: HTTP ${response.status}`);
      }
      const declared = (response.headers.get("content-type") ?? "").toLowerCase();
      if (declared.includes("svg")) {
        await response.body?.cancel().catch(() => {});
        throw new PreviewError("SVG images are never kept");
      }
      const bytes = await readAtMost(response, limits.imageBytes, "The image");
      const type = sniffImage(bytes);
      if (!type) throw new PreviewError("the image isn't PNG, JPEG, GIF or WebP");
      return { bytes, type };
    });
    return { ok: true, meta: page.meta, image };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === TURNED_OFF) return { ok: false, error: message, turnedOff: true };
    // The page's text is still a preview without its image.
    return { ok: true, meta: page.meta, imageError: message };
  }
}

// --- In the room ---------------------------------------------------------------------

export async function linkPreviewsOn(ctx: QueryCtx, teamId: Id<"teams">): Promise<boolean> {
  return (await ctx.db.get(teamId))?.linkPreviews !== "off";
}

/** At most this many teams are recorded as waiting on one pending fetch. */
const MAX_WAITING = 50;

/** The teams waiting on a pending row, with this one added. */
function waitingWith(row: { status: string; waitingTeams?: Id<"teams">[] } | null, teamId: Id<"teams">): Id<"teams">[] {
  const waiting = row?.status === "pending" ? (row.waitingTeams ?? []) : [];
  return waiting.includes(teamId) || waiting.length >= MAX_WAITING ? waiting : [...waiting, teamId];
}

/**
 * Asks for the previews a new or edited message needs, unless the team turned them off. A link
 * another team's fetch is already getting waits on that fetch, and is recorded as waiting, so the
 * fetch goes on for it if the team that started it turns previews off (#70).
 */
export async function requestPreviews(ctx: MutationCtx, teamId: Id<"teams">, urls: string[]): Promise<void> {
  if (!(await linkPreviewsOn(ctx, teamId))) return;
  const now = Date.now();
  for (const url of urls) {
    const row = await ctx.db
      .query("linkPreviews")
      .withIndex("by_url", (q) => q.eq("url", url))
      .unique();
    if (row?.status === "pending" && now - row.requestedAt < PENDING_RETRY_MS) {
      const waiting = waitingWith(row, teamId);
      if (waiting.length !== (row.waitingTeams ?? []).length) await ctx.db.patch(row._id, { waitingTeams: waiting });
      continue;
    }
    if (row && row.status !== "pending" && row.fetchedAt !== undefined && now - row.fetchedAt < PREVIEW_KEPT_MS) continue;
    const waitingTeams = waitingWith(row, teamId);
    if (row) await ctx.db.patch(row._id, { status: "pending", requestedAt: now, waitingTeams });
    else await ctx.db.insert("linkPreviews", { url, status: "pending", requestedAt: now, waitingTeams });
    await ctx.scheduler.runAfter(0, internal.linkPreviewNode.fetchPreview, { url, teamId });
  }
}

/** The previews a message shows: ready ones, as plain text, with the stored image's URL. */
export async function previewViews(ctx: QueryCtx, urls: string[]) {
  const out = [];
  for (const url of urls) {
    const row = await ctx.db
      .query("linkPreviews")
      .withIndex("by_url", (q) => q.eq("url", url))
      .unique();
    if (!row || (!row.title && !row.description)) continue;
    out.push({
      url,
      title: row.title,
      description: row.description,
      siteName: row.siteName,
      imageUrl: row.imageStorageId ? await ctx.storage.getUrl(row.imageStorageId) : null,
    });
  }
  return out;
}
