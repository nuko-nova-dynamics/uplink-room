import type { Inventory, InventoryComponent, InventoryState, Rect, Scale, Theme } from "./types.ts";

export type Options = {
  run: string;
  components: string[];
  states: string[];
  shard: [number, number];
  skipChecks: boolean;
};
export type CaptureTask = { component: InventoryComponent; state: InventoryState; theme: Theme };
export function parseArgs(args: string[]): Options {
  const run = args[0];
  if (!run || run.startsWith("--"))
    throw new Error(
      "Usage: node scripts/upclose/run.ts <run-folder> [--components ids] [--states ids] [--shard i/n] [--skip-checks]",
    );
  const options: Options = { run, components: [], states: [], shard: [1, 1], skipChecks: false };
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (key === "--skip-checks") {
      options.skipChecks = true;
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    if (key === "--components" || key === "--states")
      options[key.slice(2) as "components" | "states"] = value.split(",").filter(Boolean);
    else if (key === "--shard" && /^\d+\/\d+$/.test(value)) {
      const [part, total] = value.split("/").map(Number) as [number, number];
      if (part < 1 || part > total || total > 256)
        throw new Error("Shard must be 1-based i/n, with 1 <= i <= n <= 256");
      options.shard = [part, total];
    } else throw new Error(`Unknown option or invalid value: ${key} ${value}`);
  }
  return options;
}

/** Each component belongs to one shard, so no two shards write the same path. */
export function plan(
  inventory: Inventory,
  options: Pick<Options, "components" | "states" | "shard">,
): CaptureTask[] {
  for (const id of options.components)
    if (!inventory.components.some((c) => c.id === id)) throw new Error(`Unknown component ${id}`);
  for (const id of options.states)
    if (!inventory.components.some((c) => c.states.some((s) => s.id === id)))
      throw new Error(`Unknown state ${id}`);
  return inventory.components
    .filter((c) => !options.components.length || options.components.includes(c.id))
    .filter((_, i) => i % options.shard[1] === options.shard[0] - 1)
    .flatMap((component) =>
      component.states
        .filter((s) => !options.states.length || options.states.includes(s.id))
        .flatMap((state) =>
          (["dark", "light"] as const).map((theme) => ({ component, state, theme })),
        ),
    );
}

/** Passive captures share a load; each state with input gets its own fresh load. */
export function groups(tasks: CaptureTask[]): CaptureTask[][] {
  const passive = new Map<string, CaptureTask[]>();
  const interactive: CaptureTask[][] = [];
  for (const task of tasks) {
    if (task.state.steps?.length) interactive.push([task]);
    else {
      const key = `${task.state.gymState}/${task.theme}`;
      const group = passive.get(key) ?? [];
      group.push(task);
      passive.set(key, group);
    }
  }
  return [...passive.values(), ...interactive].sort((a, b) =>
    `${a[0]!.state.gymState}/${a[0]!.theme}`.localeCompare(
      `${b[0]!.state.gymState}/${b[0]!.theme}`,
    ),
  );
}

/** Whole device pixels, rounded outward and clamped to the viewport. */
export function cropRect(
  rect: Rect,
  viewport: { width: number; height: number },
  scale: Scale,
  margin = 5,
): Rect & { margin: number } {
  const x = Math.max(0, Math.floor((rect.x - margin) * scale) / scale);
  const y = Math.max(0, Math.floor((rect.y - margin) * scale) / scale);
  const right = Math.min(viewport.width, Math.ceil((rect.x + rect.width + margin) * scale) / scale);
  const bottom = Math.min(
    viewport.height,
    Math.ceil((rect.y + rect.height + margin) * scale) / scale,
  );
  if (right <= x || bottom <= y) throw new Error("Target has no visible area inside the viewport");
  return { x, y, width: right - x, height: bottom - y, margin };
}
