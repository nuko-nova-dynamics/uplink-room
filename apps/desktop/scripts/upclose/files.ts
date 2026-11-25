import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Return files in code-point order, independent of directory enumeration and host locale. */
export async function walk(folder: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: string[] = [];
  for (const entry of entries.toSorted((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (entry.isDirectory()) result.push(...(await walk(join(folder, entry.name))));
    else if (entry.isFile()) result.push(join(folder, entry.name));
  }
  return result;
}
