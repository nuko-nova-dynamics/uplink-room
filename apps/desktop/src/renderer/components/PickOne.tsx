import type { CSSProperties, ReactNode } from "react";
import { Toggle, ToggleGroup } from "@ui-sdk/react/toggle";

/**
 * One choice of a set that saves the moment it's chosen (who may type in a terminal, a machine's
 * most open access, the team's call quality limit), on UI SDK's Toggle Group. Arrow keys only move
 * between the choices; Space, Enter or a click chooses. A Radio or Segmented Control would choose
 * on every arrow press, and so save each choice it passes. Pressing the chosen one does nothing.
 * Its items are PickOneItem (UI SDK Toggle), pressed while chosen.
 */
export function PickOne<T extends string>({
  value,
  onPick,
  className,
  style,
  children,
  disabled,
  orientation = "horizontal",
  ...aria
}: {
  value: T | null;
  onPick: (value: T) => void;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  disabled?: boolean;
  /** A list of options one above another: Up and Down move between them. */
  orientation?: "horizontal" | "vertical";
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  return (
    <ToggleGroup
      className={className}
      style={style}
      value={value === null ? [] : [value]}
      deselectable={false}
      disabled={disabled}
      orientation={orientation}
      onValueChange={(next, details) => {
        const picked = next[0] as T | undefined;
        details.cancel();
        if (picked !== undefined && picked !== value) onPick(picked);
      }}
      {...aria}
    >
      {children}
    </ToggleGroup>
  );
}

export const PickOneItem = Toggle;
