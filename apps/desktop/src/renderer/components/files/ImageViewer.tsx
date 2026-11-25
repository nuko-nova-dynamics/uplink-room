import { useState } from "react";
import { Toggle, ToggleGroup } from "@ui-sdk/react/toggle";
import { Pins, PinMarker } from "./PinMarker";
import type { ViewerPins } from "./pins";

/**
 * An image, from a blob URL of bytes the app downloaded. Only raster types are kept
 * (spec #9), and an `<img>` never runs script. Pins sit at fractions of its size.
 */
export function ImageViewer({
  src,
  name,
  pins,
  selected,
  draft,
  placing,
  onPlace,
  onSelect,
}: ViewerPins & { src: string; name: string }) {
  const [fit, setFit] = useState(true);
  return (
    <div className="image-viewer">
      <div className="viewer-tools">
        <ToggleGroup
          className="seg surface-seg"
          aria-label="Size"
          value={[fit ? "fit" : "actual"]}
          deselectable={false}
          onValueChange={(next) => {
            if (next[0]) setFit(next[0] === "fit");
          }}
        >
          <Toggle value="fit">
            <span className="surface-label">Fit</span>
          </Toggle>
          <Toggle value="actual">
            <span className="surface-label">Actual size</span>
          </Toggle>
        </ToggleGroup>
      </div>
      <div className="image-scroll">
        <div
          className={`image-stage ${fit ? "fit" : ""} ${placing ? "placing" : ""}`}
          role="group"
          aria-label="Image comment pins"
          tabIndex={placing ? 0 : undefined}
          onKeyDown={(event) => {
            if (
              !placing ||
              event.target !== event.currentTarget ||
              !["Enter", " "].includes(event.key)
            )
              return;
            event.preventDefault();
            onPlace({ kind: "spot", x: 0.5, y: 0.5 });
          }}
          onClick={(event) => {
            if (!placing || (event.target as HTMLElement).closest(".pin")) return;
            const box = event.currentTarget.getBoundingClientRect();
            onPlace({
              kind: "spot",
              x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
              y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
            });
          }}
        >
          <img src={src} alt={name} draggable={false} />
          <Pins
            pins={pins.flatMap((p) =>
              p.pin.kind === "spot" ? [{ ...p, x: p.pin.x, y: p.pin.y }] : [],
            )}
            selected={selected}
            onSelect={onSelect}
            unit="%"
          />
          {draft?.kind === "spot" ? (
            <PinMarker label="+" x={draft.x * 100} y={draft.y * 100} unit="%" draft />
          ) : null}
        </div>
      </div>
    </div>
  );
}
