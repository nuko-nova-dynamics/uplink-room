import { isValidElement, type ReactElement, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip";

type Side = "top" | "bottom" | "left" | "right";

/**
 * A control's hint on hover and keyboard focus, on UI SDK's Tooltip, in place of the browser's
 * `title`. Wrap one element that takes a ref and props (a button, mostly):
 *
 *   <Tip label="Close"><button className="btn icon" aria-label="Close">…</button></Tip>
 *
 * When the element's own aria-label says the same as the hint, the hint doesn't repeat it to
 * screen readers; otherwise it describes the element.
 */
export function Tip({
  label,
  children,
  side = "bottom",
  disabled = false,
}: {
  label: ReactNode;
  children: ReactElement;
  side?: Side;
  /** Shows no hint, as when the label is empty; the element still works. */
  disabled?: boolean;
}) {
  const own = isValidElement<{ "aria-label"?: string }>(children)
    ? children.props["aria-label"]
    : undefined;
  return (
    <Tooltip
      delay={500}
      disabled={disabled || label === "" || label == null}
      type={typeof label === "string" && own === label ? "label" : "description"}
    >
      <TooltipTrigger render={children} />
      <TooltipContent className="tip" side={side} sideOffset={6} collisionPadding={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
