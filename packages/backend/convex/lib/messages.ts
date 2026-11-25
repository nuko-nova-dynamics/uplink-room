/**
 * Message text and limits (spec #63): mention tokens, plain-text previews, reactions and
 * attachments. Pure, so the desktop app shares it (`@uplink-room/backend/messages`).
 */

/** A person or agent named in a message body: `<@memberId>`. The app shows it as @Name. */
export const MENTION_TOKEN = /<@([0-9a-z]{8,64})>/g;

/**
 * A live run a message is addressed to: `<@run:runId>` (ADR 0026). The app shows it as the run's
 * name, such as @Claude Code (Julio). An app from before shows the token as text.
 */
export const RUN_TOKEN = /<@run:([0-9a-z]{8,64})>/g;

function idsOf(body: string, pattern: RegExp): string[] {
  const ids: string[] = [];
  for (const match of body.matchAll(pattern)) {
    if (!ids.includes(match[1]!)) ids.push(match[1]!);
  }
  return ids;
}

/** The member ids a body names with `<@memberId>`, in order, once each. */
export function mentionTokens(body: string): string[] {
  return idsOf(body, MENTION_TOKEN);
}

/** The run ids a body addresses with `<@run:runId>`, in order, once each. */
export function runTokens(body: string): string[] {
  return idsOf(body, RUN_TOKEN);
}

/**
 * The body with each `<@memberId>` written as `@Name` (or `@someone` for an unknown id), and each
 * `<@run:runId>` as `@` and the run's name (or `@a run`). `nameOf` is asked for both kinds of id.
 */
export function withNames(body: string, nameOf: (id: string, kind: "member" | "run") => string | undefined): string {
  return body
    .replace(MENTION_TOKEN, (_, id: string) => `@${nameOf(id, "member") ?? "someone"}`)
    .replace(RUN_TOKEN, (_, id: string) => `@${nameOf(id, "run") ?? "a run"}`);
}

/**
 * A short plain-text version of a message, for banners and agents: mentions as @Name (runs by their
 * names), Markdown marks and HTML tags dropped, white space folded, cut to `max` characters.
 */
export function plainPreview(
  body: string,
  format: "markdown" | "html",
  nameOf: (id: string, kind: "member" | "run") => string | undefined,
  max = 160,
): string {
  let text = withNames(body, nameOf);
  if (format === "html") {
    text = text
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  } else {
    text = text
      .replace(/```[a-z0-9-]*\n?/gi, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
      .replace(/(\*\*|__|~~|`)/g, "");
  }
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// --- Reactions ---------------------------------------------------------------

export const MAX_DISTINCT_REACTIONS = 20;
/** How many reactors' names each emoji carries in a message view. */
export const REACTION_NAMES = 3;

/** `\p{RGI_Emoji}` is a property of strings: it needs the `v` flag (ES2024). */
const RGI_EMOJI = (() => {
  try {
    return new RegExp("^\\p{RGI_Emoji}$", "v");
  } catch {
    return null;
  }
})();

/**
 * Whether `text` is exactly one emoji: one grapheme that Unicode lists as an emoji, including
 * sequences such as 👍🏽, 👩‍💻, flags and keycaps. Plain letters, digits and symbols are not.
 */
export function isSingleEmoji(text: string): boolean {
  if (!text || text.length > 32) return false;
  if (RGI_EMOJI) return RGI_EMOJI.test(text);
  // Without the `v` flag: one grapheme holding a pictograph or a flag letter.
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter && [...new Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length !== 1) {
    return false;
  }
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(text) && !/[\p{L}\s]/u.test(text);
}

// --- Attachments --------------------------------------------------------------

const KB = 1024;
const MB = 1024 * KB;

export const MAX_ATTACHMENTS = 10;
/** The same limits as project files for images and PDFs (spec #9); other files up to 50 MB. */
export const MAX_ATTACHMENT_BYTES = { image: 20 * MB, pdf: 50 * MB, file: 50 * MB } as const;
export const MAX_ATTACHMENT_NAME = 200;

export type AttachmentKind = keyof typeof MAX_ATTACHMENT_BYTES;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function extensionOf(name: string): string {
  return name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
}

/**
 * What an attachment named `name` is, and the content type it must have: images and PDFs show in
 * the app, so their stored type must match the extension. SVG is refused, because it can carry
 * script. Anything else is a `file`, only ever downloaded, whatever its type.
 */
export function attachmentKind(
  name: string,
): { kind: "image"; type: string } | { kind: "pdf"; type: string } | { kind: "file" } | { kind: "refused"; reason: string } {
  const ext = extensionOf(name);
  if (ext === "svg" || ext === "svgz") {
    return { kind: "refused", reason: "SVG images can't be attached, because they can run script. Attach a PNG instead." };
  }
  if (ext === "pdf") return { kind: "pdf", type: "application/pdf" };
  const image = IMAGE_TYPES[ext];
  if (image) return { kind: "image", type: image };
  return { kind: "file" };
}

/** A file name safe to store and show: no folders, no control characters, at most 200 characters. */
export function cleanAttachmentName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // oxlint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (clean.length <= MAX_ATTACHMENT_NAME) return clean;
  const ext = extensionOf(clean);
  const keep = MAX_ATTACHMENT_NAME - (ext ? ext.length + 1 : 0);
  return ext ? `${clean.slice(0, keep)}.${ext}` : clean.slice(0, MAX_ATTACHMENT_NAME);
}

export function sizeText(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(bytes >= 10 * MB ? 0 : 1)} MB`;
  if (bytes >= KB) return `${Math.round(bytes / KB)} KB`;
  return `${bytes} B`;
}
