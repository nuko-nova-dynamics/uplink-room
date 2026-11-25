/**
 * Codex's session-flags config layer, built from `-c key=value` values as Codex 0.166.0 builds it
 * (`build_cli_overrides_layer` and `apply_toml_override` in codex-rs/config/src/overrides.rs,
 * `parse_overrides` in codex-rs/utils/cli/src/config_override.rs): in order, each value parsed as
 * TOML or else taken as a string with its quotes trimmed, each key split on every dot, and the last
 * segment set, replacing whatever was there.
 */
import { parse } from "smol-toml";

export type Toml = Record<string, any>;

export function sessionFlags(overrides: string[]): Toml {
  const root: Toml = {};
  for (const override of overrides) {
    const at = override.indexOf("=");
    const path = override.slice(0, at).trim().split(".");
    const raw = override.slice(at + 1).trim();
    let value: unknown;
    try {
      value = (parse(`_x_ = ${raw}`) as Toml)._x_;
    } catch {
      value = raw.replace(/^["']+|["']+$/g, "");
    }
    let table = root;
    for (const segment of path.slice(0, -1)) {
      if (!table[segment] || typeof table[segment] !== "object" || Array.isArray(table[segment])) table[segment] = {};
      table = table[segment];
    }
    table[path.at(-1)!] = value;
  }
  return root;
}

/** The `key=value` overrides in `codex` arguments: `-c` and `--config` values. */
export function overridesIn(args: string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-c" || args[i] === "--config") && i + 1 < args.length) found.push(args[++i]!);
    else if (args[i]!.startsWith("--config=")) found.push(args[i]!.slice("--config=".length));
  }
  return found;
}
