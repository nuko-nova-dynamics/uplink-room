import { readFileSync } from "node:fs";
import type { CheckId, MeasuredElement, Measurement } from "./types.ts";
import { elementSelector } from "./identity.ts";

type ScopeCheck = CheckId | "icon-sizes" | "icon-pixels";
export type ScopeRule = {
  id: string;
  classes?: string[];
  frame?: { path: string; selector: string };
  checks: "all" | ScopeCheck[];
  reason: string;
};
export const scopeRules = (
  JSON.parse(readFileSync(new URL("./scope.json", import.meta.url), "utf8")) as {
    rules: ScopeRule[];
  }
).rules;
export type ScopeCounts = {
  rules: (ScopeRule & { excluded: number; byCheck: Record<string, number> })[];
};
export const emptyScopeCounts = (): ScopeCounts => ({
  rules: scopeRules.map((r) => ({ ...r, excluded: 0, byCheck: {} })),
});

export function scopeRule(
  m: Measurement,
  selector: string,
  check: ScopeCheck,
): ScopeRule | undefined {
  const path = elementSelector(selector);
  return scopeRules.find((rule) => {
    if (rule.checks !== "all" && !rule.checks.includes(check)) return false;
    if (rule.id === "running-rotation") {
      const rotation = m.rotations?.[path];
      if (rotation) return rotation === "running";
      return /\.state-icon(?![\w-])[^>]*\.live(?![\w-])/.test(path) && !!m.layoutRects?.[path];
    }
    if (m.scopeMatches?.[path]?.includes(rule.id)) return true;
    return rule.classes?.some((name) => new RegExp(`\\.${name}(?![\\w-])`).test(path)) ?? false;
  });
}

export function inScope(m: Measurement, e: MeasuredElement, check: ScopeCheck): boolean {
  return !scopeRule(m, e.selector, check);
}
