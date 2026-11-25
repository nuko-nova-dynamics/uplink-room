import { link, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { scopeRules } from "../scope.ts";
import { loadState } from "./common.ts";
import {
  motionProperty,
  nearestComponent,
  sceneComponents,
  animationEasings,
  tokenValue,
} from "./rules.ts";
import { elements, finding, mapped, save, shot, steps, video, type Context } from "./common.ts";
export async function motion(c: Context) {
  const observer = await c.page.context().newCDPSession(c.page);
  const { identifier } = await observer.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(()=>{const seen=[];let frame;window.__earlyAnimations=seen;const poll=()=>{for(const a of document.getAnimations())if(!seen.includes(a))seen.push(a);frame=requestAnimationFrame(poll)};window.__stopEarlyAnimations=()=>cancelAnimationFrame(frame);poll()})()`,
  });
  try {
    const records = [];
    const actions = c.inventory.components.flatMap((component) =>
      component.states.filter((s) => s.gymState === c.state).map((state) => ({ component, state })),
    );
    if (!actions.some((a) => !a.state.steps?.length))
      actions.unshift({
        component: {
          id: "unmapped",
          name: "Page animations",
          kind: "view",
          selector: "body",
          sources: [],
          zoom: false,
          states: [],
        },
        state: { id: "initial", gymState: c.state },
      });
    const seen = new Set<string>();
    for (const { component, state } of actions) {
      const key = `${component.id}/${state.id}/${JSON.stringify(state.steps || [])}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const [reduced, phase] of [false, true].flatMap((reduced) =>
        (state.steps?.length ? ["trigger", "release"] : ["trigger"]).map(
          (phase) => [reduced, phase] as const,
        ),
      )) {
        await loadState(c.page, c.state, c.theme, { reducedMotion: reduced });
        if (phase === "release") {
          try {
            await steps(c, state.steps || []);
          } catch {
            continue;
          }
        }
        // A passive specimen may be below the fold; record its actual animation in view.
        const specimen = c.page.locator(state.target || component.selector).first();
        if (await specimen.isVisible().catch(() => false)) await specimen.scrollIntoViewIfNeeded();
        const before = await elements(c);
        let target = before.find((e) =>
          e.ancestry.some((a) => a.includes(state.target || component.selector)),
        );
        if (!target) target = before.find((e) => e.control) || before[0];
        if (!target) {
          records.push({
            component: component.id,
            state: state.id,
            reduced,
            error: "Selector did not match visible element",
          });
          continue;
        }
        const name = `${c.state}-${state.id}-${phase}`;
        const path = (file: string) =>
          c.paths.motion(component.id, name, c.theme, (reduced ? "reduced/" : "") + file);
        const stop = await video(path("live.webm"));
        const videoLinks = new Set<string>();
        try {
          // Pause as soon as an animation is observed, before a short transition can finish.
          await c.page.evaluate((ignoreExisting) => {
            const w = window as unknown as { __motionPoll?: number; __motions?: Animation[] };
            const early = window as unknown as {
              __earlyAnimations?: Animation[];
              __stopEarlyAnimations?: () => void;
            };
            early.__stopEarlyAnimations?.();
            const existing = new Set([
              ...(early.__earlyAnimations || []),
              ...document.getAnimations(),
            ]);
            w.__motions = ignoreExisting ? [] : [...existing];
            for (const a of existing) a.pause();
            const poll = () => {
              for (const a of document.getAnimations())
                if ((!ignoreExisting || !existing.has(a)) && !w.__motions!.includes(a)) {
                  a.pause();
                  w.__motions!.push(a);
                }
              w.__motionPoll = requestAnimationFrame(poll);
            };
            poll();
          }, !!state.steps?.length);
          try {
            if (phase === "release") {
              if (state.steps?.some((s) => s.do === "press")) await c.page.mouse.up();
              else if (state.steps?.some((s) => s.do === "hover")) await c.page.mouse.move(1, 1);
              else await c.page.keyboard.press("Escape");
            } else {
              await steps(c, state.steps || []);
            }
          } catch (error) {
            records.push({
              component: component.id,
              state: state.id,
              reduced,
              error: String(error),
            });
          }
          await c.page.waitForTimeout(80);
          target =
            (await elements(c)).find((e) =>
              e.ancestry.some((a) => a.includes(state.target || component.selector)),
            ) || target;
          const data = await c.page.evaluate(
            ({ selectors, libraries }) => {
              const w = window as unknown as { __motionPoll: number; __motions: Animation[] };
              cancelAnimationFrame(w.__motionPoll);
              const root = getComputedStyle(document.documentElement);
              const tokens: Record<string, string> = {};
              for (const sheet of document.styleSheets) {
                try {
                  for (const rule of sheet.cssRules) {
                    if (rule instanceof CSSStyleRule && rule.selectorText.includes(":root"))
                      for (const name of rule.style)
                        if (name.startsWith("--"))
                          tokens[name] = root.getPropertyValue(name).trim();
                  }
                } catch {
                  /* Cross-origin sheets do not expose CSS rules. */
                }
              }
              return {
                tokens,
                animations: w.__motions.map((a, i) => {
                  const e = (a.effect as KeyframeEffect)?.target as Element | null;
                  const t = a.effect?.getComputedTiming();
                  return {
                    index: i,
                    outOfScope: !!e && libraries.some((name) => e.closest("." + CSS.escape(name))),
                    selector: (() => {
                      const parts: string[] = [];
                      for (
                        let node = e;
                        node && node !== document.body;
                        node = node.parentElement
                      ) {
                        if (node.id) {
                          parts.unshift("#" + CSS.escape(node.id));
                          return parts.join(" > ");
                        }
                        const tag = node.tagName.toLowerCase();
                        const siblings = [...(node.parentElement?.children || [])].filter(
                          (s) => s.tagName === node!.tagName,
                        );
                        parts.unshift(
                          tag +
                            (siblings.length > 1
                              ? `:nth-of-type(${siblings.indexOf(node) + 1})`
                              : ""),
                        );
                      }
                      return "body > " + parts.join(" > ");
                    })(),
                    html: e?.outerHTML.slice(0, 400),
                    target: e?.tagName,
                    ancestry: (() => {
                      const rows: string[][] = [];
                      for (let n = e; n; n = n.parentElement)
                        rows.push(
                          selectors.filter((s) => {
                            try {
                              return n!.matches(s);
                            } catch {
                              return false;
                            }
                          }),
                        );
                      return rows;
                    })(),
                    rect: e?.getBoundingClientRect().toJSON(),
                    duration: t?.duration,
                    easing: a.effect?.getTiming().easing,
                    iterations: t?.iterations === Infinity ? "Infinity" : t?.iterations,
                    property: a instanceof CSSTransition ? a.transitionProperty : null,
                    frames: (a.effect as KeyframeEffect)?.getKeyframes() || [],
                    live: !!e?.closest(
                      "[data-state=working], [data-state=typing], .working, .typing, .timer, .state-icon.live, .space-state .spin, .face-working, .agent-working",
                    ),
                  };
                }),
              };
            },
            {
              selectors: sceneComponents(c.inventory.components, c.state).map((c) => c.selector),
              libraries: scopeRules.find((r) => r.id === "third-party-dom")?.classes || [],
            },
          );
          records.push({ component: component.id, state: state.id, phase, reduced, ...data });
          // Static and reduced-motion states still need visible endpoints. An absent
          // animation is intentional behavior, not a reason to omit their frames.
          for (const a of data.animations.filter((a) => !a.outOfScope)) {
            const animationComponent = nearestComponent(
              a.ancestry,
              sceneComponents(c.inventory.components, c.state),
            );
            videoLinks.add(
              c.paths.motion(
                animationComponent,
                `${name}-${a.index}`,
                c.theme,
                (reduced ? "reduced/" : "") + "live.webm",
              ),
            );
            const animationTarget = {
              ...(before.find((e) => mapped(c, e) === animationComponent) || target),
              ...(a.rect ? { rect: a.rect } : {}),
              ancestry: a.ancestry,
              selector: a.selector,
            };
            const file = c.paths.motion(
              animationComponent,
              `${name}-${a.index}`,
              c.theme,
              (reduced ? "reduced/" : "") + "f000.png",
            );
            const props = new Set(
              a.frames
                .flatMap((f) => Object.keys(f))
                .filter((k) => !["offset", "computedOffset", "easing", "composite"].includes(k)),
            );
            if (a.property && !motionProperty(a.property))
              finding(
                c,
                "motion",
                animationTarget,
                "transition-property",
                a.property,
                "transform, opacity or color",
                file,
              );
            if (reduced && [...props].some((p) => p !== "opacity") && Number(a.duration) > 0)
              finding(
                c,
                "motion",
                animationTarget,
                "reduced-motion",
                { properties: [...props], duration: a.duration },
                "No movement; fade only",
                file,
              );
            if ((a.iterations === "Infinity" || Number(a.iterations) > 1) && !a.live)
              finding(
                c,
                "motion",
                animationTarget,
                "only-live-things-move",
                { html: a.html, iterations: String(a.iterations) },
                "Repeating motion only on live activity",
                file,
              );
            const durationValues = Object.values(data.tokens)
              .flatMap((v) => v.split(","))
              .map((v) => v.trim())
              .filter((v) => /^\d*\.?\d+m?s$/.test(v))
              .map((v) => parseFloat(v) * (v.endsWith("ms") ? 1 : 1000));
            if (
              Number(a.duration) > 0 &&
              !durationValues.some((d) => Math.abs(d - Number(a.duration)) < 1)
            )
              finding(
                c,
                "motion",
                animationTarget,
                "duration-token",
                { duration: a.duration, tokens: data.tokens },
                "Duration from a root motion token",
                file,
              );
            for (const easing of animationEasings(a.easing, a.frames))
              if (Number(a.duration) > 0 && !tokenValue(easing, data.tokens))
                finding(
                  c,
                  "motion",
                  animationTarget,
                  "easing-token",
                  { easing, tokens: data.tokens },
                  "Easing from a root motion token",
                  file,
                );
          }
          for (const percent of [0, 25, 50, 75, 100]) {
            await c.page.evaluate((p) => {
              const w = window as unknown as { __motions: Animation[] };
              for (const a of w.__motions) {
                const t = a.effect?.getComputedTiming();
                a.currentTime = (Number(t?.duration || 0) * p) / 100;
              }
            }, percent);
            const frame = await elements(c);
            const currentTarget = frame.find((e) => e.selector === target!.selector) || target;
            const animatedRects = await c.page.evaluate(() =>
              (window as unknown as { __motions: Animation[] }).__motions.map((a) =>
                ((a.effect as KeyframeEffect)?.target as Element | null)
                  ?.getBoundingClientRect()
                  .toJSON(),
              ),
            );
            await shot(c, path(`f${String(percent).padStart(3, "0")}.png`), currentTarget);
            for (const a of data.animations.filter((a) => !a.outOfScope)) {
              const id = nearestComponent(
                a.ancestry,
                sceneComponents(c.inventory.components, c.state),
              );
              const e = {
                ...(before.find((e) => mapped(c, e) === id) || target),
                ...(animatedRects[a.index]
                  ? { rect: animatedRects[a.index]! }
                  : a.rect
                    ? { rect: a.rect }
                    : {}),
              };
              await shot(
                c,
                c.paths.motion(
                  id,
                  `${name}-${a.index}`,
                  c.theme,
                  (reduced ? "reduced/" : "") + `f${String(percent).padStart(3, "0")}.png`,
                ),
                e,
              );
            }
            for (const peer of before) {
              if (
                peer.selector === target.selector ||
                peer.selector.startsWith(target.selector + " > ") ||
                target.selector.startsWith(peer.selector + " > ")
              )
                continue;
              const after = frame.find((e) => e.selector === peer.selector);
              if (
                after &&
                (Math.abs(after.rect.x - peer.rect.x) > 0.5 ||
                  Math.abs(after.rect.y - peer.rect.y) > 0.5)
              )
                finding(
                  c,
                  "motion",
                  peer,
                  "layout-shift",
                  { before: peer.rect, after: after.rect, percent },
                  "Unrelated elements stay in place",
                  path(`f${String(percent).padStart(3, "0")}.png`),
                );
            }
          }
          // Replay unpaused to record real timing in the 60 fps video as well.
          await c.page.evaluate(() => {
            for (const a of (window as unknown as { __motions: Animation[] }).__motions) {
              a.currentTime = 0;
              a.play();
            }
          });
          await c.page.waitForTimeout(400);
          if (state.steps?.some((s) => s.do === "press")) await c.page.mouse.up();
          await c.page.keyboard.press("Escape");
          await c.page.waitForTimeout(150);
        } finally {
          try {
            await c.page.mouse.up();
          } finally {
            await stop();
            for (const destination of videoLinks)
              if (destination !== path("live.webm")) {
                await mkdir(dirname(destination), { recursive: true });
                await link(path("live.webm"), destination).catch((error) => {
                  if (error.code !== "EEXIST") throw error;
                });
              }
          }
        }
      }
    }
    await save(c.paths.motion("index", c.state, c.theme, "animations.json"), records);
  } finally {
    await observer.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }).catch(() => {});
    await observer.detach();
  }
}
