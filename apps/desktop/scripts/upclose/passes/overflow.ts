import { loadState, sizeWindow } from "./common.ts";
import { clipped, overlappingRegions, relatedElements, layeredTogether } from "./rules.ts";
import { elements, finding, save, shot, type Context } from "./common.ts";
export async function overflow(c: Context) {
  for (const [variant, width, height] of [
    ["default", 1320, 840],
    ["narrow", 960, 600],
  ] as const) {
    await sizeWindow(c.page, width, height);
    await loadState(c.page, c.state, c.theme);
    const file = c.paths.overflow(c.state, variant, c.theme);
    await shot(c, file);
    const all = await elements(c, true);
    const viewport = await c.page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    for (const e of all) {
      if (e.text && clipped({ ...e, height: e.rect.height }))
        finding(
          c,
          "overflow",
          e,
          "clipped-without-ellipsis",
          { scrollWidth: e.scroll, clientWidth: e.width, textOverflow: e.ellipsis },
          "Visible text, wrapping, or ellipsis",
          file,
        );
      if (
        !e.scrollContainer &&
        (e.rect.x < -1 ||
          e.rect.y < -1 ||
          e.rect.x + e.rect.width > viewport.w + 1 ||
          e.rect.y + e.rect.height > viewport.h + 1)
      )
        finding(c, "overflow", e, "outside-window", e.rect, viewport, file);
    }
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!,
          b = all[j]!;
        const related = relatedElements(a, b);
        // Check only leaf text and controls. Parent boxes intentionally enclose children.
        const leaf = (e: typeof a) =>
          e.control || (!!e.text && !all.some((v) => v.ancestors.includes(e.selector)));
        if (!leaf(a) || !leaf(b)) continue;
        const layered = layeredTogether(a, b);
        const collision =
          !related && !((a.intended && b.intended) || layered)
            ? overlappingRegions(
                a.control ? [a.paint] : a.textRects,
                b.control ? [b.paint] : b.textRects,
              )
            : undefined;
        if (collision)
          finding(
            c,
            "overflow",
            a,
            "overlap",
            { other: b.selector, a: collision[0], b: collision[1] },
            "Disjoint unrelated controls and text; avatar stacks exempt",
            file,
          );
      }
    await save(file.replace(/\.png$/, ".json"), {
      viewport,
      elements: all,
      exemptions: [
        {
          selector:
            ".overlay,.drawer,.popover,[role=dialog],[role=menu],[role=tooltip],[role=listbox]",
          reason: "Overlays intentionally cover the background and their parent overlay",
        },
        {
          selector: ".avatar-stack, .face-stack, .avatars, .faces",
          reason: "Faces intentionally overlap",
        },
      ],
    });
  }
  await sizeWindow(c.page, 1320, 840);
}
