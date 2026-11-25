import { Toggle } from "@ui-sdk/react/toggle";

/** A numbered pin: a speech-bubble tag whose point sits on the spot it marks. */
export function PinMarker({
  label,
  x,
  y,
  unit,
  selected = false,
  draft = false,
  onClick,
}: {
  label: string;
  x: number;
  y: number;
  unit: "%" | "px";
  selected?: boolean;
  draft?: boolean;
  onClick?: () => void;
}) {
  return (
    // Pressed while its comment is the selected one; pressing it selects that comment.
    <Toggle
      className={`pin ${selected ? "selected" : ""} ${draft ? "draft" : ""}`}
      style={{ left: `${x}${unit}`, top: `${y}${unit}` }}
      aria-label={draft ? "New comment" : `Comment ${label}`}
      pressed={selected}
      onPressedChange={() => onClick?.()}
      tabIndex={draft ? -1 : 0}
      onClick={(event) => event.stopPropagation()}
    >
      {label}
    </Toggle>
  );
}

export function Pins({
  pins,
  selected,
  onSelect,
  unit,
}: {
  pins: { commentId: string; n: number; x: number; y: number }[];
  selected: string | null;
  onSelect: (commentId: string) => void;
  unit: "%" | "px";
}) {
  const scale = unit === "%" ? 100 : 1;
  return (
    <>
      {pins.map((p) => (
        <PinMarker
          key={p.commentId}
          label={String(p.n)}
          x={p.x * scale}
          y={p.y * scale}
          unit={unit}
          selected={p.commentId === selected}
          onClick={() => onSelect(p.commentId)}
        />
      ))}
    </>
  );
}
