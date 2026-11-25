import type { CommentThread } from "../../lib/api";

export type Pin = CommentThread["pin"];

/** A pinned comment as a viewer draws it: its number in the list and where it points. */
export type PinView = { commentId: string; n: number; pin: Pin };

/** What every viewer is given and reports back. */
export type ViewerPins = {
  pins: PinView[];
  selected: string | null;
  /** A pin the person placed but hasn't commented on yet. */
  draft: Pin | null;
  /** True while the next click on the file places a pin. */
  placing: boolean;
  onPlace: (pin: Pin) => void;
  onSelect: (commentId: string) => void;
};

export function pinLabel(pin: Pin): string {
  switch (pin.kind) {
    case "file":
      return "On the file";
    case "page":
      return `Page ${pin.page}`;
    case "spot":
      return "On the image";
    case "point":
      return "On the canvas";
    case "text":
      return `“${pin.quote.length > 60 ? `${pin.quote.slice(0, 57)}…` : pin.quote}”`;
  }
}

/** Reads the theme's colours, for frames that can't read the app's CSS. */
export function themeColors(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(`--${name}`).trim();
  return {
    ground: read("ground"),
    raised: read("raised"),
    line: read("line"),
    text: read("text"),
    muted: read("muted"),
    select: read("working"),
  };
}

/** Whether the app shows its dark theme. */
export function isDark(): boolean {
  return document.documentElement.dataset["theme"] !== "light";
}
