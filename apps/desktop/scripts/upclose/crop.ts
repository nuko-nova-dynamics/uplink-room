import { decode, encode } from "./image.ts";
import type { Rect, Scale } from "./types.ts";

/** Cut a full viewport PNG on whole device pixels, without resizing its pixels. */
export function cropPng(png: Uint8Array, crop: Rect, scale: Scale): Uint8Array {
  const source = decode(png);
  const [x, y, width, height] = [crop.x, crop.y, crop.width, crop.height].map((n) => n * scale) as [
    number,
    number,
    number,
    number,
  ];
  if (
    ![x, y, width, height].every(Number.isInteger) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x + width > source.width ||
    y + height > source.height
  )
    throw new Error("Crop must contain whole device pixels inside the screenshot");
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++)
    data.set(
      source.data.subarray(
        ((y + row) * source.width + x) * 4,
        ((y + row) * source.width + x + width) * 4,
      ),
      row * width * 4,
    );
  return encode({ width, height, data });
}
