import { resolve } from "node:path";
import { openGym } from "../launch.ts";
import { runPaths, type Finding, type Theme } from "../types.ts";
import {
  inventory,
  save,
  finding,
  loadState,
  sizeWindow,
  shot,
  enableWindowSizing,
  type Context,
} from "./common.ts";
import { mouse } from "./mouse.ts";
import { keyboard, keyboardOverlays } from "./keyboard.ts";
import { motion } from "./motion.ts";
import { overflow } from "./overflow.ts";
import { detector } from "./detector.ts";
import { recheckCursor } from "./cursor-recheck.ts";
const args = process.argv.slice(2),
  run = resolve(args[0] || "");
if (!args[0])
  throw new Error(
    "Usage: run.ts <run-folder> [--passes mouse,keyboard,motion,overflow,detector] [--states ids] [--shard i/n]",
  );
if (process.platform === "darwin" || !process.env["UPLINK_GYM_XVFB"])
  throw new Error("Run only on a gym box with UPLINK_GYM_XVFB=1");
const option = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const passes = { mouse, keyboard, motion, overflow, detector };
const selected = (option("--passes") || Object.keys(passes).join(",")).split(
  ",",
) as (keyof typeof passes)[];
for (const p of selected) if (!passes[p]) throw new Error("Unknown pass " + p);
const shard = (option("--shard") || "1/1").split("/").map(Number),
  index = shard[0]!,
  total = shard[1]!;
if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || index > total)
  throw new Error("Invalid shard");
await enableWindowSizing();
let failed = false;
const inv = await inventory(),
  gym = await openGym();
try {
  gym.page.setDefaultTimeout(3000);
  const states = (
    await gym.page.evaluate(() => (window as unknown as { gymStates: { id: string }[] }).gymStates)
  ).map((s) => s.id);
  const requested = option("--states")?.split(",");
  if (requested?.some((s) => !states.includes(s))) throw new Error("Unknown gym state");
  const chosen = states
    .filter((s) => !requested || requested.includes(s))
    .filter((_, i) => i % total === index - 1);
  const summary: Record<string, unknown> = { states: chosen, shard: `${index}/${total}` };
  await save(resolve(run, "states.json"), summary);
  for (const pass of selected) {
    const findings: Finding[] = [];
    const started = Date.now();
    const coverage = [];
    for (const state of chosen)
      for (const theme of ["dark", "light"] as Theme[]) {
        const c: Context = {
          gym,
          page: gym.page,
          run,
          state,
          theme,
          inventory: inv,
          findings,
          paths: runPaths(run),
        };
        const at = Date.now();
        try {
          await sizeWindow(gym.page, 1320, 840);
          if (!(await loadState(gym.page, state, theme)) && pass !== "detector")
            throw new Error("State did not render");
          if (pass === "keyboard" && args.includes("--overlays-only")) await keyboardOverlays(c);
          else await passes[pass](c);
          coverage.push({ state, theme, seconds: (Date.now() - at) / 1000, ok: true });
        } catch (error) {
          failed = true;
          const artifact = c.paths.detector(state, theme) + "." + pass + ".error.json";
          await save(artifact, { error: String(error) });
          const picture = artifact + ".png";
          const pictured = await shot(c, picture).then(
            () => true,
            () => false,
          );
          finding(
            c,
            pass,
            undefined,
            "pass-error",
            String(error),
            "Pass completes",
            pictured ? picture : artifact,
          );
          coverage.push({ state, theme, ok: false, error: String(error) });
        }
        await save(runPaths(run).findings(pass), findings);
        console.log(
          JSON.stringify({
            pass,
            state,
            theme,
            findings: findings.length,
            seconds: (Date.now() - at) / 1000,
          }),
        );
      }
    if (pass === "mouse" && chosen.length) {
      const corrected = await recheckCursor(run);
      findings.splice(0, findings.length, ...corrected);
    }
    summary[pass] = { seconds: (Date.now() - started) / 1000, findings: findings.length, coverage };
    await save(resolve(run, "passes.json"), summary);
  }
} finally {
  await gym.close();
}

if (failed) process.exitCode = 1;
