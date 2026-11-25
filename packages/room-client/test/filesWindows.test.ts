import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { tempDir } from "./support.ts";

const fault = vi.hoisted(() => ({ suffix: "", code: "", remaining: 0, operation: "open" }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rm: (...args: Parameters<typeof fs.rm>) => {
      if (fault.operation === "rm" && String(args[0]).endsWith(fault.suffix) && fault.remaining-- > 0)
        return Promise.reject(Object.assign(new Error("Windows sharing violation"), { code: fault.code }));
      return fs.rm(...args);
    },
    open: (...args: Parameters<typeof fs.open>) => {
      if (fault.operation === "open" && String(args[0]).endsWith(fault.suffix) && fault.remaining-- > 0)
        return Promise.reject(
          Object.assign(new Error("Windows sharing violation"), { code: fault.code }),
        );
      return fs.open(...args);
    },
  };
});
import { withFileLock } from "../src/files.ts";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  fault.remaining = 0;
});

for (const suffix of [".uplink-lock", ".takeover"]) {
  test.each(["EPERM", "EACCES", "EBUSY"])(
    `retries %s opening ${suffix} on Windows`,
    async (code) => {
      const dir = await tempDir("uplink-lock-busy-");
      const file = join(dir, "settings.json");
      if (suffix === ".takeover") await writeFile(`${file}.uplink-lock`, "0 abandoned");
      Object.defineProperty(process, "platform", { value: "win32" });
      Object.assign(fault, { suffix, code, remaining: 2, operation: "open" });
      const work = vi.fn(async () => "done");
      await expect(withFileLock(file, work, { staleMs: -1 })).resolves.toBe("done");
      expect(work).toHaveBeenCalledOnce();
      expect(fault.remaining).toBeLessThanOrEqual(0);
    },
  );
}

for (const suffix of [".uplink-lock", ".takeover"]) {
  test.each(["EPERM", "EACCES", "EBUSY"])(`retries %s removing ${suffix} on Windows`, async (code) => {
    const dir = await tempDir("uplink-unlock-busy-");
    const file = join(dir, "settings.json");
    if (suffix === ".takeover") await writeFile(`${file}.uplink-lock`, "0 abandoned");
    Object.defineProperty(process, "platform", { value: "win32" });
    Object.assign(fault, { suffix, code, remaining: 2, operation: "rm" });
    await withFileLock(file, async () => {}, { staleMs: -1 });
    expect(await readdir(dir)).toEqual([]);
  });
}
