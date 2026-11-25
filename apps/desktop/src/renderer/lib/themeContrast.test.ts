import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

/** Resolve theme aliases as CSS does so neutral state tokens share one contrast check. */
function themeTokens(theme: "dark" | "light"): Record<string, string> {
  const css = readFileSync(join(import.meta.dirname, "..", "styles.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const root = /:root\s*\{([^}]*)\}/.exec(css)![1]!;
  const light = /:root\[data-theme="light"\]\s*\{([^}]*)\}/.exec(css)![1]!;
  const tokens = Object.fromEntries(
    [
      ...(root + (theme === "light" ? light : "")).matchAll(
        /--([\w-]+):\s*(#[0-9a-f]{6}|var\(--[\w-]+\))\s*;/gi,
      ),
    ].map(([, name, value]) => [name!, value!.toLowerCase()]),
  );
  const resolve = (name: string): string => {
    const value = tokens[name]!;
    const alias = /^var\(--([\w-]+)\)$/.exec(value);
    return alias ? resolve(alias[1]!) : value;
  };
  return Object.fromEntries(Object.keys(tokens).map((name) => [name, resolve(name)]));
}

/** WCAG 2 contrast between two colors. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

test.each(["dark", "light"] as const)("%s state text reads at 4.5:1 on every surface", (theme) => {
  const tokens = themeTokens(theme);
  for (const color of ["working", "done", "done-text", "failed", "stopped"])
    for (const surface of ["raised", "ground", "sidebar", "hover"]) {
      const ratio = contrast(tokens[color]!, tokens[surface]!);
      expect(
        ratio,
        `${color} ${tokens[color]} on ${surface} ${tokens[surface]}: ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
});
