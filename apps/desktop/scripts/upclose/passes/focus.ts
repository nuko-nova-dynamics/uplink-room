import { decode } from "fast-png";

/** Compare the same viewport-aligned control, including an inset ring, after real focus changes. */
export function focusPixels(focused: Uint8Array, unfocused: Uint8Array): number {
  const a = decode(focused),
    b = decode(unfocused);
  if (a.width !== b.width || a.height !== b.height)
    throw new Error("Focus crops have different bounds");
  let changed = 0;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      if (x >= 10 && y >= 10 && x < a.width - 10 && y < a.height - 10) continue;
      const p = (y * a.width + x) * a.channels;
      if ([0, 1, 2].some((k) => Math.abs(Number(a.data[p + k]) - Number(b.data[p + k])) > 20))
        changed++;
    }
  return changed;
}
