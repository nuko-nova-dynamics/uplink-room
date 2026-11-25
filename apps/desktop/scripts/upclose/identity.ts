/** Remove positional and React-generated identity, retaining semantic classes and text runs. */
export function normalizedSelector(selector: string): string {
  return selector
    .replace(/:nth-(?:child|of-type)\(\d+\)/g, "")
    .replace(
      /\.(?:is-)?(?:selected|active|open|disabled|hover|pressed|focused|focus-visible|on|off|live)(?![\w-])/g,
      "",
    )
    .replace(/\.state-(?:working|waiting|done|failed|stopped)(?![\w-])/g, "")
    .replace(/#(?:\\:|:)[rR][\w\\:-]*(?:\\:|:)/g, "")
    .replace(/#_?[rR]_[\w-]+_?/g, "")
    .replace(/>\s*(?=>)/g, "")
    .replace(/::text\(\d+\)\[\d+:\d+\]/g, "::text")
    .replace(/\s+/g, " ")
    .trim();
}

/** Prefer a constrained selector to a generic alias on the same DOM root. */
export function selectorSpecificity(selector: string): number {
  const text = selector.replace(/"[^"]*"|'[^']*'/g, "");
  return (
    (text.match(/#[\w-]+/g)?.length ?? 0) * 10000 +
    (text.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g)?.length ?? 0) * 100 +
    (text.match(/(?:^|[\s>+~(])[a-z][\w-]*/gi)?.length ?? 0)
  );
}

export function elementSelector(selector: string): string {
  return selector.replace(/::(?:text\(\d+\)\[\d+:\d+\]|value)$/, "");
}

/** Object key order is not part of a measured value. Array order is. */
export function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableValue(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
