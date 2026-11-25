/**
 * Keeps the room's token for an agent's gateway out of what the room saves (ADR 0012, ADR 0018).
 * An agent can say anything back: an error that echoes the request's headers, a status message, an
 * artifact streamed in pieces. Run errors, connection checks and what the agent reported are
 * readable by anyone in the team with `room.read`, while the token is shown only as its last four
 * characters. So every text an agent supplied is cleaned before it is kept, and cleaned again
 * whenever pieces are joined (stream chunks appended to an artifact), right before each save:
 *
 *   - the token itself, as sent, URL-encoded and JSON-escaped;
 *   - the value after a credential header's name (`Authorization: …`, `"x-api-key":"…"`): a
 *     quoted value up to its closing quote, and a Cookie or Set-Cookie value with every pair;
 *   - `Bearer` or `Basic` followed by something shaped like a token: 16 or more characters with
 *     no space, holding a digit or both cases, so "basic arithmetic" stays as written.
 *
 * Cleaning comes before cutting, always: a text is cut only after the token is out of it, and a
 * cut that ends with the start of the token (6 characters or more) loses that start too.
 */
import type { Credential } from "./protocol";

export const REDACTED = "[redacted]";

/** The longest error or check result the room keeps. */
export const MAX_SAVED_TEXT = 600;

/** The shortest start of the token taken out at a cut. */
const MIN_TOKEN_START = 6;

/** Headers whose value is a credential, whatever the gateway calls its own. */
const CREDENTIAL_HEADERS = [
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "cookie",
  "set-cookie",
];

/** Headers whose value holds `;`-separated parts, all of them secret. */
const COOKIE_HEADERS = ["set-cookie", "cookie"];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A run after `Bearer` or `Basic` that looks like a token, not a word: a digit, or both cases. */
function tokenLike(run: string): boolean {
  return /\d/.test(run) || (/[a-z]/.test(run) && /[A-Z]/.test(run));
}

export type Redactor = {
  /** The text with the credential taken out, whole. */
  clean(text: string): string;
  /** Cleaned first, then cut to `max` characters (the last one "…"), with no start of the token left at the cut. */
  cut(text: string, max: number): { text: string; truncated: boolean };
};

export function redactor(credential: Credential | null): Redactor {
  // Shorter than 4 characters, a token would be found inside ordinary words.
  const forms =
    credential && credential.secret.length >= 4
      ? [
          ...new Set([
            credential.secret,
            encodeURIComponent(credential.secret),
            JSON.stringify(credential.secret).slice(1, -1),
          ]),
        ]
      : [];
  const names = [
    ...new Set([
      ...CREDENTIAL_HEADERS,
      ...(credential?.kind === "header" ? [credential.name.toLowerCase()] : []),
    ]),
  ];
  // A header and its value, as text or JSON: `Authorization: Bearer x`, `"x-api-key":"x"`, `api-key=x`.
  // A quoted value goes whole, up to its closing quote, whatever it holds (`"Bearer a,b"`). An
  // unquoted one ends at the first separator, except a cookie's: a Cookie header is pairs joined by
  // `; ` and a Set-Cookie header has attributes after `;` (an Expires date has a comma), so its
  // value goes to the end of the line.
  const headerPattern = (list: string[], unquoted: string) =>
    new RegExp(
      `(["']?)(${list.map(escapeRegExp).join("|")})\\1(\\s*[:=]\\s*)(?:(["'])(?:\\\\.|(?!\\4)[^\\\\\\r\\n])*|${unquoted})`,
      "gi",
    );
  const headers = [
    headerPattern(names.filter((n) => !COOKIE_HEADERS.includes(n)), `[^"'\\r\\n,;}&]*`),
    headerPattern(COOKIE_HEADERS, `[^\\r\\n]*`),
  ];
  const scheme = /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{16,})/gi;

  const clean = (text: string): string => {
    let out = text;
    for (const form of forms) out = out.split(form).join(REDACTED);
    for (const header of headers) {
      out = out.replace(
        header,
        (_match, quote: string, name: string, separator: string, valueQuote: string | undefined) =>
          `${quote}${name}${quote}${separator}${valueQuote ?? ""}${REDACTED}`,
      );
    }
    return out.replace(scheme, (match, word: string, space: string, run: string) =>
      tokenLike(run) ? `${word}${space}${REDACTED}` : match,
    );
  };

  /** A cut that ends with the start of the token loses it: the rest may have been past the cut. */
  const withoutTokenStart = (head: string): string => {
    for (const form of forms) {
      for (let k = Math.min(form.length - 1, head.length); k >= MIN_TOKEN_START; k--) {
        if (head.endsWith(form.slice(0, k))) return `${head.slice(0, head.length - k)}${REDACTED}`;
      }
    }
    return head;
  };

  const cut = (text: string, max: number) => {
    const whole = clean(text);
    if (whole.length <= max) return { text: whole, truncated: false };
    return { text: `${withoutTokenStart(whole.slice(0, max - 1))}…`, truncated: true };
  };

  return { clean, cut };
}

/** Takes nothing out but credential headers and bearer or basic tokens: for text read without the room's token at hand. */
export const PLAIN_REDACTOR = redactor(null);

/** `text` without the credential, cut to `max` characters. */
export function redact(text: string, credential: Credential | null, max = MAX_SAVED_TEXT): string {
  return redactor(credential).cut(text, max).text;
}
