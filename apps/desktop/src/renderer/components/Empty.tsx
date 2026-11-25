import type { ReactNode } from "react";
import { LinkMascot } from "../characters/LinkMascot";

/**
 * An empty view or panel (DESIGN.md: Link appears in empty states). One line
 * says what belongs here, and the optional action is the next step.
 */
export function Empty({
  children,
  action,
  size = 36,
}: {
  children: ReactNode;
  action?: ReactNode;
  size?: number;
}) {
  return (
    <div className="empty-state">
      <LinkMascot size={size} still />
      <div className="empty-copy">
        <p>{children}</p>
        {action ? <div className="empty-action">{action}</div> : null}
      </div>
    </div>
  );
}
