/**
 * For the analytics tests: words no event property may be named after, because a property by
 * that name would carry a person's name or email, or message, terminal, document or URL contents.
 */
export const FORBIDDEN = [
  "email",
  "name",
  "title",
  "text",
  "body",
  "message",
  "content",
  "prompt",
  "command",
  "input",
  "output",
  "transcript",
  "url",
  "href",
  "path",
  "pathname",
  "repo",
  "query",
  "referrer",
];

/** Every key in `value`, nested ones included, named after a forbidden word. */
export function forbiddenKeys(value: unknown, at = ""): string[] {
  if (!value || typeof value !== "object") return [];
  const found: string[] = [];
  for (const [key, inner] of Object.entries(value)) {
    // Replay data is masked by the recorder and checked on its own.
    if (key === "$snapshot_data") continue;
    const words = key.toLowerCase().replace(/^\$/, "").split(/[_/.-]/);
    if (FORBIDDEN.some((word) => words.includes(word))) found.push(at + key);
    found.push(...forbiddenKeys(inner, `${at}${key}.`));
  }
  return found;
}
