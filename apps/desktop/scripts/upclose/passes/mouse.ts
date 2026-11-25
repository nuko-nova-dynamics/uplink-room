import {
  roundedHit,
  tooltipPresent,
  hitMismatch,
  cursorExpected,
  coveredByLayer,
} from "./rules.ts";
import { elements, finding, mapped, move, save, shot, type Context } from "./common.ts";
export async function mouse(c: Context) {
  const controls = (await elements(c)).filter((e) => e.control && !coveredByLayer(e));
  const cursors: Record<string, number> = {};
  const records = [];
  for (let i = 0; i < controls.length; i++) {
    const original = controls[i]!;
    await c.page
      .locator(original.selector)
      .scrollIntoViewIfNeeded()
      .catch(() => {});
    const e = (await elements(c, false, false, original.selector))[0];
    if (!e || coveredByLayer(e)) continue;
    await move(c, e);
    await c.page.waitForTimeout(e.icon ? 650 : 100);
    const file = c.paths.mouse(c.state, c.theme, `${i}.png`);
    const measured = await c.page.locator(e.selector).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const radii = [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius,
      ].map((value) => {
        const parts = value.split(" ");
        const length = (v: string, size: number) =>
          parseFloat(v) * (v.endsWith("%") ? size / 100 : 1);
        return [length(parts[0]!, r.width), length(parts[1] || parts[0]!, r.height)];
      });
      const hits = [];
      for (const dx of [
        -2,
        Math.min(2, r.width / 4),
        r.width / 2,
        r.width - Math.min(2, r.width / 4),
        r.width + 2,
      ])
        for (const dy of [
          -2,
          Math.min(2, r.height / 4),
          r.height / 2,
          r.height - Math.min(2, r.height / 4),
          r.height + 2,
        ]) {
          const x = r.x + dx,
            y = r.y + dy,
            hit = document.elementFromPoint(x, y);
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
          // A scroll viewport clips both painting and hit testing.
          let clipped = false;
          for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor),
              box = ancestor.getBoundingClientRect(),
              left = box.left + ancestor.clientLeft,
              top = box.top + ancestor.clientTop;
            if (
              (/hidden|clip|auto|scroll/.test(style.overflowX) &&
                (x < left || x >= left + ancestor.clientWidth)) ||
              (/hidden|clip|auto|scroll/.test(style.overflowY) &&
                (y < top || y >= top + ancestor.clientHeight))
            )
              clipped = true;
          }
          if (clipped) continue;
          hits.push({
            x,
            y,
            dx,
            dy,
            hit: !!hit && (el === hit || el.contains(hit)),
            hitElement: hit
              ? {
                  tag: hit.tagName,
                  classes: [...hit.classList],
                  rect: hit.getBoundingClientRect().toJSON(),
                }
              : null,
          });
        }
      return {
        cursor: style.cursor,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        radii,
        hits,
      };
    });
    const tested = {
      ...measured,
      hits: measured.hits.map((h) => ({
        ...h,
        inside: roundedHit(h.dx, h.dy, measured.rect.width, measured.rect.height, measured.radii),
      })),
    };
    cursors[measured.cursor] = (cursors[measured.cursor] || 0) + 1;
    const hasTooltip = await c.page.locator("[role=tooltip], .tooltip").count();
    const tooltips = (hasTooltip ? await elements(c) : []).filter(
      (t) => t.role === "tooltip" || /tooltip/.test(t.selector),
    );
    if (e.icon && !tooltipPresent(e.name, e.title, tooltips.length > 0)) {
      await shot(c, file, e);
      finding(
        c,
        "mouse",
        e,
        "icon-tooltip",
        { nativeTitle: e.title, customTooltip: false },
        "Native title or visible tooltip, and an accessible name",
        file,
      );
    }
    for (let t = 0; t < tooltips.length; t++) {
      const tip = tooltips[t]!,
        f = c.paths.mouse(c.state, c.theme, `${i}-tooltip-${t}.png`);
      await shot(c, f, tip);
      const viewport = await c.page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
      if (
        tip.rect.x < 0 ||
        tip.rect.y < 0 ||
        tip.rect.x + tip.rect.width > viewport.w ||
        tip.rect.y + tip.rect.height > viewport.h
      )
        finding(c, "mouse", e, "tooltip-bounds", tip.rect, viewport, f);
    }
    if (tested.hits.some((h) => hitMismatch(h, tested.rect, tested.radii))) {
      await shot(c, file, e);
      finding(
        c,
        "mouse",
        e,
        "hit-box",
        {
          missedInterior: tested.hits.filter((h) => h.inside && !h.hit).length,
          outsideHits: tested.hits.filter(
            (h) => !h.inside && hitMismatch(h, tested.rect, tested.radii),
          ).length,
          width: tested.rect.width,
          height: tested.rect.height,
        },
        "Painted interior receives input; input stays inside the rectangular control bounds",
        file,
      );
    }
    records.push({ ...e, component: mapped(c, e), ...tested });
  }
  const convention = Object.entries(cursors).sort((a, b) => b[1] - a[1])[0]?.[0];
  const cursorFile = c.paths.mouse(c.state, c.theme, "cursor.png");
  if (records.some((r) => !cursorExpected(r).includes(r.cursor))) await shot(c, cursorFile);
  for (const record of records)
    if (!cursorExpected(record).includes(record.cursor)) {
      const e = controls.find((e) => e.selector === record.selector)!;
      const file = c.paths.mouse(c.state, c.theme, "cursor.png");
      finding(c, "mouse", e, "cursor-convention", record.cursor, cursorExpected(record), file);
    }
  await save(c.paths.mouse(c.state, c.theme, "controls.json"), { convention, cursors, records });
}
