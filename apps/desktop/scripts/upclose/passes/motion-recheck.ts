// Reapply motion checks to recorded animations without launching a window.
import { readFile, access } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { walk } from "../files.ts";
import { findingId, runPaths, type Finding, type Theme } from "../types.ts";
import { inventory, save } from "./common.ts";
import {
  animationEasings,
  motionProperty,
  nearestComponent,
  sceneComponents,
  tokenValue,
} from "./rules.ts";
type AnimationRecord = {
  index: number;
  outOfScope?: boolean;
  ancestry: string[][];
  selector?: string;
  html?: string;
  duration: number | string;
  easing?: string;
  property?: string | null;
  iterations?: number | string;
  frames: Record<string, unknown>[];
  live: boolean;
};
type CaptureRecord = {
  component: string;
  state: string;
  phase?: string;
  reduced: boolean;
  tokens: Record<string, string>;
  animations?: AnimationRecord[];
};
export async function recheckMotion(run: string) {
  run = resolve(run);
  const paths = runPaths(run),
    inv = await inventory();
  const original: Finding[] = JSON.parse(await readFile(paths.findings("motion"), "utf8"));
  const rebuilt = new Set([
    "duration-token",
    "easing-token",
    "transition-property",
    "reduced-motion",
    "only-live-things-move",
  ]);
  const findings = original.filter((f) => !rebuilt.has(f.message));
  const unique = new Map<string, Finding>();
  let liveCorrections = 0;
  for (const file of await walk(resolve(run, "motion", "index"))) {
    if (!file.endsWith("animations.json")) continue;
    const parts = relative(resolve(run, "motion", "index"), file).split(sep),
      gs = parts[0]!,
      theme = parts[1] as Theme;
    const records: CaptureRecord[] = JSON.parse(await readFile(file, "utf8"));
    const phases = new Map<string, number>();
    for (const record of records) {
      if (!record.animations) continue;
      const phaseKey = [record.component, record.state, record.reduced].join("/");
      const n = phases.get(phaseKey) || 0;
      phases.set(phaseKey, n + 1);
      const phase = record.phase || (n === 0 ? "trigger" : "release");
      for (const a of record.animations) {
        if (a.outOfScope) continue;
        const component = nearestComponent(a.ancestry || [], sceneComponents(inv.components, gs));
        if (
          component === "state-icon" ||
          (/space/i.test(component) && /class="[^"]*spin/.test(a.html || ""))
        ) {
          if (!a.live) liveCorrections++;
          a.live = true;
        }
        const selector =
          a.selector || inv.components.find((c) => c.id === component)?.selector || "body";
        let artifact = file;
        const candidates = [
          paths.motion(
            component,
            `${gs}-${record.state}-${phase}-${a.index}`,
            theme,
            (record.reduced ? "reduced/" : "") + "f000.png",
          ),
          paths.motion(
            record.component,
            `${gs}-${record.state}-${phase}`,
            theme,
            (record.reduced ? "reduced/" : "") + "f000.png",
          ),
          ...original
            .filter((f) => f.gymState === gs && f.theme === theme && f.artifact)
            .map((f) => resolve(run, f.artifact!)),
        ];
        for (const candidate of candidates)
          if (
            await access(candidate).then(
              () => true,
              () => false,
            )
          ) {
            artifact = candidate;
            break;
          }
        const add = (rule: string, value: unknown, expected: string) => {
          const f = {
            check: "motion" as const,
            component,
            state: gs,
            gymState: gs,
            theme,
            selector,
            measured: { rule, value },
            expected,
            message: rule,
            artifact: relative(run, artifact),
          };
          unique.set(JSON.stringify([gs, theme, component, selector, rule, value]), {
            ...f,
            id: findingId(f),
          });
        };
        const duration = Number(a.duration);
        if (a.property && !motionProperty(a.property))
          add("transition-property", a.property, "transform, opacity or color");
        const props = [
          ...new Set(
            a.frames
              .flatMap((f) => Object.keys(f))
              .filter((k) => !["offset", "computedOffset", "easing", "composite"].includes(k)),
          ),
        ];
        if (record.reduced && duration > 0 && props.some((p) => p !== "opacity"))
          add(
            "reduced-motion",
            { properties: props, duration: a.duration },
            "No movement; fade only",
          );
        if ((a.iterations === "Infinity" || Number(a.iterations) > 1) && !a.live)
          add(
            "only-live-things-move",
            { html: a.html, iterations: String(a.iterations) },
            "Repeating motion only on live activity",
          );
        if (duration > 0) {
          const durations = Object.values(record.tokens)
            .flatMap((v) => v.split(","))
            .map((v) => v.trim())
            .filter((v) => /^\d*\.?\d+m?s$/.test(v))
            .map((v) => parseFloat(v) * (v.endsWith("ms") ? 1 : 1000));
          if (!durations.some((d) => Math.abs(d - duration) < 1))
            add(
              "duration-token",
              { duration: a.duration, tokens: record.tokens },
              "Duration from a root motion token",
            );
          for (const easing of animationEasings(a.easing, a.frames))
            if (!tokenValue(easing, record.tokens))
              add(
                "easing-token",
                { easing, tokens: record.tokens },
                "Easing from a root motion token",
              );
        }
      }
    }
    await save(file, records);
  }
  findings.push(...unique.values());
  await save(paths.findings("motion"), findings);
  await save(resolve(run, "motion-recheck.json"), {
    previousFindings: original.length,
    rebuiltFindings: unique.size,
    liveCorrections,
    mapping: "Animation target ancestry takes precedence over the visible fallback crop target.",
  });
  return findings;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await recheckMotion(process.argv[2]!);
