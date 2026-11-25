import type { CSSProperties } from "react";
import { getImageProps } from "next/image";

/** Screenshots are 1320 by 840. A crop shows the part from `x`, `w` wide and `h` tall, scaled to fit. */
type Crop = { x: number; w: number; h: number };

/**
 * A screenshot of the app (apps/desktop/screenshots, taken with sample data), in the theme that
 * matches the visitor's: the dark capture under `prefers-color-scheme: dark`, the light one
 * otherwise. Next's docs use getImageProps with <picture> for this.
 */
export function Shot({
  name,
  alt,
  caption,
  className,
  eager = false,
  crop,
  sizes = "(max-width: 900px) 100vw, 760px",
}: {
  crop?: Crop;
  name: string;
  alt: string;
  caption?: string;
  className?: string;
  eager?: boolean;
  sizes?: string;
}) {
  const common = { alt, width: 1320, height: 840, sizes };
  const {
    props: { srcSet: dark },
  } = getImageProps({ ...common, src: `/screens/${name}-dark.png` });
  const { props: light } = getImageProps({
    ...common,
    src: `/screens/${name}-light.png`,
    loading: eager ? "eager" : "lazy",
    fetchPriority: eager ? "high" : "auto",
  });
  return (
    <figure className={className ? `shot ${className}` : "shot"}>
      <div
        className={crop ? "shot-frame cropped" : "shot-frame"}
        style={
          crop ? ({ "--x": crop.x, "--w": crop.w, "--h": crop.h } as CSSProperties) : undefined
        }
      >
        <picture>
          <source media="(prefers-color-scheme: dark)" srcSet={dark} />
          <img {...light} alt={alt} />
        </picture>
      </div>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}
