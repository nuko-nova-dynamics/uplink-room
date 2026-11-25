import { labelCapCenter } from "../text-metrics.ts";
import type { Finding, Measurement } from "../types.ts";
import { deviceRect, inkBounds, iconInkRect } from "../image.ts";
import {
  ALIGNMENT_TOLERANCE,
  center,
  contentBox,
  contentGroup,
  finding,
  hasClass,
  pairedText,
  px,
} from "./shared.ts";
import type { Images } from "./shared.ts";

export function iconAlignment(m: Measurement, images: Images = {}): Finding[] {
  const result: Finding[] = [];
  for (const icon of m.icons) {
    const context = m.iconContexts?.[icon.selector];
    const label = pairedText(m, icon.selector);
    const container = context?.container ?? m.target;
    // A view can contain many unrelated icons. Capture supplies each real wrapper for those.
    if (!context && m.icons.length > 1) {
      result.push(
        finding(
          m,
          "icon-alignment",
          icon.selector,
          "container geometry not captured",
          "iconContexts container in CSS px",
          "Capture is missing the icon's container geometry.",
        ),
      );
      continue;
    }
    if (context?.labelSelector && !m.texts.some((t) => t.selector === context.labelSelector)) {
      result.push(
        finding(
          m,
          "icon-alignment",
          icon.selector,
          "label geometry not captured",
          "paired text geometry in CSS px",
          "Capture is missing the icon's paired label geometry.",
        ),
      );
    }
    const box = context?.alignmentRect ?? contentBox(container);
    const expected = center(box);
    const actual = center(icon.rect);
    // A column stacks items along y. Its cross-axis is x; raster ink still centers in the icon box.
    if (container.styles.flexDirection?.startsWith("column")) expected.y = actual.y;
    if (
      container.styles.display?.includes("flex") &&
      !container.styles.flexDirection?.startsWith("column")
    ) {
      if (["start", "flex-start"].includes(container.styles.alignItems ?? ""))
        expected.y = box.y + Number.parseFloat(icon.styles.marginTop ?? "0") + icon.rect.height / 2;
      if (["end", "flex-end"].includes(container.styles.alignItems ?? ""))
        expected.y =
          box.y +
          box.height -
          Number.parseFloat(icon.styles.marginBottom ?? "0") -
          icon.rect.height / 2;
    }
    // Positioned input adornments occupy their own horizontal slot, not the text field's center.
    if (icon.styles.position === "absolute") expected.x = actual.x;
    // In a text button the icon and label form one centered horizontal group.
    const labelInContainer =
      label &&
      label.inkRect.x >= box.x - ALIGNMENT_TOLERANCE &&
      label.inkRect.x + label.inkRect.width <= box.x + box.width + ALIGNMENT_TOLERANCE;
    const flow =
      icon.styles.position === "absolute"
        ? undefined
        : (context?.contentGroup ?? contentGroup(m, container));
    const group = flow
      ? { x: center(flow).x, y: actual.y }
      : labelInContainer && icon.styles.position !== "absolute"
        ? {
            x:
              (Math.min(icon.rect.x, label.inkRect.x) +
                Math.max(icon.rect.x + icon.rect.width, label.inkRect.x + label.inkRect.width)) /
              2,
            y: actual.y,
          }
        : actual;
    const leadingFlow =
      icon.styles.position !== "absolute" &&
      (labelInContainer || flow) &&
      !hasClass(container.selector, "btn") &&
      container.styles.display?.includes("flex") &&
      !container.styles.flexDirection?.startsWith("column") &&
      ["normal", "start", "flex-start"].includes(container.styles.justifyContent ?? "normal");
    // Navigation rows intentionally put the icon and label at their leading content edge.
    const dx = leadingFlow
        ? (flow?.x ?? Math.min(icon.rect.x, label!.inkRect.x)) - box.x
        : group.x - expected.x,
      dy = actual.y - expected.y;
    if (Math.abs(dx) > ALIGNMENT_TOLERANCE || Math.abs(dy) > ALIGNMENT_TOLERANCE)
      result.push(
        finding(
          m,
          "icon-alignment",
          icon.selector,
          { source: "layout", x: px(dx), y: px(dy) },
          { x: "±0.5px", y: "±0.5px" },
          "Layout icon is outside the container's content alignment tolerance.",
        ),
      );
    const labelCenter = label
      ? labelCapCenter(label, m.texts, container.styles.alignItems)
      : undefined;
    if (labelCenter !== undefined && Math.abs(actual.y - labelCenter) > ALIGNMENT_TOLERANCE)
      result.push(
        finding(
          m,
          "icon-alignment",
          icon.selector,
          { source: "layout", labelOffset: px(actual.y - labelCenter) },
          "±0.5px",
          "Layout icon and label cap band do not share a centerline.",
        ),
      );
    if (m.scale !== 2) continue;
    if (!images.crop) throw new Error(`Missing 2x raster for ${m.component}: ${icon.selector}`);
    const inkRegion = iconInkRect(m, icon);
    // Partial captures cannot establish the drawing's center.
    if (
      inkRegion.x < m.crop.x ||
      inkRegion.y < m.crop.y ||
      inkRegion.x + inkRegion.width > m.crop.x + m.crop.width ||
      inkRegion.y + inkRegion.height > m.crop.y + m.crop.height
    )
      continue;
    const ink = inkBounds(images.crop, deviceRect(m, inkRegion), icon.background);
    if (!ink) {
      result.push(
        finding(
          m,
          "icon-alignment",
          icon.selector,
          { source: "raster", inkArea: "0px²" },
          "visible icon ink",
          "The 2x crop contains no visible icon ink.",
        ),
      );
      continue;
    }
    const inkBoxCenter = center(ink);
    const inkCenter = { x: inkBoxCenter.x / 2 + m.crop.x, y: inkBoxCenter.y / 2 + m.crop.y };
    // Preserve the layout group's horizontal offset, replacing only the icon's center.
    const rx = inkCenter.x - actual.x + dx,
      ry = inkCenter.y - expected.y;
    if (Math.abs(rx) > ALIGNMENT_TOLERANCE || Math.abs(ry) > ALIGNMENT_TOLERANCE)
      result.push(
        finding(
          m,
          "icon-alignment",
          icon.selector,
          { source: "raster", x: px(rx), y: px(ry) },
          { x: "±0.5px", y: "±0.5px" },
          "Raster icon is outside the container's content alignment tolerance.",
        ),
      );
    if (labelCenter !== undefined) {
      const offset = inkCenter.y - labelCenter;
      if (Math.abs(offset) > ALIGNMENT_TOLERANCE)
        result.push(
          finding(
            m,
            "icon-alignment",
            icon.selector,
            { source: "raster", labelOffset: px(offset) },
            "±0.5px",
            "Raster icon and label cap band do not share a centerline.",
          ),
        );
    }
  }
  return result;
}
