import { focusPixels } from "./focus.ts";
import { readFile, writeFile, rm } from "node:fs/promises";
import { cropPng } from "../crop.ts";
import { cropRect } from "../plan.ts";
import { loadState } from "./common.ts";
import {
  cycleLength,
  focusKey,
  coveredByLayer,
  arrowMoved,
  escapeProgress,
  interactive,
  tabBudget,
} from "./rules.ts";
import {
  click,
  elements,
  emptyClick,
  finding,
  safe,
  save,
  shot,
  steps,
  video,
  type Context,
  type ElementInfo,
  scopeTabTraversal,
  arrowDescendants,
} from "./common.ts";
async function active(c: Context) {
  return (await elements(c, false, true))[0];
}
async function overlayRules(
  c: Context,
  overlay: ElementInfo,
  opener?: ElementInfo,
  suffix = "overlay",
) {
  const file = c.paths.keyboard(c.state, c.theme, `${suffix}.png`);
  await shot(c, file);
  const node = await c.page.locator(overlay.selector).elementHandle();
  // A removed popup can change an ancestor's nth-of-type without replacing the opener.
  const openerNode = opener
    ? await c.page
        .locator(opener.selector)
        .elementHandle()
        .catch(() => null)
    : null;
  const has = async () =>
    node
      ?.evaluate(
        (el) =>
          el.isConnected &&
          el.matches(
            '.overlay,.pop,.menu,.popover,.dialog,.drawer,[role="dialog"],[role="menu"],[role="listbox"]',
          ) &&
          getComputedStyle(el).display !== "none" &&
          getComputedStyle(el).visibility !== "hidden",
      )
      .catch(() => false);
  if (
    overlay.role === "menu" ||
    overlay.role === "listbox" ||
    /menu|listbox|pop/.test(overlay.selector)
  ) {
    const items = await c.page.locator(overlay.selector).evaluate((root) => {
      const roles = [...root.querySelectorAll("[role=menuitem],[role=option],[role=tab]")];
      const candidates = roles.length ? roles : [...root.querySelectorAll("button,[tabindex]")];
      return candidates
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.width > 0 &&
            r.height > 0 &&
            !el.matches(":disabled,[aria-disabled=true]") &&
            getComputedStyle(el).visibility !== "hidden"
          );
        })
        .map((el) => el.getAttribute("aria-label") || el.textContent?.trim() || el.tagName);
    });
    await c.page.keyboard.press("ArrowDown");
    const a = await active(c);
    await c.page.keyboard.press("ArrowDown");
    const b = await active(c);
    if (!arrowMoved(focusKey(a), focusKey(b), items.length))
      finding(
        c,
        "keyboard",
        overlay,
        "arrow-navigation",
        { before: focusKey(a), after: focusKey(b), itemCount: items.length },
        items.length > 1 ? "ArrowDown moves between items" : "ArrowDown focuses the available item",
        file,
      );
    await c.page.keyboard.press("ArrowUp");
    const back = await active(c);
    await save(file + ".json", {
      items,
      before: focusKey(a),
      after: focusKey(b),
      back: focusKey(back),
    });
    if (a && focusKey(back) !== focusKey(a))
      finding(c, "keyboard", overlay, "arrow-reverse", back?.selector, a.selector, file);
  }
  if (overlay.modal) {
    const count = await c.page
      .locator(overlay.selector)
      .locator("button,input,select,textarea,[tabindex]")
      .count();
    for (let n = 0; n < Math.min(count + 2, 200); n++) {
      await c.page.keyboard.press("Tab");
      const inside = await c.page
        .locator(overlay.selector)
        .evaluate((el) => el.contains(document.activeElement))
        .catch(() => false);
      if (!inside) {
        finding(
          c,
          "keyboard",
          overlay,
          "dialog-focus-trap",
          { escapedTo: (await active(c))?.selector },
          "Tab stays in dialog",
          file,
        );
        break;
      }
    }
  }
  const escapeState = async () =>
    node?.evaluate((el) => {
      const active = document.activeElement;
      return {
        layers: [
          ...el.querySelectorAll("[role=listbox],[role=menu],[role=dialog],.pop,.popover"),
        ].filter((child) => child.getBoundingClientRect().width > 0).length,
        value:
          active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
            ? active.value
            : "",
      };
    });
  const escapeSteps = [];
  for (let i = 0; i < 10; i++) {
    const before = await escapeState();
    await c.page.keyboard.press("Escape");
    await c.page.waitForTimeout(120);
    const after = await escapeState();
    escapeSteps.push({ before, after, open: !!(await has()) });
    if (!(await has()) || !before || !after || !escapeProgress(before, after)) break;
  }
  await save(file.replace(/\.png$/, "-escape.json"), escapeSteps);
  if (await has()) finding(c, "keyboard", overlay, "escape-closes", true, false, file);
  else if (
    opener &&
    openerNode &&
    (await openerNode.evaluate(
      (element) => element.isConnected && element !== document.activeElement,
    ))
  )
    finding(
      c,
      "keyboard",
      opener,
      "escape-restores-focus",
      (await active(c))?.selector,
      opener.selector,
      file,
    );
}
async function menus(c: Context) {
  const cases = c.inventory.components.flatMap((component) =>
    component.states
      .filter(
        (s) =>
          s.gymState === c.state &&
          ["default", "open"].includes(s.id) &&
          ["menu", "dialog", "popover", "listbox"].includes(component.role || ""),
      )
      .map((state) => ({ component, state })),
  );
  const visited = new Set<string>();
  const skipped = [];
  for (const { component, state } of cases) {
    const signature = (state.target || component.selector) + JSON.stringify(state.steps);
    if (visited.has(signature)) continue;
    visited.add(signature);
    await loadState(c.page, c.state, c.theme);
    try {
      await steps(c, state.steps || []);
    } catch (error) {
      skipped.push({ component: component.id, error: String(error) });
      continue;
    }
    const all = await elements(c);
    const trigger = state.steps?.findLast((s) => s.do === "click");
    const triggerBox =
      trigger?.do === "click"
        ? await c.page
            .locator(trigger.target)
            .first()
            .boundingBox()
            .catch(() => null)
        : null;
    const opener = triggerBox
      ? all.find(
          (e) =>
            e.control &&
            ["button", "input", "a"].includes(e.role) &&
            Math.abs(e.rect.x - triggerBox.x) < 0.5 &&
            Math.abs(e.rect.y - triggerBox.y) < 0.5,
        )
      : undefined;
    const overlay = all.find((e) => e.ancestry[0]?.includes(state.target || component.selector));
    if (!overlay) {
      skipped.push({ component: component.id, error: "Overlay selector did not match" });
      continue;
    }
    const items = ["menu", "popover"].includes(component.role || "")
      ? all.filter((e) => e.control && e.selector.startsWith(overlay.selector + " > "))
      : [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (!safe(item)) {
        skipped.push({ selector: item.selector, reason: "external, clipboard, or disabled" });
        continue;
      }
      await loadState(c.page, c.state, c.theme);
      await steps(c, state.steps || []);
      const before = (await elements(c)).filter(
        (e) => ["dialog", "menu", "listbox"].includes(e.role) || /drawer|popover/.test(e.selector),
      );
      await click(c, item);
      await c.page.waitForTimeout(120);
      const after = (await elements(c)).filter(
        (e) => ["dialog", "menu", "listbox"].includes(e.role) || /drawer|popover/.test(e.selector),
      );
      for (const next of after.filter(
        (e) => !before.some((b) => b.selector === e.selector && b.text === e.text),
      ))
        await overlayRules(c, next, item, `${component.id}-${i}-level2`);
    }
    await loadState(c.page, c.state, c.theme);
    await steps(c, state.steps || []);
    const reopened = (await elements(c)).find((e) =>
      e.ancestry[0]?.includes(state.target || component.selector),
    );
    if (!reopened) {
      skipped.push({
        component: component.id,
        error: "Overlay did not reopen after action traversal",
      });
      continue;
    }
    await overlayRules(
      c,
      {
        ...reopened,
        role: component.role === "popover" ? "menu" : component.role || reopened.role,
      },
      opener,
      component.id,
    );
  }
  await save(c.paths.keyboard(c.state, c.theme, "menu-coverage.json"), {
    cases: cases.length,
    skipped,
  });
}
async function shortcuts(c: Context) {
  if (!(await c.page.locator(".inbox-row").count())) return;
  const records = [];
  for (const [key, label] of [
    ["a", "Allow"],
    ["s", "Settle"],
    ["z", "Snooze"],
    ["h", "Hand off"],
    ["Enter", "Open"],
  ]) {
    await loadState(c.page, c.state, c.theme);
    let eligible = false;
    let chosenView = "Mine";
    for (const view of ["Mine", "Team"]) {
      const tab = c.page.getByRole("tab", { name: view, exact: true });
      if (await tab.count()) {
        const box = await tab.first().boundingBox();
        if (box) await c.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      }
      await emptyClick(c);
      const count = await c.page.locator(".inbox-row").count();
      for (let i = 0; i <= count; i++) await c.page.keyboard.press("ArrowUp");
      for (let i = 0; i < count; i++) {
        const row = c.page.locator(".inbox-row[data-focus=true]");
        if ((await row.count()) && (await row.innerText()).includes(label!)) {
          eligible = true;
          chosenView = view;
          break;
        }
        await c.page.keyboard.press("ArrowDown");
      }
      if (eligible) break;
    }
    if (!eligible) {
      records.push({ key, eligible: false });
      continue;
    }
    const row = c.page.locator(".inbox-row[data-focus=true]");
    const before = await row.innerText();
    const title = await row.locator(".title .t").innerText();
    const stable = (text: string) => text.replace(/\b\d{1,2}:\d{2}\b/g, "<timer>");
    const sameBefore = (await c.page.locator(".inbox-row").allInnerTexts()).filter(
      (text) => stable(text) === stable(before),
    ).length;
    const titleBefore = await c.page.locator(".inbox-row").filter({ hasText: title }).count();
    const mutationStart = await c.page.evaluate(
      () => (window as unknown as { gymMutations?: unknown[] }).gymMutations?.length || 0,
    );
    await c.page.keyboard.press(key!);
    await c.page.waitForTimeout(500);
    const mutations = await c.page.evaluate(
      (start) =>
        (
          window as unknown as { gymMutations?: { path: string; args: Record<string, unknown> }[] }
        ).gymMutations?.slice(start) || [],
      mutationStart,
    );
    const after = await c.page.locator("body").innerText();
    const rowsAfter = await c.page.locator(".inbox-row").allInnerTexts();
    const sameAfter = rowsAfter.filter((text) => stable(text) === stable(before)).length;
    const titleAfter = await c.page.locator(".inbox-row").filter({ hasText: title }).count();
    const file = c.paths.keyboard(c.state, c.theme, `shortcut-${key}.png`);
    await shot(c, file);
    // The rows always show "Snooze" and "Hand off" as hints, so only the opened menu proves the key worked.
    const expected =
      key === "z"
        ? await c.page.getByRole("menu", { name: "Snooze until" }).isVisible()
        : key === "h"
          ? await c.page.getByRole("menu", { name: "Hand off to" }).isVisible()
          : key === "Enter"
            ? (await c.page.locator(".drawer,.thread-view,.terminal-view").count()) > 0
            : key === "s"
              ? titleAfter < titleBefore
              : sameAfter < sameBefore ||
                mutations.some(
                  (m) =>
                    m.path === "inbox:answer" &&
                    m.args["answer"] === "allow" &&
                    !!m.args["promptId"],
                );
    records.push({
      key,
      eligible: true,
      view: chosenView,
      before,
      rowsAfter,
      mutations,
      passed: expected,
    });
    if (!expected)
      finding(
        c,
        "keyboard",
        (await elements(c)).find((e) => e.selector.includes("inbox-row")),
        "inbox-shortcut-" + key,
        after.slice(-1000),
        label,
        file,
      );
  }
  await save(c.paths.keyboard(c.state, c.theme, "shortcuts.json"), records);
}
export async function keyboard(c: Context) {
  const initial = (await elements(c)).filter(
    (e) => e.control && !e.disabled && !e.dismissal && !coveredByLayer(e),
  );
  // Selectors can change when a combobox closes its sibling list during Tab.
  // Retain the actual controls so a reached node remains reached after that layout change.
  const initialNodes = await Promise.all(
    initial.map((element) =>
      c.page
        .locator(element.selector)
        .elementHandle()
        .catch(() => null),
    ),
  );
  const visitedNodes = await c.page.evaluateHandle(() => new Set([document.activeElement]));
  const order: ElementInfo[] = [];
  const initiallyFocused = await active(c);
  await emptyClick(c);
  const restoreLibraries = await scopeTabTraversal(c);
  const budget = tabBudget(await c.page.locator(interactive).count());
  const stop = await video(c.paths.keyboard(c.state, c.theme, "tab.webm"));
  let cycle: number | null = null;
  try {
    for (let i = 0; i < budget; i++) {
      const previous = await active(c);
      const full = c.paths.keyboard(c.state, c.theme, `before-${i}.png`);
      await shot(c, full);
      await c.page.keyboard.press("Tab");
      await c.page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      await c.page.waitForTimeout(40);
      const e = await active(c);
      await visitedNodes.evaluate((seen) => {
        seen.add(document.activeElement);
      });
      if (!e) {
        await rm(full);
        continue;
      }
      order.push(e);
      cycle = cycleLength(order.map((e) => e.selector));
      const focused = c.paths.keyboard(c.state, c.theme, `focus-${i}.png`),
        unfocused = c.paths.keyboard(c.state, c.theme, `unfocus-${i}.png`);
      await shot(c, focused, e);
      const viewport = await c.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      await writeFile(
        unfocused,
        cropPng(await readFile(full), cropRect(e.rect, viewport, 1, 6), 1),
      );
      await rm(full);
      const valid = previous?.selector !== e.selector;
      const changed = valid
        ? focusPixels(await readFile(focused), await readFile(unfocused))
        : null;
      await save(focused.replace(/\.png$/, ".json"), {
        target: e.selector,
        focused: e,
        unfocused: previous ?? null,
        valid,
        borderPixelsChanged: changed,
      });
      if (changed !== null && changed < 4)
        finding(
          c,
          "keyboard",
          e,
          "focus-visible",
          { borderPixelsChanged: changed },
          "Visible ring in focused crop",
          focused,
        );
      if (cycle) break;
    }
  } finally {
    try {
      await stop();
    } finally {
      await restoreLibraries();
    }
  }
  const file = c.paths.keyboard(c.state, c.theme, "screen.png");
  await shot(c, file);
  // A transient control (for example Jump to newest) can disappear as Tab
  // scrolls the list. Keep that evidence separate from controls that remain
  // available but were never reached.
  const initialStatus = await Promise.all(
    initialNodes.map(async (node, index) => ({
      selector: initial[index]!.selector,
      ...(node
        ? await visitedNodes.evaluate(
            (seen, element) => ({
              reached: seen.has(element),
              retired: !element.isConnected,
            }),
            node,
          )
        : { reached: false, retired: true }),
    })),
  );
  await save(c.paths.keyboard(c.state, c.theme, "initial-controls.json"), initialStatus);
  await visitedNodes.dispose();
  for (const node of initialNodes) await node?.dispose();
  const reached = new Set([
    ...(initiallyFocused ? [initiallyFocused.selector] : []),
    ...order.map((e) => e.selector),
    ...initialStatus.filter((element) => element.reached).map((element) => element.selector),
  ]);
  const retired = new Set(
    initialStatus.filter((element) => element.retired).map((element) => element.selector),
  );
  // Inbox owns its row focus without adding a tab stop per row.
  const composite = [];
  if (await c.page.locator(".inbox-row").count()) {
    await loadState(c.page, c.state, c.theme);
    await emptyClick(c);
    const count = await c.page.locator(".inbox-row").count();
    for (let i = 0; i < count + 1; i++) {
      await c.page.keyboard.press("ArrowDown");
      const row = await c.page.locator(".inbox-row[data-focus=true]").evaluateAll((els) =>
        els.map((el) => {
          const parts = [];
          for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
            if (n.id) {
              parts.unshift("#" + CSS.escape(n.id));
              return parts.join(" > ");
            }
            const siblings = [...(n.parentElement?.children || [])].filter(
              (s) => s.tagName === n!.tagName,
            );
            parts.unshift(
              n.tagName.toLowerCase() +
                (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(n) + 1})` : ""),
            );
          }
          return "body > " + parts.join(" > ");
        }),
      );
      for (const selector of row) {
        reached.add(selector);
        composite.push(selector);
      }
    }
  }
  const descendants: Record<string, string[]> = {};
  for (const control of initial.filter((e) => e.activeDescendant)) {
    await loadState(c.page, c.state, c.theme);
    const visited = await arrowDescendants(c.page, control.selector);
    descendants[control.selector] = visited;
    for (const selector of visited) reached.add(selector);
  }
  await save(c.paths.keyboard(c.state, c.theme, "composites.json"), {
    inbox: composite,
    descendants,
  });
  for (const e of initial)
    if (!reached.has(e.selector) && !retired.has(e.selector))
      finding(
        c,
        "keyboard",
        e,
        "tab-reachability",
        "not reached",
        "Reachable with Tab or documented composite arrows",
        file,
      );
  if (!cycle)
    finding(
      c,
      "keyboard",
      undefined,
      "tab-cycle",
      order.length,
      `A repeating focus cycle within ${budget} presses`,
      file,
    );
  await save(c.paths.keyboard(c.state, c.theme, "cycle.json"), {
    cycle,
    budget,
    visited: order.length,
  });
  await save(
    c.paths.keyboard(c.state, c.theme, "order.json"),
    order.map(({ selector, role, name, rect }) => ({ selector, role, name, rect })),
  );
  await keyboardOverlays(c);
}

export async function keyboardOverlays(c: Context) {
  await loadState(c.page, c.state, c.theme);
  const overlays = (await elements(c)).filter((e) =>
    ["dialog", "menu", "listbox"].includes(e.role),
  );
  const seen = new Set<string>();
  for (const e of overlays) {
    if (seen.has(e.selector)) continue;
    seen.add(e.selector);
    await loadState(c.page, c.state, c.theme);
    await overlayRules(c, e, undefined, `initial-overlay-${seen.size}`);
  }
  await menus(c);
  await shortcuts(c);
}
