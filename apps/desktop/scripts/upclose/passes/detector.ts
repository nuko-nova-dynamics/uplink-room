import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { coveredByLayer } from "./rules.ts";
import { scopeRules } from "../scope.ts";
import { resolve } from "node:path";
import { elements, finding, save, shot, type Context } from "./common.ts";
export async function detector(c: Context) {
  let code = 0,
    stdout = "",
    stderr = "";
  try {
    const r = await promisify(execFile)(
      "npx",
      [
        "-y",
        "impeccable@4.8.0",
        "detect",
        "--cdp",
        String(c.gym.port),
        "--target",
        "gym.html",
        "--json",
      ],
      {
        cwd: resolve(import.meta.dirname, "../../../../.."),
        timeout: 120000,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    stdout = r.stdout;
    stderr = r.stderr;
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    code = typeof e.code === "number" ? e.code : 1;
    stdout = e.stdout || "";
    stderr = e.stderr || String(error);
  }
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    data = null;
  }
  const file = c.paths.detector(c.state, c.theme);
  await save(file, { exitCode: code, data, stdout, stderr });
  const all = await elements(c);
  await shot(c, file + ".png");
  if (code === 1 || data === null || ![0, 2].includes(code))
    finding(c, "detector", undefined, "scan-failed", { code, stderr }, "Completed scan", file);
  else {
    const rows: Record<string, unknown>[] = Array.isArray(data)
      ? data
      : (data as { findings?: Record<string, unknown>[] })?.findings || [];
    for (const row of rows) {
      const selector = String(row["selector"] || "");
      if (
        selector &&
        (await c.page
          .locator(selector)
          .first()
          .evaluate(
            (el, classes) => {
              // A modal intentionally covers its inert background controls.
              if (el.closest("[inert]")) return true;
              for (let node: Element | null = el; node; node = node.parentElement)
                if (classes.some((name) => node!.classList.contains(name))) return true;
              return false;
            },
            scopeRules.find((r) => r.id === "third-party-dom")?.classes || [],
          )
          .catch(() => false))
      )
        continue;
      const index = selector
        ? await c.page
            .locator(selector)
            .first()
            .evaluate(
              (el, selectors) => {
                for (let node: Element | null = el; node; node = node.parentElement) {
                  const at = selectors.findIndex((s) => document.querySelector(s) === node);
                  if (at >= 0) return at;
                }
                return -1;
              },
              all.map((e) => e.selector),
            )
            .catch(() => -1)
        : -1;
      const matched =
        index >= 0
          ? all[index]
          : all.find(
              (e) => e.selector === selector || e.ancestry.some((a) => a.includes(selector)),
            );
      if (row["antipattern"] === "text-occlusion" && matched && coveredByLayer(matched)) continue;
      const e = matched ? { ...matched, selector: selector || matched.selector } : undefined;
      finding(
        c,
        "detector",
        e,
        String(row["rule"] || row["type"] || row["antipattern"] || "detector-finding"),
        row,
        "No detector finding",
        file,
      );
    }
    if (code === 2 && !rows.length)
      finding(
        c,
        "detector",
        undefined,
        "unparsed-findings",
        data,
        "Parse every detector finding",
        file,
      );
  }
}
