import type { Inventory, Measurement } from "./types.ts";
import { elementSelector, selectorSpecificity } from "./identity.ts";

export type Owner = { component: string; root: string };
export type OwnershipIndex = Map<string, Owner[]>;

/** Older runs recorded target paths but not owners. Use captured roots on that same scene. */
export function ownershipIndex(measurements: Measurement[], inventory?: Inventory): OwnershipIndex {
  const index: OwnershipIndex = new Map();
  const selectors = new Map(inventory?.components.map((c) => [c.id, c.selector]));
  for (const m of measurements) {
    const roots = index.get(m.gymState) ?? [];
    if (!roots.some((r) => r.root === m.target.selector && r.component === m.component))
      roots.push({ component: m.component, root: m.target.selector });
    index.set(m.gymState, roots);
  }
  for (const roots of index.values())
    roots.sort(
      (a, b) =>
        b.root.split(" > ").length - a.root.split(" > ").length ||
        selectorSpecificity(selectors.get(b.component) ?? "") -
          selectorSpecificity(selectors.get(a.component) ?? "") ||
        a.component.localeCompare(b.component),
    );
  return index;
}

export function withOwnership(m: Measurement, index: OwnershipIndex): Measurement {
  if (m.owners) return m;
  const roots = index.get(m.gymState) ?? [];
  const owners: NonNullable<Measurement["owners"]> = {};
  const all = [
    m.target,
    ...m.icons,
    ...m.texts,
    ...m.rowPeers,
    ...m.columnPeers,
    ...(m.extraElements ?? []),
    ...(m.focus ? [m.focus.element] : []),
  ];
  for (const e of all) {
    const selector = elementSelector(e.selector);
    const owner = roots.find((r) => selector === r.root || selector.startsWith(`${r.root} > `));
    if (owner) owners[selector] = owner;
  }
  return { ...m, owners };
}

export function owns(m: Measurement, selector: string): boolean {
  return (
    !m.owners?.[elementSelector(selector)] ||
    m.owners[elementSelector(selector)]!.component === m.component
  );
}
